import { sql } from 'kysely';
import type { ValueSeriesPoint } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { CENTS, PER_SHARE, SHARES, centsNumber, fitsColumn, numericUnits, shareValueToCents, unitsToText, type AnswerDecimal } from '../../utils/decimal.js';

const logger = createLogger({ service: 'PortfolioValuationService' });

export interface PortfolioValuation {
  /** Dollars, as an answer gives them (exact text when a number can't hold them). */
  total_value: AnswerDecimal;
  cost_basis: AnswerDecimal;
  holdings_count: number;
  priced_securities: number;
  stale_securities: number; // valued on a carried-forward close (or unpriced)
}

/** One day of the equity curve (@nuggets/shared, the GET /reports/value-series answer's). */
export type { ValueSeriesPoint } from '@nuggets/shared';

/**
 * Daily mark-to-market portfolio valuation (the equity curve). Tenant-scoped —
 * call inside a tenant transaction (getDb / RLS). Value as-of a date uses the
 * latest close on or before that date (carry-forward), counting positions valued
 * on a stale close so the curve can flag them.
 */
export class PortfolioValuationService {
  /** Compute total mark-to-market value of open lots as of `date` (YYYY-MM-DD). */
  async computeValueAsOf(date: string): Promise<PortfolioValuation> {
    const v = await this.valueCentsAsOf(date);
    return { ...v, total_value: centsNumber(v.total_value), cost_basis: centsNumber(v.cost_basis) };
  }

  /**
   * The valuation with its money in cents: each position's shares × close is summed
   * exactly, at SHARE_VALUE_SCALE, and rounded once; the cost basis is the lots' remaining
   * basis (total_cost_basis) summed, not their shares × their 4-place basis per share, which a
   * partial sale can leave cents off it. A lot with no shares (a reverse split rounded one to
   * none before v2.1.0) adds none, as before.
   */
  private async valueCentsAsOf(date: string): Promise<Omit<PortfolioValuation, 'total_value' | 'cost_basis'> & { total_value: bigint; cost_basis: bigint }> {
    const rows = await sql<{
      security_id: number;
      shares: string;
      cost: string;
      close: string | null;
      price_date: string | null;
    }>`
      SELECT tl.security_id,
             SUM(tl.shares_remaining) AS shares,
             COALESCE(SUM(tl.total_cost_basis) FILTER (WHERE tl.shares_remaining > 0), 0) AS cost,
             lp.close AS close,
             lp.price_date::text AS price_date
      FROM tax_lots tl
      LEFT JOIN LATERAL (
        SELECT close, price_date FROM security_prices sp
        WHERE sp.security_id = tl.security_id AND sp.price_date <= ${date}
        ORDER BY sp.price_date DESC LIMIT 1
      ) lp ON true
      WHERE tl.is_open = true
      GROUP BY tl.security_id, lp.close, lp.price_date
    `.execute(getDb());

    let total = 0n;
    let cost = 0n;
    let holdings = 0;
    let priced = 0;
    let stale = 0;
    for (const r of rows.rows) {
      holdings++;
      cost += numericUnits(r.cost, CENTS.scale);
      if (r.close != null) {
        total += numericUnits(r.shares, SHARES.scale) * numericUnits(r.close, PER_SHARE.scale);
        priced++;
        if (r.price_date !== date) stale++;
      } else {
        stale++; // no price at all → can't value this position
      }
    }
    return {
      total_value: shareValueToCents(total),
      cost_basis: cost,
      holdings_count: holdings,
      priced_securities: priced,
      stale_securities: stale,
    };
  }

  /**
   * Compute + upsert the snapshot for `date` (default: today). Idempotent per day. A value or
   * cost basis too large for the snapshot's NUMERIC(12,2) (over $9,999,999,999.99) isn't
   * written, and says so in the log: Postgres refused it with an error, which failed
   * the ledger's part of the price sync. `snapshot_written` says which.
   */
  async upsertSnapshot(date: string, method = 'scheduled'): Promise<PortfolioValuation & { snapshot_written: boolean }> {
    const v = await this.valueCentsAsOf(date);
    const valuation = { ...v, total_value: centsNumber(v.total_value), cost_basis: centsNumber(v.cost_basis) };
    if (!fitsColumn(v.total_value, CENTS) || !fitsColumn(v.cost_basis, CENTS)) {
      // No amounts in the log.
      logger.warn({ date, holdings: v.holdings_count }, 'Portfolio value is too large for a value snapshot; not written');
      return { ...valuation, snapshot_written: false };
    }
    await getDb()
      .insertInto('portfolio_value_snapshots')
      .values({
        snapshot_date: date,
        total_value: unitsToText(v.total_value, CENTS.scale),
        cost_basis: unitsToText(v.cost_basis, CENTS.scale),
        holdings_count: v.holdings_count,
        priced_securities: v.priced_securities,
        stale_securities: v.stale_securities,
        calculation_method: method,
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'snapshot_date']).doUpdateSet((eb) => ({
          total_value: eb.ref('excluded.total_value'),
          cost_basis: eb.ref('excluded.cost_basis'),
          holdings_count: eb.ref('excluded.holdings_count'),
          priced_securities: eb.ref('excluded.priced_securities'),
          stale_securities: eb.ref('excluded.stale_securities'),
          calculation_method: eb.ref('excluded.calculation_method'),
        }))
      )
      .execute();
    // No amounts in the log.
    logger.info({ date, holdings: v.holdings_count, stale: v.stale_securities }, 'Upserted portfolio value snapshot');
    return { ...valuation, snapshot_written: true };
  }

  /** The equity-curve series (ascending by date). */
  async getSeries(opts: { startDate?: string; limit?: number } = {}): Promise<ValueSeriesPoint[]> {
    const limit = Math.min(Math.max(opts.limit ?? 1825, 1), 3650); // default ~5y, cap 10y
    const rows = await sql<{ snapshot_date: string; total_value: string; cost_basis: string | null; stale_securities: number }>`
      SELECT snapshot_date::text AS snapshot_date, total_value, cost_basis, stale_securities
      FROM portfolio_value_snapshots
      WHERE 1 = 1
        ${opts.startDate ? sql`AND snapshot_date >= ${opts.startDate}` : sql``}
      ORDER BY snapshot_date ASC
      LIMIT ${limit}
    `.execute(getDb());
    return rows.rows.map((r) => ({
      snapshot_date: r.snapshot_date,
      total_value: Number(r.total_value),
      cost_basis: r.cost_basis != null ? Number(r.cost_basis) : null,
      stale_securities: r.stale_securities,
    }));
  }
}
