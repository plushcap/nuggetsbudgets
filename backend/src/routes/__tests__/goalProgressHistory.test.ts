import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';
import { addDays, addMonths, daysBetween, firstOfMonth, lastOfMonth } from '../../utils/calendarDate.js';

/**
 * A goal's progress history, computed from the balances when it is read, through
 * the real app under RLS. One goal of ledger A has two linked accounts (and a hidden one,
 * which doesn't count), and an envelope, all linked since the goal began; their
 * transactions and budget events change over the last four months. GET /api/goals/:uuid/progress-history answers its progress
 * at each month end and today, which the expected figures below give by hand; the
 * projection's growth rate reads the same points. Ledger B's goal is a 404.
 *
 * The dates are relative to today (the ledger's app_today()): M-k is the month k months
 * before this one, E-k its last day.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

type Point = { snapshot_date: string; total_from_accounts: string; total_from_budget_items: string; total_progress: string };

describeDb('Goal progress history', () => {
  let h: RouteHarness;
  let a: TestTenant;
  let b: TestTenant;
  let member: string;
  let today: string;
  let goal: { id: number; uuid: string };
  let goalB: { uuid: string };
  /** The first day of the month k months back (0 = this month). */
  const monthStart = (k: number) => addMonths(firstOfMonth(today), -k);
  /** Day `d` of the month k months back. */
  const day = (k: number, d: number) => `${monthStart(k).slice(0, 8)}${String(d).padStart(2, '0')}`;
  /** The last day of the month k months back. */
  const monthEnd = (k: number) => lastOfMonth(monthStart(k));

  const one = async <T>(t: TestTenant, text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows[0] as T;
  const account = async (name: string, hidden = false) =>
    (
      await one<{ id: number }>(
        a,
        `INSERT INTO accounts (name, account_type, account_group, type, hide_account) VALUES ($1, 'savings', 'cash', 'Asset', $2) RETURNING id`,
        [name, hidden]
      )
    ).id;
  const txn = (
    accountId: number,
    amount: string,
    date: string,
    type: 'starting balance' | 'income' | 'expense',
    envelope?: { itemId: number; periodId: number }
  ) =>
    a.pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, budget_period_id)
       VALUES ($1, $2, $3, $4, 'Goal history', $5, $6)`,
      [accountId, amount, date, type, envelope?.itemId ?? null, envelope?.periodId ?? null]
    );
  const history = async (query = '') => {
    const res = await h.call(member, 'get', `/api/goals/${goal.uuid}/progress-history${query}`);
    expect(res.status, res.text).toBe(200);
    return res.body.history as Point[];
  };
  const point = (date: string, accounts: string, envelopes: string, total: string): Point => ({
    snapshot_date: date,
    total_from_accounts: accounts,
    total_from_budget_items: envelopes,
    total_progress: total,
  });

  /** The goal's progress at each date, worked out by hand from the fixture in beforeAll. */
  let expected: Record<'e4' | 'e3' | 'e2' | 'e1' | 'today', Point>;

  beforeAll(async () => {
    h = await startRouteHarness('Goal progress history');
    a = await createTestTenant('Goal history A');
    b = await createTestTenant('Goal history B');
    member = await h.signIn(a.userId, a.tenantId);
    today = (await one<{ today: string }>(a, 'SELECT app_today()::text AS today')).today;

    // A budget period for each of the last four months and this one.
    const periods = (
      await a.pool.query<{ id: number; start_date: string }>(
        `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
         SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), extract(year FROM d)::int, extract(month FROM d)::int,
                d::date, (d + interval '1 month - 1 day')::date
           FROM generate_series(date_trunc('month', app_today()::timestamp) - interval '4 months',
                                date_trunc('month', app_today()::timestamp), interval '1 month') AS d
         RETURNING id, start_date::text`
      )
    ).rows;
    const periodOf = (k: number) => periods.find((p) => p.start_date === monthStart(k))!.id;

    // The goal, begun on the 2nd of M-4: its life so far covers E-4 to today.
    const created = await h.call(member, 'post', '/api/goals', { name: 'House', target_amount: 5000, target_date: '2030-01-01' });
    expect(created.status, created.text).toBe(201);
    goal = { id: created.body.goal.id, uuid: created.body.goal.uuid };
    await a.pool.query(`UPDATE budget_items SET created_at = $2::date + time '12:00' WHERE id = $1`, [goal.id, day(4, 2)]);

    // Savings (linked): 1,000.00 opening in M-4, +250.50 in M-3, -100.25 in M-2, +300.00
    // on the 20th of M-1 (not counted at E-2), and +999.99 dated five days from now, which
    // counts at no date up to today.
    const savings = await account('Savings');
    await txn(savings, '1000.00', day(4, 10), 'starting balance');
    await txn(savings, '250.50', day(3, 15), 'income');
    await txn(savings, '-100.25', day(2, 5), 'expense');
    await txn(savings, '300.00', day(1, 20), 'income');
    await txn(savings, '999.99', addDays(today, 5), 'income');
    // Brokerage (linked): 500.00 opening on the 1st of M-3, -50.00 in M-1, +10.00 on the
    // 1st of this month (on or before today).
    const brokerage = await account('Brokerage');
    await txn(brokerage, '500.00', day(3, 1), 'starting balance');
    await txn(brokerage, '-50.00', day(1, 10), 'expense');
    await txn(brokerage, '10.00', day(0, 1), 'income');
    // Hidden (linked, so it never counts) and Checking (not linked).
    const hidden = await account('Old savings', true);
    await txn(hidden, '5000.00', day(4, 1), 'starting balance');
    const checking = await account('Checking');
    await txn(checking, '777.00', day(4, 1), 'starting balance');
    for (const id of [savings, brokerage, hidden]) {
      const res = await h.call(member, 'post', `/api/goals/${goal.uuid}/accounts`, { account_id: id });
      expect(res.status, res.text).toBe(201);
    }

    // The envelope (linked): a 25.00 starting balance in M-4, 200.00 budgeted in M-3 and
    // 100.00 in M-2, an 80.00 expense in M-1, and 50.00 budgeted and a 20.00 expense this
    // month. Another envelope, not linked, has 999.00 in M-3.
    const envelope = await one<{ id: number }>(a, `INSERT INTO budget_items (name, expense_type, rollover) VALUES ('House fund', 'Savings', true) RETURNING id`);
    const other = await one<{ id: number }>(a, `INSERT INTO budget_items (name, expense_type, rollover) VALUES ('Holiday fund', 'Savings', true) RETURNING id`);
    const periodItems = (
      await a.pool.query<{ id: number; uuid: string; budget_item_id: number; budget_period_id: number }>(
        `INSERT INTO budget_period_items (budget_period_id, budget_item_id)
         SELECT p.id, i.id FROM budget_period p CROSS JOIN unnest($1::int[]) AS i(id)
         RETURNING id, uuid, budget_item_id, budget_period_id`,
        [[envelope.id, other.id]]
      )
    ).rows;
    const periodItem = (itemId: number, k: number) => periodItems.find((p) => p.budget_item_id === itemId && p.budget_period_id === periodOf(k))!;
    const budget = async (itemId: number, k: number, amount: number) => {
      const res = await h.call(member, 'put', `/api/budgets/period-items/${periodItem(itemId, k).uuid}/budget`, { amount });
      expect(res.status, res.text).toBe(200);
    };
    // The starting balance event, as BudgetService.changeStartingBalance records it.
    await a.pool.query(`SELECT record_budget_change_event($1, $2, 25.00, 0, 'Starting balance', NULL, NULL, 'starting_balance')`, [
      periodItem(envelope.id, 4).id,
      envelope.id,
    ]);
    await budget(envelope.id, 3, 200);
    await budget(envelope.id, 2, 100);
    await txn(checking, '-80.00', day(1, 12), 'expense', { itemId: envelope.id, periodId: periodOf(1) });
    await budget(envelope.id, 0, 50);
    await txn(checking, '-20.00', day(0, 1), 'expense', { itemId: envelope.id, periodId: periodOf(0) });
    await budget(other.id, 3, 999);
    const linked = await h.call(member, 'post', `/api/goals/${goal.uuid}/budget-items`, { budget_item_id: envelope.id });
    expect(linked.status, linked.text).toBe(201);
    // Linked the day the goal began: a link counts from its first day on, and the
    // routes link from today. (goalLinkHistory.test.ts has links made later.)
    await a.pool.query('UPDATE budget_item_accounts SET valid_from = $2 WHERE budget_item_id = $1', [goal.id, day(4, 2)]);
    await a.pool.query('UPDATE goal_budget_items SET valid_from = $2 WHERE goal_id = $1', [goal.id, day(4, 2)]);

    // By hand: accounts are savings + brokerage; the envelope is its running balance.
    //          savings    brokerage   accounts    envelope   total
    //   E-4    1000.00       0.00     1000.00      25.00    1025.00
    //   E-3    1250.50     500.00     1750.50     225.00    1975.50
    //   E-2    1150.25     500.00     1650.25     325.00    1975.25
    //   E-1    1450.25     450.00     1900.25     245.00    2145.25
    //   today  1450.25     460.00     1910.25     275.00    2185.25
    expected = {
      e4: point(monthEnd(4), '1000.00', '25.00', '1025.00'),
      e3: point(monthEnd(3), '1750.50', '225.00', '1975.50'),
      e2: point(monthEnd(2), '1650.25', '325.00', '1975.25'),
      e1: point(monthEnd(1), '1900.25', '245.00', '2145.25'),
      today: point(today, '1910.25', '275.00', '2185.25'),
    };

    // Ledger B's goal, with an account of its own.
    goalB = await one<{ uuid: string }>(
      b,
      `INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount, goal_target_date)
       VALUES ('Their goal', 'Savings', 'Goal', 'Goal', 1000, '2027-01-01') RETURNING uuid`
    );
  }, 120_000);

  afterAll(async () => {
    const settled = await Promise.allSettled([h?.close(), a?.cleanup(), b?.cleanup()]);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, 60_000);

  it('answers the progress at each month end and today, from the balances', async () => {
    expect(await history(`?start_date=${monthStart(4)}&end_date=${today}`)).toEqual([
      expected.e4,
      expected.e3,
      expected.e2,
      expected.e1,
      expected.today,
    ]);
  });

  it("covers the goal's life so far by default, and agrees with its current progress", async () => {
    expect(await history()).toEqual([expected.e4, expected.e3, expected.e2, expected.e1, expected.today]);

    const detail = await h.call(member, 'get', `/api/goals/${goal.uuid}`);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.goal).toMatchObject({ total_from_accounts: 1910.25, total_from_budget_items: 275, current_progress: 2185.25 });
    expect(detail.body.goal.progress_history).toEqual([expected.e4, expected.e3, expected.e2, expected.e1, expected.today]);
  });

  it('answers only the dates in the range, and none after today', async () => {
    // From the middle of M-3: E-3 is in the range, today isn't.
    expect(await history(`?start_date=${day(3, 16)}&end_date=${monthEnd(1)}`)).toEqual([expected.e3, expected.e2, expected.e1]);
    expect(await history(`?start_date=${monthEnd(2)}&end_date=${monthEnd(2)}`)).toEqual([expected.e2]);
    // An end in the future stops at today: no month end after it, and no forecast.
    expect(await history(`?start_date=${monthStart(1)}&end_date=${addMonths(today, 3)}`)).toEqual([expected.e1, expected.today]);
    expect(await history(`?start_date=${monthStart(1)}`)).toEqual([expected.e1, expected.today]);
    // Only an end: the goal's life up to it.
    expect(await history(`?end_date=${monthEnd(3)}`)).toEqual([expected.e4, expected.e3]);
    // Wholly after today, or before the goal with no start: nothing.
    expect(await history(`?start_date=${addDays(today, 1)}&end_date=${addMonths(today, 1)}`)).toEqual([]);
    expect(await history(`?start_date=${addDays(today, 1)}`)).toEqual([]);
    expect(await history(`?end_date=${day(4, 1)}`)).toEqual([]);
    // A range before the goal began is answered from the balances: the savings opening
    // on the 10th of M-4 is in E-4, and before it there is nothing.
    expect(await history(`?start_date=${addMonths(monthStart(4), -1)}&end_date=${monthEnd(4)}`)).toEqual([
      point(monthEnd(5), '0.00', '0.00', '0.00'),
      expected.e4,
    ]);
  });

  it('projects completion from the growth over its latest points', async () => {
    // The latest four points are E-3, E-2, E-1 and today: 1,975.50 to 2,185.25 is 209.75
    // over the months from E-3 to today; 5,000.00 - 2,185.25 = 2,814.75 to go.
    const elapsedMonths = daysBetween(monthEnd(3), today) / 30.4375;
    const months = Math.ceil(2814.75 / (209.75 / elapsedMonths));
    const detail = await h.call(member, 'get', `/api/goals/${goal.uuid}`);
    expect(detail.body.goal.projection).toMatchObject({
      currentProgress: 2185.25,
      remainingAmount: 2814.75,
      pastPerformanceMonths: months,
      pastPerformanceDate: addMonths(today, months),
    });
    const listed = await h.call(member, 'get', '/api/goals');
    expect(listed.body.goals.find((g: { uuid: string }) => g.uuid === goal.uuid)).toMatchObject({
      current_progress: 2185.25,
      projected_completion_date: addMonths(today, months),
    });
  });

  it('refuses a malformed date, a start after the end, or a range of more than ten years', async () => {
    for (const query of ['?start_date=31/10/2026', `?end_date=${today}T00:00:00Z`, '?start_date=2026-02-30', '?start_date=a&start_date=b']) {
      const res = await h.call(member, 'get', `/api/goals/${goal.uuid}/progress-history${query}`);
      expect(res.status, query).toBe(400);
    }
    const backwards = await h.call(member, 'get', `/api/goals/${goal.uuid}/progress-history?start_date=${monthEnd(1)}&end_date=${monthEnd(2)}`);
    expect(backwards.status).toBe(400);
    expect(backwards.body.code).toBe('INVALID_DATE_RANGE');
    for (const query of ['?start_date=1926-01-01', '?start_date=1900-01-01&end_date=2000-01-01', `?start_date=${addDays(addMonths(today, -120), -31)}`]) {
      const res = await h.call(member, 'get', `/api/goals/${goal.uuid}/progress-history${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.code).toBe('DATE_RANGE_TOO_LONG');
    }
    // Ten years exactly is answered: 120 month ends and today at most.
    const tenYears = await history(`?start_date=${addMonths(today, -120)}`);
    expect(tenYears.length).toBeGreaterThanOrEqual(120);
    expect(tenYears.length).toBeLessThanOrEqual(121);
    expect(tenYears[tenYears.length - 1]).toEqual(expected.today);
  });

  it("answers another ledger's goal with a 404", async () => {
    expect((await h.call(member, 'get', `/api/goals/${goalB.uuid}/progress-history`)).status).toBe(404);
    expect((await h.call(member, 'get', `/api/goals/${goalB.uuid}/progress-history?start_date=${monthStart(4)}`)).status).toBe(404);
  });
});
