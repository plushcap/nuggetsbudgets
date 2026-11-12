import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createTransactionsRoutes } from '../transactions.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { inTransaction } from '../../test/inTransaction.js';

// A split parent's budget items are its children's (requires Postgres test DB).
// Changing the parent's budget item used to move the parent into the new item
// while its splits stayed in theirs, listing one purchase in two places.
describe('Budget item on a split parent', () => {
  const stamp = Date.now();
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountId: number;
  let periodId: number;
  const items: Record<'groceries' | 'household' | 'gifts', number> = { groceries: 0, household: 0, gifts: 0 };
  let parent: { id: number; uuid: string };
  let child: { id: number; uuid: string };

  const row = async (id: number) =>
    (await pool.query('SELECT budget_item_id, budget_period_item_id, budget_period_id, notes FROM transactions WHERE id = $1', [id])).rows[0];

  beforeAll(async () => {
    tenant = await createTestTenant('Budget item on a split parent');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());

    accountId = (await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'credit_card','credit_cards','Liability') RETURNING id`, [`Split Card ${stamp}`])).rows[0].id;
    periodId = (await pool.query(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date) VALUES ($1,'October',2026,10,'2026-10-01','2026-10-31') RETURNING id`,
      [`Split period ${stamp}`],
    )).rows[0].id;
    // Paused, not active: suites running alongside borrow "any active budget
    // item" as a fixture, and these are deleted when this file finishes.
    for (const key of Object.keys(items) as (keyof typeof items)[]) {
      items[key] = (await pool.query(`INSERT INTO budget_items (name, status) VALUES ($1, 'paused') RETURNING id`, [`${key} ${stamp}`])).rows[0].id;
      await pool.query('INSERT INTO budget_period_items (budget_item_id, budget_period_id) VALUES ($1, $2)', [items[key], periodId]);
    }

    // The split and its splits in one transaction: they must add up when it commits.
    await inTransaction(pool, async (client) => {
      parent = (await client.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, is_split_parent, budget_period_id)
         VALUES ($1, -100, '2026-10-20', 'expense', 'Sample Mart', true, $2) RETURNING id, uuid`,
        [accountId, periodId],
      )).rows[0];
      const children = await client.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, parent_transaction_id, budget_item_id, budget_period_id)
         VALUES ($1, -60, '2026-10-20', 'expense', 'Sample Mart', $2, $3, $5), ($1, -40, '2026-10-20', 'expense', 'Sample Mart', $2, $4, $5)
         RETURNING id, uuid`,
        [accountId, parent.id, items.groceries, items.household, periodId],
      );
      child = children.rows[0];
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('refuses a budget item on the parent and leaves the splits where they are', async () => {
    const res = await request(app).put(`/api/transactions/${parent.uuid}`).send({ budget_item_id: items.gifts }).expect(400);
    expect(res.body.error).toBe('This transaction is split. Change the budget item on each split instead.');
    expect(await row(parent.id)).toMatchObject({ budget_item_id: null, budget_period_item_id: null, budget_period_id: periodId });
    expect((await row(child.id)).budget_item_id).toBe(items.groceries);
  });

  it("still saves the parent's other fields, including a whole-form save with no budget item", async () => {
    await request(app).put(`/api/transactions/${parent.uuid}`).send({ notes: 'Prime Day', budget_item_id: null, budget_period_id: periodId }).expect(200);
    expect(await row(parent.id)).toMatchObject({ notes: 'Prime Day', budget_item_id: null, budget_period_item_id: null });
  });

  it("moves a split's own budget item", async () => {
    await request(app).put(`/api/transactions/${child.uuid}`).send({ budget_item_id: items.gifts, budget_period_id: periodId }).expect(200);
    const moved = await row(child.id);
    expect(moved.budget_item_id).toBe(items.gifts);
    expect(moved.budget_period_item_id).not.toBeNull();
  });

  it('keeps the parent clear in a bulk edit that includes it', async () => {
    await request(app)
      .put('/api/transactions/bulk')
      .send({ transactionUuids: [parent.uuid, child.uuid], updates: { budget_item_id: items.household } })
      .expect(200);
    expect(await row(parent.id)).toMatchObject({ budget_item_id: null, budget_period_item_id: null });
    expect((await row(child.id)).budget_item_id).toBe(items.household);
  });
});
