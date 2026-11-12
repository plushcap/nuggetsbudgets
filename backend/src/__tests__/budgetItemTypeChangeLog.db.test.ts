import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createBudgetRoutes } from '../routes/budgets.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * A monthly item that becomes an envelope (BudgetItemTypeChange): the envelope's
 * balance is what the month had left, worked out in cents, and the log line says which item and
 * whether an event was booked, never the amounts (it logged `carried` and `adjustment`).
 * Every line the services log, at every level, is captured as JSON through the app's own
 * redaction. The item has money this month only: one with money in an earlier period keeps its
 * kind (budgetItemRolloverLock.db.test.ts), so no carry-over event is needed.
 */

const captured = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger.js')>();
  const { default: pino } = await import('pino');
  const capture = pino(
    { level: 'trace', redact: { paths: actual.REDACT_PATHS, censor: '[REDACTED]' } },
    { write: (line: string) => void captured.lines.push(line) }
  );
  return { ...actual, createLogger: (context: Record<string, unknown>) => capture.child(context) };
});

describe('A monthly budget item that becomes an envelope', () => {
  let app: Express;
  let tenant: TestTenant;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;

  beforeAll(async () => {
    tenant = await createTestTenant('Type change log');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budgets', createBudgetRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it("keeps this month's balance in cents and logs no amount", async () => {
    const account = await one<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`
    );
    const item = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ('Groceries', 'Expense', false, 'Monthly') RETURNING id, uuid`
    );
    // Last month: a row with nothing on it. This month: 50.10 budgeted and 20.05 spent (30.05 left).
    for (const [offset, budget, spent] of [[-1, null, null], [0, '50.10', '-20.05']] as const) {
      const period = await one<{ id: number; day: string }>(
        `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
         SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), extract(month FROM d)::int, extract(year FROM d)::int,
                d, (d + interval '1 month - 1 day')::date
           FROM (SELECT (date_trunc('month', app_today()) + make_interval(months => $1))::date AS d) m
         RETURNING id, to_char(start_date + 4, 'YYYY-MM-DD') AS day`,
        [offset]
      );
      const row = await one<{ id: number }>(
        'INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [period.id, item.id]
      );
      if (budget === null) continue;
      await one(
        `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
         VALUES ($1, $2, 'add', 'budget_update', $3) RETURNING id`,
        [row.id, item.id, budget]
      );
      await one(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, budget_period_id)
         VALUES ($1, $2, $3, 'expense', 'Shop', $4, $5) RETURNING id`,
        [account.id, spent, period.day, item.id, period.id]
      );
    }

    captured.lines.length = 0;
    const res = await request(app).put(`/api/budgets/items/${item.uuid}`).send({ type: 'Envelope', rollover: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // As an envelope its balance is this month's 30.05 too: no event is needed.
    const events = await tenant.pool.query<{ transaction_type: string; amount: string }>(
      `SELECT transaction_type, amount FROM budget_period_transactions WHERE budget_item_id = $1 AND source_system = 'type_change'`,
      [item.id]
    );
    expect(events.rows).toEqual([]);
    const current = await one<{ r: string }>(
      `SELECT calculate_remaining_for_period_item(bpi.id) AS r
         FROM budget_period_items bpi JOIN budget_period bp ON bp.id = bpi.budget_period_id
        WHERE bpi.budget_item_id = $1 AND app_today() BETWEEN bp.start_date AND bp.end_date`,
      [item.id]
    );
    expect(current.r).toBe('30.05');

    const line = captured.lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'Monthly budget item became an envelope');
    expect(line).toMatchObject({ budgetItemId: item.id, carriedOver: false });
    expect(line).not.toHaveProperty('carried');
    expect(line).not.toHaveProperty('adjustment');
    // No line of the change says the amounts.
    for (const amount of ['30.05', '50.10', '20.05']) {
      expect(captured.lines.filter((l) => new RegExp(`(^|[^0-9.])-?${amount.replace('.', '\\.')}($|[^0-9])`).test(l))).toEqual([]);
    }
  });
});
