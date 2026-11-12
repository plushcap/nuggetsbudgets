import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createGoalRoutes } from '../goals.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { addDays, addMonths, daysBetween, firstOfMonth, lastOfMonth } from '../../utils/calendarDate.js';

// The "past performance" projection averaged the change between
// consecutive progress snapshots and called it a monthly rate, whatever the time between
// them. The rate is the change over the time the points span, per month. Now the
// points are the goal's progress history, computed from its balances: its month ends and
// today, over its life so far.
describe('Goal projection by past performance', () => {
  let app: Express;
  let tenant: TestTenant;
  let today: string;
  /** Day `d` of the month k months back (0 = this month). */
  const day = (k: number, d: number) => `${addMonths(firstOfMonth(today), -k).slice(0, 8)}${String(d).padStart(2, '0')}`;
  /** The last day of the month k months back. */
  const monthEnd = (k: number) => lastOfMonth(day(k, 1));

  /**
   * A goal of 10,000.00 begun on `begun`, with one linked savings account holding the
   * `deposits` ([date, amount]) and nothing else.
   */
  const createGoal = async (name: string, begun: string | null, deposits: Array<[string, string]>) => {
    const goal = (
      await tenant.pool.query<{ id: number; uuid: string }>(
        `INSERT INTO budget_items (name, status, type, expense_type, goal_target_amount, created_at)
         VALUES ($1, 'active', 'Goal', 'Savings', 10000, COALESCE($2::date + time '12:00', now())) RETURNING id, uuid`,
        [name, begun]
      )
    ).rows[0];
    const account = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'savings', 'cash', 'Asset') RETURNING id`,
        [`${name} savings`]
      )
    ).rows[0];
    for (const [date, amount] of deposits) {
      await tenant.pool.query(
        `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status)
         VALUES ($1, $2, 'Deposit', $3, 'income', 'cleared')`,
        [account.id, amount, date]
      );
    }
    // Linked the day the goal began: a link counts from its first day on.
    await tenant.pool.query(
      `INSERT INTO budget_item_accounts (budget_item_id, account_id, valid_from) VALUES ($1, $2, COALESCE($3::date, app_today()))`,
      [goal.id, account.id, begun]
    );
    return goal.uuid;
  };

  /** A goal of 10,000.00 begun on `begun`, with no account yet. */
  const bareGoal = async (name: string, begun: string) =>
    (
      await tenant.pool.query<{ id: number; uuid: string }>(
        `INSERT INTO budget_items (name, status, type, expense_type, goal_target_amount, created_at)
         VALUES ($1, 'active', 'Goal', 'Savings', 10000, $2::date + time '12:00') RETURNING id, uuid`,
        [name, begun]
      )
    ).rows[0];
  /** A savings account holding `deposits`, created hidden when `hidden`. */
  const savings = async (name: string, deposits: Array<[string, string]>, hidden = false) => {
    const { id } = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type, hide_account) VALUES ($1, 'savings', 'cash', 'Asset', $2) RETURNING id`,
        [name, hidden]
      )
    ).rows[0];
    for (const [date, amount] of deposits) {
      await tenant.pool.query(
        `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status)
         VALUES ($1, $2, 'Deposit', $3, 'income', 'cleared')`,
        [id, amount, date]
      );
    }
    return id;
  };
  /** 2,000.00 before E-3, then 1,000.00, 1,000.00 and 500.00: 2,500.00 more today than at E-3. */
  const steadyDeposits = (): Array<[string, string]> => [
    [day(6, 1), '2000.00'],
    [day(2, 5), '1000.00'],
    [day(1, 5), '1000.00'],
    [day(0, 1), '500.00'],
  ];
  const detail = async (uuid: string) =>
    (await request(app).get(`/api/goals/${uuid}`).expect(200)).body.goal as {
      progress_history: Array<{ total_progress: string }>;
      projection: Record<string, unknown>;
    };

  const projection = async (uuid: string) =>
    (await request(app).get(`/api/goals/${uuid}`).expect(200)).body.goal.projection as {
      currentProgress: number;
      remainingAmount: number;
      pastPerformanceMonths: number | null;
      pastPerformanceDate: string | null;
    };
  /** The months to go at the rate `change` over the time from `from` to today. */
  const monthsToGo = (remaining: number, change: number, from: string) => Math.ceil(remaining / (change / (daysBetween(from, today) / 30.4375)));

  beforeAll(async () => {
    tenant = await createTestTenant('Goal growth rate');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/goals', createGoalRoutes());
    today = (await tenant.pool.query<{ today: string }>('SELECT app_today()::text AS today')).rows[0].today;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('measures growth per month of the time its latest four points span', async () => {
    // Points E-3, E-2, E-1 and today: 2,000.00, 3,000.00, 4,000.00, 4,500.00. 2,500.00 over
    // the months from E-3 to today; 5,500.00 to go. A deposit dated after today counts at
    // no point.
    const uuid = await createGoal('Steady saver', day(5, 2), [
      [day(6, 1), '2000.00'],
      [day(2, 5), '1000.00'],
      [day(1, 5), '1000.00'],
      [day(0, 1), '500.00'],
      [addDays(today, 3), '9000.00'],
    ]);
    const p = await projection(uuid);
    expect(p.currentProgress).toBe(4500);
    expect(p.remainingAmount).toBe(5500);
    const months = monthsToGo(5500, 2500, monthEnd(3));
    expect(p.pastPerformanceMonths).toBe(months);
    expect(p.pastPerformanceDate).toBe(addMonths(today, months));
  });

  it('counts from the goal\'s first month end, not the balances before it began', async () => {
    // Begun on the 10th of M-2: its points are E-2, E-1 and today (6,000.00, 6,600.00,
    // 6,900.00). The 5,000.00 in M-3, before it began, isn't growth.
    const uuid = await createGoal('Late starter', day(2, 10), [
      [day(6, 1), '1000.00'],
      [day(3, 5), '5000.00'],
      [day(1, 5), '600.00'],
      [day(0, 1), '300.00'],
    ]);
    const p = await projection(uuid);
    expect(p.remainingAmount).toBe(3100);
    expect(p.pastPerformanceMonths).toBe(monthsToGo(3100, 900, monthEnd(2)));
  });

  it('makes no projection with fewer than three points, or no growth', async () => {
    const deposits: Array<[string, string]> = [[day(4, 1), '1000.00'], [day(2, 1), '1000.00'], [day(0, 1), '1000.00']];
    // Begun today: one point. Begun last month: E-1 and today.
    for (const begun of [null, day(1, 2)]) {
      const p = await projection(await createGoal(`New saver ${begun ?? 'today'}`, begun, deposits));
      expect(p.remainingAmount).toBe(7000);
      expect(p.pastPerformanceMonths).toBeNull();
      expect(p.pastPerformanceDate).toBeNull();
    }
    // Four points, all 3,000.00.
    const flat = await projection(await createGoal('Flat saver', day(6, 1), [[day(5, 1), '3000.00']]));
    expect(flat.pastPerformanceMonths).toBeNull();
  });

  // Links and hiding have days, so the history before a link is made doesn't count
  // the account. The growth is measured on the accounts the goal counts now, at every point:
  // what they gained, not what linking, unlinking, hiding or showing one added or took away.
  it("doesn't count linking an account that already holds money as growth", async () => {
    // Begun on the 2nd of M-5; linked today to an account that has held 6,000.00 for a
    // year. The history is 0.00 up to today and 6,000.00 today, but nothing grew.
    const goal = await bareGoal('Linked late', day(5, 2));
    const account = await savings('Linked late savings', [[day(12, 1), '6000.00']]);
    await request(app).post(`/api/goals/${goal.uuid}/accounts`).send({ account_id: account }).expect(201);
    const shown = await detail(goal.uuid);
    expect(shown.progress_history.slice(-2).map((p) => p.total_progress)).toEqual(['0.00', '6000.00']);
    expect(shown.projection).toMatchObject({ currentProgress: 6000, pastPerformanceMonths: null, pastPerformanceDate: null });
    const listed = (await request(app).get('/api/goals').expect(200)).body.goals.find((g: { uuid: string }) => g.uuid === goal.uuid);
    expect(listed.projected_completion_date).toBeNull();
  });

  it("doesn't count unlinking, hiding or showing an account as a loss or growth", async () => {
    // Steady (linked since the goal began) has 2,500.00 more today than at E-3. Kept
    // (5,000.00) was unlinked on the 10th of M-2 and Shy (3,000.00) hidden then; Shown
    // (1,000.00), hidden since it was opened, is shown today.
    const goal = await bareGoal('Reshuffled', day(5, 2));
    const steady = await savings('Reshuffled steady', steadyDeposits());
    const kept = await savings('Reshuffled kept', [[day(6, 1), '5000.00']]);
    const shy = await savings('Reshuffled shy', [[day(6, 1), '3000.00']]);
    const shownToday = await savings('Reshuffled shown', [[day(6, 1), '1000.00']], true);
    for (const account of [steady, kept, shy, shownToday]) {
      await tenant.pool.query('INSERT INTO budget_item_accounts (budget_item_id, account_id, valid_from) VALUES ($1, $2, $3)', [goal.id, account, day(5, 2)]);
    }
    await tenant.pool.query('UPDATE budget_item_accounts SET valid_to = $3 WHERE budget_item_id = $1 AND account_id = $2', [goal.id, kept, day(2, 10)]);
    await tenant.pool.query('UPDATE accounts SET hide_account = true WHERE id = $1', [shy]);
    await tenant.pool.query('UPDATE account_hidden_ranges SET hidden_from = $2 WHERE account_id = $1', [shy, day(2, 10)]);
    await tenant.pool.query('UPDATE accounts SET hide_account = false WHERE id = $1', [shownToday]);

    // The history follows each change from its day: E-3 counts Steady, Kept and Shy; E-2
    // and E-1 Steady alone; today Steady and Shown.
    const shown = await detail(goal.uuid);
    expect(shown.progress_history.slice(-4).map((p) => p.total_progress)).toEqual(['10000.00', '3000.00', '4000.00', '5500.00']);
    // The growth is Steady's and Shown's, 3,000.00 at E-3 and 5,500.00 today: 2,500.00.
    const months = monthsToGo(4500, 2500, monthEnd(3));
    expect(shown.projection).toMatchObject({ currentProgress: 5500, remainingAmount: 4500, pastPerformanceMonths: months });
  });

  it('counts the deposits into an account linked today as growth', async () => {
    const goal = await bareGoal('Linked today', day(5, 2));
    const account = await savings('Linked today savings', steadyDeposits());
    await request(app).post(`/api/goals/${goal.uuid}/accounts`).send({ account_id: account }).expect(201);
    const p = await projection(goal.uuid);
    expect(p.currentProgress).toBe(4500);
    expect(p.pastPerformanceMonths).toBe(monthsToGo(5500, 2500, monthEnd(3)));
  });
});
