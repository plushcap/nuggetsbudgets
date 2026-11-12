import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import type { BudgetItemHistoryAnswer } from '@nuggets/shared';
import { BudgetItemNotFoundError } from './BudgetItemEditor.js';

/**
 * A budget item's figures over its recent periods, and in the current one:
 * GET /api/budget-items/:uuid/history. The item's detail page used to ask
 * GET /budgets/periods/:uuid/items once per period for these.
 *
 * Every figure comes from the event-sourced calculate_*_for_period_item functions, never
 * a stored amount (CLAUDE.md "Event-sourced budgets"). Amounts are NUMERIC, so they
 * travel as strings, as GET /budgets/periods/:uuid/items sends them.
 */

/**
 * The answer, as sent: `@nuggets/shared`'s budgetItemHistoryResponseSchema, which
 * the frontend reads it with. `periods` are the item's figures in each of the ledger's last N
 * periods by start_date, oldest first; `current` its figures in the current period: the one
 * whose dates hold the household's today (app_today()), else the earliest active one (as the
 * Budget page's resolvePeriodIndex picks), else the latest one; null when the item has no row
 * in it.
 */
type PeriodFigures = BudgetItemHistoryAnswer['periods'][number];

/** The item's history over the last `periodCount` periods; a 404 (BudgetItemNotFoundError) when no item of the ledger has `uuid`. */
export async function getBudgetItemHistory(uuid: string, periodCount: number): Promise<BudgetItemHistoryAnswer> {
  const item = await getDb()
    .selectFrom('budget_items')
    .select(['id', 'uuid'])
    .where('uuid', '=', uuid)
    .executeTakeFirst();
  if (!item) throw new BudgetItemNotFoundError();

  // The window is chosen from budget_period alone (ordered by start_date, id last),
  // and the expensive calculate_* calls run only for the item's rows in it.
  const history = await sql<PeriodFigures>`
    WITH recent AS (
      SELECT bp.id
        FROM budget_period bp
       ORDER BY bp.start_date DESC, bp.id DESC
       LIMIT ${periodCount}
    )
    SELECT bp.uuid AS period_uuid, bp.name AS period_name, bp.month, bp.month_number, bp.year,
           bp.start_date, bp.end_date, bp.status,
           calculate_budget_for_period_item(bpi.id) AS budget,
           calculate_actual_for_period_item(bpi.id) AS actual,
           calculate_transfers_for_period_item(bpi.id) AS transfers,
           calculate_remaining_for_period_item(bpi.id) AS remaining
      FROM recent
      JOIN budget_period bp ON bp.id = recent.id
      JOIN budget_period_items bpi ON bpi.budget_period_id = bp.id AND bpi.budget_item_id = ${item.id}
     ORDER BY bp.start_date ASC, bp.id ASC
  `.execute(getDb());

  const current = await sql<PeriodFigures>`
    WITH current_period AS (
      SELECT bp.id
        FROM budget_period bp
       ORDER BY (bp.start_date <= app_today() AND bp.end_date >= app_today()) DESC,
                (bp.status = 'active') DESC NULLS LAST,
                CASE WHEN bp.status = 'active' THEN bp.start_date END ASC,
                bp.start_date DESC, bp.id DESC
       LIMIT 1
    )
    SELECT bp.uuid AS period_uuid, bp.name AS period_name, bp.month, bp.month_number, bp.year,
           bp.start_date, bp.end_date, bp.status,
           calculate_budget_for_period_item(bpi.id) AS budget,
           calculate_actual_for_period_item(bpi.id) AS actual,
           calculate_transfers_for_period_item(bpi.id) AS transfers,
           calculate_remaining_for_period_item(bpi.id) AS remaining
      FROM current_period
      JOIN budget_period bp ON bp.id = current_period.id
      JOIN budget_period_items bpi ON bpi.budget_period_id = bp.id AND bpi.budget_item_id = ${item.id}
  `.execute(getDb());

  return { budget_item_uuid: item.uuid, periods: history.rows, current: current.rows[0] ?? null };
}
