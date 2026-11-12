import { sql, type RawBuilder } from 'kysely';
import { getDb, withTenant } from '../../db/withTenant.js';
import { appToday } from '../../utils/appDate.js';
import { accountNotFound } from '../accounts/AccountError.js';
import { centsToAmount, numericToCents } from '../../utils/money.js';

/**
 * The active ledger's data as CSV exports (the Data Export page, and the merchants export on
 * the merchant page): what each export reads, its columns and its file name. Every query runs
 * on getDb() in a transaction of ledger `tenantId`, so RLS keeps each export to that ledger.
 *
 * An export is read in two steps, each in short transactions, none open while the route sends
 * what was read (the export used to stream inside the request's transaction, so a slow
 * client held its pool connection idle in it, up to the 5-minute limit):
 *   1. its rows' ids, in the export's order (one unique key, so the order is the same however
 *      the rows are read), in one transaction: which rows the export holds, and in what order,
 *      is fixed there;
 *   2. the rows of those ids, EXPORT_BATCH_ROWS at a time ({@link CsvExport}'s `batches`),
 *      each batch in a transaction of its own. So an export of any size holds its ids and one
 *      batch in memory, and statement_timeout bounds each read rather than the whole export;
 *      the route writes each batch before the next is read (routes/export.ts streamCsv).
 *      A row deleted between the two steps is left out; each row is as it stood when its batch
 *      was read.
 *
 * Cell formats: money is the NUMERIC text pg returns (never a float); a calendar date
 * (`date`) is YYYY-MM-DD; an instant (`timestamptz`) is ISO-8601 in UTC, as the JSON API
 * writes it. Cell escaping (RFC-4180 quoting, formula-injection guard) is in @nuggets/shared's csv.ts.
 */

/**
 * A calendar date column as YYYY-MM-DD, whatever the session's DateStyle. Read as a
 * timestamp without time zone, so no zone is ever applied to the day.
 */
const calendarDate = (column: string): RawBuilder<string | null> =>
  sql<string | null>`to_char(${sql.ref(column)}::timestamp, 'YYYY-MM-DD')`;

/** An instant column as ISO-8601 UTC (2026-06-14T23:40:00.000Z), whatever the session's TimeZone. */
const instant = (column: string): RawBuilder<string | null> =>
  sql<string | null>`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The names of the tags on a transaction or budget item, comma-separated ('' for none). */
const tagNames = (taggableType: 'transaction' | 'budget_item', idColumn: string): RawBuilder<string> => sql<string>`
  COALESCE(
    (SELECT STRING_AGG(tags.name, ', ' ORDER BY tags.name)
       FROM taggings
       JOIN tags ON taggings.tag_id = tags.id
      WHERE taggings.taggable_type = ${taggableType}
        AND taggings.taggable_id = ${sql.ref(idColumn)}),
    ''
  )`;

const dateFilter = ({ start, end }: { start?: string; end?: string }): RawBuilder<unknown> => sql`
  ${start ? sql` AND t.transaction_date >= ${start}::date` : sql``}
  ${end ? sql` AND t.transaction_date <= ${end}::date` : sql``}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rows an export reads at a time: the most of it held in memory at once. */
export const EXPORT_BATCH_ROWS = 1000;

/** An export: its file name, its columns in order, and its rows a batch at a time. */
export interface CsvExport {
  filename: string;
  headers: readonly string[];
  /**
   * The rows, EXPORT_BATCH_ROWS at a time, in the export's order, each batch read in a
   * transaction of its own when it is asked for: the first batch is read at the first next()
   * (empty for an export with no rows). Stopping early (the client went away) reads no more.
   */
  batches: AsyncGenerator<Record<string, unknown>[], void, undefined>;
}

/** Which rows an export holds, in its order: their ids (an `integer[]`, `'{}'` for none). */
type ExportKeys = { ids: number[] };

/**
 * The rows `rowsOf` reads for each slice of `ids` (`from` to `to`, in order), a batch at a
 * time, each in a short transaction of ledger `tenantId`.
 */
async function* batchesOf(
  tenantId: number,
  ids: readonly number[],
  rowsOf: (from: number, to: number) => RawBuilder<Record<string, unknown>>
): AsyncGenerator<Record<string, unknown>[], void, undefined> {
  let from = 0;
  do {
    const to = Math.min(from + EXPORT_BATCH_ROWS, ids.length);
    const rows = to > from ? (await withTenant(tenantId, () => rowsOf(from, to).execute(getDb()))).rows : [];
    yield rows;
    from = to;
  } while (from < ids.length);
}

/** A row of an account's export as its batch reads it: its columns, and what its balance needs. */
type AccountExportRow = Record<string, unknown> & { export_counts: boolean; export_anchor: string | null; amount: string };

/**
 * An account export's rows, a batch at a time (ExportService.accountTransactions), each with
 * the balance after it: the first row's read with the first batch, each later one the one
 * above it less the amount of the row above (none for a split child).
 */
async function* accountBatches(
  tenantId: number,
  accountId: number,
  ids: readonly number[]
): AsyncGenerator<Record<string, unknown>[], void, undefined> {
  // The balance after the next row written, in cents; null until the first row is read.
  let balance: number | null = null;
  let from = 0;
  do {
    const to = Math.min(from + EXPORT_BATCH_ROWS, ids.length);
    let rows: AccountExportRow[] = [];
    if (to > from) {
      // Until the anchor is read: the balance after the first row read, the account's sum of
      // every row at or older than it, in the statement that reads its amount (one snapshot).
      // CASE runs the sum for that row alone.
      const anchor = balance === null
        ? sql`CASE WHEN k.ord = MIN(k.ord) OVER () THEN (
            SELECT COALESCE(SUM(a.amount) FILTER (WHERE a.parent_transaction_id IS NULL), 0)
            FROM transactions a
            WHERE a.account_id = ${accountId}
              AND (a.transaction_date, a.created_at, a.id) <= (t.transaction_date, t.created_at, t.id)
          )::text END`
        : sql`NULL::text`;
      rows = (await withTenant(tenantId, () => sql<AccountExportRow>`
        SELECT ${transactionColumns}, (t.parent_transaction_id IS NULL) AS export_counts, ${anchor} AS export_anchor
        FROM ${keyRows(ids, from, to)}
        JOIN transactions t ON t.id = k.id AND t.account_id = ${accountId}
        ${transactionJoins}
        ORDER BY k.ord
      `.execute(getDb()))).rows;
      if (balance === null && rows[0]) balance = numericToCents(rows[0].export_anchor);
    }
    yield rows.map((row) => {
      const columns: Record<string, unknown> = { ...row, running_balance: centsToAmount(balance ?? 0) };
      delete columns.export_anchor;
      delete columns.export_counts;
      if (row.export_counts) balance = (balance ?? 0) - numericToCents(row.amount);
      return columns;
    });
    from = to;
  } while (from < ids.length);
}

/** The ids `ids.slice(from, to)` as the `k(id, ord)` rows a batch joins its table to, in order. */
const keyRows = (ids: readonly number[], from: number, to: number) =>
  sql`unnest(${ids.slice(from, to)}::int[]) WITH ORDINALITY AS k(id, ord)`;

/** An inclusive range of calendar days; either end open. */
export interface DayRange {
  start?: string;
  end?: string;
}

// Columns shared by the transaction exports, with the joins they read.
const transactionColumns = sql`
  t.uuid,
  ${calendarDate('t.transaction_date')} AS transaction_date,
  t.description,
  m.name AS merchant_name,
  t.amount,
  t.type,
  t.status,
  t.review_status,
  t.notes,
  t.import_pending AS pending,
  bp.name AS budget_period_name,
  COALESCE(bi.name, bi_from_bpi.name) AS budget_item_name,
  NULLIF(concat_ws(' ', u_assigned.first_name, u_assigned.last_name), '') AS assigned_to,
  ${tagNames('transaction', 't.id')} AS tags,
  t.import_description,
  ${instant('t.import_posted_date')} AS import_posted_date,
  ${instant('t.import_transacted_at')} AS import_transacted_at,
  t.import_provider,
  t.import_transaction_id,
  ${instant('t.import_imported_at')} AS import_imported_at,
  ${instant('t.created_at')} AS created_at,
  ${instant('t.updated_at')} AS updated_at`;

const transactionJoins = sql`
  LEFT JOIN budget_items bi ON t.budget_item_id = bi.id
  LEFT JOIN budget_period bp ON t.budget_period_id = bp.id
  LEFT JOIN budget_period_items bpi ON t.budget_period_item_id = bpi.id
  LEFT JOIN budget_items bi_from_bpi ON bpi.budget_item_id = bi_from_bpi.id
  LEFT JOIN merchants m ON t.merchant_id = m.id
  LEFT JOIN users u_assigned ON t.assigned_to = u_assigned.id`;

const TRANSACTION_HEADERS = [
  'uuid',
  'transaction_date',
  'description',
  'merchant_name',
  'amount',
  'type',
  'account_name',
  'budget_period_name',
  'budget_item_name',
  'assigned_to',
  'tags',
  'status',
  'review_status',
  'notes',
  'pending',
  'import_description',
  'import_posted_date',
  'import_transacted_at',
  'import_provider',
  'import_transaction_id',
  'import_imported_at',
  'created_at',
  'updated_at',
] as const;


const ACCOUNT_TRANSACTION_HEADERS = [
  'uuid',
  'transaction_date',
  'description',
  'merchant_name',
  'amount',
  'running_balance',
  'type',
  'budget_period_name',
  'budget_item_name',
  'assigned_to',
  'tags',
  'status',
  'review_status',
  'notes',
  'pending',
  'import_description',
  'import_posted_date',
  'import_transacted_at',
  'import_provider',
  'import_transaction_id',
  'import_imported_at',
  'created_at',
  'updated_at',
] as const;

const BUDGET_ITEM_HEADERS = [
  'uuid',
  'name',
  'expense_type',
  'priority',
  'type',
  'subtype',
  'description',
  'category_name',
  'merchant_name',
  'rollover',
  'rollover_target_amount',
  'rollover_target_date',
  'rollover_starting_balance',
  'rollover_starting_balance_date',
  'default_budget_amount',
  'isbill',
  'recurring_payment',
  'recurring_payment_amount',
  'recurring_payment_frequency',
  'recurring_last_payment_date',
  'recurring_next_payment_date',
  'recurring_amount_varies',
  'goal_target_amount',
  'goal_target_date',
  'icon',
  'color',
  'status',
  'tags',
  'created_at',
  'updated_at',
] as const;

const ACCOUNT_HEADERS = [
  'uuid',
  'name',
  'account_type',
  'account_group',
  'type',
  'subtype',
  'institution_name',
  'account_number',
  'routing_number',
  'balance',
  'import_balance',
  'import_available_balance',
  'import_balance_date',
  'exclude_account_balance',
  'hide_account',
  'hide_transactions',
  'close_account',
  'is_envelope_account',
  'require_zero_balance',
  'custom_sort',
  'notes',
  'created_at',
  'updated_at',
] as const;

const MERCHANT_HEADERS = [
  'id',
  'uuid',
  'name',
  'merchant_website',
  'merchant_accountid',
  'merchant_image',
  'notes',
  'instructions',
  'auto_tag_name',
  'transaction_count',
  'total_transaction_amount',
  'first_transaction_date',
  'last_transaction_date',
  'rule_count',
  'matching_rules',
  'created_at',
  'updated_at',
] as const;

/** The CSV exports of the active ledger's data. */
export class ExportService {
  /** Every transaction of ledger `tenantId`, newest first. */
  async transactions(tenantId: number, range: DayRange): Promise<CsvExport> {
    const { ids, today } = await withTenant(tenantId, async () => {
      const { rows } = await sql<ExportKeys>`
        SELECT COALESCE(array_agg(t.id ORDER BY t.transaction_date DESC, t.created_at DESC, t.id DESC), '{}') AS ids
        FROM transactions t
        WHERE true ${dateFilter(range)}
      `.execute(getDb());
      return { ids: rows[0]?.ids ?? [], today: await appToday() };
    });

    return {
      filename: `transactions_${range.start || 'all'}_to_${range.end || 'all'}_${today}.csv`,
      headers: TRANSACTION_HEADERS,
      batches: batchesOf(tenantId, ids, (from, to) => sql<Record<string, unknown>>`
        SELECT ${transactionColumns}, a.name AS account_name
        FROM ${keyRows(ids, from, to)}
        JOIN transactions t ON t.id = k.id
        LEFT JOIN accounts a ON t.account_id = a.id
        ${transactionJoins}
        ORDER BY k.ord
      `),
    };
  }

  /**
   * One account's transactions, newest first, with the balance after each; a 404 for an
   * account the ledger hasn't (or an id that isn't a uuid).
   *
   * The balance after each row is worked out as the rows are written, from the amounts the
   * file holds, so the file agrees with itself however the account changes during the
   * download. It is anchored on the export's first row: the balance after it, read in the
   * statement that reads the first batch, as the account's sum of every row at or older
   * than it (so a date-ranged export still shows the true balance; an export of the
   * whole account starts at the account's balance then). Each later row's balance is the one
   * above it less the amount of the row above (split children count nothing: their parent
   * carries the amount; amounts are pre-signed, so a balance is a plain sum), in integer cents.
   * A row deleted, or moved to another account, before its batch is read is left out, as if it
   * had never been there. Worked out in the database per row, as before, a row's balance came
   * from the moment of one read and its amount from another's, and could disagree with them.
   */
  async accountTransactions(tenantId: number, accountUuid: string, range: DayRange): Promise<CsvExport> {
    const { account, ids, today } = await withTenant(tenantId, async () => {
      const account = UUID_RE.test(accountUuid)
        ? await getDb().selectFrom('accounts').select(['id', 'name']).where('uuid', '=', accountUuid).executeTakeFirst()
        : undefined;
      if (!account) throw accountNotFound();
      const { rows } = await sql<ExportKeys>`
        SELECT COALESCE(array_agg(t.id ORDER BY t.transaction_date DESC, t.created_at DESC, t.id DESC), '{}') AS ids
        FROM transactions t
        WHERE t.account_id = ${account.id} ${dateFilter(range)}
      `.execute(getDb());
      return { account, ids: rows[0]?.ids ?? [], today: await appToday() };
    });

    return {
      filename: `${account.name.replace(/[^a-zA-Z0-9]/g, '_')}_transactions_${range.start || 'all'}_to_${range.end || 'all'}_${today}.csv`,
      headers: ACCOUNT_TRANSACTION_HEADERS,
      batches: accountBatches(tenantId, account.id, ids),
    };
  }

  /** Every budget item, with its uuid for import mapping. */
  async budgetItems(tenantId: number): Promise<CsvExport> {
    const { ids, today } = await withTenant(tenantId, async () => {
      const { rows } = await sql<ExportKeys>`
        SELECT COALESCE(array_agg(bi.id ORDER BY bi.name ASC, bi.id ASC), '{}') AS ids FROM budget_items bi
      `.execute(getDb());
      return { ids: rows[0]?.ids ?? [], today: await appToday() };
    });
    const query = (from: number, to: number) => sql<Record<string, unknown>>`
      SELECT
        bi.uuid,
        bi.name,
        bi.expense_type,
        bi.priority,
        bi.type,
        bi.subtype,
        bi.description,
        c.name AS category_name,
        m.name AS merchant_name,
        bi.rollover,
        bi.rollover_target_amount,
        ${calendarDate('bi.rollover_target_date')} AS rollover_target_date,
        bi.rollover_starting_balance,
        ${calendarDate('bi.rollover_starting_balance_date')} AS rollover_starting_balance_date,
        bi.default_budget_amount,
        bi.isbill,
        bi.recurring_payment,
        bi.recurring_payment_amount,
        bi.recurring_payment_frequency,
        ${calendarDate('bi.recurring_last_payment_date')} AS recurring_last_payment_date,
        ${calendarDate('bi.recurring_next_payment_date')} AS recurring_next_payment_date,
        bi.recurring_amount_varies,
        bi.goal_target_amount,
        ${calendarDate('bi.goal_target_date')} AS goal_target_date,
        bi.icon,
        bi.color,
        bi.status,
        ${tagNames('budget_item', 'bi.id')} AS tags,
        ${instant('bi.created_at')} AS created_at,
        ${instant('bi.updated_at')} AS updated_at
      FROM ${keyRows(ids, from, to)}
      JOIN budget_items bi ON bi.id = k.id
      LEFT JOIN categories c ON bi.category_id = c.id
      LEFT JOIN merchants m ON bi.merchant_id = m.id
      ORDER BY k.ord
    `;

    return { filename: `budget_items_${today}.csv`, headers: BUDGET_ITEM_HEADERS, batches: batchesOf(tenantId, ids, query) };
  }

  /**
   * Every account (hidden and closed too), with its uuid for import mapping. `balance` is the
   * ledger's balance as the Accounts page shows it: calculate_account_balance, the one balance
   * definition. The import_* balances are what the bank last reported through the
   * bank import.
   */
  async accounts(tenantId: number): Promise<CsvExport> {
    const { ids, today } = await withTenant(tenantId, async () => {
      const { rows } = await sql<ExportKeys>`
        SELECT COALESCE(array_agg(a.id ORDER BY a.custom_sort NULLS LAST, a.name ASC, a.id ASC), '{}') AS ids FROM accounts a
      `.execute(getDb());
      return { ids: rows[0]?.ids ?? [], today: await appToday() };
    });
    const query = (from: number, to: number) => sql<Record<string, unknown>>`
      SELECT
        a.uuid,
        a.name,
        a.account_type,
        a.account_group,
        a.type,
        a.subtype,
        ai.name AS institution_name,
        a.account_number,
        a.routing_number,
        calculate_account_balance(a.id)::numeric(12,2) AS balance,
        a.import_balance,
        a.import_available_balance,
        ${instant('a.import_balance_date')} AS import_balance_date,
        a.exclude_account_balance,
        a.hide_account,
        a.hide_transactions,
        a.close_account,
        a.is_envelope_account,
        a.require_zero_balance,
        a.custom_sort,
        a.notes,
        ${instant('a.created_at')} AS created_at,
        ${instant('a.updated_at')} AS updated_at
      FROM ${keyRows(ids, from, to)}
      JOIN accounts a ON a.id = k.id
      LEFT JOIN account_institutions ai ON a.institution_id = ai.id
      ORDER BY k.ord
    `;

    return { filename: `accounts_${today}.csv`, headers: ACCOUNT_HEADERS, batches: batchesOf(tenantId, ids, query) };
  }

  /**
   * Every merchant with its transaction count, total and date range, and its matching rules
   * (for deduplication). Transactions and rules are aggregated separately so neither
   * multiplies the other, and a split counts once, as its parent (its children inherit the
   * merchant).
   */
  async merchants(tenantId: number): Promise<CsvExport> {
    const { ids, today } = await withTenant(tenantId, async () => {
      const { rows } = await sql<ExportKeys>`
        SELECT COALESCE(array_agg(m.id ORDER BY m.name ASC, m.id ASC), '{}') AS ids FROM merchants m
      `.execute(getDb());
      return { ids: rows[0]?.ids ?? [], today: await appToday() };
    });
    const query = (from: number, to: number) => sql<Record<string, unknown>>`
      SELECT
        m.id,
        m.uuid,
        m.name,
        m.merchant_website,
        m.merchant_accountid,
        m.merchant_image,
        m.notes,
        m.instructions,
        tg.name AS auto_tag_name,
        tx.transaction_count,
        COALESCE(tx.total_amount, 0.00) AS total_transaction_amount,
        ${calendarDate('tx.first_date')} AS first_transaction_date,
        ${calendarDate('tx.last_date')} AS last_transaction_date,
        rules.rule_count,
        COALESCE(rules.matching_rules, '') AS matching_rules,
        ${instant('m.created_at')} AS created_at,
        ${instant('m.updated_at')} AS updated_at
      FROM ${keyRows(ids, from, to)}
      JOIN merchants m ON m.id = k.id
      LEFT JOIN tags tg ON m.transaction_auto_tag_id = tg.id
      CROSS JOIN LATERAL (
        SELECT
          COUNT(*)::int AS transaction_count,
          SUM(t.amount) AS total_amount,
          MIN(t.transaction_date) AS first_date,
          MAX(t.transaction_date) AS last_date
        FROM transactions t
        WHERE t.merchant_id = m.id AND t.parent_transaction_id IS NULL
      ) tx
      CROSS JOIN LATERAL (
        SELECT
          COUNT(*)::int AS rule_count,
          STRING_AGG(mr.method || ':' || mr.matching_text, ' | ' ORDER BY mr.method, mr.matching_text) AS matching_rules
        FROM merchant_matching_rules mr
        WHERE mr.merchant_id = m.id
      ) rules
      ORDER BY k.ord
    `;

    return { filename: `merchants_${today}.csv`, headers: MERCHANT_HEADERS, batches: batchesOf(tenantId, ids, query) };
  }
}
