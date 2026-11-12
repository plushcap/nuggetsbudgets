import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { sql } from 'kysely';
import { createBudgetRoutes } from '../budgets.js';
import { testTenantContext } from '../../test/tenantContext.js';
import { globalDb, withTenant, getDb } from '../../db/withTenant.js';
import { fixtureAccountId } from '../../test/fixtureAccount.js';

/**
 * Changing a budget item's kind through the ordinary update, in a tenant of its
 * own, with two budget periods (a past one and the current one):
 * - Groceries: monthly, $100 budgeted and $30 spent last period, $50 and $20 now
 * - Gifts: an envelope holding $40
 * - Insurance: a bill with due dates ahead, one open and one skipped
 */
describe('Budget items: changing their kind', () => {
  const stamp = Date.now();
  const year = 3000 + (stamp % 5000);
  let tenantId: number;
  let organizationId: number;
  let userId: number;
  let app: Express;
  const periods = { past: 0, current: 0 };
  const items: Record<'groceries' | 'gifts' | 'insurance', { id: number; uuid: string }> = {} as never;
  const inTenant = <T>(fn: () => Promise<T>) => withTenant(tenantId, fn);

  /** Inside a tenant transaction. */
  const periodItem = (item: number, period: number) => getDb().selectFrom('budget_period_items').select('id')
    .where('budget_item_id', '=', item).where('budget_period_id', '=', period).executeTakeFirstOrThrow();

  const remaining = (item: number, period: number) => inTenant(async () => {
    const { id } = await periodItem(item, period);
    return Number((await sql<{ r: string }>`SELECT calculate_remaining_for_period_item(${id}::int) AS r`.execute(getDb())).rows[0].r);
  });

  beforeAll(async () => {
    organizationId = (await globalDb.insertInto('organizations').values({ name: `Kind org ${stamp}` }).returning('id').executeTakeFirstOrThrow()).id;
    tenantId = (await globalDb.insertInto('tenants').values({ name: `Kind ${stamp}`, organization_id: organizationId }).returning('id').executeTakeFirstOrThrow()).id;
    userId = (await globalDb.insertInto('users').values({ email: `kind-${stamp}@test.local`, password_hash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
    app = express();
    app.use(express.json());
    app.use('/api/budgets', testTenantContext({ userId, tenantId }), createBudgetRoutes());

    await inTenant(async () => {
      const db = getDb();
      items.groceries = await db.insertInto('budget_items')
        .values({ name: `Groceries ${stamp}`, rollover: false, expense_type: 'Expense', type: 'Monthly' })
        .returning(['id', 'uuid']).executeTakeFirstOrThrow();
      items.gifts = await db.insertInto('budget_items')
        .values({ name: `Gifts ${stamp}`, rollover: true, expense_type: 'Expense', type: 'Envelope' })
        .returning(['id', 'uuid']).executeTakeFirstOrThrow();
      items.insurance = await db.insertInto('budget_items')
        .values({
          name: `Insurance ${stamp}`, rollover: true, expense_type: 'Expense', type: 'Envelope', isbill: true,
          recurring_payment: true, recurring_payment_amount: '600.00', recurring_payment_frequency: 6,
        })
        .returning(['id', 'uuid']).executeTakeFirstOrThrow();
      periods.past = (await sql<{ id: number }>`SELECT create_budget_period_with_items(${year}, 1, ${userId}, false) AS id`.execute(db)).rows[0].id;
      periods.current = (await sql<{ id: number }>`SELECT create_budget_period_with_items(${year}, 2, ${userId}, false) AS id`.execute(db)).rows[0].id;

      const budget = async (item: number, period: number, amount: number) => db.insertInto('budget_period_transactions')
        .values({
          budget_period_item_id: (await periodItem(item, period)).id, budget_item_id: item,
          transaction_type: 'add', type: 'budget_update', amount: amount.toFixed(2),
        })
        .execute();
      const spend = async (item: number, period: number, day: string, amount: number) => db.insertInto('transactions')
        .values({ account_id: await fixtureAccountId(db), type: 'expense', amount: (-amount).toFixed(2), transaction_date: day, budget_item_id: item, budget_period_id: period, description: 'Spend' })
        .execute();
      await budget(items.groceries.id, periods.past, 100);
      await spend(items.groceries.id, periods.past, `${year}-01-10`, 30);
      await budget(items.groceries.id, periods.current, 50);
      await spend(items.groceries.id, periods.current, `${year}-02-10`, 20);
      await budget(items.gifts.id, periods.past, 40);

      await db.insertInto('bill_occurrences').values([
        { budget_item_id: items.insurance.id, due_date: `${year + 1}-01-15`, expected_amount: '-600.00' },
        { budget_item_id: items.insurance.id, due_date: `${year + 1}-07-15`, expected_amount: '-600.00', resolution: 'skipped' },
      ]).execute();
    });
  });

  afterAll(async () => {
    await inTenant(async () => {
      const db = getDb();
      await db.deleteFrom('bill_occurrences').where('tenant_id', '=', tenantId).execute();
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

  it("monthly to envelope: the envelope starts with this month's leftover, not every past month's", async () => {
    expect(await remaining(items.groceries.id, periods.current)).toBe(30);
    await request(app).put(`/api/budgets/items/${items.groceries.uuid}`).send({ type: 'Envelope', rollover: true }).expect(200);
    // Without the carry-over it would be 70 + 30 = 100.
    expect(await remaining(items.groceries.id, periods.current)).toBe(30);
  });

  it('keeps the carry-over when its starting balance is edited later', async () => {
    await request(app).put(`/api/budgets/items/${items.groceries.uuid}`).send({ rollover_starting_balance: 0, name: `Groceries ${stamp}` }).expect(200);
    expect(await remaining(items.groceries.id, periods.current)).toBe(30);
  });

  it('envelope to monthly: refused while it holds money', async () => {
    const res = await request(app).put(`/api/budgets/items/${items.gifts.uuid}`).send({ type: 'Monthly', rollover: false }).expect(409);
    expect(res.body.error).toBe(`Gifts ${stamp} holds $40.00. Transfer it to another budget item first; only an empty envelope can become a monthly item.`);
    const unchanged = await inTenant(() => getDb().selectFrom('budget_items').select(['type', 'rollover']).where('id', '=', items.gifts.id).executeTakeFirstOrThrow());
    expect(unchanged).toEqual({ type: 'Envelope', rollover: true });
  });

  it('envelope to monthly: allowed once it is empty', async () => {
    await request(app).put(`/api/budgets/items/${items.groceries.uuid}`).send({ type: 'Monthly', rollover: false }).expect(409);
    await inTenant(async () => {
      await getDb().insertInto('transactions').values({
        account_id: await fixtureAccountId(getDb()),
        type: 'expense', amount: '-30.00', transaction_date: `${year}-02-12`, budget_item_id: items.groceries.id,
        budget_period_id: periods.current, description: 'Spend',
      }).execute();
    });
    await request(app).put(`/api/budgets/items/${items.groceries.uuid}`).send({ type: 'Monthly', rollover: false }).expect(200);
  });

  it('bill to expense: drops its open due dates ahead, keeps the ones someone decided', async () => {
    await request(app).put(`/api/budgets/items/${items.insurance.uuid}`)
      .send({ isbill: false, recurring_payment: false, type: 'Monthly', rollover: false }).expect(200);
    const left = await inTenant(() => getDb().selectFrom('bill_occurrences').select('resolution')
      .where('budget_item_id', '=', items.insurance.id).execute());
    expect(left).toEqual([{ resolution: 'skipped' }]);
  });
});
