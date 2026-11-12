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
import { createTransactionsRoutes } from '../transactions.js';
import { createTagsRoutes } from '../tags.js';
import { createAnnotationsRoutes } from '../annotations.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A tag or a note written on a transaction that Delete Transactions holds: the write
 * locks its transaction first (FOR KEY SHARE, lockTransactionsForReference), so it waits for
 * the deletion. One that waits past the pool's lock_timeout failed with 55P03 and answered a
 * generic 500. It answers 409 TRANSACTION_BUSY, as Delete answers its own lock timeout:
 * nothing was saved, try again. And tried again once the lock is gone, it goes through.
 */
describe('a tag or note write that waits too long for its transaction', () => {
  let app: Express;
  let tenant: TestTenant;
  let transaction: { id: number; uuid: string };
  let tag: { id: number; uuid: string };

  beforeAll(async () => {
    tenant = await createTestTenant('Tags and notes lock timeout');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/tags', createTagsRoutes());
    app.use('/api/annotations', createAnnotationsRoutes());
    const accountId = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Lock timeout checking', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0].id;
    transaction = (
      await tenant.pool.query<{ id: number; uuid: string }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
         VALUES ($1, -12, '2022-05-10', 'expense', 'Lock timeout fixture') RETURNING id, uuid`,
        [accountId]
      )
    ).rows[0];
    tag = (await tenant.pool.query<{ id: number; uuid: string }>(`INSERT INTO tags (name) VALUES ('Lock timeout tag') RETURNING id, uuid`)).rows[0];
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

  const tagCount = async () =>
    (await tenant.pool.query(`SELECT 1 FROM taggings WHERE taggable_type = 'transaction' AND taggable_id = $1`, [transaction.id])).rowCount;
  const noteCount = async () =>
    (await tenant.pool.query(`SELECT 1 FROM annotations WHERE subject_type = 'transaction' AND subject_id = $1`, [transaction.id])).rowCount;

  const writes = () => [
    { name: 'POST /api/transactions/:uuid/tags/:tagUuid', send: () => request(app).post(`/api/transactions/${transaction.uuid}/tags/${tag.uuid}`), count: tagCount },
    { name: 'POST /api/tags/transaction/:uuid', send: () => request(app).post(`/api/tags/transaction/${transaction.uuid}`).send({ tag_id: tag.id }), count: tagCount },
    {
      name: 'POST /api/annotations',
      send: () => request(app).post('/api/annotations').send({ subject_type: 'transaction', subject_uuid: transaction.uuid, kind: 'question', body: 'Waits for it' }),
      count: noteCount,
    },
  ];

  it('answers 409 TRANSACTION_BUSY, saving nothing, and goes through when tried again', async () => {
    for (const write of writes()) {
      const before = await write.count();
      const res = await whileDeleting(write.send);
      expect({ write: write.name, status: res.status, body: res.body }).toMatchObject({
        status: 409,
        body: { code: 'TRANSACTION_BUSY', error: expect.stringMatching(/nothing was saved.*try again/i) },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/lock|timeout|55P03/i);
      expect(await write.count(), write.name).toBe(before);

      const retried = await write.send();
      expect(retried.status, `${write.name} ${JSON.stringify(retried.body)}`).toBeLessThan(300);
      // Taken off again, so the next write of the same tag isn't refused as a duplicate.
      await tenant.pool.query(`DELETE FROM taggings WHERE taggable_type = 'transaction' AND taggable_id = $1`, [transaction.id]);
    }
  }, 30_000);

  // A budget item's tag and a note on another subject lock that subject the same way.
  it('answers 409 RECORD_BUSY for a budget item or an account held the same way, saving nothing', async () => {
    const item = (await tenant.pool.query<{ id: number; uuid: string }>(`INSERT INTO budget_items (name, expense_type) VALUES ('Lock timeout item', 'Expense') RETURNING id, uuid`)).rows[0];
    const account = (
      await tenant.pool.query<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Lock timeout savings', 'savings', 'cash', 'Asset') RETURNING id`)
    ).rows[0];
    const thread = (
      await tenant.pool.query<{ uuid: string }>(`INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('account', $1, 'question', 'Which bank?') RETURNING uuid`, [
        account.id,
      ])
    ).rows[0];
    const held = async <T>(table: string, id: number, fn: () => Promise<T>): Promise<T> => {
      const holder: PoolClient = await tenant.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
        return await fn();
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    };
    const itemTags = async () => (await tenant.pool.query(`SELECT 1 FROM taggings WHERE taggable_type = 'budget_item' AND taggable_id = $1`, [item.id])).rowCount;
    const replies = async () => (await tenant.pool.query(`SELECT 1 FROM annotations WHERE subject_type = 'account' AND subject_id = $1`, [account.id])).rowCount;
    for (const write of [
      { table: 'budget_items', id: item.id, label: 'budget item', send: () => request(app).post(`/api/tags/budget-items/${item.uuid}/tags`).send({ tag_id: tag.id }), count: itemTags },
      {
        table: 'accounts',
        id: account.id,
        label: 'account',
        send: () => request(app).post('/api/annotations').send({ parent_uuid: thread.uuid, kind: 'answer', body: 'The credit union' }),
        count: replies,
      },
    ]) {
      const before = await write.count();
      const res = await held(write.table, write.id, write.send);
      expect({ status: res.status, body: res.body }).toMatchObject({
        status: 409,
        body: { code: 'RECORD_BUSY', error: `Another change to this ${write.label} was being saved at the same time, so nothing was saved. Try again.` },
      });
      expect(await write.count()).toBe(before);
      const retried = await write.send();
      expect(retried.status, JSON.stringify(retried.body)).toBe(201);
      expect(await write.count()).toBe((before ?? 0) + 1);
    }
  }, 30_000);

  it('answers taking a tag off the same way', async () => {
    await tenant.pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2)`, [tag.id, transaction.id]);
    for (const send of [
      () => request(app).delete(`/api/transactions/${transaction.uuid}/tags/${tag.uuid}`),
      () => request(app).delete(`/api/tags/transaction/${transaction.uuid}/tag/${tag.id}`),
    ]) {
      const res = await whileDeleting(send);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe('TRANSACTION_BUSY');
      expect(await tagCount()).toBe(1);
    }
  }, 30_000);
});
