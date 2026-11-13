import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { appToday } from '../../utils/appDate.js';
import { yearMonthOf } from '../../utils/calendarDate.js';
import { centsToNumber, numericToCents } from '../../utils/money.js';
import { BudgetService } from '../BudgetService.js';
import { BudgetItemNotFoundError } from '../budgetItems/BudgetItemEditor.js';
import { noEnvelopeAccount } from './BudgetPeriodError.js';
import { budgetPeriodIdOf, budgetPeriodItemIdOf } from './periodLookups.js';

/**
 * What the budget page, the budget-period settings page and the budget-item pages read
 * about the ledger's budget periods: the periods, each period's items with
 * their figures, an item's budget events and transactions, and the envelope account's
 * transfers. Reads only: every change to budget data goes through BudgetService.
 *
 * Runs on the request's tenant transaction (getDb(), under RLS). A period or period item
 * that isn't the ledger's is a BudgetPeriodError (404), as one that doesn't exist.
 */

/** A budget period with its counts. COUNT is bigint, which pg returns as a string. */
interface ManagedBudgetPeriodRow {
  id: number;
  uuid: string;
  name: string;
  year: number;
  month_number: number;
  start_date: string;
  end_date: string;
  /** When it was archived (pg reads a timestamptz as a Date), null while it is shown. */
  archived_at: Date | null;
  transaction_count: string;
  budget_item_count: string;
  budget_transaction_count: string;
}

/** The periods' overall counts: COUNT as a string; MIN/MAX of no rows are null. */
interface BudgetPeriodStatsRow {
  total_periods: string;
  earliest_year: number | null;
  latest_year: number | null;
}

/** Every period of the ledger, oldest first. */
export async function listBudgetPeriods() {
  return getDb().selectFrom('budget_period').selectAll().orderBy('year', 'asc').orderBy('month_number', 'asc').execute();
}

/** A period's figures per item (get_budget_period_summary). */
export async function budgetPeriodSummary(uuid: string) {
  return new BudgetService().getBudgetPeriodSummary(await budgetPeriodIdOf(uuid));
}

/**
 * A period's items, with their budget items' fields and their computed figures. The
 * calculate_* functions are expensive per row, so a caller that needs one item (the
 * budget-item page) names it by uuid, and only its row is computed. An archived item
 * shows only in the periods it had budget events or transactions in (asked for by uuid,
 * it always shows).
 */
export async function budgetPeriodItems(periodUuid: string, budgetItemUuid?: string | undefined) {
  const periodId = await budgetPeriodIdOf(periodUuid);
  const budgetItemFilter = budgetItemUuid
    ? sql` AND bi.uuid = ${budgetItemUuid}`
    : sql` AND (COALESCE(bi.status, 'active') <> 'archived'
                OR EXISTS (SELECT 1 FROM budget_period_transactions bpt WHERE bpt.budget_period_item_id = bpi.id)
                OR EXISTS (SELECT 1 FROM transactions t WHERE t.budget_period_item_id = bpi.id))`;

  // Raw sql: calculate_* PL/pgSQL calls per row over a multi-join.
  const { rows } = await sql<Record<string, unknown>>`
    SELECT
      bpi.*,
      bi.name as budget_item_name,
      bi.uuid as budget_item_uuid,
      bi.expense_type,
      bi.priority,
      bi.type,
      bi.subtype,
      bi.rollover,
      bi.rollover_target_amount,
      bi.isbill,
      bi.color,
      bi.icon,
      bi.goal_target_amount,
      bi.goal_target_date,
      bi.image_path,
      bi.status,
      c.name as category_name,
      calculate_budget_for_period_item(bpi.id) as calculated_budget,
      calculate_actual_for_period_item(bpi.id) as calculated_actual,
      calculate_transfers_for_period_item(bpi.id) as calculated_transfers,
      calculate_remaining_for_period_item(bpi.id) as calculated_remaining
    FROM budget_period_items bpi
    JOIN budget_items bi ON bpi.budget_item_id = bi.id
    LEFT JOIN categories c ON bi.category_id = c.id
    WHERE bpi.budget_period_id = ${periodId}${budgetItemFilter}
    ORDER BY bi.expense_type DESC, bi.type, bi.subtype, bi.name
  `.execute(getDb());
  return rows;
}

/**
 * The envelope account's transfers in a period, and their net (pre-signed: positive into
 * the envelopes, negative out). Summed in cents: as floats, 0.10 and 0.20 came to
 * 0.30000000000000004. A ledger without an envelope account is a 404 NO_ENVELOPE_ACCOUNT.
 */
export async function envelopeTransfers(periodUuid: string) {
  const periodId = await budgetPeriodIdOf(periodUuid);
  const envelopeAccount = await getDb()
    .selectFrom('accounts')
    .select(['id', 'uuid', 'name'])
    .where('is_envelope_account', '=', true)
    .limit(1)
    .executeTakeFirst();
  if (!envelopeAccount) throw noEnvelopeAccount();

  // Each transfer is two transactions linked by transfer_transaction_id; this is the
  // envelope account's side, and transfer_source_account_id the account it came from.
  // Raw sql: the accounts table joined twice, under two aliases.
  const { rows } = await sql<{
    uuid: string | null;
    transaction_date: string;
    amount: string | null;
    description: string | null;
    account_name: string | null;
    source_account_name: string | null;
  }>`
    SELECT
      t.uuid,
      t.transaction_date,
      t.amount,
      t.description,
      a_account.name as account_name,
      a_source.name as source_account_name
    FROM transactions t
    LEFT JOIN accounts a_account ON t.account_id = a_account.id
    LEFT JOIN accounts a_source ON t.transfer_source_account_id = a_source.id
    WHERE t.budget_period_id = ${periodId}
      AND t.account_id = ${envelopeAccount.id}
      AND t.type = 'transfer'
    ORDER BY t.transaction_date DESC, t.created_at DESC
  `.execute(getDb());

  const netCents = rows.reduce((sum, t) => sum + numericToCents(t.amount), 0);
  return {
    envelope_account: { id: envelopeAccount.id, uuid: envelopeAccount.uuid, name: envelopeAccount.name },
    net_transfer_amount: centsToNumber(netCents),
    transfer_count: rows.length,
    transfers: rows.map((t) => ({
      uuid: t.uuid,
      date: t.transaction_date,
      amount: centsToNumber(numericToCents(t.amount)),
      description: t.description,
      account_name: t.account_name,
      source_account_name: t.source_account_name,
    })),
  };
}

/**
 * Each envelope account's money through a period, counted as its envelopes are: what is filed
 * under that period or an earlier one (by start date), what is filed under none and dated by
 * the period's last day, and the opening balance ('starting balance', from before any period).
 * The envelope accounts are the Accounts list's (not hidden, not closed).
 *
 * The envelopes' remaining (calculate_remaining_for_period_item) counts what is filed under
 * each period, so a balance by date disagreed with them over whatever was filed across a
 * month's end: a close-out transfer filed under October and dated November 2 counted in
 * November's balance and October's envelopes. Not an account balance, which is
 * calculate_account_balance: this is the account's side of the envelope reconciliation.
 */
export async function envelopeBalanceThroughPeriod(periodUuid: string) {
  const periodId = await budgetPeriodIdOf(periodUuid);
  // Raw sql: a filtered aggregate over a join, with the period's span from a CTE.
  const { rows } = await sql<{ uuid: string; balance: string }>`
    WITH period AS (SELECT start_date, end_date FROM budget_period WHERE id = ${periodId}),
         through AS (SELECT bp.id FROM budget_period bp, period WHERE bp.start_date <= period.start_date)
    SELECT a.uuid,
           COALESCE(SUM(t.amount) FILTER (
             WHERE t.parent_transaction_id IS NULL
               AND (t.type = 'starting balance'
                    OR t.budget_period_id IN (SELECT id FROM through)
                    OR (t.budget_period_id IS NULL AND t.transaction_date <= (SELECT end_date FROM period)))
           ), 0)::text AS balance
      FROM accounts a
      LEFT JOIN transactions t ON t.account_id = a.id
     WHERE a.is_envelope_account = true
       AND a.hide_account = false
       AND a.close_account = false
     GROUP BY a.id, a.uuid
     ORDER BY a.id
  `.execute(getDb());
  return { accounts: rows.map((row) => ({ uuid: row.uuid, balance: centsToNumber(numericToCents(row.balance)) })) };
}

/** Every period with its counts of transactions, items and budget events, and the periods' span, for the settings page. */
export async function budgetPeriodsForManagement() {
  // Raw sql: an aggregate of several grouped subqueries.
  const periods = await sql<ManagedBudgetPeriodRow>`
    SELECT
      bp.id,
      bp.uuid,
      bp.name,
      bp.year,
      bp.month_number,
      bp.start_date,
      bp.end_date,
      bp.archived_at,
      COALESCE(t_count.transaction_count, 0) as transaction_count,
      COALESCE(bpi_count.budget_item_count, 0) as budget_item_count,
      COALESCE(bpt_count.budget_transaction_count, 0) as budget_transaction_count
    FROM budget_period bp
    LEFT JOIN (
      SELECT budget_period_id, COUNT(*) as transaction_count
      FROM transactions
      WHERE budget_period_id IS NOT NULL
      GROUP BY budget_period_id
    ) t_count ON bp.id = t_count.budget_period_id
    LEFT JOIN (
      SELECT budget_period_id, COUNT(*) as budget_item_count
      FROM budget_period_items
      GROUP BY budget_period_id
    ) bpi_count ON bp.id = bpi_count.budget_period_id
    LEFT JOIN (
      SELECT
        bpi.budget_period_id,
        COUNT(bpt.*) as budget_transaction_count
      FROM budget_period_items bpi
      LEFT JOIN budget_period_transactions bpt ON bpi.id = bpt.budget_period_item_id
      GROUP BY bpi.budget_period_id
    ) bpt_count ON bp.id = bpt_count.budget_period_id
    ORDER BY bp.year, bp.month_number
  `.execute(getDb());

  const stats = await sql<BudgetPeriodStatsRow>`
    SELECT
      COUNT(*) as total_periods,
      MIN(year) as earliest_year,
      MAX(year) as latest_year
    FROM budget_period
  `.execute(getDb());

  const currentYear = yearMonthOf(await appToday()).year;
  return {
    periods: periods.rows,
    stats: stats.rows[0] || { total_periods: 0, earliest_year: currentYear, latest_year: currentYear },
  };
}

/** A period item's budget events (budget changes and transfers), newest first. */
export async function periodItemBudgetActivity(periodItemUuid: string) {
  const periodItemId = await budgetPeriodItemIdOf(periodItemUuid);
  return getDb()
    .selectFrom('budget_period_transactions as bpt')
    .innerJoin('budget_period_items as bpi', 'bpt.budget_period_item_id', 'bpi.id')
    .innerJoin('budget_items as bi', 'bpi.budget_item_id', 'bi.id')
    .select([
      'bpt.id', 'bpt.type', 'bpt.transaction_type', 'bpt.amount',
      'bpt.description', 'bpt.created_at', 'bi.name as budget_item_name',
    ])
    .where('bpt.budget_period_item_id', '=', periodItemId)
    .orderBy('bpt.created_at', 'desc')
    .execute();
}

/** A period item's transactions, newest first. */
export async function periodItemTransactions(periodItemUuid: string) {
  const periodItemId = await budgetPeriodItemIdOf(periodItemUuid);
  return getDb()
    .selectFrom('transactions as t')
    .innerJoin('accounts as a', 't.account_id', 'a.id')
    .select([
      't.id', 't.uuid', 't.description', 't.amount',
      't.transaction_date as date', 'a.name as account_name', 't.type',
    ])
    .where('t.budget_period_item_id', '=', periodItemId)
    .orderBy('t.transaction_date', 'desc')
    .execute();
}

/**
 * The budget event log (BudgetService.getBudgetEventHistory): one item's events, one
 * period's, or both, the latest `limit`. An item or period that isn't the ledger's is a 404.
 */
export async function budgetEvents(filter: { budgetItemUuid?: string | undefined; periodUuid?: string | undefined; limit: number }) {
  let budgetItemId: number | undefined;
  if (filter.budgetItemUuid !== undefined) {
    const item = await getDb().selectFrom('budget_items').select('id').where('uuid', '=', filter.budgetItemUuid).executeTakeFirst();
    if (!item) throw new BudgetItemNotFoundError();
    budgetItemId = item.id;
  }
  const periodId = filter.periodUuid === undefined ? undefined : await budgetPeriodIdOf(filter.periodUuid);
  return new BudgetService().getBudgetEventHistory(budgetItemId, periodId, filter.limit);
}
