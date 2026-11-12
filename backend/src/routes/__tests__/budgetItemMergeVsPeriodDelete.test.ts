import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Long enough that the deadlock detector (1 s), not a lock timeout, decides.
const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '8000';
  process.env.LOG_LEVEL ??= 'silent';
  return previous;
});

// Physical-order scans, as deletesLockInIdOrder.test.ts does, so the gate's row is met first.
vi.mock('../../db/withTenant.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/withTenant.js')>();
  const { sql } = await import('kysely');
  return {
    ...actual,
    withTenant: <T>(tenantId: number, fn: Parameters<typeof actual.withTenant<T>>[1]) =>
      actual.withTenant(tenantId, async (trx) => {
        await sql`SELECT set_config('enable_indexscan', 'off', true), set_config('enable_indexonlyscan', 'off', true),
                         set_config('enable_bitmapscan', 'off', true)`.execute(trx);
        return fn(trx);
      }),
  };
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import { createBudgetRoutes } from '../budgets.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A budget item's merge and a budget period's delete at once. The delete locks
 * the period's transactions, then its period items, then deletes its budget events; the merge
 * moved the merged item's budget events (row locks, and a key share on the target's period
 * item) before it locked the transactions, so the two waited on each other and Postgres ended
 * the merge with a deadlock, a 500. The merge now locks its transactions first, as every write
 * of several transactions does, so it waits for the delete, or the delete for it.
 *
 * A gate holds another item's budget event in the period, so the delete stops in its DELETE
 * of the budget events, having taken its locks, before it reaches the merged item's.
 */
describe('A budget item merge and a budget period delete at once', () => {
  let app: Express;
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Merge vs period delete');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budget-periods', createBudgetPeriodRoutes());
    app.use('/api/budgets', createBudgetRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const blockedBy = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map((r) => r.pid);
  const pidOf = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const waitUntil = async (check: () => Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  // Whether the target item has a row in the period, and whether the merged item has spending
  // there (or only budget events): with no spending there, the two shared no transaction lock
  // and still deadlocked (the merge's event move waited for the target's row the delete held),
  // and a target row the merge added was committed between the delete's steps.
  it.each([
    { targetRow: true, spending: true, year: 2016 },
    { targetRow: false, spending: true, year: 2013 },
    { targetRow: true, spending: false, year: 2011 },
    { targetRow: false, spending: false, year: 2012 },
  ])('both succeed, one after the other (target row: $targetRow, spending in the period: $spending)', async ({ targetRow, spending, year }) => {
    const period = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
       VALUES ($1, 'July', 7, $2, make_date($2, 7, 1), make_date($2, 7, 31)) RETURNING id, uuid`,
      [`July ${year}`, year]
    );
    const other = await one<{ id: number }>(`INSERT INTO budget_items (name, expense_type, rollover) VALUES ('Other item', 'Expense', false) RETURNING id`);
    const item = await one<{ id: number; uuid: string }>(`INSERT INTO budget_items (name, expense_type, rollover) VALUES ('Merged item', 'Expense', false) RETURNING id, uuid`);
    const into = await one<{ id: number; uuid: string }>(`INSERT INTO budget_items (name, expense_type, rollover) VALUES ('Target item', 'Expense', false) RETURNING id, uuid`);
    const otherRow = await one<{ id: number }>(`INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id`, [period.id, other.id]);
    const itemRow = await one<{ id: number }>(`INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id`, [period.id, item.id]);
    if (targetRow) await one(`INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id`, [period.id, into.id]);
    // The gate's event first, physically, then the merged item's.
    const gateEvent = await one<{ id: number }>(
      `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount) VALUES ($1, $2, 'add', 'budget_update', 0) RETURNING id`,
      [otherRow.id, other.id]
    );
    await one(
      `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount) VALUES ($1, $2, 'add', 'budget_update', 0) RETURNING id`,
      [itemRow.id, item.id]
    );
    const account = await one<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`);
    // Spending in the period, or (without) in no period at all, so the merge still has some.
    await one(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, budget_period_id)
       VALUES ($1, -3, make_date($2, 7, 4), 'expense', 'Groceries', $3, $4) RETURNING id`,
      [account.id, year, item.id, spending ? period.id : null]
    );

    const gate: PoolClient = await tenant.pool.connect();
    let deleting: Promise<request.Response> | undefined;
    let merging: Promise<request.Response> | undefined;
    try {
      await gate.query('BEGIN');
      const gatePid = await pidOf(gate);
      await gate.query('SELECT 1 FROM budget_period_transactions WHERE id = $1 FOR UPDATE', [gateEvent.id]);
      deleting = request(app).delete(`/api/budget-periods/${period.uuid}`).then((r) => r);
      await waitUntil(async () => (await blockedBy(gatePid)).length > 0);
      const deleterPid = (await blockedBy(gatePid))[0]!;
      merging = request(app).post(`/api/budgets/items/${item.uuid}/merge`).send({ into_uuid: into.uuid }).then((r) => r);
      let done = false;
      void merging.then(() => (done = true));
      await waitUntil(async () => done || (await blockedBy(deleterPid)).length > 0);
    } finally {
      await gate.query('COMMIT').catch(() => undefined);
      gate.release();
    }
    const [deleted, merged] = await Promise.all([deleting!, merging!]);
    expect([`${deleted.status} ${deleted.body.code ?? ''}`.trim(), `${merged.status} ${merged.body.code ?? ''}`.trim()]).toEqual(['200', '200']);
  }, 30_000);
});
