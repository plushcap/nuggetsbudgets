import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { withTenant } from '../db/withTenant.js';
import { BudgetItemMatcher } from '../services/BudgetItemMatcher.js';

/**
 * Items the budget item matcher ranks equal. Its description-similarity tier keeps
 * the 20 most-used items, and its merchant history the most-used, latest item: with no tie-break,
 * equal items came out in whatever order the plan gave, and the path that counts a sync's earlier
 * rows (a pending history, ranked in JS) could keep others than the query's LIMIT did. Ties go to
 * the lowest id on both paths. (On these rows the plans read the items in id order, so this passes
 * without the tie-break too; it holds the order whatever the plan.)
 */
describe('BudgetItemMatcher ties', () => {
  let tenant: TestTenant;
  const matcher = new BudgetItemMatcher();

  const item = async (name: string, description: string | null = null) =>
    (await tenant.pool.query<{ id: number }>(`INSERT INTO budget_items (name, description, expense_type) VALUES ($1, $2, 'Expense') RETURNING id`, [name, description])).rows[0]!.id;
  /** The match by the query alone, and by the path that merges a sync's earlier rows (an unrelated one). */
  const bothPaths = async (merchantId: number | null, description: string, unrelated: number) =>
    withTenant(tenant.tenantId, async () => [
      await matcher.findBudgetItemMatch(merchantId, description, 10),
      await matcher.findBudgetItemMatch(merchantId, description, 10, {
        usage: new Map([[unrelated, 0]]),
        ...(merchantId === null ? {} : { merchant: new Map([[unrelated, { count: 0, lastDate: '2000-01-01' }]]) }),
      }),
    ]);

  beforeAll(async () => {
    tenant = await createTestTenant('budget item matcher ties');
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('keeps the lowest ids of equally used items for description similarity, on both paths', async () => {
    // 30 unused items: the first and the last are the only ones like the description.
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(await item(i === 0 ? 'Harbor Kayak Rental' : i === 29 ? 'Harbor Kayak Tours' : `Filler ${i} Expense`));
    }
    const unrelated = await item('Unrelated Pending');
    expect((await bothPaths(null, 'harbor kayak rental', unrelated)).map((m) => m.budgetItemId)).toEqual([ids[0], ids[0]]);
    // The last is past the 20 kept on either path.
    expect((await bothPaths(null, 'harbor kayak tours', unrelated)).map((m) => m.budgetItemId)).toEqual([null, null]);
  });

  it("gives a merchant's history its lowest id of items used as often and as lately, on both paths", async () => {
    const merchant = (await tenant.pool.query<{ id: number }>(`INSERT INTO merchants (name) VALUES ('Tie Shop') RETURNING id`)).rows[0]!.id;
    const account = (await tenant.pool.query<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Tie card', 'checking', 'cash', 'Asset') RETURNING id`)).rows[0]!.id;
    const period = (await tenant.pool.query<{ id: number }>(
      `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date) VALUES ('March 2035', 'March', 3, 2035, '2035-03-01', '2035-03-31') RETURNING id`
    )).rows[0]!.id;
    const tied = [await item('Tie One'), await item('Tie Two'), await item('Tie Three')];
    // Written highest id first, so the table's order isn't the ids'.
    for (const itemId of [...tied].reverse()) {
      await tenant.pool.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, merchant_id, budget_item_id, budget_period_id)
         VALUES ($1, -5.00, '2035-03-10', 'expense', 'tie', $2, $3, $4)`,
        [account, merchant, itemId, period]
      );
    }
    const unrelated = await item('Unrelated History');
    const matches = await bothPaths(merchant, 'zzz', unrelated);
    expect(matches.map((m) => [m.budgetItemId, m.method])).toEqual([[tied[0], 'merchant-history'], [tied[0], 'merchant-history']]);
  });
});
