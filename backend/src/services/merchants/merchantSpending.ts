import { sql } from 'kysely';
import type { MerchantSpendingAnswer } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { oneRow } from '../../utils/present.js';

/**
 * A merchant's spending summary for its detail page, in one request:
 * GET /api/merchant-spending/:uuid.
 *
 * The page used to fetch every one of the merchant's transactions to draw two charts and
 * paginate a table in the browser. The table now pages on the server
 * (GET /transactions/paginated?merchant_uuid=…); this answers the charts and the header's counts.
 *
 * Same figures the page computed: the merchant's transactions without a parent (a split's
 * children aren't listed; the parent carries the merchant and the whole amount), each
 * counted by its size (ABS(amount): a refund adds to the bar as the page drew it), over the
 * 24 months to the household's today (app_today()). Totals are NUMERIC sums, sent as strings.
 */

const MONTHS = 24;

/** The summary as the route sends it: `@nuggets/shared`'s merchantSpendingResponseSchema. */
export type MerchantSpending = MerchantSpendingAnswer;

/** The merchant's spending summary, or null when no merchant has `uuid`. */
export async function getMerchantSpending(uuid: string): Promise<MerchantSpending | null> {
  const merchant = await getDb()
    .selectFrom('merchants')
    .select(['id', 'uuid'])
    .where('uuid', '=', uuid)
    .executeTakeFirst();
  if (!merchant) return null;

  const sinceResult = await sql<{ since: string }>`
    SELECT (app_today() - make_interval(months => ${MONTHS}))::date AS since
  `.execute(getDb());
  const since = oneRow(sinceResult.rows, 'the since date').since;

  const monthly = await sql<{ month: string; total: string }>`
    SELECT to_char(t.transaction_date, 'YYYY-MM') AS month, SUM(ABS(t.amount)) AS total
      FROM transactions t
     WHERE t.merchant_id = ${merchant.id}
       AND t.parent_transaction_id IS NULL
       AND t.transaction_date >= ${since}::date
     GROUP BY 1
     ORDER BY 1
  `.execute(getDb());

  const byBudgetItem = await sql<{ budget_item_uuid: string | null; budget_item_name: string | null; total: string }>`
    WITH totals AS (
      SELECT t.budget_item_id, SUM(ABS(t.amount)) AS total
        FROM transactions t
       WHERE t.merchant_id = ${merchant.id}
         AND t.parent_transaction_id IS NULL
         AND t.transaction_date >= ${since}::date
       GROUP BY t.budget_item_id
    )
    SELECT bi.uuid AS budget_item_uuid, bi.name AS budget_item_name, totals.total
      FROM totals
      LEFT JOIN budget_items bi ON bi.id = totals.budget_item_id
     WHERE totals.total > 0
     ORDER BY totals.total DESC, bi.name NULLS LAST
  `.execute(getDb());

  const counts = await sql<{ transactions: string; rules: string }>`
    SELECT (SELECT COUNT(*) FROM transactions t WHERE t.merchant_id = ${merchant.id}) AS transactions,
           (SELECT COUNT(*) FROM merchant_matching_rules mr WHERE mr.merchant_id = ${merchant.id}) AS rules
  `.execute(getDb());
  const totals = oneRow(counts.rows, 'the counts');

  return {
    merchant_uuid: merchant.uuid,
    since,
    transaction_count: parseInt(totals.transactions, 10),
    rule_count: parseInt(totals.rules, 10),
    monthly: monthly.rows,
    by_budget_item: byBudgetItem.rows,
  };
}
