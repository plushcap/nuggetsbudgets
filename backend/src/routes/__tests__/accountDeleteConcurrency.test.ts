import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Long enough that the deadlock detector (1 s), not a lock timeout, decides.
const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '6000';
  return previous;
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createAnnotationsRoutes } from '../annotations.js';
import { createAccountsRoutes } from '../accounts.js';
import { createTransactionsRoutes } from '../transactions.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Deleting an account while other requests write it. The delete removes the
 * opening balance, then the account. A note locks its subjects account first, then
 * transaction (`REFERENCE_LOCK_ORDER`), so resolving notes on both at once could deadlock,
 * and Postgres aborted the delete: a 500. Locking the account first instead deadlocked with
 * splitting the opening balance (the transaction, then the account its splits reference) and
 * made a second delete of the same account a 500. So the order stays, and a deadlock or a
 * lock timeout in the delete answers 409 RECORD_BUSY: try again. No case answers a 500.
 */
describe('Deleting an account while it is written', () => {
  let app: Express;
  let tenant: TestTenant;
  type Row = { id: number; uuid: string };

  beforeAll(async () => {
    tenant = await createTestTenant('Account delete and note locks');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/annotations', createAnnotationsRoutes());
    app.use('/api/accounts', createAccountsRoutes());
    app.use('/api/transactions', createTransactionsRoutes());
  });
  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  const one = async (text: string, params: unknown[]) => (await tenant.pool.query(text, params)).rows[0] as Row;
  const waitersOf = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map((r) => r.pid);
  const waitUntil = async (check: () => Promise<boolean>, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const newAccount = async (name: string) => {
    const account = await one(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id, uuid`, [name]);
    const opening = await one(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, 10, '2031-01-01', 'starting balance', 'Opening') RETURNING id, uuid`,
      [account.id]
    );
    return { account, opening };
  };
  /** Runs `start` while a gate holds `lockSql` on `id`, so the requests it starts overlap; then lets them go. */
  const overlapping = async <T>(lockSql: string, id: number, start: (waitForGate: () => Promise<void>) => Promise<T>): Promise<T> => {
    const gate: PoolClient = await tenant.pool.connect();
    try {
      await gate.query('BEGIN');
      const gatePid = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await gate.query(lockSql, [id]);
      const done = start(() => waitUntil(async () => (await waitersOf(gatePid)).length > 0));
      // Give the requests time to take their locks and queue behind each other.
      await new Promise((r) => setTimeout(r, 1500));
      await gate.query('COMMIT');
      return await done;
    } finally {
      await gate.query('ROLLBACK').catch(() => {});
      gate.release();
    }
  };

  it('and its notes are resolved: neither answers a server error', async () => {
    const { account, opening } = await newAccount('Old checking');
    await tenant.pool.query(`INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('account', $1, 'question', 'a'), ('transaction', $2, 'question', 't')`, [account.id, opening.id]);

    // Something holds the account FOR KEY SHARE a moment (an import's settings read, a row
    // inserted with a foreign key to it), so the two requests overlap.
    const [d, r] = await overlapping('SELECT 1 FROM accounts WHERE id = $1 FOR KEY SHARE', account.id, async (waitForGate) => {
      const del = request(app).delete(`/api/accounts/${account.uuid}`).then((x) => x);
      await waitForGate();
      const resolve = request(app).post('/api/annotations/manual-resolve').send({ scope: 'all' }).then((x) => x);
      return Promise.all([del, resolve]);
    });
    expect(d.status, JSON.stringify(d.body)).toBeLessThan(500);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
  }, 30_000);

  it('and its opening balance is split: neither answers a server error', async () => {
    const { account, opening } = await newAccount('Split while deleted');
    const [s, d] = await overlapping('SELECT 1 FROM transactions WHERE id = $1 FOR KEY SHARE', opening.id, async (waitForGate) => {
      const split = request(app).post(`/api/transactions/${opening.uuid}/split`).send({ splits: [{ amount: 4 }, { amount: 6 }] }).then((x) => x);
      await waitForGate();
      const del = request(app).delete(`/api/accounts/${account.uuid}`).then((x) => x);
      return Promise.all([split, del]);
    });
    expect(s.status, JSON.stringify(s.body)).toBeLessThan(500);
    expect(d.status, JSON.stringify(d.body)).toBeLessThan(500);
  }, 30_000);

  it('twice at once: neither answers a server error', async () => {
    const { account } = await newAccount('Twice deleted');
    const [a, b] = await overlapping('SELECT 1 FROM accounts WHERE id = $1 FOR KEY SHARE', account.id, async (waitForGate) => {
      const d1 = request(app).delete(`/api/accounts/${account.uuid}`).then((x) => x);
      const d2 = request(app).delete(`/api/accounts/${account.uuid}`).then((x) => x);
      await waitForGate();
      return Promise.all([d1, d2]);
    });
    expect(a.status, JSON.stringify(a.body)).toBeLessThan(500);
    expect(b.status, JSON.stringify(b.body)).toBeLessThan(500);
  }, 30_000);

  // The second delete waited for the first, then found nothing to delete and answered
  // 200 "Account deleted successfully". It answers 404, as a delete of an account that isn't
  // there does.
  it('twice at once: the one that finds it gone answers 404', async () => {
    const { account } = await newAccount('Deleted second');
    const gate: PoolClient = await tenant.pool.connect();
    let first: Promise<request.Response> | undefined;
    let second: Promise<request.Response> | undefined;
    try {
      await gate.query('BEGIN');
      const gatePid = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await gate.query('SELECT 1 FROM accounts WHERE id = $1 FOR KEY SHARE', [account.id]);
      // The first has deleted the opening balance and waits at the account; the second
      // then waits for the first at the opening balance.
      first = request(app).delete(`/api/accounts/${account.uuid}`).then((x) => x);
      let firstPid: number | undefined;
      await waitUntil(async () => (firstPid = (await waitersOf(gatePid))[0]) !== undefined);
      second = request(app).delete(`/api/accounts/${account.uuid}`).then((x) => x);
      await waitUntil(async () => (await waitersOf(firstPid!)).length > 0);
    } finally {
      await gate.query('COMMIT').catch(() => {});
      gate.release();
    }
    const [a, b] = await Promise.all([first!, second!]);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect({ status: b.status, body: b.body }).toMatchObject({ status: 404, body: { error: 'Account not found' } });
    expect((await tenant.pool.query('SELECT 1 FROM accounts WHERE id = $1', [account.id])).rowCount).toBe(0);
  }, 30_000);
});
