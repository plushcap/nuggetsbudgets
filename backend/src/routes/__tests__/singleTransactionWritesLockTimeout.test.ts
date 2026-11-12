import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The app pool's lock_timeout (DB_LOCK_TIMEOUT_MS, 15 s by default), short here so a wait
// for a held lock ends in this test's time. db.ts reads it as it's imported, so it is set
// before any import; put back for whatever runs in this process next.
const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '1000';
  process.env.LOG_LEVEL ??= 'silent';
  return previous;
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createTransactionsRoutes } from '../transactions.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * An edit, a split or an unsplit of one transaction that waits too long for it.
 * Each locked the transaction (and a transfer's other side) with a FOR UPDATE of its own,
 * not through lockTransactions: behind Delete Transactions, which holds a range FOR UPDATE,
 * or a bulk edit holding a split, the wait passed the pool's lock_timeout and failed with
 * 55P03, which answered a generic 500. Each answers 409 TRANSACTION_BUSY now, nothing saved,
 * as a write of several transactions does, and goes through when tried again. An unsplit and
 * a re-split lock the splits they delete too, after the parent, in id order.
 */
describe('an edit, split or unsplit of one transaction that waits too long for it', () => {
  let app: Express;
  let tenant: TestTenant;
  let accountId: number;

  beforeAll(async () => {
    tenant = await createTestTenant('Single transaction writes lock timeout');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    accountId = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Busy single', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  type Row = { id: number; uuid: string };
  const one = async <T = Row>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const add = (date: string) =>
    one(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -40, $2, 'expense', 'Busy single') RETURNING id, uuid`,
      [accountId, date]
    );
  const splitBody = { splits: [{ amount: -25 }, { amount: -15 }] };
  const splitOf = async (row: Row) => {
    const res = await request(app).post(`/api/transactions/${row.uuid}/split`).send(splitBody);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (await tenant.pool.query<{ id: number }>('SELECT id FROM transactions WHERE parent_transaction_id = $1 ORDER BY id', [row.id])).rows.map((r) => r.id);
  };

  /** Run `fn` while another connection holds transaction `id` (FOR UPDATE, as Delete Transactions holds a range). */
  const whileHeld = async <T>(id: number, fn: () => Promise<T>, lock = 'FOR UPDATE'): Promise<T> => {
    const holder: PoolClient = await tenant.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM transactions WHERE id = $1 ${lock}`, [id]);
      return await fn();
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  };

  const expectBusy = (res: request.Response, what: string) => {
    expect({ what, status: res.status, code: res.body.code }).toEqual({ what, status: 409, code: 'TRANSACTION_BUSY' });
    expect(res.body.error).toMatch(/^Another change to these transactions was being saved at the same time, so nothing was (saved|deleted)\. Try again\.$/);
    expect(JSON.stringify(res.body)).not.toMatch(/lock|timeout|55P03/i);
  };

  const columnOf = async (id: number, column: string) => (await tenant.pool.query(`SELECT ${column} AS v FROM transactions WHERE id = $1`, [id])).rows[0]?.v;
  const childrenOf = async (id: number) =>
    (await tenant.pool.query<{ id: number }>('SELECT id FROM transactions WHERE parent_transaction_id = $1 ORDER BY id', [id])).rows.map((r) => r.id);

  it('an edit answers 409 TRANSACTION_BUSY, changing nothing, and goes through when tried again', async () => {
    const row = await add('2022-07-01');
    const send = () => request(app).put(`/api/transactions/${row.uuid}`).send({ description: 'Edited' });
    expectBusy(await whileHeld(row.id, send), 'edit');
    expect(await columnOf(row.id, 'description')).toBe('Busy single');
    const retried = await send();
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(await columnOf(row.id, 'description')).toBe('Edited');
  });

  it('a split answers 409 TRANSACTION_BUSY, splitting nothing', async () => {
    const row = await add('2022-07-02');
    const send = () => request(app).post(`/api/transactions/${row.uuid}/split`).send(splitBody);
    expectBusy(await whileHeld(row.id, send), 'split');
    expect(await childrenOf(row.id)).toEqual([]);
    expect((await send()).status).toBe(200);
    expect(await childrenOf(row.id)).toHaveLength(2);
  });

  it('a re-split whose split is held answers 409 TRANSACTION_BUSY, keeping the splits', async () => {
    const row = await add('2022-07-03');
    const children = await splitOf(row);
    const send = () => request(app).post(`/api/transactions/${row.uuid}/split`).send({ splits: [{ amount: -20 }, { amount: -20 }] });
    // A bulk edit holds the split it changes (FOR NO KEY UPDATE).
    expectBusy(await whileHeld(children[1]!, send, 'FOR NO KEY UPDATE'), 're-split');
    expect(await childrenOf(row.id)).toEqual(children);
    expect((await send()).status).toBe(200);
  });

  it('an unsplit answers 409 TRANSACTION_BUSY, whether its transaction or one of its splits is held', async () => {
    const row = await add('2022-07-04');
    const children = await splitOf(row);
    const send = () => request(app).delete(`/api/transactions/${row.uuid}/unsplit`);

    expectBusy(await whileHeld(row.id, send), 'unsplit, transaction held');
    expectBusy(await whileHeld(children[0]!, send, 'FOR NO KEY UPDATE'), 'unsplit, split held');
    expect(await childrenOf(row.id)).toEqual(children);
    expect(await columnOf(row.id, 'is_split_parent')).toBe(true);

    const retried = await send();
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(await childrenOf(row.id)).toEqual([]);
  });
});
