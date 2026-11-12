import { sql } from 'kysely';
import type { SecurityDataNeed } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { notFoundError } from '../controlPlaneErrors.js';
import { daysBetween } from '../../utils/calendarDate.js';

/**
 * Data Freshness Report. With no scheduled refresh jobs, this
 * surfaces stale/missing reference data for an agent to refresh via MCP write
 * tools. Default thresholds live here; per-security overrides come from
 * data_freshness_thresholds.
 */
export const DEFAULT_THRESHOLDS = {
  price_held: 1,
  price_unheld: 30,
  composition: 90,
  expense_ratio: 365,
  underlying_holdings: 90,
} as const;

export class FreshnessService {
  /**
   * Returns prioritized stale/missing data: prices, compositions, expense ratios.
   * Ordered actively-held first, then by holding market value desc.
   */
  async getReport(opts: { minHoldingValue?: number } = {}) {
    const rows = await sql<{
      security_uuid: string;
      ticker: string;
      is_pass_through: boolean;
      is_held: boolean;
      market_value: string | null;
      price_age_days: number | null;
      composition_age_days: number | null;
      expense_ratio_missing: boolean;
      has_price: boolean;
      has_composition: boolean;
    }>`
      WITH held AS (
        SELECT security_id, SUM(shares_remaining) AS shares
        FROM tax_lots WHERE is_open = true GROUP BY security_id
      ),
      latest_price AS (
        SELECT security_id, MAX(price_date) AS last_date FROM security_prices GROUP BY security_id
      )
      SELECT s.uuid AS security_uuid,
             s.ticker,
             s.is_pass_through,
             (h.security_id IS NOT NULL) AS is_held,
             (COALESCE(h.shares, 0) * lp_close.close) AS market_value,
             (app_today() - lp.last_date) AS price_age_days,
             (app_today() - (SELECT MAX(snapshot_date) FROM fund_compositions fc WHERE fc.security_id = s.id)) AS composition_age_days,
             (s.expense_ratio_percentage IS NULL) AS expense_ratio_missing,
             (lp.last_date IS NOT NULL) AS has_price,
             (EXISTS (SELECT 1 FROM fund_compositions fc WHERE fc.security_id = s.id)) AS has_composition
      FROM securities s
      LEFT JOIN held h ON h.security_id = s.id
      LEFT JOIN latest_price lp ON lp.security_id = s.id
      LEFT JOIN LATERAL (SELECT close FROM security_prices sp WHERE sp.security_id = s.id ORDER BY sp.price_date DESC LIMIT 1) lp_close ON true
      WHERE s.is_active = true
      ORDER BY is_held DESC, market_value DESC NULLS LAST
    `.execute(getDb());

    const stalePrices: unknown[] = [];
    const staleCompositions: unknown[] = [];
    const missingExpenseRatios: unknown[] = [];

    for (const r of rows.rows) {
      const marketValue = r.market_value != null ? Number(r.market_value) : 0;
      if (opts.minHoldingValue && marketValue < opts.minHoldingValue) continue;
      const priceThreshold = r.is_held ? DEFAULT_THRESHOLDS.price_held : DEFAULT_THRESHOLDS.price_unheld;
      if (!r.has_price || (r.price_age_days != null && r.price_age_days > priceThreshold)) {
        stalePrices.push({ security_uuid: r.security_uuid, ticker: r.ticker, is_held: r.is_held, market_value: marketValue, price_age_days: r.price_age_days, never_recorded: !r.has_price });
      }
      if (r.is_pass_through) {
        if (!r.has_composition || (r.composition_age_days != null && r.composition_age_days > DEFAULT_THRESHOLDS.composition)) {
          staleCompositions.push({ security_uuid: r.security_uuid, ticker: r.ticker, composition_age_days: r.composition_age_days, never_recorded: !r.has_composition });
        }
        if (r.expense_ratio_missing) {
          missingExpenseRatios.push({ security_uuid: r.security_uuid, ticker: r.ticker });
        }
      }
    }

    return {
      stale_prices: stalePrices,
      stale_compositions: staleCompositions,
      missing_expense_ratios: missingExpenseRatios,
      summary: {
        stale_price_count: stalePrices.length,
        stale_composition_count: staleCompositions.length,
        missing_expense_ratio_count: missingExpenseRatios.length,
      },
    };
  }

  /** Securities lacking a given data category (price | composition | expense_ratio). */
  async getSecuritiesNeedingData(category: SecurityDataNeed) {
    if (category === 'price') {
      const r = await sql<{ uuid: string; ticker: string; name: string }>`
        SELECT s.uuid, s.ticker, s.name FROM securities s
        WHERE s.is_active = true AND NOT EXISTS (SELECT 1 FROM security_prices sp WHERE sp.security_id = s.id)
        ORDER BY s.ticker`.execute(getDb());
      return { category, securities: r.rows };
    }
    if (category === 'composition') {
      const r = await sql<{ uuid: string; ticker: string; name: string }>`
        SELECT s.uuid, s.ticker, s.name FROM securities s
        WHERE s.is_active = true AND s.is_pass_through = true
          AND NOT EXISTS (SELECT 1 FROM fund_compositions fc WHERE fc.security_id = s.id)
        ORDER BY s.ticker`.execute(getDb());
      return { category, securities: r.rows };
    }
    const r = await sql<{ uuid: string; ticker: string; name: string }>`
      SELECT s.uuid, s.ticker, s.name FROM securities s
      WHERE s.is_active = true AND s.is_pass_through = true AND s.expense_ratio_percentage IS NULL
      ORDER BY s.ticker`.execute(getDb());
    return { category, securities: r.rows };
  }

  /** Gaps in a security's price history exceeding `thresholdDays` between points. */
  async getPriceHistoryGaps(securityUuid: string, thresholdDays = 5) {
    const sec = await getDb().selectFrom('securities').select('id').where('uuid', '=', securityUuid).executeTakeFirst();
    if (!sec) throw notFoundError('security');
    const rows = await sql<{ price_date: string }>`
      SELECT price_date::text AS price_date FROM security_prices WHERE security_id = ${sec.id} ORDER BY price_date ASC`.execute(getDb());
    const dates = rows.rows.map((r) => r.price_date);
    const gaps: Array<{ after: string; before: string; gap_days: number }> = [];
    let after: string | undefined;
    for (const before of dates) {
      if (after !== undefined) {
        const gapDays = daysBetween(after, before);
        if (gapDays > thresholdDays) gaps.push({ after, before, gap_days: gapDays });
      }
      after = before;
    }
    return { security_uuid: securityUuid, first_price: dates[0] ?? null, last_price: dates[dates.length - 1] ?? null, gaps };
  }
}
