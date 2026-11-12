import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { withTenant } from '../db/withTenant.js';
import { BudgetItemMatcher } from '../services/BudgetItemMatcher.js';

/**
 * Which budget item an imported transaction gets from its ledger's matching rules, by each
 * rule method: exact, starts_with, ends_with and contains on the description (ignoring case),
 * merchant_exact for a merchant's own rule (and never as a general rule), and a rule with no
 * text. Rules are tried in priority order, merchant rules before general ones.
 */
describe('BudgetItemMatcher rule methods', () => {
  let tenant: TestTenant;
  const matcher = new BudgetItemMatcher();
  const items: Record<string, number> = {};
  let merchant: number;

  const match = (merchantId: number | null, description: string, amount = -10) =>
    withTenant(tenant.tenantId, () => matcher.findBudgetItemMatch(merchantId, description, amount));
  const rule = (budgetItemId: number, method: string, matchingText: string | null, merchantId: number | null = null, priority = 10) =>
    tenant.pool.query(
      `INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, merchant_id, priority) VALUES ($1, $2, $3, $4, $5)`,
      [budgetItemId, method, matchingText, merchantId, priority]
    );

  beforeAll(async () => {
    tenant = await createTestTenant('budget item matcher rules');
    for (const name of ['Groceries', 'Fuel', 'Coffee', 'Rent', 'Merchant default', 'Never']) {
      items[name] = (
        await tenant.pool.query<{ id: number }>(`INSERT INTO budget_items (name, expense_type) VALUES ($1, 'Expense') RETURNING id`, [name])
      ).rows[0].id;
    }
    merchant = (await tenant.pool.query<{ id: number }>(`INSERT INTO merchants (name) VALUES ('Corner Shop') RETURNING id`)).rows[0].id;

    await rule(items.Groceries, 'exact', 'WEEKLY SHOP');
    await rule(items.Fuel, 'starts_with', 'fuelco ');
    await rule(items.Coffee, 'ends_with', ' coffee co');
    await rule(items.Rent, 'contains', 'rent payment');
    // merchant_exact names no text: any description from that merchant. As a general rule
    // (no merchant), it never matches.
    await rule(items['Merchant default'], 'merchant_exact', null, merchant);
    await rule(items.Never, 'merchant_exact', null, null, 1);
    // A text rule with no text matches only an empty description exactly.
    await rule(items.Never, 'exact', null, null, 99);
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('matches exact, starts_with, ends_with and contains rules on the description, ignoring case', async () => {
    expect(await match(null, 'Weekly Shop')).toMatchObject({ budgetItemId: items.Groceries, method: 'description-rule' });
    expect((await match(null, 'Weekly Shop extra')).budgetItemId).not.toBe(items.Groceries);
    expect(await match(null, 'FUELCO Station 42')).toMatchObject({ budgetItemId: items.Fuel, method: 'description-rule' });
    expect(await match(null, 'Main St Coffee Co')).toMatchObject({ budgetItemId: items.Coffee, method: 'description-rule' });
    expect(await match(null, 'Monthly RENT PAYMENT June')).toMatchObject({ budgetItemId: items.Rent, method: 'description-rule' });
  });

  it("matches a merchant's merchant_exact rule for any description, before the general rules", async () => {
    expect(await match(merchant, 'Weekly Shop')).toMatchObject({ budgetItemId: items['Merchant default'], method: 'merchant-rule' });
    expect(await match(merchant, 'anything at all')).toMatchObject({ budgetItemId: items['Merchant default'], method: 'merchant-rule' });
  });

  it('never matches a general merchant_exact rule, or a text rule with no text on a description', async () => {
    const result = await match(null, 'something unmatched');
    expect(result.budgetItemId).not.toBe(items.Never);
  });
});
