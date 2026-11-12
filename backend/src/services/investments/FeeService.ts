import { sql } from 'kysely';
import type { CostOfOwnershipAnswer, FeesSummaryAnswer } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { costOfOwnership, holdingValueDollars } from './fees.js';
import { notFoundError } from '../controlPlaneErrors.js';
import { assertReferenceFree, insertHoldingEvent } from './HoldingsService.js';
import { CENTS, centsNumber, numericUnits, requestCents, unitsToText, type DecimalValue } from '../../utils/decimal.js';
import { holdingEventType } from '@nuggets/shared';

/** pg_advisory_xact_lock's class for an account's fees with a reference ('FEER'). */
const FEE_REFERENCE_LOCK_CLASS = 0x46454552;

const logger = createLogger({ service: 'FeeService' });

/**
 * Fee tracking + cost of ownership. Standalone fee events are
 * holding_events rows with event_type='fee' (account-level or security-level).
 * Commissions on buys/sells are absorbed into basis/proceeds elsewhere and are
 * not duplicated here. Cost of ownership combines explicit fees with imputed
 * expense-ratio drag (clearly labeled estimated).
 */
export class FeeService {
  private async accountIdByUuid(uuid: string): Promise<number> {
    const row = await getDb().selectFrom('accounts').select('id').where('uuid', '=', uuid).executeTakeFirst();
    if (!row) throw notFoundError('account');
    return row.id;
  }
  private async securityIdByUuid(uuid: string): Promise<number> {
    const row = await getDb().selectFrom('securities').select('id').where('uuid', '=', uuid).executeTakeFirst();
    if (!row) throw notFoundError('security');
    return row.id;
  }

  async recordFee(input: {
    accountUuid: string;
    securityUuid?: string | null;
    feeType: string;
    amount: DecimalValue;
    eventDate: string;
    description?: string | null;
    externalReference?: string | null;
    source?: string;
    userId?: number;
  }) {
    // The amount as sent, in cents: 12.345 or "1e2" is refused, not rounded or read as 100.
    const amount = requestCents(input.amount, 'amount');
    const accountId = await this.accountIdByUuid(input.accountUuid);
    const securityId = input.securityUuid ? await this.securityIdByUuid(input.securityUuid) : null;

    // Idempotent re-import: a fee already recorded under this external_reference
    // (for the same account/security) is returned as-is rather than duplicated. Two retries
    // at once take the account's fee lock first, so the second finds the first's fee and
    // answers skipped (not 409); the reference's unique index can't serialize them for a fee
    // without a security, whose NULL it counts as distinct.
    if (input.externalReference) {
      await sql`SELECT pg_advisory_xact_lock(${FEE_REFERENCE_LOCK_CLASS}::int, ${accountId}::int)`.execute(getDb());
      const dup = await getDb()
        .selectFrom('holding_events')
        .select('uuid')
        .where('event_type', '=', holdingEventType.enum.fee)
        .where('account_id', '=', accountId)
        .where((eb) => securityId == null ? eb('security_id', 'is', null) : eb('security_id', '=', securityId))
        .where('external_reference', '=', input.externalReference)
        .executeTakeFirst();
      if (dup) return { event_uuid: dup.uuid, status: 'skipped' as const };
      // Another kind of event of the security with the reference (a buy's): the 409 naming it,
      // rather than the unique index's, which can't.
      if (securityId != null) await assertReferenceFree(accountId, securityId, input.externalReference);
    }

    // A reference another kind of event of the security has (a buy's) is a 409, not the
    // unique index's error.
    const event = await insertHoldingEvent({
      account_id: accountId,
      security_id: securityId,
      user_id: input.userId ?? null,
      event_type: 'fee',
      fee_type: input.feeType,
      event_date: input.eventDate,
      total_amount: unitsToText(amount, CENTS.scale),
      source: input.source ?? 'manual',
      description: input.description ?? null,
      external_reference: input.externalReference ?? null,
    });
    // Ids, not amounts, in the log.
    logger.info({ accountId, feeType: input.feeType, eventUuid: event.uuid }, 'Recorded fee');
    return { event_uuid: event.uuid, status: 'created' as const };
  }

  /** Total Fees Report: explicit fee events grouped by fee_type. */
  async getFeesSummary(opts: { startDate?: string; endDate?: string; accountUuid?: string } = {}): Promise<FeesSummaryAnswer> {
    const accountId = opts.accountUuid ? await this.accountIdByUuid(opts.accountUuid) : null;
    const rows = await sql<{ fee_type: string; total: string; count: string }>`
      SELECT he.fee_type, SUM(he.total_amount) AS total, COUNT(*) AS count
      FROM holding_events he
      WHERE he.event_type = 'fee'
        ${accountId != null ? sql`AND he.account_id = ${accountId}` : sql``}
        ${opts.startDate ? sql`AND he.event_date >= ${opts.startDate}` : sql``}
        ${opts.endDate ? sql`AND he.event_date <= ${opts.endDate}` : sql``}
      GROUP BY he.fee_type
      ORDER BY total DESC
    `.execute(getDb());
    const byType = rows.rows.map((r) => ({ fee_type: r.fee_type, total: centsNumber(numericUnits(r.total, CENTS.scale)), count: Number(r.count) }));
    // Summed in cents.
    return { by_type: byType, total: centsNumber(rows.rows.reduce((s, r) => s + numericUnits(r.total, CENTS.scale), 0n)) };
  }

  /**
   * Total Cost of Ownership Report: per-holding explicit fees + imputed
   * expense-ratio drag. averageHoldingValue is approximated by current market
   * value in v1 (a documented simplification); drag is labeled estimated.
   */
  async getCostOfOwnership(opts: { accountUuid?: string } = {}): Promise<CostOfOwnershipAnswer> {
    const accountId = opts.accountUuid ? await this.accountIdByUuid(opts.accountUuid) : null;
    // Current market value + expense ratio per held security.
    const holdings = await sql<{ security_id: number; ticker: string; market_value: string | null; expense_ratio_percentage: string | null }>`
      SELECT tl.security_id, s.ticker,
             SUM(tl.shares_remaining) * lp.close AS market_value,
             s.expense_ratio_percentage
      FROM tax_lots tl
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN LATERAL (SELECT close FROM security_prices sp WHERE sp.security_id = tl.security_id ORDER BY sp.price_date DESC LIMIT 1) lp ON true
      WHERE tl.is_open = true
        ${accountId != null ? sql`AND tl.account_id = ${accountId}` : sql``}
      GROUP BY tl.security_id, s.ticker, s.expense_ratio_percentage, lp.close
    `.execute(getDb());

    // Security-attributed explicit fees.
    const secFees = await sql<{ security_id: number; total: string }>`
      SELECT he.security_id, SUM(he.total_amount) AS total
      FROM holding_events he
      WHERE he.event_type = 'fee' AND he.security_id IS NOT NULL
        ${accountId != null ? sql`AND he.account_id = ${accountId}` : sql``}
      GROUP BY he.security_id
    `.execute(getDb());
    const feeBySecurity = new Map(secFees.rows.map((r) => [r.security_id, r.total]));

    // Exact: the market value as SQL gives it, the drag and the fees in cents.
    const perHolding = holdings.rows
      .filter((h) => h.market_value != null)
      .map((h) => {
        const coo = costOfOwnership({
          averageHoldingValue: h.market_value!,
          expenseRatioPct: h.expense_ratio_percentage,
          explicitFees: feeBySecurity.get(h.security_id) ?? 0,
        });
        return { security_id: h.security_id, ticker: h.ticker, average_holding_value: holdingValueDollars(h.market_value!), ...coo, imputed_drag_is_estimated: true };
      });

    // Account-level explicit fees (no security attribution, e.g. advisory).
    const acctFeesRow = await sql<{ total: string }>`
      SELECT COALESCE(SUM(he.total_amount), 0) AS total
      FROM holding_events he
      WHERE he.event_type = 'fee' AND he.security_id IS NULL
        ${accountId != null ? sql`AND he.account_id = ${accountId}` : sql``}
    `.execute(getDb());
    const accountLevelFees = numericUnits(acctFeesRow.rows[0]?.total ?? '0', CENTS.scale);

    // Each holding's figures are whole cents: their sums are exact.
    const cents = (dollars: DecimalValue) => numericUnits(dollars, CENTS.scale);
    const totalExplicit = perHolding.reduce((s, h) => s + cents(h.explicitFees), 0n) + accountLevelFees;
    const totalImputed = perHolding.reduce((s, h) => s + cents(h.imputedDrag), 0n);
    return {
      per_holding: perHolding,
      account_level_fees: centsNumber(accountLevelFees),
      total_explicit_fees: centsNumber(totalExplicit),
      total_imputed_drag: centsNumber(totalImputed),
      total_cost: centsNumber(totalExplicit + totalImputed),
      note: 'Imputed expense-ratio drag is an estimate (current market value used as the period average).',
    };
  }
}
