import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { withTenant } from '../../db/withTenant.js';
import { GoalService } from '../../services/GoalService.js';
import { createSettingsRoutes } from '../settings.js';
import type { TenantRequest } from '../../middleware/tenant.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A ledger time-zone change that moves today back, and a goal's history.
 *
 * A goal's point for today reads the links open now and the accounts' hide_account flags; a
 * past day's reads the links' and hidden ranges' days, which are the ledger's today when each
 * was written. Under a zone whose today is K, a link removed today ends on K, one made today
 * starts on K and an account hidden today is hidden from K. A move to a zone whose today is N,
 * before K, left those days after N: N's point, today's figure while N was today, read them once
 * N had passed, and counted the removed link and the hidden account and not the new link. The
 * zone change now clamps the ledger's ranges to the new today, in its transaction.
 *
 * Kiritimati (UTC+14) and Pago Pago (UTC-11) are 25 hours apart, so today in Pago Pago is always
 * a day or two before today in Kiritimati. "N has passed" is a move back to Kiritimati.
 */
describe('A time-zone change that moves today back keeps the goal history', () => {
  const AHEAD = 'Pacific/Kiritimati';
  const BEHIND = 'Pacific/Pago_Pago';
  let app: Express;
  let tenant: TestTenant;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const today = async () => (await one<{ d: string }>('SELECT app_today()::text AS d')).d;
  const setZone = async (zone: string) =>
    request(app).post('/api/settings/general').send({ settings: { application_timezone: zone } }).expect(200);
  const goals = new GoalService();
  const pointsAt = (goalId: number, days: string[]) =>
    withTenant(tenant.tenantId, () => goals.progressAt(goalId, days)).then((points) => new Map(points.map((p) => [p.snapshot_date, p.total_progress])));

  beforeAll(async () => {
    tenant = await createTestTenant('Time zone change and goal ranges');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use((req, _res, next) => {
      (req as TenantRequest).tenant = { id: tenant.tenantId, isAdmin: true };
      next();
    });
    app.use('/api/settings', createSettingsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it("clamps the links and hidden ranges to the new today: a day's point is the same today and once it has passed", async () => {
    await setZone(AHEAD);
    const k = await today();
    const n = (await one<{ d: string }>(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [BEHIND])).d;
    const yesterday = (await one<{ d: string }>(`SELECT ($1::date - 1)::text AS d`, [n])).d;
    const weekAgo = (await one<{ d: string }>(`SELECT ($1::date - 7)::text AS d`, [n])).d;
    expect(n < k).toBe(true);

    const goal = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount) VALUES ('House', 'Savings', 'Goal', 'Goal', 10000) RETURNING id, uuid`
    );
    const account = async (name: string, balance: number) => {
      const row = await one<{ id: number; uuid: string }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'savings', 'cash', 'Asset') RETURNING id, uuid`, [name]
      );
      await one(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, $2, '2020-01-01', 'income', 'Opening') RETURNING id`,
        [row.id, balance]
      );
      return row;
    };
    const removed = await account('Removed today', 100);
    const added = await account('Linked today', 200);
    const hidden = await account('Hidden today', 400);
    const ahead = await account('Linked and removed further ahead', 800);
    // The envelope, with a row and its 1600.00 in each period from last week's month to K's.
    const envelope = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ('Deposit fund', 'Expense', true, 'Envelope') RETURNING id, uuid`
    );
    const periods = await tenant.pool.query<{ id: number }>(
      `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
       SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), extract(month FROM d)::int, extract(year FROM d)::int,
              d, (d + interval '1 month - 1 day')::date
         FROM generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month') AS g(d)
       RETURNING id`,
      [weekAgo, k]
    );
    for (const [i, period] of periods.rows.entries()) {
      const row = await one<{ id: number }>('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [period.id, envelope.id]);
      if (i === 0) {
        await one(
          `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount) VALUES ($1, $2, 'add', 'budget_update', 1600) RETURNING id`,
          [row.id, envelope.id]
        );
      }
    }

    // Linked since 2020; today (K) one account and the envelope are unlinked, one account is
    // linked and one hidden, as the goal page and the account form do it.
    for (const id of [removed.id, hidden.id]) {
      await one(`INSERT INTO budget_item_accounts (budget_item_id, account_id, valid_from) VALUES ($1, $2, '2020-01-01') RETURNING id`, [goal.id, id]);
    }
    await one(`INSERT INTO goal_budget_items (goal_id, budget_item_id, valid_from) VALUES ($1, $2, '2020-01-01') RETURNING id`, [goal.id, envelope.id]);
    // A link and a hidden range whose days are both after K: written under a zone further ahead.
    await one(`INSERT INTO budget_item_accounts (budget_item_id, account_id, valid_from, valid_to) VALUES ($1, $2, $3, ($3::date + 1)) RETURNING id`, [goal.id, ahead.id, k]);
    await one(`INSERT INTO account_hidden_ranges (account_id, hidden_from, hidden_to) VALUES ($1, $2, ($2::date + 1)) RETURNING id`, [ahead.id, k]);
    await withTenant(tenant.tenantId, async () => {
      await goals.unlinkAccount(goal.uuid, removed.uuid);
      await goals.unlinkBudgetItem(goal.uuid, envelope.uuid);
      await goals.linkAccount(goal.uuid, added.id);
    });
    await one('UPDATE accounts SET hide_account = true WHERE id = $1 RETURNING id', [hidden.id]);
    const ranges = async () => ({
      accounts: (await tenant.pool.query(
        `SELECT account_id, valid_from::text, valid_to::text FROM budget_item_accounts WHERE budget_item_id = $1 ORDER BY account_id, valid_from`, [goal.id]
      )).rows,
      envelopes: (await tenant.pool.query(
        `SELECT budget_item_id, valid_from::text, valid_to::text FROM goal_budget_items WHERE goal_id = $1 ORDER BY budget_item_id, valid_from`, [goal.id]
      )).rows,
      hidden: (await tenant.pool.query(
        `SELECT account_id, hidden_from::text, hidden_to::text FROM account_hidden_ranges ORDER BY account_id, hidden_from`
      )).rows,
    });
    expect(await ranges()).toEqual({
      accounts: [
        { account_id: removed.id, valid_from: '2020-01-01', valid_to: k },
        { account_id: added.id, valid_from: k, valid_to: null },
        { account_id: hidden.id, valid_from: '2020-01-01', valid_to: null },
        { account_id: ahead.id, valid_from: k, valid_to: expect.any(String) },
      ],
      envelopes: [{ budget_item_id: envelope.id, valid_from: '2020-01-01', valid_to: k }],
      hidden: [
        { account_id: hidden.id, hidden_from: k, hidden_to: null },
        { account_id: ahead.id, hidden_from: k, hidden_to: expect.any(String) },
      ],
    });
    const before = await pointsAt(goal.id, [weekAgo, yesterday]);

    // The zone moves today back to N.
    await setZone(BEHIND);
    expect(await today()).toBe(n);
    // What the change rewrote: every day after N is N, and a range left with no day is gone.
    expect(await ranges()).toEqual({
      accounts: [
        { account_id: removed.id, valid_from: '2020-01-01', valid_to: n },
        { account_id: added.id, valid_from: n, valid_to: null },
        { account_id: hidden.id, valid_from: '2020-01-01', valid_to: null },
      ],
      envelopes: [{ budget_item_id: envelope.id, valid_from: '2020-01-01', valid_to: n }],
      hidden: [{ account_id: hidden.id, hidden_from: n, hidden_to: null }],
    });
    // A past day's point is as it was: the removed account, the hidden one and the envelope.
    expect(await pointsAt(goal.id, [weekAgo, yesterday])).toEqual(before);
    expect(before.get(yesterday)).toBe('2100.00');
    // N's point today: the account linked today, the others removed or hidden.
    const onN = (await pointsAt(goal.id, [n])).get(n);
    expect(onN).toBe('200.00');

    // Once N has passed, its point is the same. Before, it was 2100.00: N read the ranges'
    // days K, so the removed account, the hidden one and the envelope counted, the new one not.
    await setZone(AHEAD);
    expect(await today()).toBe(k);
    expect((await pointsAt(goal.id, [n])).get(n)).toBe(onN);
    expect(await pointsAt(goal.id, [weekAgo, yesterday])).toEqual(before);
  }, 60_000);

  // A link made and an account hidden under the old zone, still being saved when the zone
  // changes: the change waits for them (it locks the goals and the accounts they lock first),
  // then clamps the days they wrote. Without the wait it read neither row, and both kept K.
  it('waits for a link and a hide being saved under the old zone, and clamps them too', async () => {
    await setZone(AHEAD);
    const k = await today();
    const n = (await one<{ d: string }>(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [BEHIND])).d;
    const goal = await one<{ id: number }>(
      `INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount) VALUES ('Car', 'Savings', 'Goal', 'Goal', 5000) RETURNING id`
    );
    const account = await one<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Car fund', 'savings', 'cash', 'Asset') RETURNING id`
    );
    const blockedBy = async (pid: number) =>
      (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.length > 0;
    const writer = await tenant.pool.connect();
    try {
      // As GoalService links an account (its goal's row first) and the account form hides one.
      await writer.query('BEGIN');
      await writer.query('SELECT id FROM budget_items WHERE id = $1 FOR NO KEY UPDATE', [goal.id]);
      await writer.query('INSERT INTO budget_item_accounts (budget_item_id, account_id) VALUES ($1, $2)', [goal.id, account.id]);
      await writer.query('UPDATE accounts SET hide_account = true WHERE id = $1', [account.id]);
      const pid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const changing = setZone(BEHIND).then((r) => r);
      const deadline = Date.now() + 10_000;
      while (!(await blockedBy(pid))) {
        if (Date.now() > deadline) throw new Error('the zone change did not wait for the writer');
        await new Promise((r) => setTimeout(r, 20));
      }
      await writer.query('COMMIT');
      await changing;
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    expect(await today()).toBe(n);
    expect(n < k).toBe(true);
    expect((await one<{ d: string }>('SELECT valid_from::text AS d FROM budget_item_accounts WHERE account_id = $1', [account.id])).d).toBe(n);
    expect((await one<{ d: string }>('SELECT hidden_from::text AS d FROM account_hidden_ranges WHERE account_id = $1', [account.id])).d).toBe(n);
  }, 60_000);
});
