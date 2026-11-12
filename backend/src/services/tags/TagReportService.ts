import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { tagNotFound, tagSummaryNotFound } from './TagError.js';
import { centsToNumber, numericToCents } from '../../utils/money.js';
import { tagAndDescendantIds, tagIdOf } from './TagService.js';
import { oneRow } from '../../utils/present.js';

/** A report's optional range: inclusive calendar days (YYYY-MM-DD). */
export interface DateRange {
  start?: string;
  end?: string;
}

export type TimeSeriesBucket = 'day' | 'week' | 'month';

/**
 * The range filter of the tag reports, on the transaction's own calendar date
 * (inclusive), never on when the row was written (synced_transactiondate).
 */
const transactionDateFilter = ({ start, end }: DateRange) => sql`
  ${start ? sql` AND t.transaction_date >= ${start}::date` : sql``}
  ${end ? sql` AND t.transaction_date <= ${end}::date` : sql``}`;

/**
 * A transaction of a tag's report as the tag's transaction list answers it: a row of the
 * shared transaction list (`transactionResponseSchema`), which the page's table shows; its
 * merchant, period item and instants were missing from it.
 */
export interface TagTransactionRow {
  id: number;
  uuid: string | null;
  description: string | null;
  amount: string | null;
  type: string;
  status: string | null;
  review_status: string | null;
  assigned_to: number | null;
  merchant_id: number | null;
  budget_item_id: number | null;
  budget_period_id: number | null;
  budget_period_item_id: number | null;
  transaction_date: string;
  notes: string | null;
  is_split_parent: boolean;
  parent_transaction_id: number | null;
  created_at: Date;
  updated_at: Date | null;
  account_name: string | null;
  account_uuid: string | null;
  merchant_name: string | null;
  merchant_uuid: string | null;
  budget_item_name: string | null;
  budget_item_uuid: string | null;
  budget_period_name: string | null;
  assigned_user: string | null;
  tags: { id: number; uuid: string | null; name: string; color: string | null; icon: string | null }[];
}

/** One slice of a tag's breakdown: a direct sub-tag's branch, or the tag itself (is_parent). */
export interface BreakdownSlice {
  id: number;
  uuid: string;
  name: string;
  color: string | null;
  icon: string | null;
  is_parent: boolean;
  /** The sum of the absolute amounts. */
  value: number;
  /** The sum of the signed amounts. */
  net: number;
  count: number;
}

/** The slice a tag belongs to: the direct sub-tag whose branch it is in, or the viewed tag. */
export type Branch = number | 'parent';

/**
 * Attributes each transaction (its amount and in-hierarchy tag ids) to exactly one
 * slice, with no double counting:
 *   1. Most specific wins: a transaction tagged with a sub-tag (or any descendant of
 *      one) goes to that sub-tag's branch rather than the parent.
 *   2. Parent-only transactions (the viewed tag, no sub-tag branch) go to 'parent'.
 *   3. Ties between sibling branches go to the largest slice, the smaller tag id breaking
 *      an exact tie. Unambiguous transactions are settled first, and every tie is
 *      measured against those totals alone, frozen before any tie is resolved.
 *
 * So the slices don't depend on the order the transactions come in (the query's GROUP BY
 * has no ORDER BY): measured against the totals so far, a tie could go one way or
 * the other depending on which ties came before it. Sums are in cents, so an exact tie is
 * one whatever order its amounts were added in.
 */
export function attributeToBranches(
  transactions: ReadonlyArray<{ amount: number; tagIds: readonly number[] }>,
  branchOfTag: ReadonlyMap<number, Branch>
): Map<Branch, { value: number; net: number; count: number }> {
  // In cents until the end (utils/money.ts).
  const slices = new Map<Branch, { value: number; net: number; count: number }>();
  const addTo = (key: Branch, cents: number) => {
    const slice = slices.get(key) || { value: 0, net: 0, count: 0 };
    slice.value += Math.abs(cents);
    slice.net += cents;
    slice.count += 1;
    slices.set(key, slice);
  };

  // Pass 1: settle unambiguous transactions; collect ties for pass 2.
  const ties: { cents: number; branches: number[] }[] = [];
  for (const { amount: dollars, tagIds } of transactions) {
    const amount = numericToCents(dollars);
    const branches = new Set<number>();
    let hasParent = false;
    for (const tagId of tagIds) {
      const branch = branchOfTag.get(tagId);
      if (branch === 'parent') hasParent = true;
      else if (branch !== undefined) branches.add(branch);
    }
    const [only] = branches;
    if (only !== undefined && branches.size === 1) {
      addTo(only, amount);
    } else if (branches.size > 1) {
      ties.push({ cents: amount, branches: [...branches].sort((a, b) => a - b) });
    } else if (hasParent) {
      addTo('parent', amount);
    }
  }

  // Pass 2: each tie goes to the branch with the largest pass-1 total, the smaller tag id
  // breaking an exact tie (branches are sorted). Frozen first, so resolving one tie
  // doesn't move the next.
  const settled = new Map([...slices].map(([key, slice]) => [key, slice.value]));
  const valueOf = (key: Branch) => settled.get(key) ?? 0;
  for (const tie of ties) {
    const [first, ...others] = tie.branches;
    if (first === undefined) continue;
    let winner = first;
    for (const branch of others) {
      if (valueOf(branch) > valueOf(winner)) winner = branch;
    }
    addTo(winner, tie.cents);
  }

  return new Map(
    [...slices].map(([key, slice]) => [key, { value: centsToNumber(slice.value), net: centsToNumber(slice.net), count: slice.count }])
  );
}

/** The ids of the transactions carrying any of `tagIds`, each once. */
const taggedTransactionIds = (tagIds: number[]) => sql`
  SELECT tg.taggable_id FROM taggings tg
   WHERE tg.taggable_type = 'transaction' AND tg.tag_id = ANY(${tagIds})`;

/**
 * A page of the transactions carrying any of `tagIds` (not split parents), newest first
 * with `id` breaking ties: chosen from transactions alone, each once, then the names
 * joined and the tags aggregated for its rows only. It was a SELECT DISTINCT over
 * the joins, so a page deep in a large tag joined and deduplicated every row before it.
 */
export function tagTransactionsPage(tagIds: number[], range: DateRange, page: { limit: number; offset: number }) {
  return sql<TagTransactionRow>`
    WITH page AS (
      SELECT t.id, t.uuid, t.description, t.amount, t.type, t.status,
             t.review_status, t.assigned_to, t.account_id, t.merchant_id,
             t.budget_item_id, t.budget_period_id, t.budget_period_item_id, t.transaction_date,
             t.notes, t.is_split_parent, t.parent_transaction_id, t.created_at, t.updated_at
        FROM transactions t
       WHERE t.id IN (${taggedTransactionIds(tagIds)})
         AND t.is_split_parent = false
       ${transactionDateFilter(range)}
       ORDER BY t.transaction_date DESC, t.id DESC
       LIMIT ${page.limit}
      OFFSET ${page.offset}
    )
    SELECT
      p.id, p.uuid, p.description, p.amount, p.type, p.status,
      p.review_status, p.assigned_to, p.merchant_id,
      p.budget_item_id, p.budget_period_id, p.budget_period_item_id,
      p.transaction_date,
      p.notes, p.is_split_parent, p.parent_transaction_id, p.created_at, p.updated_at,
      a.name as account_name, a.uuid as account_uuid,
      m.name as merchant_name, m.uuid as merchant_uuid,
      bi.name as budget_item_name, bi.uuid as budget_item_uuid,
      bp.name as budget_period_name,
      u_assigned.first_name || ' ' || u_assigned.last_name as assigned_user,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', tags.id,
              'uuid', tags.uuid,
              'name', tags.name,
              'color', tags.color,
              'icon', tags.icon
            )
          )
          FROM taggings tags_join
          INNER JOIN tags ON tags.id = tags_join.tag_id
          WHERE tags_join.taggable_type = 'transaction'
            AND tags_join.taggable_id = p.id
        ),
        '[]'::jsonb
      ) as tags
    FROM page p
    LEFT JOIN accounts a ON p.account_id = a.id
    LEFT JOIN merchants m ON p.merchant_id = m.id
    LEFT JOIN budget_items bi ON p.budget_item_id = bi.id
    LEFT JOIN budget_period bp ON p.budget_period_id = bp.id
    LEFT JOIN users u_assigned ON p.assigned_to = u_assigned.id
    ORDER BY p.transaction_date DESC, p.id DESC
  `;
}

/**
 * The tag reports. Each covers the tag and every tag below it, counts a transaction once
 * however many of those tags it carries, leaves out split parents (their splits count),
 * and filters on the transaction's own date.
 */
export class TagReportService {
  /** Count and totals of the tag's transactions in the range (get_tag_transaction_summary); 404 if it answers no row. */
  async summary(uuid: string, range: DateRange) {
    // The function raises for a tag that doesn't exist.
    if ((await tagIdOf(uuid)) === null) throw tagSummaryNotFound();

    const result = await sql<{
      tag_id: number;
      tag_name: string;
      tag_uuid: string;
      hierarchy_path: string | null;
      transaction_count: string;
      total_amount: string;
      income_amount: string;
      expense_amount: string;
    }>`
      SELECT * FROM get_tag_transaction_summary(${uuid}, ${range.start ?? null}::date, ${range.end ?? null}::date)
    `.execute(getDb());
    if (result.rows.length === 0) throw tagNotFound();
    return result.rows[0];
  }

  /**
   * A page of the tag's transactions, newest first, each with every tag it carries (not
   * only the matched one) and the fields the shared transaction table shows, and how
   * many there are in all.
   */
  async transactions(
    uuid: string,
    range: DateRange,
    page: { limit: number; offset: number }
  ): Promise<{ transactions: TagTransactionRow[]; total: number }> {
    const tagId = await tagIdOf(uuid);
    if (tagId === null) throw tagNotFound();
    const tagIds = await tagAndDescendantIds(tagId);
    const dateFilter = transactionDateFilter(range);

    const result = await tagTransactionsPage(tagIds, range, page).execute(getDb());

    // The same transactions, without joins, each once.
    const count = await sql<{ total: string }>`
      SELECT COUNT(*) as total
      FROM transactions t
      WHERE t.id IN (${taggedTransactionIds(tagIds)})
        AND t.is_split_parent = false
      ${dateFilter}
    `.execute(getDb());

    return { transactions: result.rows, total: parseInt(oneRow(count.rows, 'count(*)').total) };
  }

  /**
   * Received (positive amounts) and spent (negative ones, as positive numbers) per day,
   * week or month, oldest first. Weeks start on Sunday, as the chart's do; a bucket is
   * named by its first day.
   */
  async timeSeries(
    uuid: string,
    range: DateRange,
    bucket: TimeSeriesBucket
  ): Promise<Array<{ bucket_date: string; income: number; expenses: number }>> {
    const tagId = await tagIdOf(uuid);
    if (tagId === null) throw tagNotFound();
    const tagIds = await tagAndDescendantIds(tagId);

    // Buckets of the transaction's own calendar date, truncated as a timestamp without
    // time zone so no zone ever moves a day. date_trunc('week') is Monday-based: shift
    // +1 day before truncating and -1 day after to land on the Sunday.
    const bucketExpr =
      bucket === 'week'
        ? sql`(date_trunc('week', (t.transaction_date + 1)::timestamp) - interval '1 day')::date`
        : bucket === 'day'
          ? sql`t.transaction_date`
          : sql`date_trunc('month', t.transaction_date::timestamp)::date`;

    // Dedupe transactions first (one may carry several in-scope tags), then split each
    // bucket's signed amounts by sign: a presentation split, not a balance.
    const result = await sql<{ bucket_date: string; income: string; expenses: string }>`
      SELECT
        bucket_date,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS expenses
      FROM (
        SELECT DISTINCT t.id, t.amount, ${bucketExpr} AS bucket_date
        FROM transactions t
        INNER JOIN taggings tg ON tg.taggable_id = t.id AND tg.taggable_type = 'transaction'
        WHERE tg.tag_id = ANY(${tagIds})
          AND t.is_split_parent = false
        ${transactionDateFilter(range)}
      ) deduped
      GROUP BY bucket_date
      ORDER BY bucket_date
    `.execute(getDb());

    return result.rows.map((row) => ({
      bucket_date: row.bucket_date,
      income: parseFloat(row.income),
      expenses: parseFloat(row.expenses),
    }));
  }

  /**
   * The tag's totals split across its direct sub-tags and itself, for the pie chart, each
   * transaction in one slice ({@link attributeToBranches}). Sub-tags first, in their
   * order, then the tag; a slice with no transactions is left out.
   */
  async breakdown(uuid: string, range: DateRange): Promise<BreakdownSlice[]> {
    const parent = await getDb().selectFrom('tags').select(['id', 'name', 'color', 'icon']).where('uuid', '=', uuid).executeTakeFirst();
    if (!parent) throw tagNotFound();

    const children = await getDb()
      .selectFrom('tags')
      .select(['id', 'uuid', 'name', 'color', 'icon'])
      .where('parent_id', '=', parent.id)
      .orderBy('sort_order')
      .orderBy('name')
      .execute();

    // Every in-hierarchy tag's slice: each direct child's descendants (one LATERAL call
    // for all children) go to that child's branch, the viewed tag to 'parent'.
    const branchOfTag = new Map<number, Branch>([[parent.id, 'parent']]);
    const descendants = await sql<{ branch_id: number; tag_id: number }>`
      SELECT child.id AS branch_id, d.tag_id
      FROM tags child
      CROSS JOIN LATERAL get_child_tag_ids(child.id) AS d
      WHERE child.parent_id = ${parent.id}
    `.execute(getDb());
    for (const row of descendants.rows) branchOfTag.set(row.tag_id, row.branch_id);

    // One row per transaction, with the in-hierarchy tag ids it carries.
    const transactions = await sql<{ id: number; amount: string; tag_ids: number[] }>`
      SELECT t.id, t.amount, array_agg(DISTINCT tg.tag_id) AS tag_ids
      FROM transactions t
      INNER JOIN taggings tg ON tg.taggable_id = t.id AND tg.taggable_type = 'transaction'
      WHERE tg.tag_id = ANY(${Array.from(branchOfTag.keys())})
        AND t.is_split_parent = false
      ${transactionDateFilter(range)}
      GROUP BY t.id, t.amount
    `.execute(getDb());

    const slices = attributeToBranches(
      transactions.rows.map((row) => ({ amount: parseFloat(row.amount), tagIds: row.tag_ids })),
      branchOfTag
    );
    const totals = (key: Branch) => ({
      value: slices.get(key)?.value || 0,
      net: slices.get(key)?.net || 0,
      count: slices.get(key)?.count || 0,
    });

    return [
        ...children.map((child) => ({
          id: child.id,
          uuid: child.uuid,
          name: child.name,
          color: child.color,
          icon: child.icon,
          is_parent: false,
          ...totals(child.id),
        })),
        { id: parent.id, uuid, name: parent.name, color: parent.color, icon: parent.icon, is_parent: true, ...totals('parent') },
      ].filter((slice) => slice.count > 0);
  }
}
