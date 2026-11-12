import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The app pool's lock_timeout (DB_LOCK_TIMEOUT_MS, 15 s by default), short here so the
// merge's wait for a held goal ends in this test's time; db.ts reads it as it's imported.
const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '1000';
  process.env.LOG_LEVEL ??= 'silent';
  return previous;
});

import request from 'supertest';
import express, { type Express } from 'express';
import { createBudgetRoutes } from '../budgets.js';
import { createGoalRoutes } from '../goals.js';
import { withTenant } from '../../db/withTenant.js';
import { GoalService } from '../../services/GoalService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Merging a budget item that a goal links: the merge moves the item's whole history onto the
 * target, so the goal gets the target linked from the first day of its link to the merged item
 * (a link to the target from later begins then; one from earlier is left as it is), and its
 * link to the merged item closes today.
 * The goal's history stays smooth and ends at today's figure, the target's own money
 * before the merge counted too.
 *
 * Three periods, two months ago's (M-2), last month's (M-1) and this month's (a goal's
 * figures are taken at month ends and today). In each case the source S had +100 in M-2
 * and +50 in M-1, the target T its own +40 in M-2 and +30 in M-1, and this month S moved
 * its 150 to T (an envelope must be empty to be merged); then S is merged into T.
 */
describe('Merging an envelope a goal links', () => {
  let tenant: TestTenant;
  let app: Express;
  let periods: { twoBack: number; oneBack: number; current: number };
  let days: { twoBackEnd: string; oneBackEnd: string; today: string; firstOfLastMonth: string };
  let seq = 0;
  type Ref = { id: number; uuid: string };

  const one = async <T = Ref>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const period = (monthsBack: number) =>
    one<{ id: number }>(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), extract(year FROM d)::int, extract(month FROM d)::int,
              d::date, (d + interval '1 month - 1 day')::date
         FROM (SELECT date_trunc('month', app_today()::timestamp) - make_interval(months => $1::int) AS d) m
       RETURNING id`,
      [monthsBack],
    );
  const envelope = async (name: string) => {
    const item = await one(`INSERT INTO budget_items (name, expense_type, type, rollover) VALUES ($1, 'Expense', 'Envelope', true) RETURNING id, uuid`, [`${name} ${++seq}`]);
    await tenant.pool.query('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $4), ($2, $4), ($3, $4)', [
      periods.twoBack, periods.oneBack, periods.current, item.id,
    ]);
    return item;
  };
  /** A budget event of `amount` on the item's row in the period. */
  const event = async (item: Ref, periodId: number, transactionType: 'add' | 'move_in' | 'move_out', amount: number) =>
    tenant.pool.query(
      `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
       SELECT id, $2, $3, $4, $5 FROM budget_period_items WHERE budget_period_id = $1 AND budget_item_id = $2`,
      [periodId, item.id, transactionType, transactionType === 'add' ? 'budget_update' : 'transfer', amount],
    );
  const goal = () =>
    one(`INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount, goal_target_date)
         VALUES ($1, 'Savings', 'Goal', 'Goal', 1000, '2027-06-30') RETURNING id, uuid`, [`House ${++seq}`]);
  /** Link the goal to the envelope from `from` (a calendar date). */
  const link = (g: Ref, item: Ref, from: string) =>
    tenant.pool.query('INSERT INTO goal_budget_items (goal_id, budget_item_id, valid_from) VALUES ($1, $2, $3)', [g.id, item.id, from]);
  const links = async (g: Ref) =>
    (await tenant.pool.query<{ budget_item_id: number; valid_from: string; valid_to: string | null }>(
      'SELECT budget_item_id, valid_from::text, valid_to::text FROM goal_budget_items WHERE goal_id = $1 ORDER BY budget_item_id, valid_from',
      [g.id],
    )).rows;
  /** The goal's figure from its envelopes at the end of M-2, the end of M-1 and today, and its current progress. */
  const history = async (g: Ref) =>
    withTenant(tenant.tenantId, async () => {
      const service = new GoalService();
      const points = await service.progressAt(g.id, [days.twoBackEnd, days.oneBackEnd, days.today]);
      const now = await service.calculateCurrentProgress(g.id);
      return [...points.map((p) => p.total_from_budget_items), now.totalFromBudgetItems];
    });
  const merge = (from: Ref, into: Ref) => request(app).post(`/api/budgets/items/${from.uuid}/merge`).send({ into_uuid: into.uuid });

  /** S and T with the figures above: S +100 (M-2) and +50 (M-1), T +40 and +30, then S's 150 moved to T this month. */
  const sourceAndTarget = async () => {
    const source = await envelope('Car fund');
    const target = await envelope('Savings pot');
    await event(source, periods.twoBack, 'add', 100);
    await event(target, periods.twoBack, 'add', 40);
    await event(source, periods.oneBack, 'add', 50);
    await event(target, periods.oneBack, 'add', 30);
    await event(source, periods.current, 'move_out', 150);
    await event(target, periods.current, 'move_in', 150);
    return { source, target };
  };
  /** The day a long-standing link began: before M-2 began. */
  let longAgo: string;

  beforeAll(async () => {
    tenant = await createTestTenant('Goal link merge');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budgets', createBudgetRoutes());
    app.use('/api/goals', createGoalRoutes());
    periods = { twoBack: (await period(2)).id, oneBack: (await period(1)).id, current: (await period(0)).id };
    days = await one(
      `SELECT (date_trunc('month', app_today()::timestamp) - interval '1 month' - interval '1 day')::date::text AS "twoBackEnd",
              (date_trunc('month', app_today()::timestamp) - interval '1 day')::date::text AS "oneBackEnd",
              (date_trunc('month', app_today()::timestamp) - interval '1 month')::date::text AS "firstOfLastMonth",
              app_today()::text AS today`,
    );
    longAgo = (await one<{ d: string }>(`SELECT (date_trunc('month', app_today()::timestamp) - interval '3 months')::date::text AS d`)).d;
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  it('links the target from the start of the link to the merged item: 140 / 220 / 220 at M-2, M-1 and today', async () => {
    const { source, target } = await sourceAndTarget();
    const g = await goal();
    await link(g, source, longAgo);
    // Before: S's own figures, and nothing today (its money moved to T, which the goal doesn't link).
    expect(await history(g)).toEqual(['100.00', '150.00', '0.00', 0]);

    await merge(source, target).expect(200);

    // S's whole history is T's now: T counts from the day S's link began, T's own 40 and 30 too.
    expect(await history(g)).toEqual(['140.00', '220.00', '220.00', 220]);
    expect(await links(g)).toEqual([
      { budget_item_id: source.id, valid_from: longAgo, valid_to: days.today },
      { budget_item_id: target.id, valid_from: longAgo, valid_to: null },
    ].sort((x, y) => x.budget_item_id - y.budget_item_id));
  });

  it('moves a link to the target from later back to the start of the link to the merged item', async () => {
    const { source, target } = await sourceAndTarget();
    const g = await goal();
    await link(g, source, longAgo);
    await link(g, target, days.firstOfLastMonth);
    // Before: S alone at M-2's end; S and T at M-1's end; T alone today.
    expect(await history(g)).toEqual(['100.00', '220.00', '220.00', 220]);

    await merge(source, target).expect(200);

    expect(await history(g)).toEqual(['140.00', '220.00', '220.00', 220]);
    const after = await links(g);
    expect(after.filter((l) => l.budget_item_id === target.id)).toEqual([{ budget_item_id: target.id, valid_from: longAgo, valid_to: null }]);
    expect(after.find((l) => l.budget_item_id === source.id)?.valid_to).toBe(days.today);
  });

  it('changes nothing of a link to the target from earlier', async () => {
    const { source, target } = await sourceAndTarget();
    const g = await goal();
    await link(g, target, longAgo);
    await link(g, source, days.firstOfLastMonth);
    const before = await history(g);
    // T throughout, and S from M-1 on.
    expect(before).toEqual(['40.00', '220.00', '220.00', 220]);

    await merge(source, target).expect(200);

    // S's M-2 money counts now (it is T's, and T was linked then): the history keeps every
    // later figure, and today's.
    expect(await history(g)).toEqual(['140.00', '220.00', '220.00', 220]);
    expect((await links(g)).filter((l) => l.budget_item_id === target.id)).toEqual([
      { budget_item_id: target.id, valid_from: longAgo, valid_to: null },
    ]);
  });

  it('folds a closed link to the target that overlaps the start into one link', async () => {
    const { source, target } = await sourceAndTarget();
    const g = await goal();
    await link(g, source, days.firstOfLastMonth);
    // T was linked once, from long ago to the middle of last month.
    await tenant.pool.query(
      'INSERT INTO goal_budget_items (goal_id, budget_item_id, valid_from, valid_to) VALUES ($1, $2, $3, $4::date + 10)',
      [g.id, target.id, longAgo, days.firstOfLastMonth],
    );

    await merge(source, target).expect(200);

    expect((await links(g)).filter((l) => l.budget_item_id === target.id)).toEqual([
      { budget_item_id: target.id, valid_from: longAgo, valid_to: null },
    ]);
    expect(await history(g)).toEqual(['140.00', '220.00', '220.00', 220]);
  });

  /** A closed link of the goal to the envelope, [from, to). */
  const closedLink = (g: Ref, item: Ref, from: string, to: string) =>
    tenant.pool.query('INSERT INTO goal_budget_items (goal_id, budget_item_id, valid_from, valid_to) VALUES ($1, $2, $3, $4)', [g.id, item.id, from, to]);
  /** A day `n` days after `day`. */
  const plus = (day: string, n: number) => one<{ d: string }>('SELECT ($1::date + $2::int)::text AS d', [day, n]).then((r) => r.d);

  // This case: a goal linked S from the 7th of M-3 to
  // the 6th of M-1, and again from the 26th of M-1. The target took only the open range, so
  // the goal's M-2 reading lost S's 100: 0 / 220 / 220 where it had read 100 / 150 / 0.
  it('gives the target every range the goal had on the merged item, closed ones too, so its past readings keep that money', async () => {
    const { source, target } = await sourceAndTarget();
    const g = await goal();
    const from = await plus(longAgo, 6);
    const to = await plus(days.firstOfLastMonth, 5);
    const again = await plus(days.firstOfLastMonth, 25);
    await closedLink(g, source, from, to);
    await link(g, source, again);
    expect(await history(g)).toEqual(['100.00', '150.00', '0.00', 0]);

    await merge(source, target).expect(200);

    // S's money is T's on the days the goal linked S, T's own 40 and 30 with it.
    expect(await history(g)).toEqual(['140.00', '220.00', '220.00', 220]);
    expect((await links(g)).filter((l) => l.budget_item_id === target.id)).toEqual([
      { budget_item_id: target.id, valid_from: from, valid_to: to },
      { budget_item_id: target.id, valid_from: again, valid_to: null },
    ]);
    // S's ranges stay as they were, its open one closed today.
    expect((await links(g)).filter((l) => l.budget_item_id === source.id)).toEqual([
      { budget_item_id: source.id, valid_from: from, valid_to: to },
      { budget_item_id: source.id, valid_from: again, valid_to: days.today },
    ]);
  });

  it('moves the links of a goal that had unlinked the merged item before the merge', async () => {
    const { source, target } = await sourceAndTarget();
    const g = await goal();
    const to = await plus(days.firstOfLastMonth, 5);
    await closedLink(g, source, longAgo, to);
    expect(await history(g)).toEqual(['100.00', '0.00', '0.00', 0]);

    await merge(source, target).expect(200);

    expect(await history(g)).toEqual(['140.00', '0.00', '0.00', 0]);
    expect((await links(g)).filter((l) => l.budget_item_id === target.id)).toEqual([
      { budget_item_id: target.id, valid_from: longAgo, valid_to: to },
    ]);
  });

  it("folds the merged item's ranges into the target's own where they meet or overlap, keeping the target's open link", async () => {
    const { source, target } = await sourceAndTarget();
    const g = await goal();
    const sEnd = await plus(days.firstOfLastMonth, 5);
    // S: [longAgo, M-1 + 5); T: open from M-1 + 5, which S's range meets.
    await closedLink(g, source, longAgo, sEnd);
    await link(g, target, sEnd);
    const openId = (await one<{ id: number }>('SELECT id FROM goal_budget_items WHERE goal_id = $1 AND budget_item_id = $2', [g.id, target.id])).id;

    await merge(source, target).expect(200);

    const after = await tenant.pool.query<{ id: number; valid_from: string; valid_to: string | null }>(
      'SELECT id, valid_from::text, valid_to::text FROM goal_budget_items WHERE goal_id = $1 AND budget_item_id = $2',
      [g.id, target.id],
    );
    expect(after.rows).toEqual([{ id: openId, valid_from: longAgo, valid_to: null }]);
    expect(await history(g)).toEqual(['140.00', '220.00', '220.00', 220]);
  });

  // By design, a goal counts only envelopes, so a merge into a monthly
  // item took the merged envelope's money out of the goal's history (100 / 150 / 0 became
  // 0 / 0 / 0). While a goal links it, now or before, such a merge is refused, naming the goals.
  const monthlyItem = () =>
    one(`INSERT INTO budget_items (name, expense_type, type, rollover) VALUES ($1, 'Expense', 'Monthly', false) RETURNING id, uuid`, [`Gifts ${++seq}`]);
  const status = (item: Ref) => one<{ status: string; events: number }>(
    `SELECT bi.status, (SELECT COUNT(*)::int FROM budget_period_transactions WHERE budget_item_id = bi.id) AS events FROM budget_items bi WHERE bi.id = $1`,
    [item.id],
  );

  it('refuses to merge an envelope a goal links into an item that is not an envelope: 409, naming the goal, nothing merged', async () => {
    const { source } = await sourceAndTarget();
    const monthly = await monthlyItem();
    const g = await goal();
    await link(g, source, longAgo);
    const before = await history(g);
    expect(before).toEqual(['100.00', '150.00', '0.00', 0]);

    const res = await merge(source, monthly);
    expect([res.status, res.body.code]).toEqual([409, 'MERGE_UNLINKS_GOALS']);
    const name = (await one<{ name: string }>('SELECT name FROM budget_items WHERE id = $1', [g.id])).name;
    expect(res.body.goals).toEqual([{ uuid: g.uuid, name, deleted: false }]);
    expect(res.body.error).toContain(name);
    expect(await status(source)).toEqual({ status: 'active', events: 3 });
    expect(await links(g)).toEqual([{ budget_item_id: source.id, valid_from: longAgo, valid_to: null }]);
    expect(await history(g)).toEqual(before);
  });

  it('refuses it for a goal that unlinked the envelope before, too, and says so in its usage', async () => {
    const { source } = await sourceAndTarget();
    const monthly = await monthlyItem();
    const g = await goal();
    await tenant.pool.query('INSERT INTO goal_budget_items (goal_id, budget_item_id, valid_from, valid_to) VALUES ($1, $2, $3, $4)', [g.id, source.id, longAgo, days.firstOfLastMonth]);
    const name = (await one<{ name: string }>('SELECT name FROM budget_items WHERE id = $1', [g.id])).name;
    expect((await request(app).get(`/api/budgets/items/${source.uuid}/usage`).expect(200)).body.linked_goals).toEqual([{ uuid: g.uuid, name, deleted: false }]);
    expect((await merge(source, monthly)).body.code).toBe('MERGE_UNLINKS_GOALS');
    expect(await status(source)).toEqual({ status: 'active', events: 3 });
  });

  // By design, DELETE /api/goals/:uuid archives a goal and keeps its
  // links, and a goal that ever linked the envelope blocks the merge, a deleted one too. The
  // refusal marks it deleted and says the way through (an envelope); the usage answer does too.
  it('refuses it for a deleted goal, marked as deleted, and still merges into an envelope', async () => {
    const { source, target } = await sourceAndTarget();
    const monthly = await monthlyItem();
    const trip = await one(`INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount, goal_target_date)
      VALUES ('Old trip', 'Savings', 'Goal', 'Goal', 500, '2027-06-30') RETURNING id, uuid`);
    await link(trip, source, longAgo);
    await request(app).delete(`/api/goals/${trip.uuid}`).expect(200);
    expect((await one<{ status: string }>('SELECT status FROM budget_items WHERE id = $1', [trip.id])).status).toBe('archived');

    const goals = [{ uuid: trip.uuid, name: 'Old trip', deleted: true }];
    expect((await request(app).get(`/api/budgets/items/${source.uuid}/usage`).expect(200)).body.linked_goals).toEqual(goals);
    const res = await merge(source, monthly);
    expect([res.status, res.body.code, res.body.goals]).toEqual([409, 'MERGE_UNLINKS_GOALS', goals]);
    expect(res.body.error).toMatch(/^.+ counts toward the goal Old trip \(deleted\), and .+ isn’t an envelope/);
    expect(res.body.error).toContain('so merge it into an envelope instead');
    expect(res.body.error).toContain('A deleted goal keeps its history, so it counts as well');
    expect(await status(source)).toEqual({ status: 'active', events: 3 });
    // The way through it names.
    await merge(source, target).expect(200);
  });

  // The goals were named by DISTINCT name, so two goals called the same were one.
  it('names each of two goals with one name, in the plural', async () => {
    const { source } = await sourceAndTarget();
    const monthly = await monthlyItem();
    const dup = () => one(`INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount, goal_target_date)
      VALUES ('Dup goal', 'Savings', 'Goal', 'Goal', 100, '2027-06-30') RETURNING id, uuid`);
    const [a, b] = [await dup(), await dup()];
    await link(a, source, longAgo);
    await link(b, source, days.firstOfLastMonth);
    const res = await merge(source, monthly);
    expect(res.body.goals.map((g: { uuid: string }) => g.uuid).sort()).toEqual([a.uuid, b.uuid].sort());
    expect(res.body.error).toContain('counts toward the goals Dup goal, Dup goal, and');
    expect(res.body.error).toContain('out of those goals’ history');
  });

  // The refusal is checked after the merge's up-front lock. A goal linked to
  // the envelope while the merge waits for it (associateBudgetItem holds the envelope's row) is
  // seen, and the merge is refused; checked before the lock, the merge went on and archived it.
  it('refuses the merge for a goal linked while it waits for the envelope', async () => {
    const { source } = await sourceAndTarget();
    const monthly = await monthlyItem();
    const g2 = await goal();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let linked!: () => void;
    const linking = new Promise<void>((resolve) => (linked = resolve));
    const holder = withTenant(tenant.tenantId, async () => {
      await new GoalService().associateBudgetItem(g2.id, source.id);
      linked();
      await held;
    });
    await linking;
    const merging = merge(source, monthly).then((r) => r); // .then starts the request now
    expect(await waitForLockWaiters(1)).toBe(true);
    release();
    await holder;
    const res = await merging;
    const name = (await one<{ name: string }>('SELECT name FROM budget_items WHERE id = $1', [g2.id])).name;
    expect([res.status, res.body.code, res.body.goals]).toEqual([409, 'MERGE_UNLINKS_GOALS', [{ uuid: g2.uuid, name, deleted: false }]]);
    expect(await status(source)).toEqual({ status: 'active', events: 3 });
  });

  it('merges an envelope no goal links into a monthly item', async () => {
    const { source } = await sourceAndTarget();
    expect((await request(app).get(`/api/budgets/items/${source.uuid}/usage`).expect(200)).body.linked_goals).toEqual([]);
    await merge(source, await monthlyItem()).expect(200);
  });

  // By design, a merge combines the two histories, so a goal that links only the target
  // sees the merged item's money in the target's past. That is intended.
  it("shows a goal linked only to the target the merged item's money in the target's past", async () => {
    const { source, target } = await sourceAndTarget();
    const g = await goal();
    await link(g, target, longAgo);
    expect(await history(g)).toEqual(['40.00', '70.00', '220.00', 220]);
    await merge(source, target).expect(200);
    expect(await history(g)).toEqual(['140.00', '220.00', '220.00', 220]);
  });

  it('answers 409 RECORD_BUSY, merging nothing, while another change holds the goal past the lock timeout', async () => {
    const { source, target } = await sourceAndTarget();
    const g = await goal();
    await link(g, source, longAgo);
    const client = await tenant.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM budget_items WHERE id = $1 FOR UPDATE', [g.id]);
      const res = await merge(source, target);
      expect([res.status, res.body.code]).toEqual([409, 'RECORD_BUSY']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const kept = await one<{ status: string; events: string }>(
      `SELECT bi.status, (SELECT COUNT(*) FROM budget_period_transactions WHERE budget_item_id = bi.id) AS events FROM budget_items bi WHERE bi.id = $1`,
      [source.id],
    );
    expect(kept).toEqual({ status: 'active', events: '3' });
    expect((await links(g)).map((l) => [l.budget_item_id, l.valid_to])).toEqual([[source.id, null]]);
  });

  it('leaves the links of a goal that does not link the merged item', async () => {
    const { source, target } = await sourceAndTarget();
    const other = await envelope('Other');
    const g = await goal();
    await link(g, other, longAgo);
    await merge(source, target).expect(200);
    expect(await links(g)).toEqual([{ budget_item_id: other.id, valid_from: longAgo, valid_to: null }]);
  });

  /**
   * Wait (up to 900 ms, under the lock timeout) until `count` sessions of this database wait
   * on a lock: both merges, on the held goal or on each other. Asked on another connection:
   * inside the holder's transaction pg_stat_activity would be the snapshot it first read.
   */
  const waitForLockWaiters = async (count: number): Promise<boolean> => {
    for (let i = 0; i < 90; i++) {
      const { rows } = await tenant.pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
      );
      if (rows[0].n >= count) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };

  // Two merges of one empty item into two targets at once both answered 200,
  // and a goal linking it ended up linking both targets.
  it('refuses the second of two merges of one item at once: one link, to the first target', async () => {
    const source = await envelope('Spare');
    const t = await envelope('Pot T');
    const u = await envelope('Pot U');
    const g = await goal();
    await link(g, source, longAgo);

    // Hold the goal, so both merges get as far as they can before either commits.
    const client = await tenant.pool.connect();
    let answers: request.Response[];
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM budget_items WHERE id = $1 FOR UPDATE', [g.id]);
      const both = Promise.all([merge(source, t).then((r) => r), merge(source, u).then((r) => r)]);
      await waitForLockWaiters(2);
      await client.query('COMMIT');
      answers = await both;
    } finally {
      client.release();
    }
    const statuses = answers.map((r) => r.status).sort();
    expect(statuses, answers.map((r) => r.text).join('\n')).toEqual([200, 400]);
    expect(answers.find((r) => r.status === 400)?.body.error).toMatch(/is archived/);
    const open = (await links(g)).filter((l) => l.valid_to === null);
    expect(open).toHaveLength(1);
    expect([t.id, u.id]).toContain(open[0].budget_item_id);
  });
});
