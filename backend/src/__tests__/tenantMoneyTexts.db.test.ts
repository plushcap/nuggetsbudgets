import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { sql } from 'kysely';
import { getDb, withTenant } from '../db/withTenant.js';
import { createBudgetRoutes } from '../routes/budgets.js';
import { createBudgetPeriodRoutes } from '../routes/budget-periods.js';
import { writeTenantSettings } from '../services/tenantSettings.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * The texts the server writes about a budget item's money name it in the ledger's format,
 * here EUR in de-DE: an archive refused for an envelope that still holds money, a type change
 * refused for one, the carry-over a type change records, and a transfer's message.
 */
describe("a ledger's budget texts in its money format", () => {
  let tenant: TestTenant;
  let app: Express;
  const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');
  const items: Record<'vacation' | 'gifts' | 'groceries' | 'fuel', { id: number; uuid: string }> = {} as never;
  let periodUuid = '';
  const periodItemIds: Record<string, number> = {};

  beforeAll(async () => {
    tenant = await createTestTenant('Money texts');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budgets', createBudgetRoutes());
    app.use('/api/budget-periods', createBudgetPeriodRoutes());
    const year = 3000 + (Date.now() % 5000);
    await withTenant(tenant.tenantId, async () => {
      await writeTenantSettings({ application_currency: 'EUR', application_locale: 'de-DE' }, tenant.userId);
      const db = getDb();
      const item = (name: string, values: { rollover: boolean; type: string }) =>
        db.insertInto('budget_items').values({ name, expense_type: 'Expense', ...values }).returning(['id', 'uuid']).executeTakeFirstOrThrow();
      items.vacation = await item('Vacation', { rollover: true, type: 'Envelope' });
      items.gifts = await item('Gifts', { rollover: true, type: 'Envelope' });
      items.groceries = await item('Groceries', { rollover: false, type: 'Monthly' });
      items.fuel = await item('Fuel', { rollover: false, type: 'Monthly' });
      // A past period, where Groceries left 70.00 over, and the latest, where it has 30.00: as an
      // envelope it starts with this month's 30.00 (the type change records the carry-over).
      const past = (await sql<{ id: number }>`SELECT create_budget_period_with_items(${year}, 1, ${tenant.userId}, false) AS id`.execute(db)).rows[0]!.id;
      const period = (await sql<{ id: number }>`SELECT create_budget_period_with_items(${year}, 2, ${tenant.userId}, false) AS id`.execute(db)).rows[0]!.id;
      const pastGroceries = await db.selectFrom('budget_period_items').select('id').where('budget_item_id', '=', items.groceries.id).where('budget_period_id', '=', past).executeTakeFirstOrThrow();
      await db.insertInto('budget_period_transactions')
        .values({ budget_period_item_id: pastGroceries.id, budget_item_id: items.groceries.id, transaction_type: 'add', type: 'budget_update', amount: '70.00' })
        .execute();
      periodUuid = (await db.selectFrom('budget_period').select('uuid').where('id', '=', period).executeTakeFirstOrThrow()).uuid;
      for (const [key, { id }] of Object.entries(items)) {
        const row = await db.selectFrom('budget_period_items').select('id').where('budget_item_id', '=', id).where('budget_period_id', '=', period).executeTakeFirstOrThrow();
        periodItemIds[key] = row.id;
      }
      const budget = (key: string, amount: string) => db.insertInto('budget_period_transactions')
        .values({ budget_period_item_id: periodItemIds[key]!, budget_item_id: items[key as keyof typeof items].id, transaction_type: 'add', type: 'budget_update', amount })
        .execute();
      await budget('vacation', '1234.50');
      await budget('gifts', '40.00');
      await budget('groceries', '30.00');
      await budget('fuel', '100.00');
    });
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it("refuses to archive an envelope that still holds money, naming it in the ledger's format", async () => {
    const res = await request(app).post(`/api/budgets/items/${items.vacation.uuid}/archive`).expect(409);
    expect(plain(res.body.error)).toBe('Vacation still holds 1.234,50 €. Transfer it to another budget item first, then archive it.');
  });

  it("refuses to make an envelope monthly while it holds money, in the ledger's format", async () => {
    const res = await request(app).put(`/api/budgets/items/${items.gifts.uuid}`).send({ type: 'Monthly', rollover: false }).expect(409);
    expect(plain(res.body.error)).toBe('Gifts holds 40,00 €. Transfer it to another budget item first; only an empty envelope can become a monthly item.');
  });

  it("records a monthly item's carry-over, when it becomes an envelope, in the ledger's format", async () => {
    await request(app).put(`/api/budgets/items/${items.groceries.uuid}`).send({ type: 'Envelope', rollover: true }).expect(200);
    const { rows } = await tenant.pool.query<{ description: string }>(
      `SELECT description FROM budget_period_transactions WHERE budget_item_id = $1 AND type = 'starting_balance'`,
      [items.groceries.id]
    );
    expect(rows.map((row) => plain(row.description))).toEqual(['Carried over 30,00 € when Groceries became an envelope']);
  });

  it("says what a transfer moved in the ledger's format", async () => {
    const res = await request(app)
      .post(`/api/budget-periods/${periodUuid}/transfer`)
      .send({ fromBudgetPeriodItemId: periodItemIds.fuel, toBudgetPeriodItemId: periodItemIds.vacation, amount: '12.5' })
      .expect(200);
    expect(plain(res.body.message)).toBe('Successfully transferred 12,50 € from Fuel to Vacation');
  });
});
