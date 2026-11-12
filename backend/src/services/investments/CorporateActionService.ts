import { sql } from 'kysely';
import { ADJUSTED_FOR_SPLITS_LABELS } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { applySplit, applyReturnOfCapital, applySpinoff, mergerCashDisposal, mergerStockConversion, type SplitLot } from './corporateActions.js';
import { ControlPlaneError, notFoundError } from '../controlPlaneErrors.js';
import {
  CENTS, FRACTION, PER_SHARE, SHARES, assertFits, centsNumber, divRound, numericUnits, requestUnits, unitsToNumber, unitsToText,
  type DecimalValue,
} from '../../utils/decimal.js';
import { corporateActionType, holdingEventType } from '@nuggets/shared';

// Exact figures: see corporateActions.ts for the units. A request's ratio or amount
// is read as sent; a result is written as exact text and answered as a number.
const shareText = (units: bigint) => unitsToText(units, SHARES.scale);
const perShareText = (units: bigint) => unitsToText(units, PER_SHARE.scale);
const centsText = (cents: bigint) => unitsToText(cents, CENTS.scale);
const shareNumber = (units: bigint) => unitsToNumber(units, SHARES.scale);
const perShareNumber = (units: bigint) => unitsToNumber(units, PER_SHARE.scale);
// An answer's dollars: a number while a double holds it exactly, exact text past that (centsNumber).
const dollars = (cents: bigint) => centsNumber(cents);

const logger = createLogger({ service: 'CorporateActionService' });

/**
 * Refuses (409 EVENT_BEFORE_RECORDED_CORPORATE_ACTION) a buy, sale, reinvested dividend or
 * imported lot of `securityId` dated `eventDate` when a corporate action of the security recorded
 * already would have changed it (a sale of 150 shares dated before a recorded 2:1
 * split went through with only 100 pre-split shares held, and a buy dated before it stayed
 * unscaled). A split, return of capital or spinoff changes the lots acquired before its date, so
 * one dated after the event; a merger converts or sells those held on its date, so one on the
 * event's day too. The lot the event opens, or the lots it sells (held on its date), were held
 * then, and the action was applied without them. Events are recorded in date order, before the
 * corporate actions that follow them. Take the security's lot lock (lockSecurityLots) first: a
 * corporate action holds the security's row while it applies.
 *
 * `adjustedForSplits`: the event's shares and
 * prices are already adjusted for the splits and reverse splits recorded after it, as a broker's
 * history gives them. Those splits don't refuse it; it is recorded as given, and they aren't
 * applied to it again (they were applied once, to the lots of their day). Answers the id of the
 * last of them, which the event stores (holding_events.adjusted_through_action_id): its figures
 * are in the shares after every split of the security dated after it with an id up to that one,
 * as an open lot's are, and a split recorded later applies to its lot as to any other. Null when
 * none follows it: it is an event like any other. A return of capital, spinoff or merger after it
 * still refuses it: those change a lot's basis or close it, which adjusted shares and prices don't
 * say (a return of capital's gain beyond the basis, a spinoff's lot of the new security).
 */
export async function assertNoCorporateActionAfter(securityId: number, eventDate: string, event: string, adjustedForSplits = false): Promise<number | null> {
  const later = await getDb()
    .selectFrom('security_corporate_actions')
    .select(['id', 'action_type', 'action_date'])
    .where('security_id', '=', securityId)
    .where((eb) => eb.or([
      eb('action_date', '>', eventDate),
      eb.and([eb('action_date', '=', eventDate), eb('action_type', 'in', [corporateActionType.enum.merger_stock, corporateActionType.enum.merger_cash])]),
    ]))
    .orderBy('action_date', 'desc').orderBy('id', 'desc')
    .execute();
  const refusing = adjustedForSplits ? later.find((a) => !SPLIT_ACTIONS.includes(a.action_type)) : later[0];
  if (refusing) {
    const splitsOnly = later.every((a) => SPLIT_ACTIONS.includes(a.action_type));
    throw new ControlPlaneError(
      409,
      'EVENT_BEFORE_RECORDED_CORPORATE_ACTION',
      `A ${refusing.action_type.replace(/_/g, ' ')} of this security on ${refusing.action_date} is already recorded, and it was applied without ${event} dated ${eventDate}. ` +
        (splitsOnly
          ? `Record events in date order, before the corporate actions that follow them. ${sayAdjusted(event)}`
          : adjustedForSplits
            ? 'Shares and prices adjusted for later splits skip only the splits and reverse splits after it: record events in date order, before the other corporate actions that follow them.'
            : 'Record events in date order, before the corporate actions that follow them.'),
      { action_type: refusing.action_type, action_date: refusing.action_date }
    );
  }
  return later.length > 0 ? Math.max(...later.map((a) => a.id)) : null;
}

/**
 * How a person says an event's figures are already adjusted for the splits after it, in the words
 * of the form they record it on (the refusal named the API's field, and the form
 * shows the API's message): the event forms' switches, or, for an imported lot (the agent's
 * tool), the lot's own flag.
 */
function sayAdjusted(event: string): string {
  if (event.startsWith('a reinvested dividend')) {
    return `If its reinvestment price is already adjusted for the splits after it, as a broker's history shows it, record it with “${ADJUSTED_FOR_SPLITS_LABELS.reinvestment}” turned on.`;
  }
  if (event.startsWith('an imported lot')) {
    return 'If the lot\'s shares and basis are already adjusted for the splits after it, as a broker\'s history shows them, mark the lot as adjusted for later splits.';
  }
  return `If its shares and price are already adjusted for the splits after it, as a broker's history shows them, record it with “${ADJUSTED_FOR_SPLITS_LABELS.trade}” turned on.`;
}

/**
 * What a split's per-account event keeps of the lots it changed and their wash records, as they
 * were before it, in their columns' exact text: holding_events.metadata.before, beside the
 * ratio. Read back by HoldingsService closedOnSaleDay.
 */
export interface SplitBefore {
  lots: Array<{ id: number; shares_original: string; shares_remaining: string; cost_basis_per_share: string; total_cost_basis: string }>;
  wash: Array<{ id: number; lot_id: number; replacement_shares: string }>;
}

/** The corporate actions that change a lot's shares and per-share figures, and nothing else. */
export const SPLIT_ACTIONS: readonly string[] = [corporateActionType.enum.split, corporateActionType.enum.reverse_split];

/**
 * Applies corporate actions to the open lots of a security across all accounts.
 * Pure transforms live in corporateActions.ts; this class persists the
 * action catalog row, the per-account holding_events, and the lot updates.
 *
 * Date-aware: a split, return of capital or spinoff applies only to
 * lots acquired before its date (shares bought on or after the ex-date are already
 * post-action shares). A cash or stock merger disposes of the lots held on its date, those
 * acquired on or before it, as a sale does: one dated after it (recorded late, or by mistake)
 * isn't converted or sold with a negative holding period. An action is refused (409) when a sale on or after its date
 * already consumed one of the lots it would change: that sale's shares and basis
 * were figured without it, and redoing them would take replaying the event stream. A spinoff
 * or stock merger is refused, too, when the security it adds lots to has later events those
 * lots would have changed, and a buy, sale, reinvested dividend or imported lot dated before a
 * recorded action that would have changed it is refused (assertNoCorporateActionAfter).
 * Recording the same action again (a retried request) is refused too, under a lock
 * on the security's row so two at once can't both apply it.
 *
 * A lot's total_cost_basis is its remaining basis: what a sale consumes (pro rata,
 * costBasis.ts) and what an action here moves, reduces or disposes of. Its
 * cost_basis_per_share is that over its shares, to 4 places, which shares × can miss.
 *
 * Every figure an action writes is worked out in units and checked against its column
 * (assertFits) before the first write, then written as exact text: one too large
 * for its column is a 400 that writes nothing, where Postgres refused it with an error
 * (a 500). A lot's shares × its basis per share (rounded to 4 places) can be more than
 * its total basis, and more than a total basis can hold.
 */
export class CorporateActionService {
  /** The security's id, its row locked until the transaction ends (serializes its actions). */
  private async lockSecurity(uuid: string): Promise<number> {
    const row = await getDb().selectFrom('securities').select('id').where('uuid', '=', uuid).forUpdate().executeTakeFirst();
    if (!row) throw notFoundError('security');
    return row.id;
  }

  /**
   * The ids of the two securities an action moves lots between (a spinoff's source and new
   * security, a stock merger's security and acquirer), both rows locked until the transaction
   * ends, in id order. The action locked the first and then wrote lots of the second, whose
   * foreign key locks it: against a delete of both (which locks in id order) with the
   * second the lower, each waited for the other's row.
   */
  private async lockSecurityPair(firstUuid: string, secondUuid: string): Promise<[number, number]> {
    const rows = await getDb()
      .selectFrom('securities')
      .select(['id', 'uuid'])
      .where('uuid', 'in', [firstUuid, secondUuid])
      .orderBy('id')
      .forUpdate()
      .execute();
    const idOf = (uuid: string) => rows.find((r) => r.uuid === uuid.toLowerCase())?.id;
    const [first, second] = [idOf(firstUuid), idOf(secondUuid)];
    if (first === undefined || second === undefined) throw notFoundError('security');
    return [first, second];
  }

  /** Refuses an action already in the catalog for this security, type and day (a retry). */
  private async assertNotRecorded(securityId: number, actionTypes: readonly string[], actionDate: string) {
    const existing = await getDb()
      .selectFrom('security_corporate_actions')
      .select('action_type')
      .where('security_id', '=', securityId)
      .where('action_type', 'in', actionTypes)
      .where('action_date', '=', actionDate)
      .executeTakeFirst();
    if (existing) {
      throw new ControlPlaneError(409, 'CORPORATE_ACTION_ALREADY_RECORDED', `A ${existing.action_type.replace(/_/g, ' ')} of this security on ${actionDate} is already recorded.`);
    }
  }

  /**
   * Refuses (409 CORPORATE_ACTION_BEFORE_RECORDED_SALES) an action on `securityId` dated on or
   * before a recorded sale whose figures were worked out on a lot the action changes, as it was
   * before the action. The lots it changes are those `held` on its date: acquired before it (a
   * split, return of capital or spinoff: one bought on its day already has the new shares), or on
   * or before it (a merger). `lotIds` are those still open.
   *
   * - a sale (or cash merger), by any method, that took shares from a lot the action changes: the
   *   lot is closed now when that sale took its last shares, so `lotIds` doesn't name it
   *   (a 2:1 split dated before a FIFO sale that closed the first lot doubled only the open
   *   one, and a spinoff before it never took the sold lot's basis). A sale of a lot bought on a
   *   split's day isn't one (it was refused);
   * - an average-cost sale (one with no recorded method counts as one, as LotService.setCovered
   *   counts it) that re-based one of `lotIds`: costBasis.ts planSell spreads what is left
   *   of each pool it sold from over every lot of that pool held on its date, those it took no
   *   shares from too. So the lot counts when the sale took shares from a lot of its pool (its
   *   covered flag: a flag can't be corrected once such a sale pooled it) in its account and
   *   security, it was acquired on or before the sale's date, and it was there when the sale was
   *   recorded (its event before the sale's: a lot entered later wasn't in the pool). A lot open
   *   now was open then.
   *
   * And the other recorded events that close, move or re-base the security's lots, dated after it:
   * a split dated before a recorded stock merger changed nothing, the merger having
   * closed the lots it should have changed, and a return of capital before a recorded split or
   * spinoff was figured on shares or basis the later action had changed already:
   *
   * - a corporate action of the security dated after it (its split, return of capital, spinoff,
   *   merger), or a merger on its own day (which converted or sold the lots held that day), when
   *   the action changes a lot: one of `lotIds`, or one a later stock merger closed (the lot its
   *   shares became names it as its parent). An action that changes no lot (a 2015 split of a
   *   security first bought in 2022) isn't refused for a 2022 one. Other actions on
   *   one day are applied in the order they're recorded;
   * - a wash-sale adjustment of one of `lotIds` from a loss sold on or after its day: it was
   *   matched share for share with the lot's shares as they were before the action, and added to
   *   its basis then.
   *
   * Actions must be recorded in date order, before the sales that follow them.
   */
  private async assertNoLaterSales(securityId: number, lotIds: number[], actionDate: string, held: 'before' | 'onOrBefore') {
    const changes = (lot: string) =>
      held === 'before'
        ? sql`${sql.ref(`${lot}.acquisition_date`)} < ${actionDate}::date`
        : sql`${sql.ref(`${lot}.acquisition_date`)} <= ${actionDate}::date`;
    const { rows } = await sql<{ last_sale: string | null }>`
      SELECT max(later.day) AS last_sale
        FROM (
      SELECT he.event_date AS day
        FROM holding_events he
       WHERE he.event_date >= ${actionDate}::date
         AND (EXISTS (SELECT 1
                        FROM lot_consumptions lc
                        JOIN tax_lots held ON held.id = lc.tax_lot_id
                       WHERE lc.sell_event_id = he.id
                         AND held.security_id = ${securityId}
                         AND ${changes('held')})
              OR (he.event_type = 'sell'
                  AND COALESCE(he.metadata->>'method', 'average_cost') = 'average_cost'
                  AND EXISTS (
                    SELECT 1
                      FROM tax_lots l
                     WHERE l.id = ANY(${lotIds}::int[])
                       AND l.account_id = he.account_id
                       AND l.security_id = he.security_id
                       AND l.acquisition_date <= he.event_date
                       AND l.created_by_event_id < he.id
                       AND EXISTS (SELECT 1
                                     FROM lot_consumptions lc
                                     JOIN tax_lots sold ON sold.id = lc.tax_lot_id
                                    WHERE lc.sell_event_id = he.id AND sold.is_covered = l.is_covered))))
      UNION ALL
      SELECT sca.action_date
        FROM security_corporate_actions sca
       WHERE sca.security_id = ${securityId}
         AND (sca.action_date > ${actionDate}::date
              OR (sca.action_date = ${actionDate}::date AND sca.action_type IN ('merger_stock', 'merger_cash')))
         AND (cardinality(${lotIds}::int[]) > 0
              OR EXISTS (SELECT 1
                           FROM tax_lots merged
                           JOIN tax_lots became ON became.parent_lot_id = merged.id
                           JOIN holding_events conversion ON conversion.id = became.created_by_event_id
                          WHERE merged.security_id = ${securityId}
                            AND ${changes('merged')}
                            AND conversion.event_type = 'merger_stock'
                            AND conversion.event_date >= ${actionDate}::date))
      UNION ALL
      SELECT sale.event_date
        FROM wash_sale_records w
        JOIN lot_consumptions loss ON loss.id = w.loss_lot_consumption_id
        JOIN holding_events sale ON sale.id = loss.sell_event_id
       WHERE w.replacement_lot_id = ANY(${lotIds}::int[])
         AND sale.event_date >= ${actionDate}::date
        ) later
    `.execute(getDb());
    const later = rows[0];
    if (later?.last_sale) {
      throw new ControlPlaneError(
        409,
        'CORPORATE_ACTION_BEFORE_RECORDED_SALES',
        `Sales or corporate actions of this security on or after ${actionDate} (the last on ${later.last_sale}) are already recorded, and their shares and basis don't reflect this action. Record corporate actions in date order, before the sales that follow them.`
      );
    }
  }

  /**
   * Refuses (409 CORPORATE_ACTION_BEFORE_RECORDED_SALES) a split or reverse split dated
   * `actionDate` across a recorded wash sale match of the security: its loss sold
   * before the date and its replacement lot acquired on or after it, or the other way round. A
   * match counts a loss in the replacement's shares by the splits between them (washSale.ts
   * sharesNow), so one recorded before the split was counted one for one, and the split, applied
   * now, would leave it so: 50 shares bought after a 2:1 split replace 25 sold before it, and the
   * record kept 50 of the loss and all of its $1,000 (in date order, 25 and $500). A match on one
   * side of the date is in one day's shares either way: the split scales the replacement's
   * shares with its lot, or neither. A sale dated on the split's day is in its shares, as a lot
   * acquired that day is. Its other actions don't change shares, and don't enter the match.
   */
  private async assertNoWashMatchAcross(securityId: number, actionDate: string) {
    const { rows } = await sql<{ last: string | null }>`
      SELECT max(GREATEST(sale.event_date, replacement.acquisition_date))::text AS last
        FROM wash_sale_records w
        JOIN tax_lots replacement ON replacement.id = w.replacement_lot_id
        JOIN lot_consumptions loss ON loss.id = w.loss_lot_consumption_id
        JOIN holding_events sale ON sale.id = loss.sell_event_id
       WHERE replacement.security_id = ${securityId}
         AND (sale.event_date < ${actionDate}::date) <> (replacement.acquisition_date < ${actionDate}::date)
    `.execute(getDb());
    const last = rows[0]?.last;
    if (last) {
      throw new ControlPlaneError(
        409,
        'CORPORATE_ACTION_BEFORE_RECORDED_SALES',
        `A wash sale of this security is already recorded across ${actionDate} (its loss and its replacement on either side of it, the later on ${last}), and its shares were matched without this split. Record splits in date order, before the sales and purchases that follow them.`
      );
    }
  }

  /**
   * Refuses (409 CORPORATE_ACTION_BEFORE_RECORDED_SALES) a spinoff or stock merger dated
   * `actionDate` that adds lots of `targetId` (the new security, the acquirer), acquired on its
   * date, to the accounts `added` names (with the covered status of what each adds), when the
   * target's recorded events were worked out without them (only the source was
   * checked, so a merger into an acquirer dated before the acquirer's recorded split added lots
   * the split never doubled):
   *
   * - a corporate action of the target dated after it, or a merger on its day: it changed the
   *   lots held then, which these would have been;
   * - a sale of the target in one of those accounts, on or after its date, whose lots these would
   *   have come before or joined: by FIFO, one that took a lot acquired after its date; by LIFO,
   *   one that took a lot acquired on or before it; by average cost (or no recorded method), one
   *   that sold from the pool (covered or not) one of these would have joined; by HIFO, any (its
   *   order is by basis, which these could have outranked). A specific-lot sale named its lots.
   *
   * Nothing is refused when the action adds no lot.
   */
  private async assertTargetInOrder(targetId: number, added: Array<{ accountId: number; isCovered: boolean }>, actionDate: string) {
    if (added.length === 0) return;
    const { rows } = await sql<{ last_sale: string | null; ticker: string }>`
      SELECT (SELECT ticker FROM securities WHERE id = ${targetId}) AS ticker, max(later.day) AS last_sale
        FROM (
      SELECT sca.action_date AS day
        FROM security_corporate_actions sca
       WHERE sca.security_id = ${targetId}
         AND (sca.action_date > ${actionDate}::date
              OR (sca.action_date = ${actionDate}::date AND sca.action_type IN ('merger_stock', 'merger_cash')))
      UNION ALL
      SELECT he.event_date
        FROM holding_events he
        JOIN lot_consumptions lc ON lc.sell_event_id = he.id
        JOIN tax_lots sold ON sold.id = lc.tax_lot_id
       WHERE he.security_id = ${targetId}
         AND he.event_type = 'sell'
         AND he.event_date >= ${actionDate}::date
         AND EXISTS (SELECT 1
                       FROM unnest(${added.map((a) => a.accountId)}::int[], ${added.map((a) => a.isCovered)}::bool[]) AS lot(account_id, is_covered)
                      WHERE lot.account_id = he.account_id
                        AND CASE COALESCE(he.metadata->>'method', 'average_cost')
                              WHEN 'specific_id' THEN false
                              WHEN 'fifo' THEN sold.acquisition_date > ${actionDate}::date
                              WHEN 'lifo' THEN sold.acquisition_date <= ${actionDate}::date
                              WHEN 'average_cost' THEN sold.is_covered = lot.is_covered
                              ELSE true
                            END)
        ) later
    `.execute(getDb());
    const later = rows[0];
    if (later?.last_sale) {
      throw new ControlPlaneError(
        409,
        'CORPORATE_ACTION_BEFORE_RECORDED_SALES',
        `Sales or corporate actions of ${later.ticker}, which this action adds lots to, on or after ${actionDate} (the last on ${later.last_sale}) are already recorded, and their shares and basis don't reflect those lots. Record corporate actions in date order, before the sales that follow them.`
      );
    }
  }

  /**
   * Open lots of a security across all accounts, acquired before `before` when given, with what
   * names one to people (its uuid, acquisition date and account's name) for a refusal.
   */
  private async openLots(securityId: number, before?: string): Promise<Array<SplitLot & { accountId: number; sharesOriginal: bigint }>> {
    const rows = await getDb()
      .selectFrom('tax_lots as tl')
      .innerJoin('accounts as a', 'a.id', 'tl.account_id')
      .select([
        'tl.id', 'tl.uuid', 'tl.account_id', 'tl.acquisition_date', 'tl.shares_original', 'tl.shares_remaining', 'tl.cost_basis_per_share',
        'tl.total_cost_basis', 'a.name as account_name',
      ])
      .where('tl.security_id', '=', securityId)
      .where('tl.is_open', '=', true)
      .$if(before !== undefined, (qb) => qb.where('tl.acquisition_date', '<', before!))
      .orderBy('tl.acquisition_date').orderBy('tl.id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      uuid: r.uuid,
      accountName: r.account_name,
      acquisitionDate: r.acquisition_date,
      accountId: r.account_id,
      sharesOriginal: numericUnits(r.shares_original, SHARES.scale),
      sharesRemaining: numericUnits(r.shares_remaining, SHARES.scale),
      costBasisPerShare: numericUnits(r.cost_basis_per_share, PER_SHARE.scale),
      totalCostBasis: numericUnits(r.total_cost_basis, CENTS.scale),
    }));
  }

  /** One event per account the action changed lots of; `metadata` the same for each, or each account's own. */
  private async recordEvents(securityId: number, lots: Array<{ accountId: number }>, eventType: string, eventDate: string, metadata: unknown, userId?: number) {
    const accountIds = [...new Set(lots.map((l) => l.accountId))];
    for (const accountId of accountIds) {
      const accountMetadata = typeof metadata === 'function' ? (metadata as (accountId: number) => unknown)(accountId) : metadata;
      await getDb()
        .insertInto('holding_events')
        .values({
          account_id: accountId,
          security_id: securityId,
          user_id: userId ?? null,
          event_type: eventType,
          event_date: eventDate,
          source: 'system_generated',
          metadata: sql`${JSON.stringify(accountMetadata)}::jsonb`,
        })
        .execute();
    }
  }

  async applySplitAction(input: { securityUuid: string; actionDate: string; numerator: DecimalValue; denominator: DecimalValue; reverse?: boolean; userId?: number; dryRun?: boolean }) {
    const numerator = requestUnits(input.numerator, 'numerator', SHARES);
    const denominator = requestUnits(input.denominator, 'denominator', SHARES);
    const securityId = await this.lockSecurity(input.securityUuid);
    const actionType = input.reverse ? 'reverse_split' : 'split';
    // A split and a reverse split on one day would be one change recorded twice.
    await this.assertNotRecorded(securityId, SPLIT_ACTIONS, input.actionDate);
    const lots = await this.openLots(securityId, input.actionDate);
    await this.assertNoLaterSales(securityId, lots.map((l) => l.id), input.actionDate, 'before');
    await this.assertNoWashMatchAcross(securityId, input.actionDate);
    const results = lots.map((l) => ({
      accountId: l.accountId,
      ...applySplit(l, numerator, denominator),
      // The shares the lot was opened with scale by the same ratio, rounded as its remaining
      // shares are. A partly sold lot has more of them, so they can outgrow the column alone.
      sharesOriginal: divRound(l.sharesOriginal * numerator, denominator),
    }));
    for (const r of results) {
      assertFits(r.sharesRemaining, SHARES, 'A lot\'s shares after the split');
      assertFits(r.sharesOriginal, SHARES, 'A lot\'s original shares after the split');
      assertFits(r.costBasisPerShare, PER_SHARE, 'A lot\'s cost basis per share after the split');
    }
    // The wash sale records whose replacement is one of these lots: the shares they used of it
    // are its shares, so they scale with it, rounded as its shares are. Unscaled, a
    // 2:1 split left half the lot unmatched, to absorb a second loss. The loss's own shares
    // (loss_shares), sold before, stay.
    const washRecords = lots.length === 0 ? [] : (await getDb()
      .selectFrom('wash_sale_records')
      .select(['id', 'replacement_lot_id', 'replacement_shares'])
      .where('replacement_lot_id', 'in', lots.map((l) => l.id))
      .orderBy('id')
      .execute()).map((w) => ({
      id: w.id,
      // Never null here: the query takes the records of these lots.
      lotId: w.replacement_lot_id ?? 0,
      before: w.replacement_shares,
      shares: divRound(numericUnits(w.replacement_shares, SHARES.scale) * numerator, denominator),
    }));
    for (const w of washRecords) assertFits(w.shares, SHARES, 'A wash sale\'s replacement shares after the split');
    if (input.dryRun) {
      return {
        dry_run: true,
        affected_lots: results.length,
        results: results.map((r) => ({ accountId: r.accountId, lotId: r.lotId, sharesRemaining: shareNumber(r.sharesRemaining), costBasisPerShare: perShareNumber(r.costBasisPerShare) })),
      };
    }

    await getDb()
      .insertInto('security_corporate_actions')
      .values({
        security_id: securityId,
        action_type: actionType,
        action_date: input.actionDate,
        numerator: shareText(numerator),
        denominator: shareText(denominator),
      })
      .execute();

    for (const r of results) {
      await getDb()
        .updateTable('tax_lots')
        .set({
          shares_remaining: shareText(r.sharesRemaining),
          shares_original: shareText(r.sharesOriginal),
          cost_basis_per_share: perShareText(r.costBasisPerShare),
        })
        .where('id', '=', r.lotId)
        .execute();
    }
    for (const w of washRecords) {
      await getDb().updateTable('wash_sale_records').set({ replacement_shares: shareText(w.shares) }).where('id', '=', w.id).execute();
    }
    // Each account's event keeps its lots' figures and their wash records' shares as they were
    // before the split (SplitBefore): a sale recorded later in figures adjusted for this split,
    // dated before it, that closes one of the lots puts the lot back as it was then, exactly
    // (HoldingsService closedOnSaleDay), where dividing by the ratio again can't undo
    // the rounding (a lot of 10 is 3.333333 after 1:3, and 9.999999 divided back).
    const lotAccount = new Map(lots.map((l) => [l.id, l.accountId]));
    const before = (accountId: number): SplitBefore => ({
      lots: lots.filter((l) => l.accountId === accountId).map((l) => ({
        id: l.id,
        shares_original: shareText(l.sharesOriginal),
        shares_remaining: shareText(l.sharesRemaining),
        cost_basis_per_share: perShareText(l.costBasisPerShare),
        total_cost_basis: centsText(l.totalCostBasis),
      })),
      wash: washRecords.filter((w) => lotAccount.get(w.lotId) === accountId).map((w) => ({ id: w.id, lot_id: w.lotId, replacement_shares: w.before })),
    });
    await this.recordEvents(securityId, lots, actionType, input.actionDate, (accountId: number) => ({ numerator: shareNumber(numerator), denominator: shareNumber(denominator), before: before(accountId) }), input.userId);
    logger.info({ securityId, actionType, affected: results.length }, 'Applied split');
    return { action_type: actionType, affected_lots: results.length };
  }

  async applyReturnOfCapitalAction(input: { securityUuid: string; actionDate: string; amountPerShare: DecimalValue; userId?: number; dryRun?: boolean }) {
    const amountPerShare = requestUnits(input.amountPerShare, 'amount_per_share', PER_SHARE);
    const securityId = await this.lockSecurity(input.securityUuid);
    await this.assertNotRecorded(securityId, ['return_of_capital'], input.actionDate);
    const lots = await this.openLots(securityId, input.actionDate);
    await this.assertNoLaterSales(securityId, lots.map((l) => l.id), input.actionDate, 'before');
    const outcome = applyReturnOfCapital(lots, amountPerShare);
    for (const r of outcome.lots) assertFits(r.totalCostBasis, CENTS, 'A lot\'s cost basis after the return of capital');
    const answer = {
      lots: outcome.lots.map((r) => ({ lotId: r.lotId, costBasisPerShare: perShareNumber(r.costBasisPerShare), realizedLongTermGain: dollars(r.realizedLongTermGain) })),
      totalRealizedLongTermGain: dollars(outcome.totalRealizedLongTermGain),
    };
    if (input.dryRun) return { dry_run: true, ...answer };

    await getDb()
      .insertInto('security_corporate_actions')
      .values({
        security_id: securityId,
        action_type: 'return_of_capital',
        action_date: input.actionDate,
        amount_per_share: perShareText(amountPerShare),
      })
      .execute();

    for (const r of outcome.lots) {
      // total_cost_basis is the remaining basis: it drops with the per-share basis.
      await getDb().updateTable('tax_lots').set({
        cost_basis_per_share: perShareText(r.costBasisPerShare),
        total_cost_basis: centsText(r.totalCostBasis),
      }).where('id', '=', r.lotId).execute();
    }
    await this.recordEvents(securityId, lots, 'return_of_capital', input.actionDate, { amountPerShare: perShareNumber(amountPerShare), realizedLongTermGain: answer.totalRealizedLongTermGain }, input.userId);
    logger.info({ securityId, affected: outcome.lots.length }, 'Applied return of capital');
    return { action_type: 'return_of_capital', affected_lots: outcome.lots.length, realized_long_term_gain: answer.totalRealizedLongTermGain };
  }

  /**
   * Open source lots with account + holding-period for spinoff/merger transforms: those acquired
   * before `held.before` (a spinoff's ex-date), or on or before `held.onOrBefore` (a merger's date),
   * with what names one to people (its uuid, acquisition date and account's name) for a refusal.
   */
  private async sourceLots(securityId: number, held: { before: string } | { onOrBefore: string }) {
    const rows = await getDb()
      .selectFrom('tax_lots as tl')
      .innerJoin('accounts as a', 'a.id', 'tl.account_id')
      .select([
        'tl.id', 'tl.uuid', 'tl.account_id', 'tl.acquisition_date', 'tl.shares_remaining', 'tl.cost_basis_per_share', 'tl.total_cost_basis',
        'tl.holding_period_start', 'tl.is_covered', 'a.name as account_name',
      ])
      .where('tl.security_id', '=', securityId).where('tl.is_open', '=', true)
      .where('tl.acquisition_date', 'before' in held ? '<' : '<=', 'before' in held ? held.before : held.onOrBefore)
      // In acquisition order, id last: the new lots come out in the same order every time, and
      // so does any rounding cent spread over them.
      .orderBy('tl.acquisition_date').orderBy('tl.id')
      .execute();
    return rows.map((r) => ({
      id: r.id, uuid: r.uuid, accountName: r.account_name, acquisitionDate: r.acquisition_date,
      accountId: r.account_id, sharesRemaining: numericUnits(r.shares_remaining, SHARES.scale),
      costBasisPerShare: numericUnits(r.cost_basis_per_share, PER_SHARE.scale), totalCostBasis: numericUnits(r.total_cost_basis, CENTS.scale),
      holdingPeriodStart: r.holding_period_start, isCovered: r.is_covered,
    }));
  }

  /** The accounts a spinoff or stock merger adds lots to, with each lot's covered status (its source lot's). */
  private lotsAdded(lots: Array<{ id: number; accountId: number; isCovered: boolean }>, results: Array<{ sourceLotId: number; newShares: bigint }>) {
    const lotById = new Map(lots.map((l) => [l.id, l]));
    return results.filter((r) => r.newShares > 0n).map((r) => {
      const src = lotById.get(r.sourceLotId)!;
      return { accountId: src.accountId, isCovered: src.isCovered };
    });
  }

  /** Spinoff: allocate basis to a new security, inherit holding period. */
  async applySpinoffAction(input: { sourceSecurityUuid: string; newSecurityUuid: string; actionDate: string; allocationFraction: DecimalValue; shareRatio: DecimalValue; userId?: number; dryRun?: boolean }) {
    const allocationFraction = requestUnits(input.allocationFraction, 'allocation_fraction', FRACTION);
    const shareRatio = requestUnits(input.shareRatio, 'share_ratio', SHARES);
    const [sourceId, newId] = await this.lockSecurityPair(input.sourceSecurityUuid, input.newSecurityUuid);
    // A company can spin off two on one day, so a retry is the same source, child and day.
    const recorded = await getDb()
      .selectFrom('holding_events')
      .select('id')
      .where('security_id', '=', newId)
      .where('event_type', '=', holdingEventType.enum.spinoff)
      .where('event_date', '=', input.actionDate)
      .where(sql<boolean>`(metadata->>'sourceSecurityId')::int = ${sourceId}`)
      .executeTakeFirst();
    if (recorded) {
      throw new ControlPlaneError(409, 'CORPORATE_ACTION_ALREADY_RECORDED', `A spinoff of this security into that one on ${input.actionDate} is already recorded.`);
    }
    const lots = await this.sourceLots(sourceId, { before: input.actionDate });
    await this.assertNoLaterSales(sourceId, lots.map((l) => l.id), input.actionDate, 'before');
    const results = applySpinoff(lots, allocationFraction, shareRatio);
    for (const r of results) {
      assertFits(r.newShares, SHARES, 'A spun-off lot\'s shares');
      assertFits(r.newCostBasisPerShare, PER_SHARE, 'A spun-off lot\'s cost basis per share');
      assertFits(r.newTotalCostBasis, CENTS, 'A spun-off lot\'s cost basis');
      assertFits(r.sourceNewCostBasisPerShare, PER_SHARE, 'A lot\'s cost basis per share after the spinoff');
      assertFits(r.sourceNewTotalCostBasis, CENTS, 'A lot\'s cost basis after the spinoff');
    }
    await this.assertTargetInOrder(newId, this.lotsAdded(lots, results), input.actionDate);
    if (input.dryRun) {
      return {
        dry_run: true,
        affected_lots: results.length,
        results: results.map((r) => ({
          sourceLotId: r.sourceLotId,
          sourceNewCostBasisPerShare: perShareNumber(r.sourceNewCostBasisPerShare),
          newShares: shareNumber(r.newShares),
          newCostBasisPerShare: perShareNumber(r.newCostBasisPerShare),
          newTotalCostBasis: dollars(r.newTotalCostBasis),
          holdingPeriodStart: r.holdingPeriodStart,
        })),
      };
    }

    await getDb().insertInto('security_corporate_actions').values({ security_id: sourceId, action_type: 'spinoff', action_date: input.actionDate, numerator: shareText(shareRatio), denominator: '1' }).execute();

    const lotById = new Map(lots.map((l) => [l.id, l]));
    let created = 0;
    for (const r of results) {
      const src = lotById.get(r.sourceLotId)!;
      // New lot in the spun-off security, created by a per-account spinoff event.
      const event = await getDb().insertInto('holding_events').values({
        account_id: src.accountId, security_id: newId, user_id: input.userId ?? null,
        event_type: 'spinoff', event_date: input.actionDate, shares: shareText(r.newShares), source: 'system_generated',
        metadata: sql`${JSON.stringify({ sourceSecurityId: sourceId, allocationFraction: unitsToNumber(allocationFraction, FRACTION.scale), shareRatio: shareNumber(shareRatio) })}::jsonb`,
      }).returning('id').executeTakeFirstOrThrow();
      if (r.newShares > 0n) {
        await getDb().insertInto('tax_lots').values({
          account_id: src.accountId, security_id: newId, created_by_event_id: event.id, parent_lot_id: r.sourceLotId,
          acquisition_date: input.actionDate, holding_period_start: r.holdingPeriodStart,
          shares_original: shareText(r.newShares), shares_remaining: shareText(r.newShares),
          cost_basis_per_share: perShareText(r.newCostBasisPerShare), total_cost_basis: centsText(r.newTotalCostBasis),
          acquisition_method: 'spinoff',
          // Its basis comes from the source lot, so it is covered as that lot is (Treas. Reg.
          // §1.6045-1(a)(15)(iv)): one from a noncovered lot stays out of the covered pool.
          is_covered: src.isCovered,
        }).execute();
        created++;
      }
      // Reduce the source lot's basis.
      await getDb().updateTable('tax_lots').set({
        cost_basis_per_share: perShareText(r.sourceNewCostBasisPerShare),
        total_cost_basis: centsText(r.sourceNewTotalCostBasis),
      }).where('id', '=', r.sourceLotId).execute();
    }
    logger.info({ sourceId, newId, created }, 'Applied spinoff');
    return { action_type: 'spinoff', source_lots: results.length, new_lots: created };
  }

  /** Cash merger: full disposal at cash/share with realized G/L. */
  async applyMergerCashAction(input: { securityUuid: string; actionDate: string; cashPerShare: DecimalValue; userId?: number; dryRun?: boolean }) {
    const cashPerShare = requestUnits(input.cashPerShare, 'cash_per_share', PER_SHARE);
    const securityId = await this.lockSecurity(input.securityUuid);
    await this.assertNotRecorded(securityId, ['merger_cash', 'merger_stock'], input.actionDate);
    const lots = await this.sourceLots(securityId, { onOrBefore: input.actionDate });
    await this.assertNoLaterSales(securityId, lots.map((l) => l.id), input.actionDate, 'onOrBefore');
    const consumptions = mergerCashDisposal(lots, cashPerShare, input.actionDate);
    const lotAccount = new Map(lots.map((l) => [l.id, l.accountId]));
    // Each account's cash, exact: the sum of its lots' proceeds in cents.
    const proceedsByAccount = new Map<number, bigint>();
    for (const c of consumptions) {
      assertFits(c.proceeds, CENTS, 'A lot\'s merger proceeds');
      assertFits(c.basisConsumed, CENTS, 'A lot\'s basis consumed by the merger');
      assertFits(c.realizedGainLoss, CENTS, 'A lot\'s realized gain or loss on the merger');
      const accountId = lotAccount.get(c.lotId)!;
      proceedsByAccount.set(accountId, (proceedsByAccount.get(accountId) ?? 0n) + c.proceeds);
    }
    for (const total of proceedsByAccount.values()) assertFits(total, CENTS, 'An account\'s merger proceeds');
    const totalRealized = consumptions.reduce((s, c) => s + c.realizedGainLoss, 0n);
    if (input.dryRun) {
      return {
        dry_run: true,
        consumptions: consumptions.map((c) => ({
          lotId: c.lotId,
          sharesConsumed: shareNumber(c.sharesConsumed),
          basisConsumed: dollars(c.basisConsumed),
          proceeds: dollars(c.proceeds),
          realizedGainLoss: dollars(c.realizedGainLoss),
          holdingPeriodDays: c.holdingPeriodDays,
          isLongTerm: c.isLongTerm,
        })),
      };
    }

    await getDb().insertInto('security_corporate_actions').values({ security_id: securityId, action_type: 'merger_cash', action_date: input.actionDate, amount_per_share: perShareText(cashPerShare) }).execute();

    // One merger_cash event per account, then consumptions + close lots.
    const eventByAccount = new Map<number, number>();
    for (const accountId of new Set(lots.map((l) => l.accountId))) {
      const ev = await getDb().insertInto('holding_events').values({
        account_id: accountId, security_id: securityId, user_id: input.userId ?? null,
        event_type: 'merger_cash', event_date: input.actionDate, source: 'system_generated',
        total_amount: centsText(proceedsByAccount.get(accountId) ?? 0n),
      }).returning('id').executeTakeFirstOrThrow();
      eventByAccount.set(accountId, ev.id);
    }
    for (const c of consumptions) {
      await getDb().insertInto('lot_consumptions').values({
        tax_lot_id: c.lotId, sell_event_id: eventByAccount.get(lotAccount.get(c.lotId)!)!,
        shares_consumed: shareText(c.sharesConsumed), basis_consumed: centsText(c.basisConsumed), proceeds: centsText(c.proceeds),
        realized_gain_loss: centsText(c.realizedGainLoss), holding_period_days: c.holdingPeriodDays, is_long_term: c.isLongTerm,
      }).execute();
      await getDb().updateTable('tax_lots').set({ shares_remaining: '0', total_cost_basis: '0', is_open: false }).where('id', '=', c.lotId).execute();
    }
    logger.info({ securityId, lots: consumptions.length }, 'Applied cash merger');
    return { action_type: 'merger_cash', closed_lots: consumptions.length, total_realized: dollars(totalRealized) };
  }

  /** Stock merger: convert to acquirer at exchange ratio. */
  async applyMergerStockAction(input: { securityUuid: string; acquirerSecurityUuid: string; actionDate: string; exchangeRatio: DecimalValue; userId?: number; dryRun?: boolean }) {
    const exchangeRatio = requestUnits(input.exchangeRatio, 'exchange_ratio', SHARES);
    const [securityId, acquirerId] = await this.lockSecurityPair(input.securityUuid, input.acquirerSecurityUuid);
    await this.assertNotRecorded(securityId, ['merger_cash', 'merger_stock'], input.actionDate);
    const lots = await this.sourceLots(securityId, { onOrBefore: input.actionDate });
    await this.assertNoLaterSales(securityId, lots.map((l) => l.id), input.actionDate, 'onOrBefore');
    const results = mergerStockConversion(lots, exchangeRatio);
    for (const r of results) {
      assertFits(r.newShares, SHARES, 'A converted lot\'s shares');
      assertFits(r.newCostBasisPerShare, PER_SHARE, 'A converted lot\'s cost basis per share');
      assertFits(r.newTotalCostBasis, CENTS, 'A converted lot\'s cost basis');
    }
    await this.assertTargetInOrder(acquirerId, this.lotsAdded(lots, results), input.actionDate);
    if (input.dryRun) {
      return {
        dry_run: true,
        results: results.map((r) => ({
          sourceLotId: r.sourceLotId,
          newShares: shareNumber(r.newShares),
          newCostBasisPerShare: perShareNumber(r.newCostBasisPerShare),
          newTotalCostBasis: dollars(r.newTotalCostBasis),
          holdingPeriodStart: r.holdingPeriodStart,
        })),
      };
    }

    await getDb().insertInto('security_corporate_actions').values({ security_id: securityId, action_type: 'merger_stock', action_date: input.actionDate, numerator: shareText(exchangeRatio), denominator: '1' }).execute();

    const lotById = new Map(lots.map((l) => [l.id, l]));
    let created = 0;
    for (const r of results) {
      const src = lotById.get(r.sourceLotId)!;
      const ev = await getDb().insertInto('holding_events').values({
        account_id: src.accountId, security_id: acquirerId, user_id: input.userId ?? null,
        event_type: 'merger_stock', event_date: input.actionDate, shares: shareText(r.newShares), source: 'system_generated',
        metadata: sql`${JSON.stringify({ fromSecurityId: securityId, exchangeRatio: shareNumber(exchangeRatio) })}::jsonb`,
      }).returning('id').executeTakeFirstOrThrow();
      if (r.newShares > 0n) {
        await getDb().insertInto('tax_lots').values({
          account_id: src.accountId, security_id: acquirerId, created_by_event_id: ev.id, parent_lot_id: r.sourceLotId,
          acquisition_date: input.actionDate, holding_period_start: r.holdingPeriodStart,
          shares_original: shareText(r.newShares), shares_remaining: shareText(r.newShares),
          cost_basis_per_share: perShareText(r.newCostBasisPerShare), total_cost_basis: centsText(r.newTotalCostBasis),
          acquisition_method: 'merger',
          // Covered as the lot it replaces was (Treas. Reg. §1.6045-1(a)(15)(iv)).
          is_covered: src.isCovered,
        }).execute();
        created++;
      }
      await getDb().updateTable('tax_lots').set({ shares_remaining: '0', total_cost_basis: '0', is_open: false }).where('id', '=', r.sourceLotId).execute();
    }
    logger.info({ securityId, acquirerId, created }, 'Applied stock merger');
    return { action_type: 'merger_stock', converted_lots: results.length, new_lots: created };
  }
}

