import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { createBudgetRoutes } from '../budgets.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A merge whose merged item S has rows only in a period after the target T's current one.
 * The merge keeps T's balance this month at what it had plus what S had
 * left this month (mergeShortfallCents). S's "this month" was its own current row, which, with
 * no row in a period that has started, is its latest: a future one. So S's 30.00 there was
 * booked into T this month as well as moved with S's row into next month: T showed 80.00 now
 * and 110.00 next month, where it should show 50.00 and 80.00.
 *
 * The API gives every active item a row in every period (a new item, a new period, a restore),
 * so these rows are written here in SQL: data from before restores filled the periods an item
 * missed while archived can have them.
 */
describe('A budget item merge whose merged item has a row only in a future period', () => {
  let app: Express;
  let tenant: TestTenant;
  const periods: Record<number, { id: number }> = {};
  let seq = 0;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const left = async (itemId: number, offset: number) =>
    (await one<{ r: string }>(
      `SELECT calculate_remaining_for_period_item(id) AS r FROM budget_period_items WHERE budget_item_id = $1 AND budget_period_id = $2`,
      [itemId, periods[offset]!.id]
    )).r;

  beforeAll(async () => {
    tenant = await createTestTenant('Merge future row');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budgets', createBudgetRoutes());
    for (const offset of [0, 1]) {
      periods[offset] = await one(
        `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
         SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), extract(month FROM d)::int, extract(year FROM d)::int,
                d, (d + interval '1 month - 1 day')::date
           FROM (SELECT (date_trunc('month', app_today()) + make_interval(months => $1))::date AS d) m
         RETURNING id`,
        [offset]
      );
    }
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  /** An item with a row in each of `budgets`' periods (by offset), and that budget in it. */
  async function item(kind: 'envelope' | 'monthly', budgets: Record<number, number>) {
    const created = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', $2, $3) RETURNING id, uuid`,
      [`${kind} ${++seq}`, kind === 'envelope', kind === 'envelope' ? 'Envelope' : 'Monthly']
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

  // A monthly item: an envelope holding money isn't merged (it is emptied first), and an empty
  // one adds nothing either way.
  it("a monthly item's 30.00 next month counts in the target from next month only", async () => {
    const t = await item('envelope', { 0: 50, 1: 0 });
    const s = await item('monthly', { 1: 30 });
    const res = await merge(s, t);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await left(t.id, 0)).toBe('50.00');
    expect(await left(t.id, 1)).toBe('80.00');
  });

  // The same item with a row this month too, as the API makes it: what it has left this month
  // is kept, as before.
  it('keeps what a merged item with a row this month has left this month', async () => {
    const t = await item('envelope', { 0: 50, 1: 0 });
    const s = await item('monthly', { 0: 20, 1: 30 });
    const res = await merge(s, t);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await left(t.id, 0)).toBe('70.00');
    expect(await left(t.id, 1)).toBe('100.00');
  });
});
