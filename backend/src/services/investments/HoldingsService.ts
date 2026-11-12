import { sql, type InsertObject } from 'kysely';
import type { AcquisitionMethod, DataQuality, WashSaleOutcome } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import type { DB } from '../../db/schema.generated.js';
import { createLogger } from '../../utils/logger.js';
import { errorCode, errorConstraint } from '../../utils/errors.js';
import {
  planSell,
  lotsHeldOn,
  buildBuyLotBasis,
  perShareOf,
  sellPlanAmounts,
  shareValueCents,
  type CostBasisMethod,
  type OpenLot,
  type SellPlan,
} from './costBasis.js';
import { NO_WASH_SALE, WashSaleService, lockSecurityLots, recordedSplits } from './WashSaleService.js';
import { splitsSince } from './splitUnits.js';
import { assertNoCorporateActionAfter, type SplitBefore } from './CorporateActionService.js';
import { ControlPlaneError, invalidRequestError, notFoundError } from '../controlPlaneErrors.js';
import {
  CENTS, PER_SHARE, SHARES, assertFits, centsNumber, divRound, numericUnits, pow10, requestCents, requestUnits,
  unitsToNumber, unitsToText, type DecimalValue,
} from '../../utils/decimal.js';
import { costBasisMethod, holdingEventType } from '@nuggets/shared';

const logger = createLogger({ service: 'HoldingsService' });

const shareText = (units: bigint) => unitsToText(units, SHARES.scale);
const perShareText = (units: bigint) => unitsToText(units, PER_SHARE.scale);
const centsText = (cents: bigint) => unitsToText(cents, CENTS.scale);

/**
 * Whether a lot acquired on `acquisitionDate` is covered when nothing says: from 2012-01-01 on.
 * That is the date for mutual fund and dividend-reinvestment-plan shares, the ones average cost
 * applies to (Treas. Reg. §1.6045-1(a)(15)(i)(B)); stock's was 2011-01-01, which only moves a
 * 2011 stock purchase, and average cost doesn't apply to stock outside a plan.
 */
export function coveredByDate(acquisitionDate: string): boolean {
  return acquisitionDate >= '2012-01-01';
}

/** A closed lot's shares_original and cost_basis_per_share, in exact units. */
interface ClosedLotFigures {
  sharesOriginal: bigint;
  costBasisPerShare: bigint;
}

/** What closedOnSaleDay puts back: the lots' two figures, and their wash records' replacement shares. */
interface ClosedOnSaleDay {
  lots: Map<number, ClosedLotFigures>;
  replacementShares: Map<number, bigint>;
}

/**
 * The lots a sale in adjusted figures closes, with the shares_original and
 * cost_basis_per_share they have closed in date order, and their wash records' replacement_shares.
 * Closed on its day, a lot never takes the splits after it; recorded later, it was
 * open when they were applied, and kept them: 180 shares at 0.6722 where date order keeps 30 at
 * 4.0333. The lots answer (GET /holdings/:uuid/lots, the agent's get_holding_lots) and a lot
 * correction's answer show a closed lot's two figures, so they are put back; its remaining shares
 * and basis are none either way, and the sale's own figures stay as given (its lot_consumptions
 * in today's shares, as adjusted_through_action_id says).
 *
 * Exactly, from what the first of those splits kept of the lot as it was before it (its event's
 * metadata.before, CorporateActionService SplitBefore), when it kept it:
 * - shares_original is the one kept;
 * - cost_basis_per_share is the one kept when only splits and sales changed the lot since (a sale
 *   leaves it as it is), else, after a wash adjustment or an average-cost sale, its basis before
 *   this sale over its shares then, as those work it out: the shares kept when only splits changed
 *   them since, else its shares now divided by the splits (below);
 * - a wash record's replacement_shares is the one kept, for a record made before the split.
 *
 * What wasn't kept is divided by the splits after the sale's day, the ratio R of their new shares
 * to old, rounded once to the millionth: a lot the person entered after the splits, in their
 * shares (adjusted_for_splits); a record made after them; shares a sale in adjusted figures took
 * since; a lot a split recorded before v2.4.0 changed (it kept nothing). That is a figure
 * the person gave, or worked out from one, after the splits, which date order would have had them
 * give before; where it is the figure of the sale's day times R rounded to the millionth
 * (x_today = round(x × R)), the result is within floor(1 / (2R) + 1/2) millionths of x: exact when
 * R ≥ 1 (a forward split, or none on balance), at most 2 millionths after a 1:3, 5 after a 1:10. A
 * basis per share worked out from such shares is the basis over them, to 4 places.
 */
async function closedOnSaleDay(
  securityId: number,
  saleDate: string,
  saleEventId: number,
  lots: OpenLot[],
  lotsAfter: ReadonlyMap<number, { sharesRemaining: bigint }>
): Promise<ClosedOnSaleDay> {
  const result: ClosedOnSaleDay = { lots: new Map(), replacementShares: new Map() };
  const closedIds = [...lotsAfter].filter(([, after]) => after.sharesRemaining === 0n).map(([lotId]) => lotId);
  if (closedIds.length === 0) return result;
  // Every split after the sale's day, in the order recorded: a net ratio of 1 (1:3 then 3:1) still
  // rounded the lot twice.
  const after = ((await recordedSplits([securityId])).get(securityId) ?? []).filter((split) => split.actionDate > saleDate);
  if (after.length === 0) return result;
  const ratio = splitsSince(after, saleDate, null);
  const onSaleDay = (shares: bigint) => divRound(shares * ratio.denominator, ratio.numerator);

  const rows = await getDb().selectFrom('tax_lots').select(['id', 'account_id', 'shares_original']).where('id', 'in', closedIds).execute();
  // The splits' events in these lots' accounts, in the order recorded. A split's event is dated on
  // its day, and a security has one split a day.
  const events = await getDb()
    .selectFrom('holding_events')
    .select(['id', 'account_id', 'event_date', 'metadata'])
    .where('security_id', '=', securityId)
    .where('event_type', 'in', [holdingEventType.enum.split, holdingEventType.enum.reverse_split])
    .where('event_date', '>', saleDate)
    .where('account_id', 'in', [...new Set(rows.map((r) => r.account_id))])
    .orderBy('id')
    .execute();
  const records = await getDb()
    .selectFrom('wash_sale_records')
    .select(['id', 'replacement_lot_id', 'replacement_shares'])
    .where('replacement_lot_id', 'in', closedIds)
    .orderBy('id')
    .execute();

  for (const row of rows) {
    const before = lots.find((l) => l.id === row.id);
    if (!before) continue;
    const recordsOf = records.filter((r) => r.replacement_lot_id === row.id);
    // The first split that kept this lot, if it is the first split after the sale's day: an
    // earlier one changed it too, and kept nothing of it.
    let kept: { eventId: number; split: number; lot: SplitBefore['lots'][number]; wash: SplitBefore['wash'] } | undefined;
    for (const event of events) {
      if (event.account_id !== row.account_id) continue;
      const keptBefore = (event.metadata as { before?: SplitBefore } | null)?.before;
      const lot = keptBefore?.lots.find((l) => l.id === row.id);
      if (!keptBefore || !lot) continue;
      const split = after.findIndex((s) => s.actionDate === event.event_date);
      if (split === 0) kept = { eventId: event.id, split, lot, wash: keptBefore.wash.filter((w) => w.lot_id === row.id) };
      break;
    }
    for (const r of recordsOf) {
      const keptShares = kept?.wash.find((w) => w.id === r.id)?.replacement_shares;
      result.replacementShares.set(r.id, keptShares !== undefined ? numericUnits(keptShares, SHARES.scale) : onSaleDay(numericUnits(r.replacement_shares, SHARES.scale)));
    }
    if (!kept) {
      result.lots.set(row.id, {
        sharesOriginal: onSaleDay(numericUnits(row.shares_original, SHARES.scale)),
        costBasisPerShare: perShareOf(before.totalCostBasis, onSaleDay(before.sharesRemaining)),
      });
      continue;
    }
    // Its shares as the splits since left them, each rounding as it rounded: what it holds now
    // when nothing but splits changed them.
    const keptShares = numericUnits(kept.lot.shares_remaining, SHARES.scale);
    const replayed = after.reduce((shares, split) => divRound(shares * split.numerator, split.denominator), keptShares);
    const sharesThen = replayed === before.sharesRemaining ? keptShares : onSaleDay(before.sharesRemaining);
    const keptRecords = new Set(kept.wash.map((w) => w.id));
    const rebased = recordsOf.some((r) => !keptRecords.has(r.id)) || (await averageCostSaleSince(row.account_id, securityId, kept.eventId, saleEventId));
    result.lots.set(row.id, {
      sharesOriginal: numericUnits(kept.lot.shares_original, SHARES.scale),
      costBasisPerShare: rebased ? perShareOf(before.totalCostBasis, sharesThen) : numericUnits(kept.lot.cost_basis_per_share, PER_SHARE.scale),
    });
  }
  return result;
}

/**
 * Whether an average-cost sale (one with no method recorded counts as one) of the security in the
 * account was recorded after event `sinceEventId`, other than `saleEventId`: it re-based the lots of
 * its pool, working each one's basis per share out from its basis (costBasis.ts rebasePool).
 */
async function averageCostSaleSince(accountId: number, securityId: number, sinceEventId: number, saleEventId: number): Promise<boolean> {
  const sale = await getDb()
    .selectFrom('holding_events')
    .select('id')
    .where('account_id', '=', accountId)
    .where('security_id', '=', securityId)
    .where('event_type', '=', holdingEventType.enum.sell)
    .where('id', '>', sinceEventId)
    .where('id', '!=', saleEventId)
    .where(sql<boolean>`COALESCE(metadata->>'method', 'average_cost') = 'average_cost'`)
    .executeTakeFirst();
  return sale !== undefined;
}

/** The unique index on an account's and security's events' external_reference. */
const EXTERNAL_REFERENCE_INDEX = 'uq_holding_events_external_ref';

/** A 409 for a request whose external_reference an event of the account and security already has. */
function referenceRecorded(existing?: { uuid: string; event_type: string }): ControlPlaneError {
  return new ControlPlaneError(
    409,
    'EXTERNAL_REFERENCE_ALREADY_RECORDED',
    'An event with this external_reference is already recorded for this account and security.',
    existing ? { event_uuid: existing.uuid, event_type: existing.event_type } : {}
  );
}

/**
 * Refuses, with a 409 that names it, a request whose external_reference an event of the same
 * account and security already has: a retried buy, sale or dividend. Its insert failed
 * on the unique index, a 500. A dry run checks it too.
 */
export async function assertReferenceFree(accountId: number, securityId: number, externalReference: string | null | undefined): Promise<void> {
  if (!externalReference) return;
  const existing = await getDb()
    .selectFrom('holding_events')
    .select(['uuid', 'event_type'])
    .where('account_id', '=', accountId)
    .where('security_id', '=', securityId)
    .where('external_reference', '=', externalReference)
    .executeTakeFirst();
  if (existing) throw referenceRecorded(existing);
}

/**
 * Insert a holding event. One whose external_reference another request recorded after the
 * check (two retries at once) is the same 409, not the unique index's error (a 500).
 */
export async function insertHoldingEvent(values: InsertObject<DB, 'holding_events'>): Promise<{ id: number; uuid: string }> {
  try {
    return await getDb().insertInto('holding_events').values(values).returning(['id', 'uuid']).executeTakeFirstOrThrow();
  } catch (err) {
    if (errorCode(err) === '23505' && errorConstraint(err) === EXTERNAL_REFERENCE_INDEX) throw referenceRecorded();
    throw err;
  }
}

/**
 * Persistence wrapper around the pure cost-basis engine (costBasis.ts).
 *
 * All queries run on `getDb()` (the request's tenant transaction → RLS-scoped).
 * The holding_events stream is the system of record; tax_lots and
 * lot_consumptions are written here and current holdings are computed on read
 * from open lots + latest prices (no incrementally-maintained cache in v1).
 *
 * A buy, a sale, a reinvested dividend and each imported lot answer `wash_sale`, a
 * WashSaleOutcome (@nuggets/shared): the losses it flags, the loss disallowed and each
 * replacement lot's adjustment. Its dry run answers the same, worked out without writing:
 * the lot it would create has a null lot_uuid.
 */
export class HoldingsService {
  // ------------------------------------------------------------------ helpers
  private async securityIdByUuid(uuid: string): Promise<number> {
    const row = await getDb()
      .selectFrom('securities')
      .select('id')
      .where('uuid', '=', uuid)
      .executeTakeFirst();
    if (!row) throw notFoundError('security');
    return row.id;
  }

  private async accountIdByUuid(uuid: string): Promise<number> {
    const row = await getDb()
      .selectFrom('accounts')
      .select('id')
      .where('uuid', '=', uuid)
      .executeTakeFirst();
    if (!row) throw notFoundError('account');
    return row.id;
  }

  /** Open lots for an (account, security), oldest-first, in exact units. Take lockSecurityLots first to write from them. */
  private async openLots(accountId: number, securityId: number): Promise<(OpenLot & { uuid: string })[]> {
    const rows = await getDb()
      .selectFrom('tax_lots')
      .select(['id', 'uuid', 'acquisition_date', 'holding_period_start', 'shares_remaining', 'cost_basis_per_share', 'total_cost_basis', 'is_covered'])
      .where('account_id', '=', accountId)
      .where('security_id', '=', securityId)
      .where('is_open', '=', true)
      .orderBy('acquisition_date', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      uuid: r.uuid,
      acquisitionDate: r.acquisition_date,
      holdingPeriodStart: r.holding_period_start,
      sharesRemaining: numericUnits(r.shares_remaining, SHARES.scale),
      costBasisPerShare: numericUnits(r.cost_basis_per_share, PER_SHARE.scale),
      totalCostBasis: numericUnits(r.total_cost_basis, CENTS.scale),
      isCovered: r.is_covered,
    }));
  }

  /** Resolve the effective cost basis method: (account,security) -> (account) -> fifo. */
  async resolveMethod(accountId: number, securityId: number): Promise<CostBasisMethod> {
    const rows = await getDb()
      .selectFrom('cost_basis_method_settings')
      .select(['security_id', 'method'])
      .where('account_id', '=', accountId)
      .where((eb) => eb.or([eb('security_id', '=', securityId), eb('security_id', 'is', null)]))
      .execute();
    const specific = rows.find((r) => r.security_id === securityId);
    const accountDefault = rows.find((r) => r.security_id === null);
    return (specific?.method ?? accountDefault?.method ?? 'fifo') as CostBasisMethod;
  }

  // -------------------------------------------------------------------- writes
  async recordBuy(input: {
    accountUuid: string;
    securityUuid: string;
    eventDate: string;
    shares: DecimalValue;
    pricePerShare: DecimalValue;
    fees?: DecimalValue;
    acquisitionMethod?: string;
    source?: string;
    description?: string | null;
    externalReference?: string | null;
    dataQuality?: string;
    /** Whether the lot is covered; by its date (coveredByDate) when not given. */
    isCovered?: boolean | undefined;
    /** Its shares and price are already adjusted for the splits recorded after it (assertNoCorporateActionAfter). */
    adjustedForSplits?: boolean | undefined;
    userId?: number;
    dryRun?: boolean;
  }) {
    const accountId = await this.accountIdByUuid(input.accountUuid);
    const securityId = await this.securityIdByUuid(input.securityUuid);
    // Read as sent, exactly: shares in millionths, the price in ten-thousandths, fees in cents.
    const shares = requestUnits(input.shares, 'shares', SHARES);
    const pricePerShare = requestUnits(input.pricePerShare, 'price_per_share', PER_SHARE);
    const fees = requestCents(input.fees ?? 0, 'fees');
    const { totalCostBasis, costBasisPerShare } = buildBuyLotBasis(shares, pricePerShare, fees);
    assertFits(totalCostBasis, CENTS, "The lot's cost basis");
    assertFits(costBasisPerShare, PER_SHARE, "The lot's cost basis per share");
    // The security's lock before the event is written, as a sale and a batch import take it:
    // a buy that wrote its reference first and then waited for the lock (to look for wash
    // sales) deadlocked with an import holding the lock and inserting the same reference.
    await lockSecurityLots(securityId);
    await assertReferenceFree(accountId, securityId, input.externalReference);
    // A lot bought before a recorded split would be one the split changed, unless
    // its shares and price are already the split's: then its lot is as given.
    const adjustedThrough = await assertNoCorporateActionAfter(securityId, input.eventDate, 'a buy', input.adjustedForSplits);

    if (input.dryRun) {
      // The wash-sale adjustment the lot would get, checked as the buy checks it.
      const washSale = await new WashSaleService().previewForNewLot({ securityId, acquisitionDate: input.eventDate, sharesRemaining: shares, costBasisPerShare, totalCostBasis });
      return {
        dry_run: true,
        would_create_lot: {
          shares: unitsToNumber(shares, SHARES.scale),
          total_cost_basis: unitsToNumber(totalCostBasis, CENTS.scale),
          cost_basis_per_share: unitsToNumber(costBasisPerShare, PER_SHARE.scale),
        },
        wash_sale: washSale,
      };
    }

    const event = await insertHoldingEvent({
      account_id: accountId,
      security_id: securityId,
      user_id: input.userId ?? null,
      event_type: 'buy',
      event_date: input.eventDate,
      shares: shareText(shares),
      price_per_share: perShareText(pricePerShare),
      total_amount: centsText(totalCostBasis),
      fees: centsText(fees),
      source: input.source ?? 'manual',
      description: input.description ?? null,
      external_reference: input.externalReference ?? null,
      adjusted_through_action_id: adjustedThrough,
    });

    const lot = await getDb()
      .insertInto('tax_lots')
      .values({
        account_id: accountId,
        security_id: securityId,
        created_by_event_id: event.id,
        acquisition_date: input.eventDate,
        holding_period_start: input.eventDate,
        shares_original: shareText(shares),
        shares_remaining: shareText(shares),
        cost_basis_per_share: perShareText(costBasisPerShare),
        total_cost_basis: centsText(totalCostBasis),
        acquisition_method: (input.acquisitionMethod as never) ?? 'purchase',
        data_quality: (input.dataQuality as never) ?? 'complete',
        // A 2010 buy was stored covered (the column's default) and pooled with covered lots.
        is_covered: input.isCovered ?? coveredByDate(input.eventDate),
        external_reference: input.externalReference ?? null,
      })
      .returning(['id', 'uuid'])
      .executeTakeFirstOrThrow();

    // A buy within 30 days after (or before) a loss sale replaces its shares.
    const washSale = await new WashSaleService().detectForNewLot(lot.id);

    logger.info({ accountId, securityId, eventUuid: event.uuid, lotUuid: lot.uuid, washFlagged: washSale.flagged }, 'Recorded buy');
    return { event_uuid: event.uuid, lot_uuid: lot.uuid, total_cost_basis: unitsToNumber(totalCostBasis, CENTS.scale), wash_sale: washSale };
  }

  async recordSell(input: {
    accountUuid: string;
    securityUuid: string;
    eventDate: string;
    shares: DecimalValue;
    pricePerShare: DecimalValue;
    fees?: DecimalValue;
    method?: CostBasisMethod;
    specificLots?: { lotUuid: string; shares: DecimalValue }[];
    source?: string;
    description?: string | null;
    externalReference?: string | null;
    /** Its shares and price are already adjusted for the splits recorded after it (assertNoCorporateActionAfter). */
    adjustedForSplits?: boolean | undefined;
    userId?: number;
    dryRun?: boolean;
  }) {
    const shares = requestUnits(input.shares, 'shares', SHARES);
    const pricePerShare = requestUnits(input.pricePerShare, 'price_per_share', PER_SHARE);
    const fees = requestCents(input.fees ?? 0, 'fees');
    const accountId = await this.accountIdByUuid(input.accountUuid);
    const securityId = await this.securityIdByUuid(input.securityUuid);
    // The lots stay as read until the sale is written: it writes their shares and basis.
    await lockSecurityLots(securityId);
    // A retry of a recorded sale is refused for that, before its shares are found sold.
    await assertReferenceFree(accountId, securityId, input.externalReference);
    // The lots held on a date before a recorded split hold its shares now, not those held then
    // (before, 150 shares were sold from 100). A sale whose shares and price are the split's
    // already sells them from those lots as they are now: shares, price and lots
    // in the same terms, its basis taken pro rata as any sale's. Its stored figures are in those
    // terms too, which what compares them with another day's reads (adjusted_through_action_id).
    const adjustedThrough = await assertNoCorporateActionAfter(securityId, input.eventDate, 'a sale', input.adjustedForSplits);
    // A sale sells the shares held on its date: a lot acquired after it isn't one of them, nor
    // in its average-cost pool. A sale recorded late (dated before a later buy) took the later
    // lot's shares, with a negative holding period, and its average re-based that lot too.
    const openLots = await this.openLots(accountId, securityId);
    const lots = lotsHeldOn(openLots, input.eventDate, shares);
    const method = input.method ?? (await this.resolveMethod(accountId, securityId));

    let specific;
    if (method === costBasisMethod.enum.specific_id) {
      if (!input.specificLots?.length) throw invalidRequestError('error: specific_id sell requires lot selection');
      const byUuid = new Map(lots.map((l) => [l.uuid, l.id]));
      const later = new Map(openLots.filter((l) => l.acquisitionDate > input.eventDate).map((l) => [l.uuid, l.acquisitionDate]));
      specific = input.specificLots.map((s) => {
        const id = byUuid.get(s.lotUuid);
        const acquired = later.get(s.lotUuid);
        if (acquired) throw invalidRequestError(`Lot ${s.lotUuid} was acquired on ${acquired}, after this sale's date (${input.eventDate}): a sale can only sell shares held on its date`);
        if (!id) throw invalidRequestError(`error: lot not open: ${s.lotUuid}`);
        return { lotId: id, shares: requestUnits(s.shares, 'specific_lots.shares', SHARES) };
      });
    }

    const plan: SellPlan = planSell({
      lots,
      sharesToSell: shares,
      pricePerShare,
      sellDate: input.eventDate,
      method,
      fees,
      specificLots: specific,
    });
    // Each lot after the sale (plan.lotsAfter): its remaining basis less what the sale takes of
    // it, pro rata (costBasis.ts). Its basis per share stays as it is (no share's basis changes,
    // and the total, not shares × it, is what the next sale takes), except that an average-cost
    // sale re-bases every lot of the pool, those it took no shares from too. Every figure is
    // checked against its column before the first write: one too large is a 400, where
    // Postgres refused it with an error (a 500).
    const lotsAfter = plan.lotsAfter;
    for (const c of plan.consumptions) {
      assertFits(c.basisConsumed, CENTS, 'The basis sold');
      assertFits(c.proceeds, CENTS, 'The proceeds');
      assertFits(c.realizedGainLoss, CENTS, 'The realized gain or loss');
    }
    assertFits(plan.totalProceeds, CENTS, 'The proceeds');
    for (const after of lotsAfter.values()) {
      assertFits(after.totalCostBasis, CENTS, "A lot's remaining cost basis");
      assertFits(after.costBasisPerShare, PER_SHARE, "A lot's cost basis per share");
    }

    const hasLoss = plan.consumptions.some((c) => c.realizedGainLoss < 0n);

    if (input.dryRun) {
      // The wash-sale adjustments the sale would make, checked as the sale checks them,
      // and answered.
      const washSale = hasLoss
        ? await new WashSaleService().previewForSale({ securityId, saleDate: input.eventDate, consumptions: plan.consumptions, lotsAfter })
        : NO_WASH_SALE();
      return { dry_run: true, method, plan: sellPlanAmounts(plan), wash_sale: washSale };
    }

    const event = await insertHoldingEvent({
      account_id: accountId,
      security_id: securityId,
      user_id: input.userId ?? null,
      event_type: 'sell',
      event_date: input.eventDate,
      shares: shareText(shares),
      price_per_share: perShareText(pricePerShare),
      total_amount: centsText(plan.totalProceeds),
      fees: centsText(fees),
      source: input.source ?? 'manual',
      description: input.description ?? null,
      external_reference: input.externalReference ?? null,
      metadata: sql`${JSON.stringify({ method })}::jsonb`,
      adjusted_through_action_id: adjustedThrough,
    });

    for (const c of plan.consumptions) {
      await getDb()
        .insertInto('lot_consumptions')
        .values({
          tax_lot_id: c.lotId,
          sell_event_id: event.id,
          shares_consumed: shareText(c.sharesConsumed),
          basis_consumed: centsText(c.basisConsumed),
          proceeds: centsText(c.proceeds),
          realized_gain_loss: centsText(c.realizedGainLoss),
          holding_period_days: c.holdingPeriodDays,
          is_long_term: c.isLongTerm,
        })
        .execute();
    }
    // Decrement each lot; close it when fully consumed. total_cost_basis stays the
    // remaining basis, which a wash-sale bump adds to. An average-cost sale
    // writes every lot of the pool, re-based. A lot an adjusted sale closes is put back in its
    // sale day's shares (closedOnSaleDay).
    //
    // A lot an adjusted sale leaves open gets its basis per share worked out from its basis, as the
    // split after the sale works it out in date order: a sale leaves it as it is, so
    // split first and sold after kept 121.00 / 180 (0.6722) where sold first and split after is
    // 80.67 / 120 (0.6723). With a wash adjustment worked out the same way (WashSaleService
    // adjustedBases), an open lot's basis per share is its basis over its shares in both orders.
    // It can still differ where a sale dated after the split, which leaves it as it is, was
    // recorded before the backfill: date order's figure is then the basis over the shares before
    // that sale, the backfill's the basis over the shares after it. That sale took its basis to
    // the cent, so the two differ by at most 0.0001 plus half a cent over the shares left, rounded
    // up to the 0.0001 (1 + ceil(50 / shares) ten-thousandths: 0.0002 from 50 shares up); no money
    // figure reads it, a sale taking the lot's basis, not shares times it.
    const closed = adjustedThrough != null
      ? await closedOnSaleDay(securityId, input.eventDate, event.id, lots, lotsAfter)
      : { lots: new Map<number, ClosedLotFigures>(), replacementShares: new Map<number, bigint>() };
    for (const [lotId, after] of lotsAfter) {
      const onSaleDay = closed.lots.get(lotId);
      const perShare = onSaleDay?.costBasisPerShare
        ?? (adjustedThrough != null && after.sharesRemaining > 0n ? perShareOf(after.totalCostBasis, after.sharesRemaining) : after.costBasisPerShare);
      await getDb()
        .updateTable('tax_lots')
        .set({
          shares_remaining: shareText(after.sharesRemaining),
          total_cost_basis: centsText(after.totalCostBasis),
          cost_basis_per_share: perShareText(perShare),
          is_open: after.sharesRemaining > 0n,
          ...(onSaleDay ? { shares_original: shareText(onSaleDay.sharesOriginal) } : {}),
        })
        .where('id', '=', lotId)
        .execute();
    }
    for (const [recordId, shares] of closed.replacementShares) {
      await getDb().updateTable('wash_sale_records').set({ replacement_shares: shareText(shares) }).where('id', '=', recordId).execute();
    }

    // Wash-sale detection runs on any realized loss, in the same txn.
    const washSale = hasLoss ? await new WashSaleService().detectForSellEvent(event.id) : NO_WASH_SALE();

    // Ids, not amounts, in the log.
    logger.info({ accountId, securityId, eventUuid: event.uuid, washFlagged: washSale.flagged }, 'Recorded sell');
    return { event_uuid: event.uuid, method, plan: sellPlanAmounts(plan), wash_sale: washSale };
  }

  async recordDividend(input: {
    accountUuid: string;
    securityUuid: string;
    eventDate: string;
    totalAmount: DecimalValue;
    amountPerShare?: DecimalValue | null;
    exDate?: string | null;
    recordDate?: string | null;
    payDate?: string | null;
    isQualified?: boolean;
    reinvest?: boolean;
    pricePerShare?: DecimalValue | null;
    reinvestIntoSecurityUuid?: string | null;
    source?: string;
    externalReference?: string | null;
    /** A reinvestment's price is already adjusted for the splits recorded after it (assertNoCorporateActionAfter). */
    adjustedForSplits?: boolean | undefined;
    userId?: number;
    dryRun?: boolean;
  }) {
    const totalAmount = requestCents(input.totalAmount, 'total_amount');
    const amountPerShare = input.amountPerShare != null ? requestUnits(input.amountPerShare, 'amount_per_share', PER_SHARE) : null;
    const pricePerShare = input.pricePerShare != null ? requestUnits(input.pricePerShare, 'price_per_share', PER_SHARE) : null;
    const accountId = await this.accountIdByUuid(input.accountUuid);
    const securityId = await this.securityIdByUuid(input.securityUuid);
    // Cross-security reinvestment: the reinvest lot is opened in this target
    // instead of the dividend payer (defaults to the payer when not given).
    const reinvestSecurityId = input.reinvestIntoSecurityUuid
      ? await this.securityIdByUuid(input.reinvestIntoSecurityUuid)
      : securityId;

    // DRIP is enabled either explicitly or by the (account, security) setting.
    let reinvest = input.reinvest ?? false;
    if (!reinvest) {
      const setting = await getDb()
        .selectFrom('cost_basis_method_settings')
        .select('drip_enabled')
        .where('account_id', '=', accountId)
        .where('security_id', '=', securityId)
        .executeTakeFirst();
      reinvest = setting?.drip_enabled ?? false;
    }

    // The reinvested lot, worked out and checked against its columns before anything is
    // written: each figure is rounded to its column, so one can exceed what the column holds
    // though the inputs fit (100.00 at 99,999,999.9999 a share buys 0.000001 shares, whose
    // basis per share is 100,000,000), which Postgres refused with an error (a 500). A dry run
    // makes the same checks, so it answers 400 where the real call would.
    let reinvestLot: { shares: bigint; totalCostBasis: bigint; costBasisPerShare: bigint } | undefined;
    let adjustedThrough: number | null = null;
    if (reinvest) {
      const price = pricePerShare;
      if (price == null || price <= 0n) throw invalidRequestError('error: dividend_reinvest requires a positive price_per_share');
      // The shares the dividend buys at that price, to the millionth: cents × 10^8 / price
      // is total ÷ price at the share scale.
      const shares = divRound(totalAmount * pow10(SHARES.scale + PER_SHARE.scale - CENTS.scale), price);
      const { totalCostBasis, costBasisPerShare } = buildBuyLotBasis(shares, price, 0n);
      assertFits(shares, SHARES, 'The reinvested shares');
      assertFits(totalCostBasis, CENTS, "The reinvested lot's cost basis");
      assertFits(costBasisPerShare, PER_SHARE, "The reinvested lot's cost basis per share");
      reinvestLot = { shares, totalCostBasis, costBasisPerShare };
      // A reinvested dividend opens a lot, so it takes the locks a buy does before it writes
      // (the payer's, whose event holds the reference, and the lot's), in id order, as a batch
      // import takes them.
      for (const id of [...new Set([securityId, reinvestSecurityId])].sort((x, y) => x - y)) await lockSecurityLots(id);
      // Its lot, like a buy's.
      adjustedThrough = await assertNoCorporateActionAfter(reinvestSecurityId, input.payDate ?? input.eventDate, 'a reinvested dividend', input.adjustedForSplits);
    }
    await assertReferenceFree(accountId, securityId, input.externalReference);

    if (input.dryRun) {
      // A reinvested lot's wash-sale adjustment, as the real call answers it.
      const washSale = reinvestLot
        ? await new WashSaleService().previewForNewLot({
          securityId: reinvestSecurityId,
          acquisitionDate: input.payDate ?? input.eventDate,
          sharesRemaining: reinvestLot.shares,
          costBasisPerShare: reinvestLot.costBasisPerShare,
          totalCostBasis: reinvestLot.totalCostBasis,
        })
        : undefined;
      return { dry_run: true, reinvest, total_amount: unitsToNumber(totalAmount, CENTS.scale), wash_sale: washSale };
    }

    const event = await insertHoldingEvent({
      account_id: accountId,
      security_id: securityId,
      user_id: input.userId ?? null,
      event_type: reinvest ? 'dividend_reinvest' : 'dividend',
      event_date: input.eventDate,
      total_amount: centsText(totalAmount),
      source: input.source ?? 'manual',
      external_reference: input.externalReference ?? null,
      // The reinvested lot's security's splits its price was adjusted for; a cash dividend has no shares.
      adjusted_through_action_id: adjustedThrough,
      // Link the payout to the security it was reinvested into (audit trail).
      ...(input.reinvestIntoSecurityUuid
        ? { metadata: sql`${JSON.stringify({ reinvested_into_security_uuid: input.reinvestIntoSecurityUuid })}::jsonb` }
        : {}),
    });

    await getDb()
      .insertInto('dividend_records')
      .values({
        account_id: accountId,
        security_id: securityId,
        event_id: event.id,
        ex_date: input.exDate ?? null,
        record_date: input.recordDate ?? null,
        pay_date: input.payDate ?? input.eventDate,
        amount_per_share: amountPerShare != null ? perShareText(amountPerShare) : null,
        total_amount: centsText(totalAmount),
        is_qualified: input.isQualified ?? true,
        is_reinvested: reinvest,
      })
      .execute();

    let lotUuid: string | undefined;
    let washSale: WashSaleOutcome | undefined;
    if (reinvestLot) {
      const { shares, totalCostBasis, costBasisPerShare } = reinvestLot;
      const lot = await getDb()
        .insertInto('tax_lots')
        .values({
          account_id: accountId,
          security_id: reinvestSecurityId,
          created_by_event_id: event.id,
          acquisition_date: input.payDate ?? input.eventDate,
          holding_period_start: input.payDate ?? input.eventDate,
          shares_original: shareText(shares),
          shares_remaining: shareText(shares),
          cost_basis_per_share: perShareText(costBasisPerShare),
          total_cost_basis: centsText(totalCostBasis),
          acquisition_method: 'dividend_reinvest',
          // Reinvested before 2012 is noncovered, as a buy then is.
          is_covered: coveredByDate(input.payDate ?? input.eventDate),
        })
        .returning(['id', 'uuid'])
        .executeTakeFirstOrThrow();
      lotUuid = lot.uuid;
      // Reinvested shares replace sold ones like a buy, for their share count.
      washSale = await new WashSaleService().detectForNewLot(lot.id);
    }

    return { event_uuid: event.uuid, reinvest, lot_uuid: lotUuid, reinvested_into_security_uuid: input.reinvestIntoSecurityUuid ?? null, wash_sale: washSale };
  }

  async setCostBasisMethod(input: {
    accountUuid: string;
    securityUuid?: string | null;
    method: CostBasisMethod;
    dripEnabled?: boolean;
  }) {
    const accountId = await this.accountIdByUuid(input.accountUuid);
    const securityId = input.securityUuid ? await this.securityIdByUuid(input.securityUuid) : null;
    const row = await getDb()
      .insertInto('cost_basis_method_settings')
      .values({
        account_id: accountId,
        security_id: securityId,
        method: input.method,
        drip_enabled: input.dripEnabled ?? false,
      })
      .onConflict((oc) =>
        oc.columns(['account_id', 'security_id']).doUpdateSet({
          method: input.method,
          drip_enabled: input.dripEnabled ?? false,
        })
      )
      .returning('uuid')
      .executeTakeFirstOrThrow();
    return { uuid: row.uuid };
  }

  // --------------------------------------------------------------------- reads
  /**
   * Current holdings (compute-on-read) across one or all accounts. A holding's cost basis is
   * its lots' remaining basis (total_cost_basis, what their sales take, pro rata), not their
   * shares × their 4-place basis per share, which a partial sale can leave cents off it; a lot
   * with no shares (a reverse split rounded one to none before v2.1.0) adds none, as before.
   */
  async getHoldings(accountUuid?: string) {
    const accountId = accountUuid ? await this.accountIdByUuid(accountUuid) : null;
    const rows = await sql<{
      security_id: number;
      security_uuid: string;
      ticker: string;
      name: string;
      account_id: number;
      total_shares: string;
      total_cost_basis: string;
      latest_price: string | null;
    }>`
      SELECT tl.security_id,
             s.uuid AS security_uuid,
             s.ticker,
             s.name,
             tl.account_id,
             SUM(tl.shares_remaining) AS total_shares,
             COALESCE(SUM(tl.total_cost_basis) FILTER (WHERE tl.shares_remaining > 0), 0) AS total_cost_basis,
             lp.close AS latest_price
      FROM tax_lots tl
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN LATERAL (
        SELECT close FROM security_prices sp
        WHERE sp.security_id = tl.security_id
        ORDER BY sp.price_date DESC LIMIT 1
      ) lp ON true
      WHERE tl.is_open = true
        ${accountId != null ? sql`AND tl.account_id = ${accountId}` : sql``}
      GROUP BY tl.security_id, s.uuid, s.ticker, s.name, tl.account_id, lp.close
      ORDER BY s.ticker
    `.execute(getDb());

    // Exact: the shares and price are units, the basis the lots' cents summed, and each
    // money figure is rounded to cents once (a double's half-cent error rounded $1,024.215 down).
    return rows.rows.map((r) => {
      const totalShares = numericUnits(r.total_shares, SHARES.scale);
      const totalCostBasis = numericUnits(r.total_cost_basis, CENTS.scale);
      const latestPrice = r.latest_price != null ? numericUnits(r.latest_price, PER_SHARE.scale) : null;
      const marketValue = latestPrice != null ? shareValueCents(totalShares, latestPrice) : null;
      return {
        security_id: r.security_id,
        security_uuid: r.security_uuid,
        ticker: r.ticker,
        name: r.name,
        account_id: r.account_id,
        total_shares: unitsToNumber(totalShares, SHARES.scale),
        total_cost_basis: centsNumber(totalCostBasis),
        // In cents a share: the basis ÷ the shares, rounded once.
        average_cost_per_share: totalShares > 0n ? centsNumber(divRound(totalCostBasis * pow10(SHARES.scale), totalShares)) : null,
        latest_price: latestPrice != null ? unitsToNumber(latestPrice, PER_SHARE.scale) : null,
        market_value: marketValue != null ? centsNumber(marketValue) : null,
        unrealized_gain_loss: marketValue != null ? centsNumber(marketValue - totalCostBasis) : null,
      };
    });
  }

  /**
   * A security's tax lots, open and closed, oldest first (one account's, when `accountUuid`
   * is given). An unknown security or account matches none: an empty list.
   */
  async getLots(securityUuid: string, accountUuid?: string) {
    const rows = await sql`
      SELECT tl.* FROM tax_lots tl
      JOIN securities s ON s.id = tl.security_id
      ${accountUuid ? sql`JOIN accounts a ON a.id = tl.account_id AND a.uuid = ${accountUuid}` : sql``}
      WHERE s.uuid = ${securityUuid}
      ORDER BY tl.acquisition_date ASC, tl.id ASC
    `.execute(getDb());
    return rows.rows;
  }

  /**
   * One page of the holding-events ledger (every event type), newest first, filtered by
   * account, security, event type ('all' for every one) and a range of days, with the count
   * of all that match.
   */
  async listEvents(input: {
    page: number; limit: number; offset: number;
    accountUuid?: string | undefined; securityUuid?: string | undefined; eventType?: string | undefined;
    startDate?: string | undefined; endDate?: string | undefined;
  }) {
    const { page, limit, offset } = input;
    const accountFilter = input.accountUuid ? sql` AND a.uuid = ${input.accountUuid}` : sql``;
    const securityFilter = input.securityUuid ? sql` AND s.uuid = ${input.securityUuid}` : sql``;
    const typeFilter = input.eventType && input.eventType !== 'all' ? sql` AND he.event_type = ${input.eventType}` : sql``;
    const startFilter = input.startDate ? sql` AND he.event_date >= ${input.startDate}` : sql``;
    const endFilter = input.endDate ? sql` AND he.event_date <= ${input.endDate}` : sql``;
    const where = sql`WHERE 1=1${accountFilter}${securityFilter}${typeFilter}${startFilter}${endFilter}`;

    const countRes = await sql<{ total: string }>`
      SELECT COUNT(*) AS total
      FROM holding_events he
      JOIN accounts a ON a.id = he.account_id
      LEFT JOIN securities s ON s.id = he.security_id
      ${where}
    `.execute(getDb());
    const total = parseInt(countRes.rows[0]?.total ?? '0');

    const rows = await sql`
      SELECT he.uuid, he.event_type, he.event_date, he.shares, he.price_per_share, he.total_amount,
             he.fees, he.fee_type, he.source, he.description,
             (he.adjusted_through_action_id IS NOT NULL) AS adjusted_for_splits,
             s.ticker, s.uuid AS security_uuid, a.name AS account_name, a.uuid AS account_uuid
      FROM holding_events he
      JOIN accounts a ON a.id = he.account_id
      LEFT JOIN securities s ON s.id = he.security_id
      ${where}
      ORDER BY he.event_date DESC, he.id DESC
      OFFSET ${offset} LIMIT ${limit}
    `.execute(getDb());

    return { data: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /** Realized gain/loss across a date range (from lot_consumptions). */
  async getRealizedGainLoss(opts: { startDate?: string; endDate?: string; accountUuid?: string } = {}) {
    const accountId = opts.accountUuid ? await this.accountIdByUuid(opts.accountUuid) : null;
    const rows = await sql<{
      security_id: number;
      ticker: string;
      sell_date: string;
      shares_consumed: string;
      basis_consumed: string;
      proceeds: string;
      realized_gain_loss: string;
      is_long_term: boolean;
      is_wash_sale: boolean;
    }>`
      SELECT he.security_id,
             s.ticker,
             he.event_date AS sell_date,
             lc.shares_consumed,
             lc.basis_consumed,
             lc.proceeds,
             lc.realized_gain_loss,
             lc.is_long_term,
             lc.is_wash_sale
      FROM lot_consumptions lc
      JOIN holding_events he ON he.id = lc.sell_event_id
      JOIN securities s ON s.id = he.security_id
      WHERE 1=1
        ${accountId != null ? sql`AND he.account_id = ${accountId}` : sql``}
        ${opts.startDate ? sql`AND he.event_date >= ${opts.startDate}` : sql``}
        ${opts.endDate ? sql`AND he.event_date <= ${opts.endDate}` : sql``}
      ORDER BY he.event_date DESC
    `.execute(getDb());
    return rows.rows.map((r) => ({
      security_id: r.security_id,
      ticker: r.ticker,
      sell_date: r.sell_date,
      shares_consumed: Number(r.shares_consumed),
      basis_consumed: Number(r.basis_consumed),
      proceeds: Number(r.proceeds),
      realized_gain_loss: Number(r.realized_gain_loss),
      is_long_term: r.is_long_term,
      is_wash_sale: r.is_wash_sale,
    }));
  }

  /**
   * Bulk historical lot import (the multi-year backfill). Each row
   * creates a historical_import event + a tax_lot atomically (the whole call is
   * in the request transaction, so any error rolls back all). Rows whose
   * external_reference already exists are skipped (idempotent re-import); one another kind of
   * event of the account and security has (a sale, a dividend) is a 409.
   *
   * The wash-sale locks of every security it writes are taken in id order before its first
   * insert: taken per lot as the rows came, two imports of lots in the same two
   * securities in opposite orders each held one and waited for the other (a deadlock, a 500).
   * A dry run previews each lot's wash-sale adjustment in row order, as the writes make them,
   * and refuses what the real call refuses. Each created row answers its lot's `wash_sale`, the
   * dry run's what it would be.
   */
  async batchImportLots(input: {
    lots: Array<{
      account_uuid: string; security_uuid: string; acquisition_date: string; shares: DecimalValue;
      total_cost_basis: DecimalValue; acquisition_method?: AcquisitionMethod; data_quality?: DataQuality;
      holding_period_start?: string; external_reference?: string | null; is_covered?: boolean; metadata?: unknown;
      /** Its shares and basis are already adjusted for the splits recorded after it (assertNoCorporateActionAfter). */
      adjusted_for_splits?: boolean | undefined;
    }>;
    userId?: number;
    dryRun?: boolean;
  }) {
    const acctCache = new Map<string, number>();
    const secCache = new Map<string, number>();
    const resolveAcct = async (u: string) => {
      if (!acctCache.has(u)) acctCache.set(u, await this.accountIdByUuid(u));
      return acctCache.get(u)!;
    };
    const resolveSec = async (u: string) => {
      if (!secCache.has(u)) secCache.set(u, await this.securityIdByUuid(u));
      return secCache.get(u)!;
    };

    // Every row's figures are read, exactly, before anything is written.
    const figures = input.lots.map((row, i) => {
      const shares = requestUnits(row.shares, `lots[${i}].shares`, SHARES);
      if (shares <= 0n) throw invalidRequestError(`lots[${i}].shares must be greater than zero`);
      const totalCostBasis = requestCents(row.total_cost_basis, `lots[${i}].total_cost_basis`);
      const costBasisPerShare = perShareOf(totalCostBasis, shares);
      assertFits(costBasisPerShare, PER_SHARE, `lots[${i}]'s cost basis per share`);
      return { row, shares, totalCostBasis, costBasisPerShare };
    });

    // Each row's account and security, before anything is written (an unknown one is a 404).
    const planned: Array<(typeof figures)[number] & { accountId: number; securityId: number }> = [];
    for (const lot of figures) planned.push({ ...lot, accountId: await resolveAcct(lot.row.account_uuid), securityId: await resolveSec(lot.row.security_uuid) });
    // Every security's wash-sale lock, in id order, before the first insert.
    if (!input.dryRun) {
      for (const securityId of [...new Set(planned.map((r) => r.securityId))].sort((a, b) => a - b)) await lockSecurityLots(securityId);
    }

    const results: Array<{ index: number; status: 'created' | 'skipped'; lot_uuid?: string; reason?: string; wash_sale?: WashSaleOutcome }> = [];
    // A dry run previews each lot's wash-sale adjustment in row order, as the writes make them,
    // and skips a row whose reference an earlier row would write.
    const preview = input.dryRun ? new WashSaleService().newLotsPreview() : null;
    const previewReferences = new Set<string>();
    for (const [i, { row, shares, totalCostBasis, costBasisPerShare, accountId, securityId }] of planned.entries()) {

      if (row.external_reference) {
        const dup = await getDb().selectFrom('tax_lots').select('uuid')
          .where('account_id', '=', accountId).where('security_id', '=', securityId)
          .where('external_reference', '=', row.external_reference).executeTakeFirst();
        if (dup) { results.push({ index: i, status: 'skipped', reason: 'duplicate external_reference', lot_uuid: dup.uuid }); continue; }
        const key = JSON.stringify([accountId, securityId, row.external_reference]);
        if (input.dryRun && previewReferences.has(key)) { results.push({ index: i, status: 'skipped', reason: 'duplicate external_reference' }); continue; }
        previewReferences.add(key);
        await assertReferenceFree(accountId, securityId, row.external_reference);
      }
      // A lot acquired before a recorded split, as a buy: the whole import is refused,
      // unless the row's shares are the split's already.
      const adjustedThrough = await assertNoCorporateActionAfter(securityId, row.acquisition_date, `an imported lot (lots[${i}])`, row.adjusted_for_splits);
      if (preview) {
        const washSale = await preview({ securityId, acquisitionDate: row.acquisition_date, sharesRemaining: shares, costBasisPerShare, totalCostBasis });
        results.push({ index: i, status: 'created', wash_sale: washSale });
        continue;
      }

      const event = await insertHoldingEvent({
        account_id: accountId, security_id: securityId, user_id: input.userId ?? null,
        event_type: 'historical_import', event_date: row.acquisition_date, shares: shareText(shares),
        total_amount: centsText(totalCostBasis), source: 'historical_import', external_reference: row.external_reference ?? null,
        metadata: sql`${JSON.stringify(row.metadata ?? { imported: true })}::jsonb`,
        adjusted_through_action_id: adjustedThrough,
      });

      const lot = await getDb().insertInto('tax_lots').values({
        account_id: accountId, security_id: securityId, created_by_event_id: event.id,
        acquisition_date: row.acquisition_date, holding_period_start: row.holding_period_start ?? row.acquisition_date,
        shares_original: shareText(shares), shares_remaining: shareText(shares),
        cost_basis_per_share: perShareText(costBasisPerShare), total_cost_basis: centsText(totalCostBasis),
        acquisition_method: row.acquisition_method ?? 'purchase',
        data_quality: row.data_quality ?? 'complete',
        // Not given: by its date, as a buy's is (coveredByDate).
        is_covered: row.is_covered ?? coveredByDate(row.acquisition_date),
        external_reference: row.external_reference ?? null,
        metadata: sql`${JSON.stringify(row.metadata ?? {})}::jsonb`,
      }).returning(['id', 'uuid']).executeTakeFirstOrThrow();
      // An imported lot acquired within 30 days of a recorded loss sale replaces it.
      const washSale = await new WashSaleService().detectForNewLot(lot.id);
      results.push({ index: i, status: 'created', lot_uuid: lot.uuid, wash_sale: washSale });
    }
    const created = results.filter((r) => r.status === 'created').length;
    logger.info({ total: results.length, created }, 'Batch imported lots');
    return { dry_run: input.dryRun ?? false, total: results.length, created, skipped: results.length - created, results };
  }

  /** Dividend income history grouped by security with qualified split. */
  async getDividendHistory(opts: { startDate?: string; endDate?: string; accountUuid?: string } = {}) {
    const accountId = opts.accountUuid ? await this.accountIdByUuid(opts.accountUuid) : null;
    const rows = await sql<{ ticker: string; pay_date: string; total_amount: string; is_qualified: boolean; is_reinvested: boolean }>`
      SELECT s.ticker, dr.pay_date, dr.total_amount, dr.is_qualified, dr.is_reinvested
      FROM dividend_records dr JOIN securities s ON s.id = dr.security_id
      WHERE 1=1
        ${accountId != null ? sql`AND dr.account_id = ${accountId}` : sql``}
        ${opts.startDate ? sql`AND dr.pay_date >= ${opts.startDate}` : sql``}
        ${opts.endDate ? sql`AND dr.pay_date <= ${opts.endDate}` : sql``}
      ORDER BY dr.pay_date DESC
    `.execute(getDb());
    const records = rows.rows.map((r) => ({ ticker: r.ticker, pay_date: r.pay_date, total_amount: Number(r.total_amount), is_qualified: r.is_qualified, is_reinvested: r.is_reinvested }));
    // Summed in cents.
    const sumCents = (rs: typeof rows.rows) => rs.reduce((s, r) => s + numericUnits(r.total_amount, CENTS.scale), 0n);
    const total = sumCents(rows.rows);
    const qualified = sumCents(rows.rows.filter((r) => r.is_qualified));
    return { records, total: centsNumber(total), qualified: centsNumber(qualified), ordinary: centsNumber(total - qualified) };
  }
}
