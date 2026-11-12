import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Long enough that the deadlock detector (1 s), not a lock timeout, decides.
const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '8000';
  process.env.LOG_LEVEL ??= 'silent';
  return previous;
});

/**
 * Every request transaction of this file reads tables in their physical order (no index or
 * bitmap scans), so a delete that locks rows as it scans them meets them in the order they
 * were written, whatever plan the database would pick for the table's size.
 */
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
import { createAnnotationsRoutes } from '../annotations.js';
import { createMerchantsRoutes } from '../merchants.js';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Deletes of several rows against a manual resolve of notes on them. The resolve
 * locks its notes' subjects in id order (FOR KEY SHARE, lockSubjectsForReference) and then
 * answers each thread. The budget-period delete (its period items), and the unused-merchants
 * and pass-through-securities cleanups, took their rows as they scanned them: holding the
 * higher one, a delete waited for the lower one the resolve held, while the resolve waited
 * for the higher one. Postgres broke the deadlock by failing one of them, a 500. Each now
 * locks its rows in id order first, so it waits at the lower one holding none, and the two
 * go one after the other.
 *
 * The race is set up from a third connection: it holds the lower row FOR KEY SHARE (as an
 * insert with a foreign key to it would), so the delete waits there; the resolve then takes
 * the lower row (a key share waits for no other) and goes for the higher one. The rows are
 * written higher id first, so a delete that scans the table meets the higher one first.
 */
describe('deletes of several rows against a manual resolve of notes on them', () => {
  let app: Express;
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Deletes lock in id order');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/annotations', createAnnotationsRoutes());
    app.use('/api/merchants', createMerchantsRoutes());
    app.use('/api/budget-periods', createBudgetPeriodRoutes());
    app.use('/api/investments', createInvestmentsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  const query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows as T[];
  /** Two ids from `sequence`, lower first. */
  const twoIds = async (sequence: string): Promise<[number, number]> => {
    const rows = await query<{ id: string }>(`SELECT nextval($1::regclass) AS id FROM generate_series(1, 2)`, [sequence]);
    const [lower, higher] = rows.map((r) => Number(r.id)).sort((a, b) => a - b);
    return [lower!, higher!];
  };
  const blockedBy = async (pid: number) =>
    (await query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).map((r) => r.pid);
  const pidOf = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const waitUntil = async (check: () => Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  /**
   * An open note on each of the two rows of `subjectType`, then the race: `remove` (the
   * delete) waits behind a third connection's key share of the lower row, and a manual
   * resolve of every open thread starts. Answers both answers.
   */
  const race = async (table: string, subjectType: string, [lower, higher]: [number, number], remove: () => Promise<request.Response>) => {
    await query(
      `INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ($1, $2, 'question', 'Lower?'), ($1, $3, 'question', 'Higher?')`,
      [subjectType, lower, higher]
    );
    const gate: PoolClient = await tenant.pool.connect();
    let removing: Promise<request.Response> | undefined;
    let resolving: Promise<request.Response> | undefined;
    try {
      await gate.query('BEGIN');
      const gatePid = await pidOf(gate);
      await gate.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR KEY SHARE`, [lower]);
      removing = remove().then((res) => res);
      await waitUntil(async () => (await blockedBy(gatePid)).length > 0);
      const removerPid = (await blockedBy(gatePid))[0]!;
      let resolved = false;
      resolving = request(app)
        .post('/api/annotations/manual-resolve')
        .send({ scope: 'all' })
        .then((res) => {
          resolved = true;
          return res;
        });
      // The resolve either goes through (the delete holds none of its rows) or waits for the
      // delete at the higher row (it holds that one).
      await waitUntil(async () => resolved || (await blockedBy(removerPid)).length > 0);
    } finally {
      await gate.query('COMMIT').catch(() => undefined);
      gate.release();
    }
    const [removed, resolvedRes] = await Promise.all([removing!, resolving!]);
    return { removed, resolved: resolvedRes };
  };

  const remaining = async (table: string, ids: number[]) => (await query<{ id: number }>(`SELECT id FROM ${table} WHERE id = ANY($1::int[]) ORDER BY id`, [ids])).map((r) => r.id);
  const notesOn = async (subjectType: string, ids: number[]) =>
    (await query(`SELECT 1 FROM annotations WHERE subject_type = $1 AND subject_id = ANY($2::int[])`, [subjectType, ids])).length;

  it('the budget-period delete takes its items in id order: neither answers a server error', async () => {
    const period = (
      await query<{ id: number; uuid: string }>(
        `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
         VALUES ('March 2019', 'March', 3, 2019, '2019-03-01', '2019-03-31') RETURNING id, uuid`
      )
    )[0]!;
    // The lower period item is the higher budget item's, so the period's unique key also
    // meets the higher period item first.
    const items = await query<{ id: number }>(`INSERT INTO budget_items (name, expense_type) VALUES ('Order first', 'Expense'), ('Order second', 'Expense') RETURNING id`);
    const [first, second] = items.map((r) => r.id).sort((a, b) => a - b);
    const ids = await twoIds('budget_period_items_id_seq');
    await query(`INSERT INTO budget_period_items (id, budget_period_id, budget_item_id) VALUES ($1, $3, $4), ($2, $3, $5)`, [ids[1], ids[0], period.id, first, second]);

    const { removed, resolved } = await race('budget_period_items', 'budget_period_item', ids, () => request(app).delete(`/api/budget-periods/${period.uuid}`));

    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    // The resolve went first; the delete then took the items and their threads with them.
    expect(await remaining('budget_period_items', ids)).toEqual([]);
    expect(await notesOn('budget_period_item', ids)).toBe(0);
  }, 30_000);

  it('the unused-merchants cleanup takes them in id order: neither answers a server error', async () => {
    const ids = await twoIds('merchants_id_seq');
    await query(`INSERT INTO merchants (id, name) VALUES ($2, 'Unused higher'), ($1, 'Unused lower')`, ids);

    const { removed, resolved } = await race('merchants', 'merchant', ids, () => request(app).post('/api/merchants/admin/remove-unused'));

    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.removedCount).toBe(2);
    expect(await remaining('merchants', ids)).toEqual([]);
    expect(await notesOn('merchant', ids)).toBe(0);
  }, 30_000);

  it('the pass-through-securities cleanup takes them in id order: neither answers a server error', async () => {
    const ids = await twoIds('securities_id_seq');
    await query(
      `INSERT INTO securities (id, ticker, name, is_pass_through) VALUES ($2, 'ORDH', 'Order higher fund', true), ($1, 'ORDL', 'Order lower fund', true)`,
      ids
    );

    const { removed, resolved } = await race('securities', 'security', ids, () => request(app).delete('/api/investments/securities/cleanup/pass-through-unused'));

    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.deleted).toBe(2);
    expect(await remaining('securities', ids)).toEqual([]);
    expect(await notesOn('security', ids)).toBe(0);
  }, 30_000);

  it('a cleanup leaves a merchant given a transaction while it waited for its lock', async () => {
    const ids = await twoIds('merchants_id_seq');
    await query(`INSERT INTO merchants (id, name) VALUES ($1, 'Soon used'), ($2, 'Still unused')`, ids);
    const account = (await query<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Cleanup checking', 'checking', 'cash', 'Asset') RETURNING id`))[0]!.id;

    // The cleanup has found both unused, and waits to lock the first; meanwhile it is given
    // a transaction.
    const gate: PoolClient = await tenant.pool.connect();
    let removing: Promise<request.Response> | undefined;
    try {
      await gate.query('BEGIN');
      const gatePid = await pidOf(gate);
      await gate.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, merchant_id) VALUES ($1, -5, '2019-04-02', 'expense', 'Now used', $2)`,
        [account, ids[0]]
      );
      removing = request(app).post('/api/merchants/admin/remove-unused').then((res) => res);
      await waitUntil(async () => (await blockedBy(gatePid)).length > 0);
    } finally {
      await gate.query('COMMIT').catch(() => undefined);
      gate.release();
    }
    const removed = await removing!;

    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.removedMerchants.map((m: { name: string }) => m.name)).toEqual(['Still unused']);
    expect(await remaining('merchants', ids)).toEqual([ids[0]]);
    expect((await query<{ merchant_id: number }>(`SELECT merchant_id FROM transactions WHERE account_id = $1`, [account]))[0]!.merchant_id).toBe(ids[0]);
  }, 30_000);
});
