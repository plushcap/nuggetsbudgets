import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import { createBudgetRoutes } from '../budgets.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Budget item merges and the period rows they don't start with.
 *
 * - A target with no row this month: T has a row only in P-2 (+50.00), S is monthly with rows
 *   in P-1 (20.00) and P0 (25.00). T should hold 50.00 + S's 25.00 left this month = 75.00. The
 *   merge read T's current row before it gave T rows in S's periods, so it kept T's balance on
 *   the P-2 row, and the rows T then took in counted S's P-1 leftover too: 120.00.
 * - A period created during a merge gave S a row (with its default budget) the merge hadn't
 *   locked or moved, left on S once archived. Period creation now waits for the merge (the
 *   ledger's budget item rows lock, BudgetService.lockBudgetItemRows), and then leaves the
 *   archived S out.
 * - An item restored during a merge: the restore changes the item's row, which the merge
 *   holds, so the merge waits for it and then sees its rows (or the restore waits and finds
 *   nothing archived to restore); either way no row escapes the merge.
 */
describe('Budget item merges and new period rows', () => {
  let app: Express;
  let tenant: TestTenant;
  const periods: Record<number, { id: number; uuid: string }> = {};
  let seq = 0;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const pidOf = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const blockedPids = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map((r) => r.pid);
  const waitUntil = async (check: () => Promise<boolean>, ms = 5_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const left = async (rowId: number) => (await one<{ r: string }>('SELECT calculate_remaining_for_period_item($1) AS r', [rowId])).r;
  const rowOf = async (itemId: number, periodId: number) =>
    (await one<{ id: number } | undefined>('SELECT id FROM budget_period_items WHERE budget_item_id = $1 AND budget_period_id = $2', [itemId, periodId]))?.id ?? null;
  const events = async (itemId: number) => (await one<{ n: string; total: string }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN transaction_type IN ('add', 'move_in') THEN amount ELSE -amount END), 0) AS total
       FROM budget_period_transactions WHERE budget_item_id = $1`, [itemId]
  ));

  beforeAll(async () => {
    tenant = await createTestTenant('Merge new rows');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budget-periods', createBudgetPeriodRoutes());
    app.use('/api/budgets', createBudgetRoutes());
    for (const offset of [-2, -1, 0]) {
      periods[offset] = await one(
        `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
         SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), extract(month FROM d)::int, extract(year FROM d)::int,
                d, (d + interval '1 month - 1 day')::date
           FROM (SELECT (date_trunc('month', app_today()) + make_interval(months => $1))::date AS d) m
         RETURNING id, uuid`,
        [offset]
      );
    }
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  /** An item with a row in each of `budgets`' periods (by offset), and that budget in it. */
  async function item(kind: 'envelope' | 'monthly', budgets: Record<number, number>, defaultBudget: number | null = null) {
    const created = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type, default_budget_amount) VALUES ($1, 'Expense', $2, $3, $4) RETURNING id, uuid`,
      [`${kind} ${++seq}`, kind === 'envelope', kind === 'envelope' ? 'Envelope' : 'Monthly', defaultBudget]
    );
    for (const [offset, amount] of Object.entries(budgets)) {
      const row = await one<{ id: number }>(
        'INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [periods[Number(offset)]!.id, created.id]
      );
      if (amount !== 0) {
        await one(
          `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
           VALUES ($1, $2, 'add', 'budget_update', $3) RETURNING id`,
          [row.id, created.id, amount]
        );
      }
    }
    return created;
  }

  const merge = (s: { uuid: string }, t: { uuid: string }) =>
    request(app).post(`/api/budgets/items/${s.uuid}/merge`).send({ into_uuid: t.uuid }).then((r) => r);

  it('a target with no row this month ends at what it had plus what the merged item had left this month', async () => {
    const t = await item('envelope', { [-2]: 50 });
    const s = await item('monthly', { [-1]: 20, 0: 25 });
    const res = await merge(s, t);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const now = await rowOf(t.id, periods[0]!.id);
    expect(now, 'T has a row this month').not.toBeNull();
    expect(await left(now!)).toBe('75.00');
    // Its events add up to that (no spending here), and S holds none.
    expect((await events(t.id)).total).toBe('75.00');
    expect(Number((await events(s.id)).n)).toBe(0);
  });

  it('an empty envelope with rows but nothing in them: the target takes its rows, so it is on this month too', async () => {
    const t = await item('envelope', { [-2]: 50 });
    const s = await item('envelope', { [-1]: 0, 0: 0 });
    const res = await merge(s, t);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Before, T took rows only where S had events or transactions: none, so T, the item S's
    // budget is now in, was missing from this month's budget.
    const now = await rowOf(t.id, periods[0]!.id);
    expect(now, 'T has a row this month').not.toBeNull();
    expect(await left(now!)).toBe('50.00');
  });

  /** A goal linking `s`, and a connection holding its row: the merge pauses there, after it has moved S's events. */
  async function pausedMerge(s: { id: number; uuid: string }, t: { uuid: string }) {
    const goal = await one<{ id: number }>(
      `INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount) VALUES ($1, 'Savings', 'Goal', 'Goal', 1000) RETURNING id`,
      [`Goal ${++seq}`]
    );
    await one('INSERT INTO goal_budget_items (goal_id, budget_item_id, valid_from) VALUES ($1, $2, $3) RETURNING id', [goal.id, s.id, '2020-01-01']);
    const gate = await tenant.pool.connect();
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM budget_items WHERE id = $1 FOR NO KEY UPDATE', [goal.id]);
    const gatePid = await pidOf(gate);
    const merging = merge(s, t);
    let mergePid = 0;
    await waitUntil(async () => {
      [mergePid = 0] = await blockedPids(gatePid);
      return mergePid !== 0;
    });
    return {
      merging,
      mergePid,
      release: async () => {
        await gate.query('COMMIT').catch(() => undefined);
        gate.release();
      },
    };
  }

  it("a period created while the merge runs doesn't leave the merged item a row or its default budget", async () => {
    const t = await item('envelope', { 0: 50 });
    const s = await item('monthly', { 0: 25 }, 100);
    const paused = await pausedMerge(s, t);
    let creating: Promise<request.Response> | undefined;
    let waited: string;
    try {
      creating = request(app).post('/api/budget-periods').send({ year: 2302, month: 1, associate_transactions: false }).then((r) => r);
      // Before the fix the period didn't wait for the merge: it gave S a row and 100.00 there.
      waited = await Promise.race([
        creating.then(() => 'answered before the merge committed'),
        waitUntil(async () => (await blockedPids(paused.mergePid)).length > 0).then(() => 'waited for the merge'),
      ]);
    } finally {
      await paused.release();
    }
    const [merged, created] = await Promise.all([paused.merging, creating!]);
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(waited).toBe('waited for the merge');
    const next = await one<{ id: number }>('SELECT id FROM budget_period WHERE year = 2302 AND month_number = 1');
    // S is archived, and holds nothing: no row in the new period, no events anywhere.
    expect(await rowOf(s.id, next.id)).toBeNull();
    expect(Number((await events(s.id)).n)).toBe(0);
    // T has its row there, and this month what it had plus S's 25.00.
    expect(await rowOf(t.id, next.id)).not.toBeNull();
    expect(await left((await rowOf(t.id, periods[0]!.id))!)).toBe('75.00');
  });

  const ROUNDS = 30;

  it(`a merge and a period created at once: the archived item never keeps a row's money (${ROUNDS} rounds)`, async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const t = await item('envelope', { 0: 50 });
      const s = await item('monthly', { 0: 25 }, 100);
      const year = 2400 + round;
      const lead = (round % 10) * 2 - 6;
      const after = async (ms: number, send: () => Promise<request.Response>) => {
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
        return send();
      };
      const [merged, created] = await Promise.all([
        after(-lead, () => merge(s, t)),
        after(lead, () => request(app).post('/api/budget-periods').send({ year, month: 1, associate_transactions: false }).then((r) => r)),
      ]);
      const next = await one<{ id: number }>('SELECT id FROM budget_period WHERE year = $1 AND month_number = 1', [year]);
      const sRow = await rowOf(s.id, next.id);
      const tRow = (await rowOf(t.id, next.id))!;
      const sEvents = await events(s.id);
      const outcome = [
        `merge ${merged.status}`, `period ${created.status}`,
        `S ${sRow === null ? 'no row' : 'a row'} there, ${sEvents.n} events`,
        `T's budget there ${(await one<{ b: string }>('SELECT calculate_budget_for_period_item($1) AS b', [tRow])).b}`,
      ].join(', ');
      outcomes.add(outcome);
      expect([
        // The merge first: the period leaves S out.
        'merge 200, period 201, S no row there, 0 events, T\'s budget there 0.00',
        // The period first: the merge moves S's row's default budget to T.
        'merge 200, period 201, S a row there, 0 events, T\'s budget there 100.00',
      ], outcome).toContain(outcome);
    }
    if (process.env.SHOW_ROUNDS) process.stderr.write(`${[...outcomes].join('\n')}\n`);
  }, 120_000);

  it('an item restored while it is merged: the merge waits for the restore and takes its rows', async () => {
    const t = await item('envelope', { 0: 50 });
    const s = await item('monthly', { [-1]: 25 });
    await one(`UPDATE budget_items SET status = 'archived' WHERE id = $1 RETURNING id`, [s.id]);
    // A restore under way, as the service runs it: the item marked active, its rows added, not yet committed.
    const restore = await tenant.pool.connect();
    let merging: Promise<request.Response> | undefined;
    try {
      await restore.query('BEGIN');
      await restore.query(`UPDATE budget_items SET status = 'active' WHERE id = $1`, [s.id]);
      await restore.query(
        `INSERT INTO budget_period_items (budget_period_id, budget_item_id, starting)
         SELECT id, $1, 0 FROM budget_period ON CONFLICT ON CONSTRAINT budget_period_items_budget_period_id_budget_item_id_key DO NOTHING`,
        [s.id]
      );
      await restore.query(
        `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
         SELECT id, $1, 'add', 'budget_update', 30 FROM budget_period_items WHERE budget_item_id = $1 AND budget_period_id = $2`,
        [s.id, periods[0]!.id]
      );
      const restorePid = await pidOf(restore);
      merging = merge(s, t);
      await waitUntil(async () => (await blockedPids(restorePid)).length > 0);
      await restore.query('COMMIT');
    } finally {
      await restore.query('ROLLBACK').catch(() => undefined);
      restore.release();
    }
    const merged = await merging!;
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    // The rows the restore added (and the 30.00 budgeted on one) are the merge's: T holds 50.00 +
    // S's 30.00 left this month, and S holds nothing.
    expect(await left((await rowOf(t.id, periods[0]!.id))!)).toBe('80.00');
    expect(Number((await events(s.id)).n)).toBe(0);
  });
});
