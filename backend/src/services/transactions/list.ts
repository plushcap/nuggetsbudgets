import { sql, type RawBuilder, type Selectable } from 'kysely';
import type { TransactionFilterQuery } from '@nuggets/shared';
import type { Transactions } from '../../db/schema.generated.js';
import { getDb } from '../../db/withTenant.js';
// `%term%` for ILIKE, with the term's own %, _ and \ matched as themselves.
import { containsPattern } from '../../utils/likePattern.js';
import { transactionIdByUuid } from './lookup.js';
import { oneRow } from '../../utils/present.js';

/**
 * Reading transactions: the filtered lists (GET /api/transactions and its /paginated
 * page), one transaction with its names, tags and splits, and its attachments.
 */

/**
 * A list's query string, as validateQuery parsed it (transactionListQuerySchema /
 * transactionPageQuerySchema in @nuggets/shared): each filter text, checked, or absent.
 */
export type ListQuery = TransactionFilterQuery;

/** GET /'s query: the shared filters, and its own. */
type ListOnlyQuery = ListQuery & { include_children?: string | undefined; start_date?: string | undefined; end_date?: string | undefined };
/** GET /paginated's query: the shared filters, and the Tasks page's. */
type PageOnlyQuery = ListQuery & { exclude_unassigned?: string | undefined; assigned_to_or_unassigned?: string | undefined };

// Tag object shape produced by the jsonb_agg aggregations below.
type TagJson = {
  id: number;
  uuid: string | null;
  name: string;
  color: string | null;
  icon: string | null;
};

/** A row of the list queries (GET / and GET /paginated), in the order they select it. */
export interface TransactionListRow {
  id: number;
  uuid: string | null;
  description: string | null;
  amount: string;
  type: string;
  status: string | null;
  review_status: string | null;
  assigned_to: number | null;
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
  account_uuid: string | null;
  /** The account's accounts.type ('Asset' or 'Liability'). Not account_type, which the account answers use for accounts.account_type. */
  account_class: string | null;
  budget_item_name: string | null;
  budget_item_uuid: string | null;
  budget_period_name: string | null;
  budget_period_item_name: string | null;
  merchant_name: string | null;
  assigned_user: string | null;
  tags: TagJson[];
}

/** A row of the paginated list: the list row with its amount as a number. */
export type TransactionPageItem = Omit<TransactionListRow, 'amount'> & { amount: number };

/** One transaction (GET /:uuid): t.* plus joined names and jsonb aggregations. */
export type TransactionDetail = Omit<Selectable<Transactions>, 'transaction_date'> & {
  transaction_date: string; // cast to TEXT in the query
  account_name: string | null;
  account_uuid: string | null;
  /** The account's accounts.type ('Asset' or 'Liability'), as the list rows have it (account_class). */
  account_class: string | null;
  budget_item_name: string | null;
  budget_item_uuid: string | null;
  budget_period_name: string | null;
  budget_period_item_name: string | null;
  merchant_name: string | null;
  assigned_user: string | null;
  parent_transaction_uuid: string | null;
  tags: TagJson[];
  split_children: {
    id: number;
    uuid: string | null;
    amount: number | null;
    description: string | null;
    type: string;
    status: string | null;
    transaction_date: string;
    budget_item_id: number | null;
    budget_period_id: number | null;
    budget_period_item_id: number | null;
    budget_item_name: string | null;
    budget_item_uuid: string | null;
    /** The split's own tags (without them, re-editing the splits sent none, and lost them). */
    tags: TagJson[];
  }[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id of the row of `table` with this uuid, as SQL: NULL for a malformed uuid (or
 * none), so a filter on it matches nothing instead of failing the query.
 */
function idByUuid(table: 'merchants' | 'budget_items' | 'accounts', uuid: unknown) {
  return typeof uuid === 'string' && UUID_PATTERN.test(uuid)
    ? sql`(SELECT x.id FROM ${sql.table(table)} x WHERE x.uuid = ${uuid})`
    : sql`NULL`;
}

/**
 * The filters GET / and GET /paginated share, as `AND …` fragments over `t` alone.
 * A filter on a joined name or uuid is a match on t's foreign key, so the
 * page can be chosen, in order, from transactions before anything is joined or
 * any tag aggregated, and the count needs no join at all.
 *
 * The search matches what the joined names did: the description, the account's,
 * the budget item's, the period item's budget item's or the merchant's name. Under
 * RLS a trigram index can't serve ILIKE (texticlike isn't leakproof, so Postgres
 * won't run it below the tenant policy), so each name arm is a hashed lookup of
 * the few matching ids rather than a join of every row.
 *
 * The description, the one column of the large table, is matched with
 * `strpos(lower(…), lower(term)) > 0` rather than ILIKE: ILIKE on a multibyte
 * database lowercases both sides and matches the pattern (Postgres's like.c), so the two
 * answer the same, `%`, `_` and `\` in the term included (strpos has no wildcards to
 * escape), but strpos skips the pattern matcher: the count of a 50,000-row ledger, under
 * RLS, took about a fifth less time. transactionSearch.db.test.ts checks they agree.
 */
export function listFilters(query: ListQuery): RawBuilder<unknown>[] {
  const term = query.search ?? null;
  const search = term === null ? null : containsPattern(term);
  return [
    search
      ? sql` AND (
          strpos(lower(t.description), lower(${term})) > 0
          OR t.account_id IN (SELECT a.id FROM accounts a WHERE a.name ILIKE ${search})
          OR t.budget_item_id IN (SELECT bi.id FROM budget_items bi WHERE bi.name ILIKE ${search})
          OR t.budget_period_item_id IN (
            SELECT bpi.id FROM budget_period_items bpi
              JOIN budget_items bi ON bi.id = bpi.budget_item_id
             WHERE bi.name ILIKE ${search})
          OR t.merchant_id IN (SELECT m.id FROM merchants m WHERE m.name ILIKE ${search})
        )`
      : sql``,
    query.review_status && query.review_status !== 'all' ? sql` AND t.review_status = ${query.review_status}` : sql``,
    query.date_from ? sql` AND t.transaction_date >= ${query.date_from}` : sql``,
    query.date_to ? sql` AND t.transaction_date <= ${query.date_to}` : sql``,
    query.type && query.type !== 'all' ? sql` AND t.type = ${query.type}` : sql``,
    query.budget_period_id ? sql` AND t.budget_period_id = ${parseInt(query.budget_period_id, 10)}` : sql``,
    query.budget_item_id ? sql` AND t.budget_item_id = ${parseInt(query.budget_item_id, 10)}` : sql``,
    // The MCP list_transactions tool filters by these; they were ignored, so its
    // merchant and budget item filters answered every transaction.
    query.budget_item_uuid ? sql` AND t.budget_item_id = ${idByUuid('budget_items', query.budget_item_uuid)}` : sql``,
    query.merchant_id ? sql` AND t.merchant_id = ${parseInt(query.merchant_id, 10)}` : sql``,
    query.merchant_uuid ? sql` AND t.merchant_id = ${idByUuid('merchants', query.merchant_uuid)}` : sql``,
    // Amount range filters (using absolute value for comparison)
    query.amount_min ? sql` AND ABS(t.amount) >= ${parseFloat(query.amount_min)}` : sql``,
    query.amount_max ? sql` AND ABS(t.amount) <= ${parseFloat(query.amount_max)}` : sql``,
    query.account_id ? sql` AND t.account_id = ${parseInt(query.account_id, 10)}` : sql``,
    // Account UUID filter (the account detail page); a value that isn't a uuid names no
    // account, so it matches nothing (it was cast, a 500).
    query.account_uuid ? sql` AND t.account_id = ${idByUuid('accounts', query.account_uuid)}` : sql``,
    query.assigned_to ? sql` AND t.assigned_to = ${parseInt(query.assigned_to, 10)}` : sql``,
  ];
}

/**
 * One page of the transaction list, newest first: chosen from transactions alone
 * (idx_transactions_list_order walks it in order), then the names joined and the
 * tags aggregated for its rows only. `id` breaks ties, so a bulk import's
 * rows, which share created_at, page without repeats or gaps.
 */
export function listPage(filters: RawBuilder<unknown>[], limit: number, offset: number) {
  return sql<TransactionListRow>`
    WITH page AS (
      SELECT t.id, t.uuid, t.description, t.amount, t.type, t.status, t.review_status, t.assigned_to,
             t.transaction_date, t.account_id, t.budget_item_id, t.budget_period_id, t.budget_period_item_id,
             t.merchant_id, t.is_split_parent, t.parent_transaction_id, t.created_at, t.updated_at
        FROM transactions t
       WHERE 1=1 ${sql.join(filters, sql``)}
       ORDER BY t.transaction_date DESC, t.created_at DESC, t.id DESC
       LIMIT ${limit} OFFSET ${offset}
    )
    SELECT
      p.id,
      p.uuid,
      p.description,
      p.amount,
      p.type,
      p.status,
      p.review_status,
      p.assigned_to,
      p.transaction_date::TEXT as transaction_date,
      p.budget_item_id,
      p.budget_period_id,
      p.budget_period_item_id,
      p.merchant_id,
      p.is_split_parent,
      p.parent_transaction_id,
      p.created_at,
      p.updated_at,
      a.name as account_name,
      a.uuid as account_uuid,
      a.type as account_class,
      bi.name as budget_item_name,
      bi.uuid as budget_item_uuid,
      bp.name as budget_period_name,
      bi_from_bpi.name as budget_period_item_name,
      m.name as merchant_name,
      u_assigned.first_name || ' ' || u_assigned.last_name as assigned_user,
      COALESCE(
        (SELECT jsonb_agg(
                  DISTINCT jsonb_build_object(
                    'id', tags.id,
                    'uuid', tags.uuid,
                    'name', tags.name,
                    'color', tags.color,
                    'icon', tags.icon
                  )
                )
           FROM taggings
           JOIN tags ON tags.id = taggings.tag_id
          WHERE taggings.taggable_type = 'transaction'
            AND taggings.taggable_id = p.id),
        '[]'::jsonb
      ) as tags
    FROM page p
    LEFT JOIN accounts a ON p.account_id = a.id
    LEFT JOIN budget_items bi ON p.budget_item_id = bi.id
    LEFT JOIN budget_period bp ON p.budget_period_id = bp.id
    LEFT JOIN budget_period_items bpi ON p.budget_period_item_id = bpi.id
    LEFT JOIN budget_items bi_from_bpi ON bpi.budget_item_id = bi_from_bpi.id
    LEFT JOIN merchants m ON p.merchant_id = m.id
    LEFT JOIN users u_assigned ON p.assigned_to = u_assigned.id
    ORDER BY p.transaction_date DESC, p.created_at DESC, p.id DESC
  `;
}

/**
 * GET /api/transactions: up to `limit` transactions, newest first, with the shared
 * filters and this list's own. `truncated` when the limit was reached, so the caller
 * can say the list may go on. Every filter is on a column of t, so the page is chosen
 * before anything is joined.
 */
export async function listTransactions(
  query: ListOnlyQuery,
  limit: number,
): Promise<{ rows: TransactionListRow[]; truncated: boolean }> {
  const filters = [
    // CRITICAL: Exclude child transactions from main list (unless explicitly requested)
    // Budget item views need children to show split allocations
    query.include_children !== 'true' ? sql` AND t.parent_transaction_id IS NULL` : sql``,
    // merchant_uuid and budget_item_uuid are among these: a value that isn't a uuid
    // names nothing, so it matches nothing (a second copy here cast it, a 500).
    ...listFilters(query),
    // Date range filters (inclusive). Lets callers fetch only a recent window
    // instead of all history (e.g. the budget item / tag detail pages).
    query.start_date ? sql` AND t.transaction_date >= ${query.start_date}` : sql``,
    query.end_date ? sql` AND t.transaction_date <= ${query.end_date}` : sql``,
  ];
  const result = await listPage(filters, limit, 0).execute(getDb());
  return { rows: result.rows, truncated: result.rows.length === limit };
}

/**
 * GET /api/transactions/paginated: one page of the ledger's transactions (never a
 * split's children), and how many there are. The total comes from transactions
 * alone: the filters need no join.
 */
export async function listTransactionsPage(
  query: PageOnlyQuery,
  limit: number,
  offset: number,
): Promise<{ transactions: TransactionPageItem[]; total: number }> {
  const filters = [
    sql` AND t.parent_transaction_id IS NULL`,
    ...listFilters(query),
    // Exclude unassigned filter (show only assigned tasks)
    query.exclude_unassigned === 'true' ? sql` AND t.assigned_to IS NOT NULL` : sql``,
    // Assigned to user OR unassigned filter (for Tasks page)
    query.assigned_to_or_unassigned
      ? sql` AND (t.assigned_to = ${parseInt(query.assigned_to_or_unassigned, 10)} OR t.assigned_to IS NULL)`
      : sql``,
  ];

  const countResult = await sql<{ total: string }>`
    SELECT COUNT(*) AS total FROM transactions t WHERE 1=1 ${sql.join(filters, sql``)}
  `.execute(getDb());
  const total = parseInt(oneRow(countResult.rows, 'count(*)').total);

  const page = await listPage(filters, limit, offset).execute(getDb());
  return {
    transactions: page.rows.map((row) => ({ ...row, amount: parseFloat(row.amount) })),
    total,
  };
}

/** One transaction with its names, tags and splits (each with its own tags), or null when there is none. */
export async function getTransactionDetail(uuid: string): Promise<TransactionDetail | null> {
  const transactionId = await transactionIdByUuid(uuid);
  if (!transactionId) return null;

  // Multi-join select with correlated jsonb_agg subqueries — kept as raw sql
  const result = await sql<TransactionDetail>`
    SELECT
      t.*,
      t.transaction_date::TEXT as transaction_date, -- Ensure date is returned as YYYY-MM-DD string
      a.name as account_name,
      a.uuid as account_uuid,
      a.type as account_class,
      bi.name as budget_item_name,
      bi.uuid as budget_item_uuid,
      bp.name as budget_period_name,
      bi_from_bpi.name as budget_period_item_name,
      m.name as merchant_name,
      u_assigned.first_name || ' ' || u_assigned.last_name as assigned_user,
      parent_t.uuid as parent_transaction_uuid,
      COALESCE(
        (SELECT jsonb_agg(
          jsonb_build_object(
            'id', tags.id,
            'uuid', tags.uuid,
            'name', tags.name,
            'color', tags.color,
            'icon', tags.icon
          )
        )
        FROM taggings
        INNER JOIN tags ON taggings.tag_id = tags.id
        WHERE taggings.taggable_type = 'transaction'
          AND taggings.taggable_id = t.id
        ), '[]'::jsonb
      ) as tags,
      COALESCE(
        (SELECT jsonb_agg(
          jsonb_build_object(
            'id', c.id,
            'uuid', c.uuid,
            'amount', c.amount,
            'description', c.description,
            'type', c.type,
            'status', c.status,
            'transaction_date', c.transaction_date::TEXT,
            'budget_item_id', c.budget_item_id,
            'budget_period_id', c.budget_period_id,
            'budget_period_item_id', c.budget_period_item_id,
            'budget_item_name', bi_child.name,
            'budget_item_uuid', bi_child.uuid,
            'tags', COALESCE(
              (SELECT jsonb_agg(
                jsonb_build_object(
                  'id', child_tag.id,
                  'uuid', child_tag.uuid,
                  'name', child_tag.name,
                  'color', child_tag.color,
                  'icon', child_tag.icon
                ) ORDER BY child_tag.name, child_tag.id
              )
              FROM taggings child_tagging
              INNER JOIN tags child_tag ON child_tagging.tag_id = child_tag.id
              WHERE child_tagging.taggable_type = 'transaction'
                AND child_tagging.taggable_id = c.id
              ), '[]'::jsonb
            )
          ) ORDER BY c.id
        )
        FROM transactions c
        LEFT JOIN budget_items bi_child ON c.budget_item_id = bi_child.id
        WHERE c.parent_transaction_id = t.id
        ), '[]'::jsonb
      ) as split_children
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN budget_items bi ON t.budget_item_id = bi.id
    LEFT JOIN budget_period bp ON t.budget_period_id = bp.id
    LEFT JOIN budget_period_items bpi ON t.budget_period_item_id = bpi.id
    LEFT JOIN budget_items bi_from_bpi ON bpi.budget_item_id = bi_from_bpi.id
    LEFT JOIN merchants m ON t.merchant_id = m.id
    LEFT JOIN users u_assigned ON t.assigned_to = u_assigned.id
    LEFT JOIN transactions parent_t ON t.parent_transaction_id = parent_t.id
    WHERE t.id = ${transactionId}
  `.execute(getDb());
  return result.rows[0] ?? null;
}

/** A transaction's attachments, newest first, or null when there is no such transaction. */
export async function listTransactionAttachments(uuid: string) {
  const transactionId = await transactionIdByUuid(uuid);
  if (!transactionId) return null;
  return getDb()
    .selectFrom('attachments')
    .select([
      'uuid', 'name', 'original_filename', 'safe_filename', 'file_extension',
      'file_size', 'mime_type', 'date_uploaded', 'bill_date', 'notes',
      'attachment_type', 'created_at'
    ])
    .where('transaction_id', '=', transactionId)
    .orderBy('created_at', 'desc')
    .execute();
}
