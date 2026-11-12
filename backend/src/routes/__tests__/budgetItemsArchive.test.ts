import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { sql } from 'kysely';
import { createBudgetRoutes } from '../budgets.js';
import { testTenantContext } from '../../test/tenantContext.js';
import { globalDb, withTenant, getDb } from '../../db/withTenant.js';
import { BudgetItemMatcher } from '../../services/BudgetItemMatcher.js';
import { fixtureAccountId } from '../../test/fixtureAccount.js';
import { answerProblem, budgetItemMergeResponseSchema, budgetItemUsageResponseSchema, messageResponseSchema } from '@nuggets/shared';

/**
 * Retiring budget items, in a tenant of its own: archive (refused while an
 * envelope holds money), restore, delete only when unused, and merge. Two
 * budget periods, a past one and the current one:
 * - Coffee: monthly, spent in the past period only
 * - Vacation: an envelope with $300 budgeted and $200 spent
 * - Dining: monthly, the merge target
 * - Typo: never used
 */
describe('Budget items: archive, restore, delete, merge', () => {
  const stamp = Date.now();
  const year = 3000 + (stamp % 5000);
  let tenantId: number;
  let organizationId: number;
  let userId: number;
  let app: Express;
  const periods = { past: 0, current: 0 };
  const items: Record<'coffee' | 'vacation' | 'dining' | 'typo' | 'salary', { id: number; uuid: string }> = {} as never;
  const inTenant = <T>(fn: () => Promise<T>) => withTenant(tenantId, fn);

  /** The budget page's items for a period, by name. */
  const periodItems = async (periodId: number) => {
    const uuid = (await inTenant(() => getDb().selectFrom('budget_period').select('uuid').where('id', '=', periodId).executeTakeFirstOrThrow())).uuid;
    const res = await request(app).get(`/api/budgets/periods/${uuid}/items`).expect(200);
    return (res.body.data as { budget_item_name: string }[]).map((row) => row.budget_item_name.replace(` ${stamp}`, '')).sort();
  };

  beforeAll(async () => {
    organizationId = (await globalDb.insertInto('organizations').values({ name: `Archive org ${stamp}` }).returning('id').executeTakeFirstOrThrow()).id;
    tenantId = (await globalDb.insertInto('tenants').values({ name: `Archive ${stamp}`, organization_id: organizationId }).returning('id').executeTakeFirstOrThrow()).id;
    userId = (await globalDb.insertInto('users').values({ email: `archive-${stamp}@test.local`, password_hash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
    app = express();
    app.use(express.json());
    app.use('/api/budgets', testTenantContext({ userId, tenantId }), createBudgetRoutes());

    await inTenant(async () => {
      const db = getDb();
      for (const [key, name, rollover, expenseType] of [
        ['coffee', 'Coffee', false, 'Expense'], ['vacation', 'Vacation', true, 'Expense'],
        ['dining', 'Dining', false, 'Expense'], ['typo', 'Typo', false, 'Expense'], ['salary', 'Salary', false, 'Income'],
      ] as const) {
        items[key] = await db.insertInto('budget_items')
          .values({ name: `${name} ${stamp}`, rollover, expense_type: expenseType, type: rollover ? 'Envelope' : 'Monthly' })
          .returning(['id', 'uuid']).executeTakeFirstOrThrow();
      }
      periods.past = (await sql<{ id: number }>`SELECT create_budget_period_with_items(${year}, 1, ${userId}, false) AS id`.execute(db)).rows[0].id;
      periods.current = (await sql<{ id: number }>`SELECT create_budget_period_with_items(${year}, 2, ${userId}, false) AS id`.execute(db)).rows[0].id;

      const periodItem = (item: number, period: number) => db.selectFrom('budget_period_items').select('id')
        .where('budget_item_id', '=', item).where('budget_period_id', '=', period).executeTakeFirstOrThrow();
      const vacation = await periodItem(items.vacation.id, periods.past);
      await db.insertInto('budget_period_transactions')
        .values({ budget_period_item_id: vacation.id, budget_item_id: items.vacation.id, transaction_type: 'add', type: 'budget_update', amount: '300.00' })
        .execute();
      const spend = async (item: number, period: number, day: string, amount: number) => db.insertInto('transactions')
        .values({ account_id: await fixtureAccountId(db), type: 'expense', amount: (-amount).toFixed(2), transaction_date: day, budget_item_id: item, budget_period_id: period, description: 'Spend' })
        .execute();
      await spend(items.vacation.id, periods.past, `${year}-01-10`, 200);
      await spend(items.coffee.id, periods.past, `${year}-01-05`, 4.5);
      await spend(items.coffee.id, periods.past, `${year}-01-06`, 5.5);
      await db.insertInto('budget_item_matching_rules')
        .values({ budget_item_id: items.coffee.id, method: 'contains', matching_text: `SAMPLECOFFEE${stamp}` })
        .execute();
    });
  });

  afterAll(async () => {
    await inTenant(async () => {
      const db = getDb();
      await db.deleteFrom('budget_item_matching_rules').where('tenant_id', '=', tenantId).execute();
      await db.deleteFrom('transactions').where('tenant_id', '=', tenantId).execute();
      await db.deleteFrom('accounts').where('tenant_id', '=', tenantId).execute();
      await db.deleteFrom('budget_period_transactions').where('tenant_id', '=', tenantId).execute();
      await db.deleteFrom('budget_period_items').where('tenant_id', '=', tenantId).execute();
      await db.deleteFrom('budget_items').where('tenant_id', '=', tenantId).execute();
      await db.deleteFrom('budget_period').where('tenant_id', '=', tenantId).execute();
    });
    await globalDb.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await globalDb.deleteFrom('organizations').where('id', '=', organizationId).execute();
    await globalDb.deleteFrom('users').where('id', '=', userId).execute();
  });

  it("says what an item's history is, and whether it can be deleted", async () => {
    const coffee = (await request(app).get(`/api/budgets/items/${items.coffee.uuid}/usage`).expect(200)).body;
    expect(coffee).toEqual({
      transactions: 2, first_transaction_date: `${year}-01-05`, last_transaction_date: `${year}-01-06`,
      rules: 1, budget_periods: 0, attachments: 0, balance: 0, archived: false, can_delete: false, history_before_current_period: false, linked_goals: [],
    });
    // Exactly what the frontend's shared schema reads.
    expect(answerProblem(budgetItemUsageResponseSchema, coffee)).toBeNull();
    const vacation = (await request(app).get(`/api/budgets/items/${items.vacation.uuid}/usage`).expect(200)).body;
    expect(vacation).toMatchObject({ balance: 100, budget_periods: 1 });
    expect(answerProblem(budgetItemUsageResponseSchema, vacation)).toBeNull();
    expect((await request(app).get(`/api/budgets/items/${items.typo.uuid}/usage`).expect(200)).body).toMatchObject({ can_delete: true });
  });

  it('deletes only an item nothing references', async () => {
    const refused = await request(app).delete(`/api/budgets/items/${items.coffee.uuid}`).expect(409);
    expect(refused.body.error).toBe('This budget item has 2 transactions. Archive it instead, or merge it into another item.');
    expect(answerProblem(messageResponseSchema, (await request(app).delete(`/api/budgets/items/${items.typo.uuid}`).expect(200)).body)).toBeNull();
    await request(app).get(`/api/budgets/items/${items.typo.uuid}/usage`).expect(404);
  });

  it("won't archive an envelope that still holds money", async () => {
    const res = await request(app).post(`/api/budgets/items/${items.vacation.uuid}/archive`).expect(409);
    expect(res.body.error).toBe(`Vacation ${stamp} still holds $100.00. Transfer it to another budget item first, then archive it.`);
  });

  it('archives an item: gone from periods it had no activity in, kept where it had some, and from new periods', async () => {
    expect(answerProblem(messageResponseSchema, (await request(app).post(`/api/budgets/items/${items.coffee.uuid}/archive`).expect(200)).body)).toBeNull();
    expect(await periodItems(periods.past)).toContain('Coffee');
    expect(await periodItems(periods.current)).not.toContain('Coffee');

    const next = await inTenant(async () => (await sql<{ id: number }>`SELECT create_budget_period_with_items(${year}, 3, ${userId}, false) AS id`.execute(getDb())).rows[0].id);
    expect(await periodItems(next)).toEqual(['Dining', 'Salary', 'Vacation']);
  });

  it('stops automatic matching to an archived item, though its rule stays', async () => {
    const match = await inTenant(() => new BudgetItemMatcher().findBudgetItemMatch(null, `SAMPLECOFFEE${stamp} ${'#'}12`, -5));
    expect(match.budgetItemId).not.toBe(items.coffee.id);
    expect((await request(app).get(`/api/budgets/items/${items.coffee.uuid}/usage`).expect(200)).body).toMatchObject({ rules: 1, archived: true });
  });

  it('restores an item, with the periods it missed', async () => {
    expect(answerProblem(messageResponseSchema, (await request(app).post(`/api/budgets/items/${items.coffee.uuid}/restore`).expect(200)).body)).toBeNull();
    expect(await periodItems(periods.current)).toContain('Coffee');
    const missed = await inTenant(() => getDb().selectFrom('budget_period_items').select('id')
      .where('budget_item_id', '=', items.coffee.id).execute());
    expect(missed).toHaveLength(3);
  });

  it('merges an item into another: moves its transactions and rules, then archives it', async () => {
    const res = await request(app).post(`/api/budgets/items/${items.coffee.uuid}/merge`).send({ into_uuid: items.dining.uuid }).expect(200);
    expect(res.body).toEqual({ transactions: 2, rules: 1 });
    expect(answerProblem(budgetItemMergeResponseSchema, res.body)).toBeNull();

    const moved = await inTenant(() => getDb().selectFrom('transactions as t')
      .innerJoin('budget_period_items as bpi', 'bpi.id', 't.budget_period_item_id')
      .select(['t.budget_item_id', 'bpi.budget_item_id as period_item_of'])
      .where('t.description', '=', 'Spend').where('t.budget_period_id', '=', periods.past).where('t.amount', 'in', ['-4.50', '-5.50'])
      .execute());
    expect(moved).toEqual([
      { budget_item_id: items.dining.id, period_item_of: items.dining.id },
      { budget_item_id: items.dining.id, period_item_of: items.dining.id },
    ]);
    expect((await request(app).get(`/api/budgets/items/${items.coffee.uuid}/usage`).expect(200)).body).toMatchObject({ transactions: 0, rules: 0, archived: true });
    // Nothing left in it: now it could even be deleted.
    expect((await request(app).get(`/api/budgets/items/${items.coffee.uuid}/usage`).expect(200)).body.can_delete).toBe(true);
  });

  it('refuses a merge into the wrong kind of item, an archived one, or out of a funded envelope', async () => {
    expect((await request(app).post(`/api/budgets/items/${items.dining.uuid}/merge`).send({ into_uuid: items.salary.uuid }).expect(400)).body.error)
      .toBe('Merge income into income, and expenses into expenses.');
    expect((await request(app).post(`/api/budgets/items/${items.dining.uuid}/merge`).send({ into_uuid: items.coffee.uuid }).expect(400)).body.error)
      .toBe(`Coffee ${stamp} is archived. Restore it first, or merge into another item.`);
    await request(app).post(`/api/budgets/items/${items.vacation.uuid}/merge`).send({ into_uuid: items.dining.uuid }).expect(409);
    await request(app).post(`/api/budgets/items/${items.dining.uuid}/merge`).send({ into_uuid: items.dining.uuid }).expect(400);
    await request(app).post(`/api/budgets/items/${items.dining.uuid}/merge`).send({}).expect(400);
  });
});
