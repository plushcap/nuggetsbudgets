import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The app pool's lock_timeout (DB_LOCK_TIMEOUT_MS, 15 s by default), short here so a wait
// for a held lock ends in this test's time. db.ts reads it as it's imported, so it is set
// before any import; put back for whatever runs in this process next.
const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '1000';
  return previous;
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createTagsRoutes } from '../tags.js';
import { createMerchantsRoutes } from '../merchants.js';
import { createBudgetRoutes } from '../budgets.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Re-applying auto tags to a merchant's or a budget item's transactions while Delete
 * Transactions holds one of them. apply_transaction_auto_tags locks the transactions
 * first (FOR KEY SHARE), so it waited for the deletion, and a wait past the pool's
 * lock_timeout failed with 55P03 inside the function: a generic 500. The four paths that
 * call it (the two auto-tag routes, and a merchant's or a budget item's new auto-tag rule)
 * now lock them in the app first (lockTransactionsForReference), so they answer what a tag
 * on one transaction answers: 409 TRANSACTION_BUSY, nothing saved, try again. Tried again
 * once the lock is gone, each goes through.
 */
describe('re-applying auto tags while a transaction is held', () => {
  let app: Express;
  let tenant: TestTenant;
  type Row = { id: number; uuid: string };
  let transaction: Row;
  let merchant: Row & { name: string };
  let budgetItem: Row;
  let firstTag: Row;
  let secondTag: Row;

  beforeAll(async () => {
    tenant = await createTestTenant('Auto tags lock timeout');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/tags', createTagsRoutes());
    app.use('/api/merchants', createMerchantsRoutes());
    app.use('/api/budgets', createBudgetRoutes());
    const one = async <T>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
    firstTag = await one<Row>(`INSERT INTO tags (name) VALUES ('Auto lock first') RETURNING id, uuid`);
    secondTag = await one<Row>(`INSERT INTO tags (name) VALUES ('Auto lock second') RETURNING id, uuid`);
    merchant = await one(`INSERT INTO merchants (name, transaction_auto_tag_id) VALUES ('Auto lock merchant', $1) RETURNING id, uuid, name`, [firstTag.id]);
    budgetItem = await one<Row>(`INSERT INTO budget_items (name, expense_type) VALUES ('Auto lock item', 'Expense') RETURNING id, uuid`);
    const accountId = (
      await one<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Auto lock checking', 'checking', 'cash', 'Asset') RETURNING id`)
    ).id;
    transaction = await one<Row>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, merchant_id, budget_item_id)
       VALUES ($1, -12, '2022-05-10', 'expense', 'Auto lock fixture', $2, $3) RETURNING id, uuid`,
      [accountId, merchant.id, budgetItem.id]
    );
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  /** Run `fn` while another connection holds the transaction FOR UPDATE, as a deletion does. */
  const whileDeleting = async <T>(fn: () => Promise<T>): Promise<T> => {
    const holder: PoolClient = await tenant.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM transactions WHERE id = $1 FOR UPDATE', [transaction.id]);
      return await fn();
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  };

  /** What the writes change: the transaction's auto tags, and the two auto-tag rules. */
  const state = async () => ({
    autoTags: (
      await tenant.pool.query<{ tag_id: number }>(
        `SELECT tag_id FROM taggings WHERE taggable_type = 'transaction' AND taggable_id = $1 AND type = 'auto' ORDER BY tag_id`,
        [transaction.id]
      )
    ).rows.map((r) => r.tag_id),
    merchantRule: (await tenant.pool.query('SELECT transaction_auto_tag_id FROM merchants WHERE id = $1', [merchant.id])).rows[0].transaction_auto_tag_id,
    itemRule: (await tenant.pool.query('SELECT transaction_auto_tag_id FROM budget_items WHERE id = $1', [budgetItem.id])).rows[0].transaction_auto_tag_id,
  });

  it('answers 409 TRANSACTION_BUSY, saving nothing, and goes through when tried again', async () => {
    const writes = [
      { name: 'POST /api/tags/auto-tag/merchant/:uuid', send: () => request(app).post(`/api/tags/auto-tag/merchant/${merchant.uuid}`) },
      { name: 'POST /api/tags/auto-tag/budget-item/:uuid', send: () => request(app).post(`/api/tags/auto-tag/budget-item/${budgetItem.uuid}`) },
      {
        name: "PUT /api/merchants/:uuid (a new auto-tag rule)",
        send: () => request(app).put(`/api/merchants/${merchant.uuid}`).send({ name: merchant.name, transaction_auto_tag_id: secondTag.id }),
      },
      {
        name: "PUT /api/budgets/items/:uuid (a new auto-tag rule)",
        send: () => request(app).put(`/api/budgets/items/${budgetItem.uuid}`).send({ transaction_auto_tag_id: secondTag.id }),
      },
    ];
    for (const write of writes) {
      // Its auto tag off, so each write below has something to change.
      await tenant.pool.query(`DELETE FROM taggings WHERE taggable_type = 'transaction' AND taggable_id = $1`, [transaction.id]);
      const before = await state();
      const res = await whileDeleting(write.send);
      expect({ write: write.name, status: res.status, body: res.body }).toMatchObject({
        status: 409,
        body: { code: 'TRANSACTION_BUSY', error: expect.stringMatching(/nothing was saved.*try again/i) },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/lock|timeout|55P03/i);
      expect(await state(), write.name).toEqual(before);

      const retried = await write.send();
      expect(retried.status, `${write.name} ${JSON.stringify(retried.body)}`).toBeLessThan(300);
      expect(await state(), write.name).not.toEqual(before);
    }
    // The merchant's rule wins over the budget item's: both are the second tag now.
    expect(await state()).toEqual({ autoTags: [secondTag.id], merchantRule: secondTag.id, itemRule: secondTag.id });
  }, 30_000);
});
