import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';

/**
 * /api/goals through the real app under RLS: creating, listing,
 * updating and archiving a goal; linking accounts and envelopes, and the progress that
 * follows from them; the progress history.
 * Ledger B has its own goal, accounts and envelope, which A can neither see nor link.
 * Each test makes its own goal, accounts and envelopes (seedGoal), so any one passes alone
 * (`-t`, `.only`) or in another order.
 *
 * Elsewhere: goalProgressHistory.test.ts (the progress history over months),
 * goalGrowthRate.test.ts (the projection's growth rate) and
 * budgetAndGoalHistoryQueries.test.ts (the balance-history queries).
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

type Ref = { id: number; uuid: string };

describeDb('Goal routes', () => {
  let h: RouteHarness;
  let a: TestTenant;
  let b: TestTenant;
  let member: string;
  let accountB: number;
  let plainItemA: Ref;
  let envelopeB: Ref;
  let goalB: Ref;
  let seq = 0;
  /** A name no other test's row has: each test makes its own goals, accounts and envelopes. */
  const unique = (name: string) => `${name} ${++seq}`;

  const one = async <T>(t: TestTenant, text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows[0] as T;
  const account = async (t: TestTenant, name: string, balance: string, hidden = false) => {
    const { id } = await one<{ id: number }>(
      t,
      `INSERT INTO accounts (name, account_type, account_group, type, hide_account) VALUES ($1, 'savings', 'cash', 'Asset', $2) RETURNING id`,
      [name, hidden]
    );
    await t.pool.query(`INSERT INTO transactions (account_id, amount, transaction_date, type) VALUES ($1, $2, app_today() - 1, 'income')`, [id, balance]);
    return id;
  };
  const item = (t: TestTenant, name: string, rollover: boolean) =>
    one<Ref>(t, `INSERT INTO budget_items (name, expense_type, rollover) VALUES ($1, 'Savings', $2) RETURNING id, uuid`, [name, rollover]);

  /** A new envelope of ledger A with `amount` allocated to it this month, through the budget route. */
  const fundedEnvelope = async (amount: number) => {
    const envelope = await item(a, unique('House fund'), true);
    // This month's period: one per month, so made by the first test that needs it.
    const period = await one<{ id: number }>(
      a,
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       SELECT 'This month', to_char(d, 'FMMonth'), extract(year FROM d)::int, extract(month FROM d)::int,
              d::date, (d + interval '1 month - 1 day')::date
         FROM date_trunc('month', app_today()::timestamp) AS d
       ON CONFLICT (tenant_id, year, month_number) DO UPDATE SET name = budget_period.name
       RETURNING id`
    );
    const periodItem = await one<{ uuid: string }>(
      a,
      'INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING uuid',
      [period.id, envelope.id]
    );
    const allocated = await h.call(member, 'put', `/api/budgets/period-items/${periodItem.uuid}/budget`, { amount });
    expect(allocated.status, allocated.text).toBe(200);
    return envelope;
  };

  /**
   * A goal of ledger A (target 1,000.00 by 2027-06-30), with three accounts of its own:
   * savings (100.10 unless `savings` says otherwise), brokerage (200.20) and a hidden one
   * (5,000.00). `linked` links the accounts and an envelope holding 50.15, as the tests of
   * linking do: 300.30 from the accounts, 350.45 in all.
   */
  async function seedGoal(options: { linked?: boolean; savings?: string } = {}) {
    const created = await h.call(member, 'post', '/api/goals', { name: unique('Down payment'), target_amount: 1000, target_date: '2027-06-30' });
    expect(created.status, created.text).toBe(201);
    const goal = { uuid: created.body.goal.uuid as string, id: created.body.goal.id as number, name: created.body.goal.name as string };
    const accounts = {
      savings: await account(a, unique('Savings'), options.savings ?? '100.10'),
      brokerage: await account(a, unique('Brokerage'), '200.20'),
      hidden: await account(a, unique('Old savings'), '5000.00', true),
    };
    if (options.linked) {
      for (const id of Object.values(accounts)) {
        const res = await h.call(member, 'post', `/api/goals/${goal.uuid}/accounts`, { account_id: id });
        expect(res.status, res.text).toBe(201);
      }
      const envelope = await fundedEnvelope(50.15);
      const res = await h.call(member, 'post', `/api/goals/${goal.uuid}/budget-items`, { budget_item_id: envelope.id });
      expect(res.status, res.text).toBe(201);
    }
    return { goal, accounts };
  }

  beforeAll(async () => {
    h = await startRouteHarness('Goals');
    a = await createTestTenant('Goals A');
    b = await createTestTenant('Goals B');
    member = await h.signIn(a.userId, a.tenantId);

    accountB = await account(b, 'Their savings', '777.77');
    plainItemA = await item(a, 'Coffee', false);
    envelopeB = await item(b, 'Their fund', true);
    goalB = await one<Ref>(
      b,
      `INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount, goal_target_date)
       VALUES ('Their goal', 'Savings', 'Goal', 'Goal', 1000, '2027-01-01') RETURNING id, uuid`
    );
  }, 60_000);

  afterAll(async () => {
    const settled = await Promise.allSettled([h?.close(), a?.cleanup(), b?.cleanup()]);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, 60_000);

  it('creates a goal, refusing one without a positive target', async () => {
    const refused = await h.call(member, 'post', '/api/goals', { name: 'Nothing', target_amount: 0, target_date: '2027-06-30' });
    expect(refused.status).toBe(400);

    const res = await h.call(member, 'post', '/api/goals', {
      name: 'Down payment',
      target_amount: 1000,
      target_date: '2027-06-30',
      estimated_monthly_contribution: '50.25',
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body.goal).toMatchObject({
      name: 'Down payment',
      target_amount: '1000.00',
      target_date: '2027-06-30',
      estimated_monthly_contribution: '50.25',
      status: 'active',
    });
    const row = await one(a, 'SELECT expense_type, type FROM budget_items WHERE id = $1', [res.body.goal.id]);
    expect(row).toEqual({ expense_type: 'Savings', type: 'Goal' });
  });

  it("links only this ledger's accounts, and counts the visible ones' balances as progress", async () => {
    const { goal, accounts } = await seedGoal();
    for (const id of [accounts.savings, accounts.brokerage, accounts.hidden]) {
      const res = await h.call(member, 'post', `/api/goals/${goal.uuid}/accounts`, { account_id: id });
      expect(res.status, res.text).toBe(201);
    }
    // Linking twice is harmless.
    expect((await h.call(member, 'post', `/api/goals/${goal.uuid}/accounts`, { account_id: String(accounts.savings) })).status).toBe(201);

    // Another ledger's id answers as no row does.
    const foreign = await h.call(member, 'post', `/api/goals/${goal.uuid}/accounts`, { account_id: accountB });
    expect(foreign.status).toBe(400);
    expect(foreign.body).toMatchObject({ code: 'INVALID_REFERENCE', field: 'account_id' });
    const missing = await h.call(member, 'post', `/api/goals/${goal.uuid}/accounts`, {});
    expect(missing.status).toBe(400);
    const linked = await a.pool.query<{ account_id: number }>('SELECT account_id FROM budget_item_accounts WHERE budget_item_id = $1 ORDER BY account_id', [goal.id]);
    expect(linked.rows.map((r) => r.account_id)).toEqual([accounts.savings, accounts.brokerage, accounts.hidden].sort((x, y) => x - y));

    const detail = await h.call(member, 'get', `/api/goals/${goal.uuid}`);
    expect(detail.status, detail.text).toBe(200);
    // 100.10 + 200.20; the hidden account doesn't count.
    expect(detail.body.goal.total_from_accounts).toBe(300.3);
    expect(detail.body.goal.current_progress).toBe(300.3);
    expect(detail.body.goal.remaining_amount).toBe(699.7);
    expect(detail.body.goal.progress_percentage).toBeCloseTo(30.03, 10);
  });

  // The balance histories counted a hidden linked account, which the progress leaves out.
  it('leaves a hidden linked account out of the balance histories, as the progress does', async () => {
    const { goal, accounts } = await seedGoal({ linked: true });
    const total = await h.call(member, 'get', `/api/goals/${goal.uuid}/balance-history?period=day&limit=0`);
    expect(total.status, total.text).toBe(200);
    // Today: 100.10 + 200.20, not the hidden 5,000.00.
    expect(total.body.history.map((p: { balance: number }) => p.balance)).toEqual([300.3]);
    const byAccount = await h.call(member, 'get', `/api/goals/${goal.uuid}/account-balance-history?period=day&limit=0`);
    expect(byAccount.status, byAccount.text).toBe(200);
    expect(byAccount.body.accounts.map((x: { account_id: number }) => x.account_id).sort()).toEqual([accounts.savings, accounts.brokerage].sort());
    const detail = await h.call(member, 'get', `/api/goals/${goal.uuid}`);
    expect(detail.body.goal.total_from_accounts).toBe(300.3);
  });

  it('links only envelopes of this ledger', async () => {
    const { goal, accounts } = await seedGoal();
    for (const id of Object.values(accounts)) {
      expect((await h.call(member, 'post', `/api/goals/${goal.uuid}/accounts`, { account_id: id })).status).toBe(201);
    }
    const plain = await h.call(member, 'post', `/api/goals/${goal.uuid}/budget-items`, { budget_item_id: plainItemA.id });
    expect(plain.status).toBe(400);
    expect(plain.body.code).toBe('BUDGET_ITEM_NOT_ROLLOVER');
    const foreign = await h.call(member, 'post', `/api/goals/${goal.uuid}/budget-items`, { budget_item_id: envelopeB.id });
    expect(foreign.status).toBe(400);
    expect(foreign.body).toMatchObject({ code: 'INVALID_REFERENCE', field: 'budget_item_id' });
    // The envelope counts with what remains in it this period: an allocation of 50.15
    // through the budget route.
    const envelope = await fundedEnvelope(50.15);
    const ok = await h.call(member, 'post', `/api/goals/${goal.uuid}/budget-items`, { budget_item_id: envelope.id });
    expect(ok.status, ok.text).toBe(201);
    const linked = await a.pool.query<{ budget_item_id: number }>('SELECT budget_item_id FROM goal_budget_items WHERE goal_id = $1', [goal.id]);
    expect(linked.rows.map((r) => r.budget_item_id)).toEqual([envelope.id]);

    const detail = await h.call(member, 'get', `/api/goals/${goal.uuid}`);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.goal).toMatchObject({
      total_from_accounts: 300.3,
      total_from_budget_items: 50.15,
      current_progress: 350.45,
      remaining_amount: 649.55,
    });
  });

  it('lists active goals with their progress, and only this ledger\'s', async () => {
    const { goal } = await seedGoal({ linked: true });
    const res = await h.call(member, 'get', '/api/goals');
    expect(res.status, res.text).toBe(200);
    const goals = res.body.goals as Array<{ uuid: string; current_progress: number; account_count: string; budget_item_count: string }>;
    // Every goal of this ledger that isn't archived (other tests' too), and none of B's.
    const active = await a.pool.query<{ uuid: string }>(`SELECT uuid FROM budget_items WHERE type = 'Goal' AND status <> 'archived'`);
    expect(goals.map((g) => g.uuid).sort()).toEqual(active.rows.map((r) => r.uuid).sort());
    expect(goals.map((g) => g.uuid)).not.toContain(goalB.uuid);
    expect(goals.find((g) => g.uuid === goal.uuid)).toMatchObject({ current_progress: 350.45, account_count: '3', budget_item_count: '1' });
  });

  it('answers the progress history computed from the balances, today\'s as the current progress', async () => {
    // The whole history (month ends, ranges, the projection) is goalProgressHistory.test.ts's.
    const { goal } = await seedGoal({ linked: true });
    const { today } = await one<{ today: string }>(a, 'SELECT app_today()::text AS today');
    expect((await h.call(member, 'get', `/api/goals/${goal.uuid}/progress-history?end_date=31/10/2026`)).status).toBe(400);

    const history = await h.call(member, 'get', `/api/goals/${goal.uuid}/progress-history?start_date=${today}`);
    expect(history.status, history.text).toBe(200);
    expect(history.body.history).toEqual([
      { snapshot_date: today, total_from_accounts: '300.30', total_from_budget_items: '50.15', total_progress: '350.45' },
    ]);
  });

  it('unlinks an account', async () => {
    const { goal, accounts } = await seedGoal({ linked: true, savings: '109.80' });
    // The account is named by its uuid in the path.
    const brokerage = await one<{ uuid: string }>(a, 'SELECT uuid FROM accounts WHERE id = $1', [accounts.brokerage]);
    const res = await h.call(member, 'delete', `/api/goals/${goal.uuid}/accounts/${brokerage.uuid}`);
    expect(res.status).toBe(200);
    const detail = await h.call(member, 'get', `/api/goals/${goal.uuid}`);
    expect(detail.body.goal.total_from_accounts).toBe(109.8);

    // What's left is exact too: progress 109.80 + 50.15, and 160.25 minus that is
    // 0.30000000000001137 in floats.
    expect((await h.call(member, 'put', `/api/goals/${goal.uuid}`, { target_amount: '160.25' })).status).toBe(200);
    const nearly = await h.call(member, 'get', `/api/goals/${goal.uuid}`);
    expect(nearly.body.goal.remaining_amount).toBe(0.3);
    expect(nearly.body.goal.projection.remainingAmount).toBe(0.3);
    const listed = await h.call(member, 'get', '/api/goals');
    expect(listed.body.goals.find((g: { uuid: string }) => g.uuid === goal.uuid)?.remaining_amount).toBe(0.3);
  });

  it("can't read, change, link to or archive another ledger's goal", async () => {
    const mine = await account(a, unique('Savings'), '1.00');
    expect((await h.call(member, 'get', `/api/goals/${goalB.uuid}`)).status).toBe(404);
    expect((await h.call(member, 'put', `/api/goals/${goalB.uuid}`, { name: 'Mine now' })).status).toBe(404);
    expect((await h.call(member, 'post', `/api/goals/${goalB.uuid}/accounts`, { account_id: mine })).status).toBe(404);
    expect((await h.call(member, 'get', `/api/goals/${goalB.uuid}/progress-history`)).status).toBe(404);
    expect((await h.call(member, 'delete', `/api/goals/${goalB.uuid}`)).status).toBe(404);
    const theirs = await one(b, 'SELECT name, status FROM budget_items WHERE id = $1', [goalB.id]);
    expect(theirs).toEqual({ name: 'Their goal', status: 'active' });
    expect((await b.pool.query('SELECT 1 FROM budget_item_accounts WHERE budget_item_id = $1', [goalB.id])).rowCount).toBe(0);
  });

  it('updates only the fields sent, then archives the goal out of the list', async () => {
    const { goal } = await seedGoal();
    const updated = await h.call(member, 'put', `/api/goals/${goal.uuid}`, { target_amount: 1500 });
    expect(updated.status, updated.text).toBe(200);
    expect(updated.body.goal).toMatchObject({ name: goal.name, target_amount: '1500.00', target_date: '2027-06-30' });

    const archived = await h.call(member, 'delete', `/api/goals/${goal.uuid}`);
    expect(archived.status).toBe(200);
    expect(archived.body.goal.status).toBe('archived');
    // Kept, not deleted, and gone from the list.
    expect((await a.pool.query('SELECT 1 FROM budget_items WHERE id = $1', [goal.id])).rowCount).toBe(1);
    const list = await h.call(member, 'get', '/api/goals');
    expect(list.status).toBe(200);
    expect(list.body.goals.map((g: { uuid: string }) => g.uuid)).not.toContain(goal.uuid);
  });
});
