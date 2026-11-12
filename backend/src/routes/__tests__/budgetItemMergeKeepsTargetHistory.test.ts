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
 * A change to the merge target's history while a merge runs. The merge kept
 * the target's balance this month to "what it had plus what the merged item had left" by
 * reading the target's live remaining before and after it moved the merged item's rows, and
 * recording the difference. A rollover remaining is a running total, so a change to the
 * target in an earlier period (which the merge doesn't lock) committed between the two reads
 * was undone by that correction: a transfer out of it made money, a budget change or a
 * transaction on it vanished. The correction now comes from the merged item's rows alone.
 *
 * Periods P0 (last month) and P1 (this month); envelopes T, S and X. T has +50 in P0, S has a
 * row in P1 only, and a goal links S. A connection holding the goal's row pauses the merge
 * where it moves the goal's link, after it has read what it keeps; the change runs then.
 */
describe("A change to the merge target's history during the merge", () => {
  let app: Express;
  let tenant: TestTenant;
  let p0: { id: number; uuid: string };
  let p1: { id: number; uuid: string };
  let accountId: number;
  let seq = 0;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const pidOf = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const blockedBy = async (pid: number) =>
    (await tenant.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rowCount! > 0;
  const waitUntil = async (check: () => Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Merge keeps target history');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budget-periods', createBudgetPeriodRoutes());
    app.use('/api/budgets', createBudgetRoutes());
    const period = (offset: number) => one<{ id: number; uuid: string }>(
      `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
       SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), extract(month FROM d)::int, extract(year FROM d)::int,
              d, (d + interval '1 month - 1 day')::date
         FROM (SELECT (date_trunc('month', app_today()) + make_interval(months => $1))::date AS d) m
       RETURNING id, uuid`,
      [offset]
    );
    p0 = await period(-1);
    p1 = await period(0);
    accountId = (await one<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`
    )).id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  async function envelope(name: string, periods: Array<{ id: number }>) {
    const item = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', true, 'Envelope') RETURNING id, uuid`,
      [`${name} ${++seq}`]
    );
    const rows: Array<{ id: number; uuid: string }> = [];
    for (const p of periods) {
      rows.push(await one('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id, uuid', [p.id, item.id]));
    }
    return { ...item, rows };
  }
  const left = async (rowId: number) => Number((await one<{ r: string }>('SELECT calculate_remaining_for_period_item($1) AS r', [rowId])).r);

  /** Merge S into T with the merge paused at the goal's lock, `change` run meanwhile; the balances after. */
  async function mergeWith(change: (t: Awaited<ReturnType<typeof envelope>>, x: Awaited<ReturnType<typeof envelope>>) => Promise<number>) {
    const t = await envelope('Target', [p0, p1]);
    const s = await envelope('Merged', [p1]);
    const x = await envelope('Other', [p0, p1]);
    await one(
      `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
       VALUES ($1, $2, 'add', 'budget_update', 50) RETURNING id`,
      [t.rows[0]!.id, t.id]
    );
    const goal = await one<{ id: number }>(
      `INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount) VALUES ($1, 'Savings', 'Goal', 'Goal', 1000) RETURNING id`,
      [`Goal ${seq}`]
    );
    await one('INSERT INTO goal_budget_items (goal_id, budget_item_id, valid_from) VALUES ($1, $2, $3) RETURNING id', [goal.id, s.id, '2020-01-01']);

    const gate = await tenant.pool.connect();
    let merging: Promise<request.Response> | undefined;
    let changed: number | undefined;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM budget_items WHERE id = $1 FOR NO KEY UPDATE', [goal.id]);
      const gatePid = await pidOf(gate);
      merging = request(app).post(`/api/budgets/items/${s.uuid}/merge`).send({ into_uuid: t.uuid }).then((r) => r);
      await waitUntil(() => blockedBy(gatePid));
      changed = await change(t, x);
      await gate.query('COMMIT');
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
    const merged = await merging!;
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    return { changed, t: await left(t.rows[1]!.id), x: await left(x.rows[1]!.id) };
  }

  it('a transfer out of the target in an earlier period: no money from nowhere', async () => {
    const result = await mergeWith(async (t, x) => (await request(app).post(`/api/budget-periods/${p0.uuid}/transfer`)
      .send({ fromBudgetPeriodItemId: t.rows[0]!.id, toBudgetPeriodItemId: x.rows[0]!.id, amount: '5.00' })).status);
    expect(result).toEqual({ changed: 200, t: 45, x: 5 });
  });

  it("a budget change to the target's earlier period stays", async () => {
    const result = await mergeWith(async (t) => (await request(app).put(`/api/budgets/period-items/${t.rows[0]!.uuid}/budget`).send({ amount: 40 })).status);
    expect(result).toEqual({ changed: 200, t: 40, x: 0 });
  });

  it("spending on the target in an earlier period stays", async () => {
    const result = await mergeWith(async (t) => {
      await one(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, budget_period_id)
         SELECT $1, -5, start_date + 1, 'expense', 'Groceries', $2, id FROM budget_period WHERE id = $3 RETURNING id`,
        [accountId, t.id, p0.id]
      );
      return 201;
    });
    expect(result).toEqual({ changed: 201, t: 45, x: 0 });
  });
});
