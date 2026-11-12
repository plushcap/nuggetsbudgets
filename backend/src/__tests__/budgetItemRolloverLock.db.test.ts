import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { answerProblem, budgetItemUsageResponseSchema } from '@nuggets/shared';
import { createBudgetRoutes } from '../routes/budgets.js';
import { requestScope } from '../middleware/requestScope.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * Whether a budget item rolls over can't change, by design, once it has history: money
 * recorded in a period before the current one, a budget event or a transaction the figures
 * count. The budget functions read the flag live, so flipping it re-read every past period (a
 * monthly item's leftovers became an envelope's balance, an envelope's balance vanished). A
 * change is 409 ROLLOVER_LOCKED, saying why, and nothing is written; the usage answer says so
 * first, for the edit pages.
 *
 * Three periods: last month's, this month's (the current one) and next month's.
 */
describe('A rollover change once the item has history', () => {
  let tenant: TestTenant;
  let app: Express;
  let accountId: number;
  const periods = {} as Record<'last' | 'current' | 'next', { id: number; day: string }>;
  let seq = 0;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;

  /** An item with a row in each period; `money` puts a budget event or a transaction in the periods named. */
  async function item(kind: 'Monthly' | 'Envelope', money: Array<{ in: keyof typeof periods; event?: string; spent?: string; date?: string }> = []) {
    const created = await one<{ id: number; uuid: string; name: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', $2, $3) RETURNING id, uuid, name`,
      [`${kind} ${++seq}`, kind === 'Envelope', kind]
    );
    const rows = {} as Record<keyof typeof periods, number>;
    for (const key of ['last', 'current', 'next'] as const) {
      rows[key] = (await one<{ id: number }>(
        'INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id',
        [periods[key].id, created.id]
      )).id;
    }
    for (const m of money) {
      if (m.event !== undefined) {
        await tenant.pool.query(
          `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
           VALUES ($1, $2, 'add', 'budget_update', $3)`,
          [rows[m.in], created.id, m.event]
        );
      }
      if (m.spent !== undefined) {
        await tenant.pool.query(
          `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, budget_period_id)
           VALUES ($1, $2, $3, 'expense', 'Shop', $4, $5)`,
          [accountId, m.spent, m.date ?? periods[m.in].day, created.id, periods[m.in].id]
        );
      }
    }
    return created;
  }
  const usage = async (uuid: string) => {
    const body = (await request(app).get(`/api/budgets/items/${uuid}/usage`).expect(200)).body;
    expect(answerProblem(budgetItemUsageResponseSchema, body)).toBeNull();
    return body.history_before_current_period as boolean;
  };
  const change = (uuid: string, to: 'Monthly' | 'Envelope') =>
    request(app).put(`/api/budgets/items/${uuid}`).send({ type: to, rollover: to === 'Envelope' });
  const stored = (id: number) => one('SELECT rollover, type FROM budget_items WHERE id = $1', [id]);
  const typeChangeEvents = async (id: number) =>
    (await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM budget_period_transactions WHERE budget_item_id = $1 AND source_system = 'type_change'`, [id])).n;

  beforeAll(async () => {
    tenant = await createTestTenant('Rollover lock');
    app = express();
    app.use(express.json());
    app.use(requestScope);
    app.use(tenant.context());
    app.use('/api/budgets', createBudgetRoutes());
    for (const [key, offset] of [['last', -1], ['current', 0], ['next', 1]] as const) {
      periods[key] = await one<{ id: number; day: string }>(
        `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
         SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), extract(month FROM d)::int, extract(year FROM d)::int,
                d, (d + interval '1 month - 1 day')::date
           FROM (SELECT (date_trunc('month', app_today()) + make_interval(months => $1))::date AS d) m
         RETURNING id, to_char(start_date + 4, 'YYYY-MM-DD') AS day`,
        [offset]
      );
    }
    accountId = (await one<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`
    )).id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it("refuses a monthly item with last month's budget becoming an envelope: 409, saying why, nothing written", async () => {
    const m = await item('Monthly', [{ in: 'last', event: '100.00' }, { in: 'current', event: '50.00', spent: '-20.00' }]);
    expect(await usage(m.uuid)).toBe(true);
    const res = await change(m.uuid, 'Envelope');
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      code: 'ROLLOVER_LOCKED',
      error: `${m.name} has money recorded in an earlier period (a budget change or a transaction in a period before this one), so whether it rolls over can’t change: that would change what those periods show. Keep it as it is, or make a new budget item for the new way.`,
    });
    expect(await stored(m.id)).toEqual({ rollover: false, type: 'Monthly' });
    expect(await typeChangeEvents(m.id)).toBe(0);
  });

  it("refuses an empty envelope with last month's spending becoming monthly", async () => {
    // Budgeted 40 and spent 40 last month: it holds nothing, so only its history refuses it.
    const e = await item('Envelope', [{ in: 'last', event: '40.00', spent: '-40.00' }]);
    expect(await usage(e.uuid)).toBe(true);
    const res = await change(e.uuid, 'Monthly');
    expect([res.status, res.body.code]).toEqual([409, 'ROLLOVER_LOCKED']);
    expect(await stored(e.id)).toEqual({ rollover: true, type: 'Envelope' });
  });

  it('counts a transaction alone as history', async () => {
    const m = await item('Monthly', [{ in: 'last', spent: '-12.34' }]);
    expect(await usage(m.uuid)).toBe(true);
    expect((await change(m.uuid, 'Envelope')).status).toBe(409);
  });

  it('allows the change with money only in the current period or later, or a budget event of nothing earlier', async () => {
    const m = await item('Monthly', [{ in: 'last', event: '0.00' }, { in: 'current', event: '50.00', spent: '-20.00' }, { in: 'next', event: '75.00' }]);
    expect(await usage(m.uuid)).toBe(false);
    const res = await change(m.uuid, 'Envelope');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await stored(m.id)).toEqual({ rollover: true, type: 'Envelope' });
    // An envelope with nothing recorded turns monthly (one holding money is refused for that, as before).
    const empty = await item('Envelope');
    expect((await change(empty.uuid, 'Monthly')).status).toBe(200);
  });

  // Postgres reads these as booleans, and the type change saw a change only in
  // true or false, so each flipped the item past every check (the lock, the empty envelope, the
  // carry-over). They are refused before anything reads them now, as is null (NOT NULL: a 500).
  it.each([['true'], [1], ['t'], ['yes'], ['on'], ['false'], [0], ['f'], ['no'], ['off'], [null]])(
    'refuses rollover sent as %j with 400 VALIDATION_ERROR, on update and create, nothing written',
    async (value) => {
      const m = await item('Monthly', [{ in: 'last', event: '100.00' }]);
      const res = await request(app).put(`/api/budgets/items/${m.uuid}`).send({ rollover: value });
      expect([res.status, res.body.code, res.body.details?.[0]?.field]).toEqual([400, 'VALIDATION_ERROR', 'rollover']);
      expect(await stored(m.id)).toEqual({ rollover: false, type: 'Monthly' });
      const before = (await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM budget_items')).n;
      const created = await request(app).post('/api/budgets/items').send({ name: `Flag ${++seq}`, rollover: value });
      expect([created.status, created.body.code]).toEqual([400, 'VALIDATION_ERROR']);
      expect((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM budget_items')).n).toBe(before);
    },
  );

  it('refuses the other fields sent as the wrong type, or past their column, with 400 naming the field', async () => {
    const m = await item('Monthly');
    for (const [field, value] of [
      ['isbill', 'yes'], ['recurring_payment', 1], ['recurring_amount_varies', null], ['type', 7], ['color', '#12345678'],
      ['name', 'x'.repeat(101)], ['recurring_payment_frequency', 'monthly'], ['notes', { text: 'x' }], ['merchant_id', true],
    ] as const) {
      const res = await request(app).put(`/api/budgets/items/${m.uuid}`).send({ [field]: value });
      expect([res.status, res.body.code, res.body.details?.[0]?.field], `${field}: ${JSON.stringify(res.body)}`).toEqual([400, 'VALIDATION_ERROR', field]);
    }
  });

  // calculate_actual_for_period_item leaves out a transaction dated before the first
  // period starts, so its figures read 0.00; the lock counted it anyway.
  it("doesn't count a transaction dated before the first period, which the figures leave out", async () => {
    const before = (await one<{ d: string }>('SELECT (start_date - 3)::text AS d FROM budget_period WHERE id = $1', [periods.last.id])).d;
    const m = await item('Monthly', [{ in: 'last', spent: '-12.34', date: before }]);
    const f = await one('SELECT calculate_actual_for_period_item(bpi.id)::text AS actual FROM budget_period_items bpi WHERE bpi.budget_item_id = $1 AND bpi.budget_period_id = $2', [m.id, periods.last.id]);
    expect(f).toEqual({ actual: '0.00' });
    expect(await usage(m.uuid)).toBe(false);
    expect((await change(m.uuid, 'Envelope')).status).toBe(200);
  });

  it('leaves other edits of an item with history alone, the rollover sent unchanged included', async () => {
    const m = await item('Monthly', [{ in: 'last', event: '100.00' }]);
    const res = await request(app).put(`/api/budgets/items/${m.uuid}`).send({ description: 'Food', type: 'Monthly', rollover: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
