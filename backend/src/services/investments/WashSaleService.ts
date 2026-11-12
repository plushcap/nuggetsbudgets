import { sql, type RawBuilder } from 'kysely';
import { corporateActionType, holdingEventType, type WashSaleAdjustment, type WashSaleOutcome } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { addDays } from '../../utils/calendarDate.js';
import { CENTS, PER_SHARE, SHARES, assertFits, numericUnits, unitsToNumber, unitsToText } from '../../utils/decimal.js';
import { splitsSince, type RecordedSplit } from './splitUnits.js';
import { perShareOf, type LotAfterSale } from './costBasis.js';
import { matchWashSales, WASH_SALE_WINDOW_DAYS, type LossShares, type ReplacementLot, type WashMatch } from './washSale.js';

const logger = createLogger({ service: 'WashSaleService' });

/** The events whose lots are acquisitions that can replace sold shares. */
const ACQUISITION_EVENTS = ['buy', 'dividend_reinvest', 'transfer_in', 'historical_import'];

/**
 * First key of the transaction-scoped advisory lock detection holds on a security
 * (ASCII "WASH"); the second is the security id. Two detections at once (a buy and a
 * sell, two buys) would each read the same unmatched loss shares and both disallow
 * them; with the lock the second reads what the first matched once it commits.
 */
const WASH_SALE_LOCK_CLASS = 0x57415348;

/**
 * Take the locks a change to a security's open lots needs before it reads them: the
 * security's row FOR KEY SHARE, which waits out a corporate action on it (that holds the row
 * FOR UPDATE, and every other lot writer takes KEY SHARE on it, an insert's foreign key
 * included, before it reads a lot), then the wash-sale lock, which serializes the rest (two
 * sales, a sale and a wash-sale adjustment). A sale writes the shares and basis it worked out
 * from the lots it read, so the lots mustn't change between the read and the write.
 */
export async function lockSecurityLots(securityId: number): Promise<void> {
  await getDb().selectFrom('securities').select('id').where('id', '=', securityId).forKeyShare().execute();
  await sql`SELECT pg_advisory_xact_lock(${WASH_SALE_LOCK_CLASS}::int, ${securityId}::int)`.execute(getDb());
}

/** The splits and reverse splits recorded of these securities, by security, in the order recorded. */
export async function recordedSplits(securityIds: number[]): Promise<Map<number, RecordedSplit[]>> {
  const bySecurity = new Map<number, RecordedSplit[]>();
  if (securityIds.length === 0) return bySecurity;
  const rows = await getDb()
    .selectFrom('security_corporate_actions')
    .select(['id', 'security_id', 'action_date', 'numerator', 'denominator'])
    .where('security_id', 'in', securityIds)
    .where('action_type', 'in', [corporateActionType.enum.split, corporateActionType.enum.reverse_split])
    .orderBy('id')
    .execute();
  for (const r of rows) {
    if (r.numerator == null || r.denominator == null) continue;
    const split = { id: r.id, actionDate: r.action_date, numerator: numericUnits(r.numerator, SHARES.scale), denominator: numericUnits(r.denominator, SHARES.scale) };
    bySecurity.set(r.security_id, [...(bySecurity.get(r.security_id) ?? []), split]);
  }
  return bySecurity;
}

/** A lot's basis, in units: millionths of a share, ten-thousandths of a dollar, cents. */
interface LotBasis {
  sharesRemaining: bigint;
  costBasisPerShare: bigint;
  totalCostBasis: bigint;
}

/** A replacement lot's basis, with its uuid (null for the lot a dry run would create). */
type ReplacementBasis = LotBasis & { uuid: string | null };

/** A lot not yet written, as a dry run previews it. */
export type NewLot = { securityId: number; acquisitionDate: string } & LotBasis;

/** No wash sale: nothing flagged, disallowed or adjusted. */
export const NO_WASH_SALE = (): WashSaleOutcome => ({ flagged: 0, disallowed: 0, adjustments: [] });

/** The id newLotsPreview gives the lot it hasn't written (a serial id is never 0). */
const PREVIEW_LOT_ID = 0;

/** The data qualities whose lots aren't analyzed as losses. */
const UNANALYZED_QUALITIES = ['aggregate_only', 'unknown_provenance'];

/** A lot a sale consumes shares of, as a dry run of it works out (costBasis.ts planSell). */
export interface PlannedConsumption {
  lotId: number;
  /** Millionths of a share. */
  sharesConsumed: bigint;
  /** Cents; negative for a loss. */
  realizedGainLoss: bigint;
}

/**
 * Wash-sale detection. Runs across ALL accounts of the
 * tenant (the IRS rule is per-taxpayer, not per-account). Loss shares sold are
 * matched share for share with shares of the same security acquired within 30 days
 * before or after the sale (washSale.ts matchWashSales); the matched part of the
 * loss is disallowed and added to the replacement lot's basis. It runs
 * when a sell is recorded (replacements bought before it, or already recorded after
 * it) and when a lot is acquired (sales in the 30 days before or after it).
 *
 * The lot a loss was sold from is never its own replacement; a
 * replacement share absorbs one loss share, in the shares of one day (wash_sale_records.loss_shares
 * counts the loss's, replacement_shares the replacement lot's, which its splits scale; a
 * loss counts in the lot's shares across the splits recorded since it); and
 * only the matched shares' part of a loss is disallowed. What's
 * already matched stays matched, so running detection again changes nothing; it
 * doesn't re-match history recorded out of order.
 *
 * The basis bump spreads over the replacement lot's remaining shares (lots carry one
 * per-share basis), and the replacement's holding period is not extended by the loss
 * shares' (IRC §1223(3)). Lots whose data_quality is aggregate_only/unknown_provenance
 * aren't analyzed as losses.
 *
 * Shares and money are exact bigints; the adjusted basis is worked out, and checked
 * against its columns, before anything is written.
 *
 * Each detection and preview answers a WashSaleOutcome (@nuggets/shared): what it flags and
 * disallows, and each replacement lot's adjustment, so a dry run shows what the real call does.
 */
export class WashSaleService {
  /** Detect and apply wash sales for the loss consumptions of a sell event. */
  async detectForSellEvent(sellEventId: number): Promise<WashSaleOutcome> {
    const sell = await getDb()
      .selectFrom('holding_events')
      .select(['id', 'security_id', 'event_date'])
      .where('id', '=', sellEventId)
      .where('event_type', '=', holdingEventType.enum.sell)
      .executeTakeFirst();
    if (!sell || sell.security_id == null) return NO_WASH_SALE();
    await this.lockSecurity(sell.security_id);

    const losses = await this.lossShares(sql`lc.sell_event_id = ${sellEventId}`);
    if (losses.length === 0) return NO_WASH_SALE();
    const replacements = await this.replacementLots(sql`
      tl.security_id = ${sell.security_id}
      AND tl.acquisition_date BETWEEN ${addDays(sell.event_date, -WASH_SALE_WINDOW_DAYS)} AND ${addDays(sell.event_date, WASH_SALE_WINDOW_DAYS)}
    `);
    return this.apply(matchWashSales(losses, replacements), sell.event_date, { sellEventId });
  }

  /** Detect and apply the wash sales a newly acquired lot replaces (a buy, DRIP or import). */
  async detectForNewLot(lotId: number): Promise<WashSaleOutcome> {
    const lot = await getDb().selectFrom('tax_lots').select(['security_id', 'acquisition_date']).where('id', '=', lotId).executeTakeFirst();
    if (!lot) return NO_WASH_SALE();
    await this.lockSecurity(lot.security_id);
    const replacements = await this.replacementLots(sql`tl.id = ${lotId}`);
    if (replacements.length === 0) return NO_WASH_SALE();
    const losses = await this.lossShares(sql`
      tl.security_id = ${lot.security_id}
      AND he.event_date BETWEEN ${addDays(lot.acquisition_date, -WASH_SALE_WINDOW_DAYS)} AND ${addDays(lot.acquisition_date, WASH_SALE_WINDOW_DAYS)}
    `);
    return this.apply(matchWashSales(losses, replacements), lot.acquisition_date, { lotId });
  }

  /**
   * The wash sales a lot not yet written would replace, for a dry run: what detectForNewLot
   * would flag, disallow and add to it (its adjustment's lot_uuid is null), with the same checks
   * of the adjusted basis (a 400 when it wouldn't fit its columns), writing nothing.
   */
  async previewForNewLot(lot: NewLot): Promise<WashSaleOutcome> {
    return this.newLotsPreview()(lot);
  }

  /**
   * previewForNewLot for lots written one after another, as a batch import writes them:
   * call the function it gives with each lot in turn. Each lot's detection sees the
   * loss shares the lots before it matched, as detectForNewLot does once they are written,
   * and a lot whose adjusted basis wouldn't fit is refused with the 400 the real call answers.
   */
  newLotsPreview(): (lot: NewLot) => Promise<WashSaleOutcome> {
    // What the lots before matched, by loss consumption.
    const matchedBefore = new Map<number, { shares: bigint; disallowed: bigint }>();
    return async (lot) => {
      const losses = (await this.lossShares(sql`
        tl.security_id = ${lot.securityId}
        AND he.event_date BETWEEN ${addDays(lot.acquisitionDate, -WASH_SALE_WINDOW_DAYS)} AND ${addDays(lot.acquisitionDate, WASH_SALE_WINDOW_DAYS)}
      `, false))
        .map((l) => {
          const before = matchedBefore.get(l.consumptionId);
          return before ? { ...l, matchedMicro: l.matchedMicro + before.shares, disallowedCents: l.disallowedCents + before.disallowed } : l;
        })
        .filter((l) => l.matchedMicro < l.sharesMicro);
      const matches = matchWashSales(losses, [{ lotId: PREVIEW_LOT_ID, acquisitionDate: lot.acquisitionDate, availableMicro: lot.sharesRemaining }]);
      const adjusted = adjustedBases(matches, new Map([[PREVIEW_LOT_ID, { ...lot, uuid: null }]]));
      for (const m of matches) {
        const before = matchedBefore.get(m.consumptionId) ?? { shares: 0n, disallowed: 0n };
        matchedBefore.set(m.consumptionId, { shares: before.shares + m.lossSharesMicro, disallowed: before.disallowed + m.disallowedCents });
      }
      return outcome(matches, adjusted);
    };
  }

  /**
   * The wash sales a sale not yet written would make, for its dry run: what
   * detectForSellEvent would flag, disallow and add to each replacement lot once the sale is
   * written, with the same checks of the adjusted basis (a 400 when it wouldn't fit its
   * columns), writing nothing. The lots it sells from are as it leaves them (`lotsAfter`, the
   * plan's: its remaining basis less what the sale takes, pro rata, or an average-cost pool
   * re-based): a replacement counts, and spreads its added basis over, the shares it holds after
   * the sale, from the basis it has then.
   */
  async previewForSale(sale: {
    securityId: number;
    saleDate: string;
    consumptions: PlannedConsumption[];
    lotsAfter: Map<number, LotAfterSale>;
  }): Promise<WashSaleOutcome> {
    const lossLotIds = [...new Set(sale.consumptions.filter((c) => c.realizedGainLoss < 0n).map((c) => c.lotId))];
    if (lossLotIds.length === 0) return NO_WASH_SALE();
    const analyzed = new Set((await getDb()
      .selectFrom('tax_lots')
      .select('id')
      .where('id', 'in', lossLotIds)
      .where('data_quality', 'not in', UNANALYZED_QUALITIES)
      .execute()).map((r) => r.id));
    // The sale's loss consumptions, numbered in the order it writes them (as their ids would be).
    const losses: LossShares[] = sale.consumptions.flatMap((c, i) => (c.realizedGainLoss < 0n && analyzed.has(c.lotId)
      ? [{ consumptionId: i + 1, saleDate: sale.saleDate, lotId: c.lotId, sharesMicro: c.sharesConsumed, lossCents: -c.realizedGainLoss, matchedMicro: 0n, disallowedCents: 0n }]
      : []));
    if (losses.length === 0) return NO_WASH_SALE();
    const replacements = (await this.replacementCandidates(sql`
      tl.security_id = ${sale.securityId}
      AND tl.acquisition_date BETWEEN ${addDays(sale.saleDate, -WASH_SALE_WINDOW_DAYS)} AND ${addDays(sale.saleDate, WASH_SALE_WINDOW_DAYS)}
    `))
      .map((r) => ({ ...r, heldMicro: sale.lotsAfter.get(r.lotId)?.sharesRemaining ?? r.heldMicro }))
      .map(replacementOf)
      .filter((r) => r.availableMicro > 0n);
    const matches = matchWashSales(losses, replacements);
    const bases = await this.lotBases([...new Set(matches.map((m) => m.replacementLotId))]);
    for (const [lotId, basis] of bases) {
      const after = sale.lotsAfter.get(lotId);
      if (after) bases.set(lotId, { ...basis, ...after });
    }
    return outcome(matches, adjustedBases(matches, bases));
  }

  /** Serializes detection on one security until the transaction ends. */
  private async lockSecurity(securityId: number) {
    await sql`SELECT pg_advisory_xact_lock(${WASH_SALE_LOCK_CLASS}::int, ${securityId}::int)`.execute(getDb());
  }

  /**
   * Loss shares sold (by a sell) and not yet fully matched, from lots that can be analyzed.
   * `unmatchedOnly` false keeps the fully matched ones too, for a preview to count on.
   *
   * Each with its `sharesNow`: the splits of its security recorded since that its
   * shares aren't adjusted for (splitUnits.ts splitsSince), what a share sold then is in a
   * replacement lot's shares, which those splits scaled.
   */
  private async lossShares(where: RawBuilder<unknown>, unmatchedOnly = true): Promise<LossShares[]> {
    const rows = await sql<{
      id: number; tax_lot_id: number; security_id: number; sale_date: string; adjusted_through: number | null; shares_consumed: string;
      realized_gain_loss: string; disallowed_loss: string; matched: string;
    }>`
      SELECT lc.id, lc.tax_lot_id, tl.security_id, he.event_date AS sale_date, he.adjusted_through_action_id AS adjusted_through,
             lc.shares_consumed, lc.realized_gain_loss,
             lc.disallowed_loss,
             COALESCE((SELECT SUM(w.loss_shares) FROM wash_sale_records w WHERE w.loss_lot_consumption_id = lc.id), 0) AS matched
      FROM lot_consumptions lc
      JOIN tax_lots tl ON tl.id = lc.tax_lot_id
      JOIN holding_events he ON he.id = lc.sell_event_id
      WHERE ${where}
        AND he.event_type = 'sell'
        AND lc.realized_gain_loss < 0
        AND tl.data_quality NOT IN (${sql.join(UNANALYZED_QUALITIES)})
    `.execute(getDb());
    const splits = await recordedSplits([...new Set(rows.rows.map((r) => r.security_id))]);
    const losses = rows.rows.map((r) => ({
      consumptionId: r.id,
      saleDate: r.sale_date,
      lotId: r.tax_lot_id,
      sharesMicro: numericUnits(r.shares_consumed, SHARES.scale),
      lossCents: -numericUnits(r.realized_gain_loss, CENTS.scale),
      matchedMicro: numericUnits(r.matched, SHARES.scale),
      disallowedCents: numericUnits(r.disallowed_loss, CENTS.scale),
      sharesNow: splitsSince(splits.get(r.security_id) ?? [], r.sale_date, r.adjusted_through),
    }));
    return unmatchedOnly ? losses.filter((l) => l.matchedMicro < l.sharesMicro) : losses;
  }

  /** Acquired lots with shares that can still replace sold ones: not yet matched, and still held. */
  private async replacementLots(where: RawBuilder<unknown>): Promise<ReplacementLot[]> {
    return (await this.replacementCandidates(where)).map(replacementOf).filter((r) => r.availableMicro > 0n);
  }

  /** Acquired lots still held, with the shares they hold and the shares not yet matched to a loss. */
  private async replacementCandidates(where: RawBuilder<unknown>): Promise<ReplacementCandidate[]> {
    const rows = await sql<{ id: number; acquisition_date: string; shares_original: string; shares_remaining: string; used: string }>`
      SELECT tl.id, tl.acquisition_date, tl.shares_original, tl.shares_remaining,
             COALESCE((SELECT SUM(w.replacement_shares) FROM wash_sale_records w WHERE w.replacement_lot_id = tl.id), 0) AS used
      FROM tax_lots tl
      JOIN holding_events he ON he.id = tl.created_by_event_id
      WHERE ${where}
        AND he.event_type IN (${sql.join(ACQUISITION_EVENTS)})
        AND tl.shares_remaining > 0
    `.execute(getDb());
    return rows.rows.map((r) => ({
      lotId: r.id,
      acquisitionDate: r.acquisition_date,
      heldMicro: numericUnits(r.shares_remaining, SHARES.scale),
      unmatchedMicro: numericUnits(r.shares_original, SHARES.scale) - numericUnits(r.used, SHARES.scale),
    }));
  }

  /** The replacement lots' basis as it stands (the wash-sale lock keeps it so until the transaction ends). */
  private async lotBases(lotIds: number[]): Promise<Map<number, ReplacementBasis>> {
    if (lotIds.length === 0) return new Map();
    const rows = await getDb()
      .selectFrom('tax_lots')
      .select(['id', 'uuid', 'shares_remaining', 'cost_basis_per_share', 'total_cost_basis'])
      .where('id', 'in', lotIds)
      .execute();
    return new Map(rows.map((r) => [r.id, {
      uuid: r.uuid,
      sharesRemaining: numericUnits(r.shares_remaining, SHARES.scale),
      costBasisPerShare: numericUnits(r.cost_basis_per_share, PER_SHARE.scale),
      totalCostBasis: numericUnits(r.total_cost_basis, CENTS.scale),
    }]));
  }

  private async apply(matches: WashMatch[], detectionDate: string, context: Record<string, number>): Promise<WashSaleOutcome> {
    // Every replacement lot's adjusted basis, checked before the first write.
    const adjusted = adjustedBases(matches, await this.lotBases([...new Set(matches.map((m) => m.replacementLotId))]));
    for (const m of matches) {
      const amount = unitsToText(m.disallowedCents, CENTS.scale);
      await getDb()
        .updateTable('lot_consumptions')
        .set({ is_wash_sale: true, disallowed_loss: sql`disallowed_loss + ${amount}::numeric` })
        .where('id', '=', m.consumptionId)
        .execute();
      await getDb()
        .insertInto('wash_sale_records')
        .values({
          loss_lot_consumption_id: m.consumptionId,
          replacement_lot_id: m.replacementLotId,
          replacement_shares: unitsToText(m.sharesMicro, SHARES.scale),
          loss_shares: unitsToText(m.lossSharesMicro, SHARES.scale),
          disallowed_loss: amount,
          basis_adjustment: amount,
          detection_date: detectionDate,
        })
        .execute();
    }
    for (const [lotId, basis] of adjusted) {
      await getDb()
        .updateTable('tax_lots')
        .set({ total_cost_basis: unitsToText(basis.totalCostBasis, CENTS.scale), cost_basis_per_share: unitsToText(basis.costBasisPerShare, PER_SHARE.scale) })
        .where('id', '=', lotId)
        .execute();
    }
    const result = outcome(matches, adjusted);
    if (result.flagged > 0) logger.info({ ...context, flagged: result.flagged }, 'Wash sale(s) detected');
    return result;
  }

  /** Wash sale report for a period (joined to securities for display). */
  async getReport(opts: { startDate?: string; endDate?: string } = {}) {
    const rows = await sql<{
      ticker: string; detection_date: string; disallowed_loss: string; sell_date: string;
    }>`
      SELECT s.ticker, wsr.detection_date, wsr.disallowed_loss, he.event_date AS sell_date
      FROM wash_sale_records wsr
      JOIN lot_consumptions lc ON lc.id = wsr.loss_lot_consumption_id
      JOIN holding_events he ON he.id = lc.sell_event_id
      JOIN securities s ON s.id = he.security_id
      WHERE 1=1
        ${opts.startDate ? sql`AND he.event_date >= ${opts.startDate}` : sql``}
        ${opts.endDate ? sql`AND he.event_date <= ${opts.endDate}` : sql``}
      ORDER BY wsr.detection_date DESC
    `.execute(getDb());
    return rows.rows.map((r) => ({ ...r, disallowed_loss: Number(r.disallowed_loss) }));
  }
}

/** A lot that can replace sold shares, before its held and unmatched shares are compared. */
interface ReplacementCandidate {
  lotId: number;
  acquisitionDate: string;
  /** Millionths of a share it holds. */
  heldMicro: bigint;
  /** Millionths of a share of it not yet matched to a loss. */
  unmatchedMicro: bigint;
}

/** A candidate's shares that can replace sold ones: those it still holds, up to those not yet matched. */
function replacementOf(c: ReplacementCandidate): ReplacementLot {
  return { lotId: c.lotId, acquisitionDate: c.acquisitionDate, availableMicro: c.heldMicro < c.unmatchedMicro ? c.heldMicro : c.unmatchedMicro };
}

/**
 * Each replacement lot's basis after `matches`: the disallowed loss added to its
 * total exactly, and its basis per share that total over the shares it still holds, to 4 places,
 * as a split works it out. It was the old basis per share plus each match's share,
 * each rounded: six $1 matches on 18 shares added 0.0556 six times, where the same lot matched
 * first and split 3:1 after was 66.00 / 18, 3.6667 against 3.6669, so the order a split and the
 * matches were entered in changed the figure. Worked out from the total, it is the same in any
 * order. Refuses, with a 400, a basis too large for its columns, which Postgres refused
 * with an error (a 500).
 */
function adjustedBases<B extends LotBasis>(matches: WashMatch[], bases: Map<number, B>): Map<number, B> {
  const adjusted = new Map<number, B>();
  for (const m of matches) {
    const lot = adjusted.get(m.replacementLotId) ?? bases.get(m.replacementLotId);
    if (!lot) throw new Error('A wash-sale replacement lot was not found');
    const totalCostBasis = lot.totalCostBasis + m.disallowedCents;
    adjusted.set(m.replacementLotId, {
      ...lot,
      costBasisPerShare: perShareOf(totalCostBasis, lot.sharesRemaining),
      totalCostBasis,
    });
  }
  for (const lot of adjusted.values()) {
    assertFits(lot.totalCostBasis, CENTS, "The replacement lot's cost basis after the wash-sale adjustment");
    assertFits(lot.costBasisPerShare, PER_SHARE, "The replacement lot's cost basis per share after the wash-sale adjustment");
  }
  return adjusted;
}

/**
 * What `matches` do, as an answer gives it: the losses they flag, the loss they disallow, and
 * each replacement lot's adjustment (the shares it replaces, the basis added, its basis after,
 * from `adjusted`), in the order the matches first reach it. Money in dollars, shares as numbers.
 */
function outcome(matches: WashMatch[], adjusted: Map<number, ReplacementBasis>): WashSaleOutcome {
  const byLot = new Map<number, { shares: bigint; added: bigint }>();
  for (const m of matches) {
    const sofar = byLot.get(m.replacementLotId) ?? { shares: 0n, added: 0n };
    byLot.set(m.replacementLotId, { shares: sofar.shares + m.sharesMicro, added: sofar.added + m.disallowedCents });
  }
  const adjustments: WashSaleAdjustment[] = [...byLot].map(([lotId, made]) => {
    const lot = adjusted.get(lotId)!;
    return {
      lot_uuid: lot.uuid,
      replacement_shares: unitsToNumber(made.shares, SHARES.scale),
      basis_added: unitsToNumber(made.added, CENTS.scale),
      total_cost_basis: unitsToNumber(lot.totalCostBasis, CENTS.scale),
      cost_basis_per_share: unitsToNumber(lot.costBasisPerShare, PER_SHARE.scale),
    };
  });
  const disallowed = matches.reduce((total, m) => total + m.disallowedCents, 0n);
  return { flagged: new Set(matches.map((m) => m.consumptionId)).size, disallowed: unitsToNumber(disallowed, CENTS.scale), adjustments };
}
