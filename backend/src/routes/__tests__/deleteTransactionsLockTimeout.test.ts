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
import pool from '../../db.js';
import { createDataManagementRoutes } from '../data-management.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { BackupService } from '../../services/BackupService.js';

/**
 * Delete Transactions when a lock it needs is held past the pool's lock_timeout.
 * Postgres fails its statement with 55P03 (lock_not_available), which rolls the deletion
 * back whole; it answered 500. It answers 409 DELETION_CONFLICT, as a deadlock, with
 * nothing deleted, and the same preview deletes once the lock is gone.
 */
describe('delete-transactions when a lock wait times out', () => {
  let app: Express;
  let tenant: TestTenant;
  let accountId: number;

  beforeAll(async () => {
    tenant = await createTestTenant('Delete transactions lock timeout');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/data-management', createDataManagementRoutes({ backupService: new BackupService(pool) }));
    accountId = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Lock timeout checking', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  const add = async (date: string, amount: number) =>
    (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, $2, $3, 'expense', 'Lock timeout fixture') RETURNING id`,
        [accountId, amount, date]
      )
    ).rows[0].id;

  const exists = async (id: number) => (await tenant.pool.query('SELECT 1 FROM transactions WHERE id = $1', [id])).rowCount === 1;

  const preview = async (range: object) => {
    const res = await request(app).post('/api/data-management/preview-delete-transactions').send(range);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { count: number; selectionKey: string };
  };

  const remove = (range: object, previewed: { selectionKey: string }) =>
    request(app).post('/api/data-management/delete-transactions').send({ ...range, createBackup: false, selectionKey: previewed.selectionKey });

  /** Run `fn` while another connection holds `lock` (a locking SELECT) in an open transaction. */
  const whileHeld = async <T>(lock: string, params: unknown[], fn: () => Promise<T>): Promise<T> => {
    const holder: PoolClient = await tenant.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(lock, params);
      return await fn();
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  };

  it('answers 409 DELETION_CONFLICT, with nothing deleted, when a transaction stays locked (55P03)', async () => {
    const first = await add('2022-03-10', -12);
    const second = await add('2022-03-11', -13);
    const range = { dateFrom: '2022-03-01', dateTo: '2022-03-31', excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(2);

    // Another write holds the second row (an edit, a sync) longer than Delete may wait: its
    // lock of the range waits on it, after it has locked the first.
    const res = await whileHeld('SELECT 1 FROM transactions WHERE id = $1 FOR SHARE', [second], () => remove(range, previewed));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('DELETION_CONFLICT');
    expect(res.body.error).toMatch(/nothing was deleted.*try again/i);
    expect(JSON.stringify(res.body)).not.toMatch(/lock|timeout|55P03/i);
    expect([await exists(first), await exists(second)]).toEqual([true, true]);

    // The other write is done: tried again, the same preview deletes both.
    const retried = await remove(range, previewed);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.count).toBe(2);
    expect([await exists(first), await exists(second)]).toEqual([false, false]);
  });

  it('answers 409 DELETION_CONFLICT, with nothing deleted, when what goes with a transaction stays locked', async () => {
    const receipted = await add('2022-04-10', -40);
    const attachment = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO attachments (name, original_filename, safe_filename, file_extension, file_name, transaction_id)
         VALUES ('Receipt', 'r.pdf', 'r.pdf', 'pdf', 'r.pdf', $1) RETURNING id`,
        [receipted]
      )
    ).rows[0].id;
    const range = { dateFrom: '2022-04-01', dateTo: '2022-04-30', excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(1);

    // The deletion takes the receipt with it (ON DELETE CASCADE), and waits for the lock on it:
    // after it has deleted the transaction, which the timeout rolls back.
    const res = await whileHeld('SELECT 1 FROM attachments WHERE id = $1 FOR UPDATE', [attachment], () => remove(range, previewed));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('DELETION_CONFLICT');
    expect(await exists(receipted)).toBe(true);
    expect((await tenant.pool.query('SELECT 1 FROM attachments WHERE id = $1', [attachment])).rowCount).toBe(1);
  });
});
