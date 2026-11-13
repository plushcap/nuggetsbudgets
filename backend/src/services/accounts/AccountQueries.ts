import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { containsPattern } from '../../utils/likePattern.js';
import { centsToNumber, numericToCents } from '../../utils/money.js';
import { accountBalanceService, type BalanceHistoryPoint } from '../AccountBalanceService.js';
import { AccountError, accountNotFound } from './AccountError.js';
import { oneRow } from '../../utils/present.js';

const logger = createLogger({ service: 'AccountQueries' });

/**
 * What the account pages read: the account list, one account, the Close-Out zero-balance
 * audit and an account's register. Every query runs on the request's tenant transaction
 * (getDb()), so RLS keeps it to the active ledger, and every balance comes from
 * AccountBalanceService, the one balance definition. Nothing here writes.
 */

/** The account's numeric id, or a 404 for a uuid the ledger has no account for. */
export async function accountIdByUuid(uuid: string): Promise<number> {
  // kept as raw sql (DB-function call)
  const result = await sql<{ account_id: number | null }>`SELECT get_account_id_by_uuid(${uuid}) as account_id`.execute(getDb());
  const accountId = result.rows[0]?.account_id;
  if (!accountId) throw accountNotFound();
  return accountId;
}

/** A row of the account list. NUMERIC columns arrive from pg as strings. */
interface AccountListRow {
  id: number;
  uuid: string | null;
  name: string;
  account_type: string;
  account_group: string;
  type: string | null;
  institution_current_balance: string | null;
  institution_available_balance: string | null;
  import_balance: string | null;
  import_available_balance: string | null;
  account_number: string | null;
  routing_number: string | null;
  notes: string | null;
  instructions: string | null;
  icon: string | null;
  close_account: boolean | null;
  hide_transactions: boolean | null;
  hide_account: boolean | null;
  exclude_account_balance: boolean | null;
  account_image: string | null;
  is_envelope_account: boolean | null;
  require_zero_balance: boolean | null;
  default_pay_from_account_id: number | null;
  import_enabled: boolean | null;
  import_account_id: string | null;
  import_account_rebalance: boolean | null;
  import_auto_match_merchants: boolean | null;
  import_auto_assign_budget_period: boolean | null;
  import_auto_assign_budget_item: boolean | null;
  import_provider: string | null;
  import_balance_date: Date | null;
  import_last_sync: Date | null;
  import_last_error_code: string | null;
  import_last_error_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  institution_id: number | null;
  institution_uuid: string | null;
  institution_name: string | null;
  institution_notes: string | null;
}

/** Which accounts the list leaves out. */
export interface AccountListFilters {
  includeHidden: boolean;
  excludeClosed: boolean;
  /** Leave out the accounts marked "exclude from balance". */
  excludeBalance: boolean;
  /** The balances at the end of this day (YYYY-MM-DD), not today's. */
  asOf?: string | undefined;
}

/** The ledger's accounts with their institution and balance, ordered by group and name. */
export async function listAccounts(filters: AccountListFilters) {
  const conditions = [];
  if (!filters.includeHidden) conditions.push(sql`a.hide_account = false`);
  if (filters.excludeClosed) conditions.push(sql`a.close_account = false`);
  if (filters.excludeBalance) conditions.push(sql`a.exclude_account_balance = false`);
  const whereClause = conditions.length > 0 ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  // kept as raw sql (multi-join with aliased institution columns + dynamic WHERE)
  const result = await sql<AccountListRow>`
    SELECT
      a.id,
      a.uuid,
      a.name,
      a.account_type,
      a.account_group,
      a.type,
      a.institution_current_balance,
      a.institution_available_balance,
      a.import_balance,
      a.import_available_balance,
      a.account_number,
      a.routing_number,
      a.notes,
      a.instructions,
      a.icon,
      a.close_account,
      a.hide_transactions,
      a.hide_account,
      a.exclude_account_balance,
      a.account_image,
      a.is_envelope_account,
      a.require_zero_balance,
      a.default_pay_from_account_id,
      a.import_enabled,
      a.import_account_id,
      a.import_account_rebalance,
      a.import_auto_match_merchants,
      a.import_auto_assign_budget_period,
      a.import_auto_assign_budget_item,
      a.import_provider,
      a.import_balance_date,
      a.import_last_sync,
      a.import_last_error_code,
      a.import_last_error_at,
      a.created_at,
      a.updated_at,
      ai.id as institution_id,
      ai.uuid as institution_uuid,
      ai.name as institution_name,
      ai.notes as institution_notes
    FROM accounts a
    LEFT JOIN account_institutions ai ON a.institution_id = ai.id
    ${whereClause}
    ORDER BY a.account_group, a.name ASC
  `.execute(getDb());

  // Every balance in one query. If it fails, the balances are
  // unavailable (null + balance_unavailable), never a silent $0.
  const balances = await accountBalanceService.tryGetBalances(result.rows.map((a) => a.id), filters.asOf);
  return result.rows.map((account) => ({
    ...account,
    institution_balance: parseFloat(account.institution_current_balance ?? '') || 0,
    calculated_balance: balances ? (balances.get(account.id) ?? 0) : null,
    balance_unavailable: balances === null,
  }));
}

/** One account with its institution and balance. */
export async function getAccount(uuid: string) {
  const accountId = await accountIdByUuid(uuid);

  // kept as raw sql (a.* select + aliased institution join columns)
  const result = await sql<{
    institution_current_balance: string | null;
    [key: string]: unknown;
  }>`
    SELECT
      a.*,
      ai.id as institution_id,
      ai.uuid as institution_uuid,
      ai.name as institution_name,
      ai.notes as institution_notes
    FROM accounts a
    LEFT JOIN account_institutions ai ON a.institution_id = ai.id
    WHERE a.id = ${accountId}
  `.execute(getDb());
  const [found] = result.rows;
  if (!found) throw accountNotFound();

  // nuggets_balance is retired: the opening balance is a transaction.
  const row = { ...found };
  delete row.nuggets_balance;
  const balance = await accountBalanceService.tryGetBalance(accountId);
  return {
    ...row,
    institution_balance: parseFloat(found.institution_current_balance as string) || 0,
    calculated_balance: balance,
    balance_unavailable: balance === null,
  };
}

/** An account's current balance, or null (balance_unavailable) when it can't be computed. */
export async function getAccountBalance(uuid: string) {
  const accountId = await accountIdByUuid(uuid);
  const balance = await accountBalanceService.tryGetBalance(accountId);
  return { account_id: accountId, balance, balance_unavailable: balance === null };
}

/** Month-end balances, newest first (AccountBalanceService.getBalanceHistory). */
export async function getAccountBalanceHistory(
  uuid: string,
  limit: number
): Promise<{ account_id: number; balance_history: BalanceHistoryPoint[] }> {
  const accountId = await accountIdByUuid(uuid);
  return { account_id: accountId, balance_history: await accountBalanceService.getBalanceHistory(accountId, limit) };
}

/**
 * Zero-balance / adjustment audit for a budget period (Close-Out), in two queries: each
 * require_zero_balance account's sum for the period, and their current balances. It
 * replaces the frontend pulling every transaction of each such account and summing it.
 *
 * Split children (parent_transaction_id IS NOT NULL) are left out so amounts aren't
 * counted twice. Amounts are pre-signed, so a balance is a plain SUM.
 */
export async function zeroBalanceAudit(periodUuid: string) {
  const periodResult = await sql<{ id: number }>`
    SELECT id FROM budget_period WHERE uuid = ${periodUuid}
  `.execute(getDb());
  const period = periodResult.rows[0];
  if (!period) throw new AccountError(404, { error: 'Budget period not found' });

  const result = await sql<{
    id: number;
    uuid: string;
    name: string;
    account_type: string;
    icon: string | null;
    type: string | null;
    period_balance: string;
  }>`
    SELECT
      a.id,
      a.uuid,
      a.name,
      a.account_type,
      a.icon,
      a.type,
      COALESCE(SUM(t.amount) FILTER (WHERE t.parent_transaction_id IS NULL AND t.budget_period_id = ${period.id}), 0) AS period_balance
    FROM accounts a
    LEFT JOIN transactions t ON t.account_id = a.id
    WHERE a.require_zero_balance = true
      AND a.hide_account = false
      AND a.close_account = false
    GROUP BY a.id, a.uuid, a.name, a.account_type, a.icon, a.type
    ORDER BY a.name ASC
  `.execute(getDb());
  // The current balances in one query. A failure fails the audit, as it always has.
  const balances = await accountBalanceService.getBalances(result.rows.map((row) => row.id));

  // In whole cents: balanced is exactly 0, and the direction is the sum's sign.
  // Compared as floats against 0.01, a period a cent off was neither balanced nor
  // pointed anywhere, and the summary's total drifted (0.1 + 0.2).
  const accounts = result.rows.map((row) => {
    const periodCents = numericToCents(row.period_balance);
    const currentBalance = balances.get(row.id) ?? 0;
    const adjustmentDirection: 'credit' | 'debit' | 'balanced' =
      periodCents < 0 ? 'credit' : periodCents > 0 ? 'debit' : 'balanced';

    return {
      uuid: row.uuid,
      name: row.name,
      account_type: row.account_type,
      icon: row.icon ?? '',
      color: row.type ?? '',
      period_balance: centsToNumber(periodCents),
      current_balance: currentBalance,
      is_balanced: periodCents === 0,
      adjustment_needed: centsToNumber(Math.abs(periodCents)),
      adjustment_direction: adjustmentDirection,
    };
  });

  const summary = {
    total_accounts: accounts.length,
    balanced_count: accounts.filter((a) => a.is_balanced).length,
    needs_adjustment_count: accounts.filter((a) => !a.is_balanced).length,
    total_adjustment_amount: centsToNumber(
      result.rows.reduce((sum, row) => sum + Math.abs(numericToCents(row.period_balance)), 0),
    ),
  };
  return { accounts, summary };
}

/** A row of an account's register. NUMERIC columns arrive from pg as strings. */
interface AccountTransactionRow {
  id: number;
  uuid: string;
  description: string | null;
  amount: string | null;
  type: string;
  status: string | null;
  review_status: string | null;
  transaction_date: string;
  budget_item_id: number | null;
  budget_period_id: number | null;
  budget_period_item_id: number | null;
  merchant_id: number | null;
  is_split_parent: boolean;
  parent_transaction_id: number | null;
  created_at: Date | null;
  updated_at: Date | null;
  account_name: string | null;
  /** The account's accounts.type ('Asset' or 'Liability'), as the transaction answers name it. */
  account_class: string | null;
  budget_item_name: string | null;
  budget_period_name: string | null;
  budget_period_item_name: string | null;
  merchant_name: string | null;
  running_account_balance: string | null;
}

/**
 * The register's filters, as the query string sends them. An empty value (or none) is
 * no filter.
 */
export interface AccountRegisterFilters {
  search?: unknown;
  status?: unknown;
  type?: unknown;
  review_status?: unknown;
  date_from?: unknown;
  date_to?: unknown;
  budget_period_id?: unknown;
  budget_item_id?: unknown;
  amount_min?: unknown;
  amount_max?: unknown;
}

/** One page of an account's register, newest first, each row with the balance after it. */
export async function accountRegister(
  uuid: string,
  filters: AccountRegisterFilters,
  page: { page: number; limit: number; offset: number }
) {
  const {
    search = '',
    status = '',
    type = '',
    review_status = '',
    date_from = '',
    date_to = '',
    budget_period_id = '',
    budget_item_id = '',
    amount_min = '',
    amount_max = '',
  } = filters;
  const { limit, offset } = page;

  const accountId = await accountIdByUuid(uuid);

  // Split children are left out of an account's register: their parent carries the money.
  const conditions = [
    sql`t.account_id = ${accountId}`,
    sql`t.parent_transaction_id IS NULL`,
  ];
  if (search) {
    // The term's own %, _ and \ match themselves.
    const like = containsPattern(String(search));
    conditions.push(sql`(t.description ILIKE ${like} OR m.name ILIKE ${like})`);
  }
  if (status) conditions.push(sql`t.status = ${status}`);
  if (type) conditions.push(sql`t.type = ${type}`);
  if (review_status) conditions.push(sql`t.review_status = ${review_status}`);
  if (date_from) conditions.push(sql`t.transaction_date >= ${date_from}::date`);
  if (date_to) conditions.push(sql`t.transaction_date <= ${date_to}::date`);
  if (budget_period_id) conditions.push(sql`t.budget_period_id = ${parseInt(budget_period_id as string)}`);
  if (budget_item_id) conditions.push(sql`t.budget_item_id = ${parseInt(budget_item_id as string)}`);
  if (amount_min) conditions.push(sql`ABS(t.amount) >= ${parseFloat(amount_min as string)}`);
  if (amount_max) conditions.push(sql`ABS(t.amount) <= ${parseFloat(amount_max as string)}`);
  const whereClause = sql.join(conditions, sql` AND `);

  // kept as raw sql (multi-join + dynamic WHERE)
  const countResult = await sql<{ total: string }>`
    SELECT COUNT(*) as total
    FROM transactions t
    LEFT JOIN merchants m ON t.merchant_id = m.id
    WHERE ${whereClause}
  `.execute(getDb());
  const total = parseInt(oneRow(countResult.rows, 'count(*)').total);

  // Running balance is computed once over ALL of the account's parent
  // transactions with a window function, then joined into the filtered/paged
  // result. This replaces an O(n²) per-row correlated subquery.
  //
  // The balance after a row is the sum of every row up to it: the sum of all of
  // them less the strictly-NEWER ones. Ordering DESC by (transaction_date,
  // created_at, id) makes the preceding window frame (UNBOUNDED PRECEDING ..
  // 1 PRECEDING) exactly the newer rows. The sum of all of them is the account's
  // balance once every row is dated, the ones after today too: the current
  // balance (calculate_account_balance) stops at today, so the register
  // can't hang off it. The account list already excludes split children
  // (parent_transaction_id IS NULL), so every output row has a matching row in
  // the CTE.
  const transactionsResult = await sql<AccountTransactionRow>`
    WITH account_running AS (
      SELECT
        t.id,
        SUM(t.amount) OVER () - COALESCE(
          SUM(t.amount) OVER (
            ORDER BY t.transaction_date DESC, t.created_at DESC, t.id DESC
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0
        ) AS running_account_balance
      FROM transactions t
      WHERE t.account_id = ${accountId}
        AND t.parent_transaction_id IS NULL
    )
    SELECT
      t.id,
      t.uuid,
      t.description,
      t.amount,
      t.type,
      t.status,
      t.review_status,
      t.transaction_date::TEXT as transaction_date,
      t.budget_item_id,
      t.budget_period_id,
      t.budget_period_item_id,
      t.merchant_id,
      t.is_split_parent,
      t.parent_transaction_id,
      t.created_at,
      t.updated_at,
      a.name as account_name,
      a.type as account_class,
      bi.name as budget_item_name,
      bp.name as budget_period_name,
      bi_from_bpi.name as budget_period_item_name,
      m.name as merchant_name,
      ar.running_account_balance
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN budget_items bi ON t.budget_item_id = bi.id
    LEFT JOIN budget_period bp ON t.budget_period_id = bp.id
    LEFT JOIN budget_period_items bpi ON t.budget_period_item_id = bpi.id
    LEFT JOIN budget_items bi_from_bpi ON bpi.budget_item_id = bi_from_bpi.id
    LEFT JOIN merchants m ON t.merchant_id = m.id
    LEFT JOIN account_running ar ON ar.id = t.id
    WHERE ${whereClause}
    ORDER BY t.transaction_date DESC, t.created_at DESC, t.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `.execute(getDb());

  logger.debug({ accountId, rows: transactionsResult.rows.length, total }, 'Read an account register page');

  // A null amount or balance parses as NaN, which reads as 0.
  const transactions = transactionsResult.rows.map((transaction) => ({
    ...transaction,
    amount: parseFloat(transaction.amount ?? '') || 0,
    running_account_balance: parseFloat(transaction.running_account_balance ?? '') || 0,
  }));
  return { transactions, total };
}
