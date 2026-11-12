import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createBudgetRoutes } from '../budgets.js';
import { createBudgetItemHistoryRoutes } from '../budgetItemHistory.js';
import { createMerchantSpendingRoutes } from '../merchantSpending.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { answerProblem, budgetItemHistoryResponseSchema } from '@nuggets/shared';

/**
 * The detail pages' one-request summaries.
 *
 * GET /api/budget-items/:uuid/history answers, in one request, what the budget item page
 * asked GET /budgets/periods/:uuid/items for once per period: each figure is checked against
 * that route's answer for the same period item. GET /api/merchant-spending/:uuid answers the
 * merchant page's charts, checked against the same sums done by hand over the seeded rows.
 * Both are checked against another ledger's rows (requires Postgres).
 */
describe('Detail-page summaries', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let other: TestTenant;
  const stamp = Date.now();
  let itemUuid = '';
  let itemId = 0;
  let otherItemUuid = '';
  let merchantUuid = '';
  let otherMerchantUuid = '';
  let today = '';
  /** Periods by start_date, oldest first: k months from this month, -28..+1. */
  const periods: { id: number; uuid: string; start: string; end: string; k: number }[] = [];
  const MISSING_K = -5; // the item has no row in this period

  const one = async (p: Pool, text: string, values: unknown[] = []) => (await p.query(text, values)).rows[0];

  beforeAll(async () => {
    tenant = await createTestTenant('Detail-page summaries');
    other = await createTestTenant('Detail-page summaries, other ledger');
    pool = tenant.pool;

    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budgets', createBudgetRoutes());
    app.use('/api/budget-items', createBudgetItemHistoryRoutes());
    app.use('/api/merchant-spending', createMerchantSpendingRoutes());

    today = (await one(pool, 'SELECT app_today()::text AS d')).d;

    // Thirty monthly periods around today, created out of calendar order (ids don't
    // follow start_date), and the newest one in the future.
    const ks = Array.from({ length: 30 }, (_, i) => i - 28);
    const shuffled = [...ks].sort((a, b) => ((a * 7919) % 31) - ((b * 7919) % 31));
    for (const k of shuffled) {
      const row = await one(
        pool,
        `WITH s AS (SELECT (date_trunc('month', app_today()) + make_interval(months => $1))::date AS start)
         INSERT INTO budget_period (name, month, year, month_number, start_date, end_date, status)
         SELECT $2 || ' ' || $1, to_char(s.start, 'FMMonth'), extract(year FROM s.start)::int,
                extract(month FROM s.start)::int, s.start, (s.start + interval '1 month - 1 day')::date,
                CASE WHEN $1 = -3 THEN 'active' ELSE 'closed' END
           FROM s
         RETURNING id, uuid, start_date::text AS start, end_date::text AS "end"`,
        [k, `P ${stamp}`],
      );
      periods.push({ ...row, k });
    }
    periods.sort((a, b) => a.start.localeCompare(b.start));

    const account = await one(
      pool,
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id`,
      [`Checking ${stamp}`],
    );
    const item = await one(
      pool,
      `INSERT INTO budget_items (name, expense_type, type, rollover, status) VALUES ($1, 'Expense', 'Envelope', true, 'active') RETURNING id, uuid`,
      [`Envelope ${stamp}`],
    );
    itemUuid = item.uuid;
    itemId = item.id;
    const second = await one(
      pool,
      `INSERT INTO budget_items (name, expense_type, type, rollover, status) VALUES ($1, 'Expense', 'Monthly', false, 'active') RETURNING id, uuid`,
      [`Monthly ${stamp}`],
    );

    for (const [p, period] of periods.entries()) {
      for (const it of [item, second]) {
        if (it === item && period.k === MISSING_K) continue;
        const bpi = await one(
          pool,
          'INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id',
          [period.id, it.id],
        );
        const event = (txType: string, type: string, amount: number) =>
          pool.query(
            `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
             VALUES ($1, $2, $3, $4, $5)`,
            [bpi.id, it.id, txType, type, amount],
          );
        if (p === 0) await event('add', 'starting_balance', 80);
        await event('add', 'budget_update', 100 + p);
        if (p % 3 === 0) await event('remove', 'budget_update', 12.34);
        if (p % 4 === 0) await event('move_out', 'transfer', 5.5);
        await pool.query(
          `INSERT INTO transactions (account_id, budget_item_id, budget_period_id, amount, transaction_date, type, description)
           VALUES ($1, $2, $3, $4, $5::date + 3, 'expense', 'tx')`,
          [account.id, it.id, period.id, -(20 + p * 1.11), period.start],
        );
      }
    }

    // Merchant spending: inside and outside the 24 months, a refund, a split whose
    // children name the merchant too, two budget items and none.
    const merchant = await one(pool, 'INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid', [`Shop ${stamp}`]);
    merchantUuid = merchant.uuid;
    await pool.query(
      `INSERT INTO merchant_matching_rules (merchant_id, matching_text, method) VALUES ($1, $2, 'contains')`,
      [merchant.id, `shop-${stamp}`],
    );
    const tx = (amount: number, daysAgo: number, budgetItemId: number | null) =>
      pool.query(
        `INSERT INTO transactions (account_id, merchant_id, budget_item_id, amount, transaction_date, type, description)
         VALUES ($1, $2, $3, $4, app_today() - $5::int, $6, 'm')`,
        [account.id, merchant.id, budgetItemId, amount, daysAgo, amount < 0 ? 'expense' : 'income'],
      );
    await tx(-10.1, 1, item.id);
    await tx(-20.2, 40, item.id);
    await tx(5.05, 41, item.id); // a refund: drawn by its size, as the page did
    await tx(-30.3, 70, second.id);
    await tx(-7.77, 100, null);
    await tx(-99.99, 800, item.id); // more than 24 months ago
    await pool.query(
      `WITH parent AS (
         INSERT INTO transactions (account_id, merchant_id, amount, transaction_date, type, is_split_parent)
         VALUES ($1, $2, -90, app_today() - 10, 'expense', true) RETURNING id
       )
       INSERT INTO transactions (account_id, merchant_id, amount, transaction_date, type, parent_transaction_id, budget_item_id)
       SELECT $1, $2, v.amount, app_today() - 10, 'expense', parent.id, v.item
         FROM parent, (VALUES (-60::numeric, $3::int), (-30::numeric, $4::int)) AS v(amount, item)`,
      [account.id, merchant.id, item.id, second.id],
    );

    // Another ledger: a budget item and a merchant with rows of their own.
    const otherAccount = await one(
      other.pool,
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Other', 'checking', 'cash', 'Asset') RETURNING id`,
    );
    otherItemUuid = (await one(
      other.pool,
      `INSERT INTO budget_items (name, expense_type, type, rollover, status) VALUES ('Other envelope', 'Expense', 'Envelope', true, 'active') RETURNING uuid`,
    )).uuid;
    const otherMerchant = await one(other.pool, `INSERT INTO merchants (name) VALUES ('Other shop') RETURNING id, uuid`);
    otherMerchantUuid = otherMerchant.uuid;
    await other.pool.query(
      `INSERT INTO transactions (account_id, merchant_id, amount, transaction_date, type) VALUES ($1, $2, -500, app_today() - 2, 'expense')`,
      [otherAccount.id, otherMerchant.id],
    );
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup();
    await other.cleanup();
  });

  describe('GET /api/budget-items/:uuid/history', () => {
    it('answers the last 24 periods by start_date, oldest first, with the figures the per-period route answered', async () => {
      const res = await request(app).get(`/api/budget-items/${itemUuid}/history`);
      expect(res.status).toBe(200);
      // Exactly what the frontend's shared schema reads.
      expect(answerProblem(budgetItemHistoryResponseSchema, res.body)).toBeNull();
      expect(res.body.budget_item_uuid).toBe(itemUuid);

      const window = periods.slice(-24).filter((p) => p.k !== MISSING_K);
      expect(res.body.periods.map((p: { period_uuid: string }) => p.period_uuid)).toEqual(window.map((p) => p.uuid));
      expect(res.body.periods).toHaveLength(23);

      for (const [i, period] of window.entries()) {
        const old = await request(app).get(`/api/budgets/periods/${period.uuid}/items?budget_item_uuid=${itemUuid}`);
        expect(old.status).toBe(200);
        const row = old.body.data.find((r: { budget_item_uuid: string }) => r.budget_item_uuid === itemUuid);
        const got = res.body.periods[i];
        expect(got.start_date).toBe(period.start);
        expect(got.end_date).toBe(period.end);
        expect({ budget: got.budget, actual: got.actual, transfers: got.transfers, remaining: got.remaining }).toEqual({
          budget: row.calculated_budget,
          actual: row.calculated_actual,
          transfers: row.calculated_transfers,
          remaining: row.calculated_remaining,
        });
      }
      // The figures move from period to period (a rollover envelope's remaining accumulates).
      expect(new Set(res.body.periods.map((p: { remaining: string }) => p.remaining)).size).toBeGreaterThan(1);
    });

    it('answers the current period as the one holding the household\'s today', async () => {
      const res = await request(app).get(`/api/budget-items/${itemUuid}/history`);
      const current = periods.find((p) => p.start <= today && p.end >= today)!;
      expect(res.body.current.period_uuid).toBe(current.uuid);
      const old = await request(app).get(`/api/budgets/periods/${current.uuid}/items?budget_item_uuid=${itemUuid}`);
      expect(res.body.current.remaining).toBe(old.body.data[0].calculated_remaining);
      expect(res.body.current.budget).toBe(old.body.data[0].calculated_budget);
    });

    it('takes ?periods=N, bounded', async () => {
      const three = await request(app).get(`/api/budget-items/${itemUuid}/history?periods=3`);
      expect(three.body.periods.map((p: { period_uuid: string }) => p.period_uuid)).toEqual(periods.slice(-3).map((p) => p.uuid));
      const all = await request(app).get(`/api/budget-items/${itemUuid}/history?periods=100000`);
      expect(all.body.periods).toHaveLength(29); // every period, less the one without a row
      const junk = await request(app).get(`/api/budget-items/${itemUuid}/history?periods=-4`);
      expect(junk.body.periods).toHaveLength(23);
    });

    it('answers an item without a row in the current period with current: null', async () => {
      const lone = await one(
        pool,
        `INSERT INTO budget_items (name, expense_type, type, rollover, status) VALUES ($1, 'Expense', 'Envelope', true, 'active') RETURNING id, uuid`,
        [`Lone ${stamp}`],
      );
      await pool.query('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2)', [periods[0].id, lone.id]);
      const res = await request(app).get(`/api/budget-items/${lone.uuid}/history?periods=120`);
      expect(res.status).toBe(200);
      expect(answerProblem(budgetItemHistoryResponseSchema, res.body)).toBeNull();
      expect(res.body.current).toBeNull();
      expect(res.body.periods.map((p: { period_uuid: string }) => p.period_uuid)).toEqual([periods[0].uuid]);
    });

    it('without a period holding today, answers the earliest active one, as the Budget page picks', async () => {
      // The other ledger: Jan and Mar 2020 active, May 2020 closed; none holds today.
      const otherApp = express();
      otherApp.use(express.json());
      otherApp.use(other.context());
      otherApp.use('/api/budget-items', createBudgetItemHistoryRoutes());
      const lone = await one(other.pool, `SELECT id, uuid FROM budget_items WHERE uuid = $1`, [otherItemUuid]);
      const made: Record<string, string> = {};
      for (const [m, status] of [[5, 'closed'], [1, 'active'], [3, 'active']] as const) {
        const row = await one(
          other.pool,
          `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date, status)
           VALUES ($1, $1, 2020, $2, make_date(2020, $2, 1), (make_date(2020, $2, 1) + interval '1 month - 1 day')::date, $3)
           RETURNING id, uuid`,
          [`O ${m} ${stamp}`, m, status],
        );
        made[m] = row.uuid;
        await other.pool.query('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2)', [row.id, lone.id]);
      }
      const res = await request(otherApp).get(`/api/budget-items/${otherItemUuid}/history`);
      expect(res.status).toBe(200);
      expect(res.body.current.period_uuid).toBe(made[1]);
      expect(res.body.periods.map((p: { period_uuid: string }) => p.period_uuid)).toEqual([made[1], made[3], made[5]]);
    });

    it('answers 404 for another ledger\'s item and for none', async () => {
      expect((await request(app).get(`/api/budget-items/${otherItemUuid}/history`)).status).toBe(404);
      expect((await request(app).get('/api/budget-items/00000000-0000-7000-8000-000000000000/history')).status).toBe(404);
    });

    it('answers the item\'s figures only: another item\'s events do not move them', async () => {
      const before = (await request(app).get(`/api/budget-items/${itemUuid}/history`)).body;
      // An item with the same periods, given a large event in the newest period.
      const bpi = await one(
        pool,
        `SELECT bpi.id, bpi.budget_item_id FROM budget_period_items bpi
          WHERE bpi.budget_period_id = $1 AND bpi.budget_item_id <> $2 LIMIT 1`,
        [periods.at(-1)!.id, itemId],
      );
      await pool.query(
        `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
         VALUES ($1, $2, 'add', 'budget_update', 10000)`,
        [bpi.id, bpi.budget_item_id],
      );
      const after = (await request(app).get(`/api/budget-items/${itemUuid}/history`)).body;
      expect(after).toEqual(before);
    });
  });

  describe('GET /api/merchant-spending/:uuid', () => {
    it('answers monthly and per-budget-item totals over 24 months, without split children', async () => {
      const res = await request(app).get(`/api/merchant-spending/${merchantUuid}`);
      expect(res.status).toBe(200);
      expect(res.body.merchant_uuid).toBe(merchantUuid);

      // The same sums by hand: |amount| of rows without a parent, dated on or after `since`.
      const rows = (await pool.query(
        `SELECT t.transaction_date::text AS d, t.amount, bi.uuid AS item
           FROM transactions t JOIN merchants m ON m.id = t.merchant_id
           LEFT JOIN budget_items bi ON bi.id = t.budget_item_id
          WHERE m.uuid = $1 AND t.parent_transaction_id IS NULL`,
        [merchantUuid],
      )).rows as { d: string; amount: string; item: string | null }[];
      const since = res.body.since as string;
      expect(since).toBe((await one(pool, `SELECT (app_today() - interval '24 months')::date::text AS d`)).d);
      const inWindow = rows.filter((r) => r.d >= since);
      expect(inWindow).toHaveLength(6); // five rows and the split's parent; not the old one

      const cents = (v: string) => Math.round(Math.abs(Number(v)) * 100);
      const monthly = new Map<string, number>();
      const byItem = new Map<string | null, number>();
      for (const r of inWindow) {
        monthly.set(r.d.slice(0, 7), (monthly.get(r.d.slice(0, 7)) ?? 0) + cents(r.amount));
        byItem.set(r.item, (byItem.get(r.item) ?? 0) + cents(r.amount));
      }
      expect(res.body.monthly.map((m: { month: string; total: string }) => [m.month, cents(m.total)])).toEqual(
        [...monthly.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      );
      expect(res.body.by_budget_item.map((b: { budget_item_uuid: string | null; total: string }) => [b.budget_item_uuid, cents(b.total)])).toEqual(
        [...byItem.entries()].sort((a, b) => b[1] - a[1]),
      );
      // The split's parent has no budget item: it counts under none, once (90 + 7.77).
      expect(byItem.get(null)).toBe(9777);
      expect(res.body.transaction_count).toBe(9); // six, the old one, and the split's two children
      expect(res.body.rule_count).toBe(1);
    });

    it('answers 404 for another ledger\'s merchant and for none', async () => {
      expect((await request(app).get(`/api/merchant-spending/${otherMerchantUuid}`)).status).toBe(404);
      expect((await request(app).get('/api/merchant-spending/00000000-0000-7000-8000-000000000000')).status).toBe(404);
    });
  });
});
