import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { withTenant } from '../../db/withTenant.js';
import { BudgetService } from '../../services/BudgetService.js';
import { BudgetItemMatcher } from '../../services/BudgetItemMatcher.js';
import { BudgetPeriodResolver } from '../../services/import/BudgetPeriodResolver.js';
import { MerchantMatcher } from '../../services/import/MerchantMatcher.js';
import { TransactionImporter } from '../../services/import/TransactionImporter.js';
import type { SimplefinTransaction } from '../../services/import/types.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A first import and its own rows' history. A sync matched each row as it wrote it,
 * so a row's merchant-history match saw the rows of the same sync written before it: the second
 * row of a merchant took the item a rule gave the first. Matched before it writes any (to lock what
 * the rows name), the sync read only the ledger's history, and matched fewer. It now walks its
 * rows in the order it writes them and counts each one it adds in the history the later ones read
 * (and, linked to a manual entry instead, not).
 */
describe("A sync's rows see the history of the rows it adds before them", () => {
  let tenant: TestTenant;
  let n = 0;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const sync = (accountId: number, feed: SimplefinTransaction[]) => {
    const periods = new BudgetPeriodResolver(new BudgetService());
    const importer = new TransactionImporter(periods, new MerchantMatcher(periods.savepoint), new BudgetItemMatcher());
    return withTenant(tenant.tenantId, () => importer.importTransactions(accountId, feed));
  };
  const posted = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;
  const account = async () => {
    const importId = `SF-history-${++n}-${Date.now()}`;
    const row = await one<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                             import_auto_assign_budget_period, import_auto_assign_budget_item, import_auto_match_merchants)
       VALUES ($1, 'checking', 'cash', 'Asset', $2, 'simplefin', true, true, true, true) RETURNING id`,
      [`History ${n}`, importId]
    );
    return { id: row.id, importId };
  };
  const itemsOf = async (accountId: number) =>
    (await tenant.pool.query<{ import_transaction_id: string; budget_item_id: number | null; budget_matching_method: string | null; merchant: string | null }>(
      `SELECT t.import_transaction_id, t.budget_item_id, t.budget_matching_method, m.name AS merchant
         FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id WHERE t.account_id = $1 ORDER BY t.id`,
      [accountId]
    )).rows;

  beforeAll(async () => {
    tenant = await createTestTenant('Import same-sync history');
    await one(
      `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
       VALUES ('March 2032', 'March', 3, 2032, '2032-03-01', '2032-03-31') RETURNING id`
    );
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it("gives a merchant's later rows the item a rule gave its first, the merchant new or not", async () => {
    const coffee = await one<{ id: number }>(`INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ('Beans', 'Expense', false, 'Monthly') RETURNING id`);
    await one(`INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, is_active) VALUES ($1, 'contains', 'roastery', true) RETURNING id`, [coffee.id]);
    await one(`INSERT INTO merchants (name) VALUES ('Old Grinder') RETURNING id`);
    const acct = await account();
    const feed: SimplefinTransaction[] = [
      // A merchant the sync makes: its first row matched by the rule, the second by that row.
      { id: `${acct.importId}-1`, amount: '-4.00', description: 'BEAN CO ROASTERY', payee: 'Bean Co', posted: posted('2032-03-02') },
      { id: `${acct.importId}-2`, amount: '-5.00', description: 'BEAN CO 4421', payee: 'Bean Co', posted: posted('2032-03-03') },
      // A merchant the ledger has, with no history yet.
      { id: `${acct.importId}-3`, amount: '-6.00', description: 'OLD GRINDER ROASTERY', payee: 'Old Grinder', posted: posted('2032-03-04') },
      { id: `${acct.importId}-4`, amount: '-7.00', description: 'OLD GRINDER 99', payee: 'Old Grinder', posted: posted('2032-03-05') },
    ];
    expect(await sync(acct.id, feed)).toMatchObject({ imported: 4, failed: 0 });
    expect(await itemsOf(acct.id)).toEqual([
      { import_transaction_id: `${acct.importId}-1`, budget_item_id: coffee.id, budget_matching_method: 'description-rule', merchant: 'Bean Co' },
      { import_transaction_id: `${acct.importId}-2`, budget_item_id: coffee.id, budget_matching_method: 'merchant-history', merchant: 'Bean Co' },
      { import_transaction_id: `${acct.importId}-3`, budget_item_id: coffee.id, budget_matching_method: 'description-rule', merchant: 'Old Grinder' },
      { import_transaction_id: `${acct.importId}-4`, budget_item_id: coffee.id, budget_matching_method: 'merchant-history', merchant: 'Old Grinder' },
    ]);
  });

  // Guards behaviour that was already so (it passes without the in-memory history, and with the
  // old importer): the pass that keeps the history must not count a row it links.
  it('(existing behaviour) counts no history for a row it links to a manual entry instead of adding', async () => {
    const tea = await one<{ id: number }>(`INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ('Leaves', 'Expense', false, 'Monthly') RETURNING id`);
    await one(`INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, is_active) VALUES ($1, 'contains', 'tea house', true) RETURNING id`, [tea.id]);
    const acct = await account();
    // The first row is linked to this manual entry (same amount, within 7 days): it adds nothing.
    await one(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -8.00, '2032-03-10', 'expense', 'Tea by hand') RETURNING id`,
      [acct.id]
    );
    const feed: SimplefinTransaction[] = [
      { id: `${acct.importId}-1`, amount: '-8.00', description: 'LEAF TEA HOUSE', payee: 'Leaf Co', posted: posted('2032-03-10') },
      { id: `${acct.importId}-2`, amount: '-9.00', description: 'LEAF CO 12', payee: 'Leaf Co', posted: posted('2032-03-11') },
    ];
    expect(await sync(acct.id, feed)).toMatchObject({ imported: 1, updated: 1, failed: 0 });
    const added = await one<{ budget_item_id: number | null }>('SELECT budget_item_id FROM transactions WHERE import_transaction_id = $1', [`${acct.importId}-2`]);
    expect(added.budget_item_id).toBeNull();
  });
});
