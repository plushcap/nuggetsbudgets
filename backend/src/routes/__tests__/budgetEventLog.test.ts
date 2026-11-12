import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createBudgetRoutes } from '../budgets.js';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import { createTransactionsRoutes } from '../transactions.js';
import { createTransferRoutes } from '../transfer.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { getDirname } from '../../utils/esm-compat.js';
import { answerProblem, budgetItemActivityResponseSchema, budgetItemAssignedTransactionsResponseSchema, budgetItemTransferResponseSchema, budgetPeriodTransferResponseSchema } from '@nuggets/shared';

/**
 * The event-sourced budget engine through its routes, on the real database:
 * budgeted, actual and remaining come from budget_period_transactions
 * and the transactions, by the calculate_*_for_period_item functions. Each test
 * makes its own items in its own year, so they don't see each other's periods.
 */
describe('The budget event log', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let account: { id: number; uuid: string };
  // Requests take years up to 2999 (CALENDAR_DAY_YEARS): far enough ahead that no period here is current.
  let nextYear = 2100 + Math.floor(Math.random() * 800);
  const stamp = Date.now();

  type Period = { id: number; uuid: string };
  type Item = { id: number; uuid: string; name: string };

  const one = async <T>(text: string, params: unknown[]): Promise<T> => (await pool.query(text, params)).rows[0] as T;

  /** A month's period, through the route that makes one; a year no other test uses unless given. */
  const createPeriod = async (month: number, year = nextYear++): Promise<Period & { year: number }> => {
    const res = await request(app).post('/api/budgets/periods').send({ year, month }).expect(201);
    return { id: res.body.id, uuid: res.body.uuid, year };
  };

  const createItem = async (name: string, fields: Record<string, unknown> = {}): Promise<Item> => {
    const res = await request(app).post('/api/budgets/items')
      .send({ name: `${name} ${stamp}-${Math.random()}`, expense_type: 'Expense', type: 'Monthly', ...fields })
      .expect(201);
    return { id: res.body.id, uuid: res.body.uuid, name: res.body.name };
  };

  const periodItem = (item: Item, period: Period) => one<{ id: number; uuid: string }>(
    'SELECT id, uuid FROM budget_period_items WHERE budget_item_id = $1 AND budget_period_id = $2', [item.id, period.id],
  );

  /** budgeted, actual and remaining of an item in a period, as NUMERIC strings. */
  const figures = async (item: Item, period: Period) => one<{ budget: string; actual: string; remaining: string }>(
    `SELECT calculate_budget_for_period_item(id) AS budget, calculate_actual_for_period_item(id) AS actual,
            calculate_remaining_for_period_item(id) AS remaining
       FROM budget_period_items WHERE budget_item_id = $1 AND budget_period_id = $2`,
    [item.id, period.id],
  );
  const remaining = async (item: Item, period: Period) => (await figures(item, period)).remaining;

  const setBudget = async (item: Item, period: Period, amount: number) =>
    (await request(app).put(`/api/budgets/period-items/${(await periodItem(item, period)).uuid}/budget`).send({ amount }).expect(200)).body;

  /** A transaction of the item in the period, dated on the period's first day. */
  const spend = async (item: Item | null, period: Period, amount: number, type = 'expense') => one<{ id: number; uuid: string }>(
    `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, budget_period_id)
     SELECT $1, $2, bp.start_date, $3, 'Fixture', $4, bp.id FROM budget_period bp WHERE bp.id = $5
     RETURNING id, uuid`,
    [account.id, amount, type, item?.id ?? null, period.id],
  );

  beforeAll(async () => {
    tenant = await createTestTenant('Budget event log');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budgets', createBudgetRoutes());
    app.use('/api/budget-periods', createBudgetPeriodRoutes());
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/transfer', createTransferRoutes());
    account = await one(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id, uuid`,
      [`Budget log checking ${stamp}`],
    );
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('creates a period with a row for each item and its default budget as an event', async () => {
    const groceries = await createItem('Groceries', { default_budget_amount: 400 });
    const period = await createPeriod(1);
    const events = await pool.query(
      `SELECT bpt.type, bpt.transaction_type, bpt.amount FROM budget_period_transactions bpt
        WHERE bpt.budget_period_item_id = $1`,
      [(await periodItem(groceries, period)).id],
    );
    expect(events.rows).toEqual([{ type: 'budget_update', transaction_type: 'add', amount: '400.00' }]);
    expect(await figures(groceries, period)).toEqual({ budget: '400.00', actual: '0.00', remaining: '400.00' });
  });

  it('sets a budget as one event of the difference, with the uuid it answers', async () => {
    const groceries = await createItem('Groceries', { default_budget_amount: 100 });
    const period = await createPeriod(1);
    const raised = await setBudget(groceries, period, 150);
    const lowered = await setBudget(groceries, period, 120.5);
    const event = (uuid: string) => one('SELECT transaction_type, amount, previous_amount FROM budget_period_transactions WHERE uuid = $1', [uuid]);
    expect(await event(raised.eventUuid)).toEqual({ transaction_type: 'add', amount: '50.00', previous_amount: '100.00' });
    expect(await event(lowered.eventUuid)).toEqual({ transaction_type: 'remove', amount: '29.50', previous_amount: '150.00' });
    expect((await figures(groceries, period)).budget).toBe('120.50');

    await request(app).put(`/api/budgets/period-items/${(await periodItem(groceries, period)).uuid}/budget`).send({ amount: 1.005 }).expect(400);
    expect((await figures(groceries, period)).budget).toBe('120.50');
  });

  it("sums actuals as signed: spending, a refund, and a split's splits but not the split itself", async () => {
    const groceries = await createItem('Groceries', { default_budget_amount: 200 });
    const household = await createItem('Household');
    const period = await createPeriod(1);
    await spend(groceries, period, -40);
    await spend(groceries, period, 10, 'income');
    const bulkBuy = await spend(groceries, period, -100);
    const periodRow = await one<{ uuid: string }>('SELECT uuid FROM budget_period WHERE id = $1', [period.id]);
    await request(app).post(`/api/transactions/${bulkBuy.uuid}/split`).send({
      splits: [
        { amount: -60, budget_item_uuid: groceries.uuid, budget_period_uuid: periodRow.uuid },
        { amount: -40, budget_item_uuid: household.uuid, budget_period_uuid: periodRow.uuid },
      ],
    }).expect(200);

    expect(await figures(groceries, period)).toEqual({ budget: '200.00', actual: '-90.00', remaining: '110.00' });
    expect(await figures(household, period)).toEqual({ budget: '0.00', actual: '-40.00', remaining: '-40.00' });

    // The period item's transactions and budget events, exactly as the shared schemas read them.
    const row = await periodItem(groceries, period);
    const listed = (await request(app).get(`/api/budget-periods/items/${row.uuid}/transactions`).expect(200)).body;
    expect(listed.length).toBeGreaterThan(0);
    expect(answerProblem(budgetItemAssignedTransactionsResponseSchema, listed)).toBeNull();
    const activity = (await request(app).get(`/api/budget-periods/items/${row.uuid}/budget-activity`).expect(200)).body;
    expect(activity.length).toBeGreaterThan(0);
    expect(answerProblem(budgetItemActivityResponseSchema, activity)).toBeNull();
  });

  it('moves remaining from one item to another, and refuses more than the item has', async () => {
    const fun = await createItem('Fun', { type: 'Envelope', rollover: true, default_budget_amount: 100 });
    const dining = await createItem('Dining', { default_budget_amount: 50 });
    const period = await createPeriod(1);
    const [from, to] = [await periodItem(fun, period), await periodItem(dining, period)];
    const transfer = (amount: number) => request(app).post(`/api/budget-periods/${period.uuid}/transfer`)
      .send({ fromBudgetPeriodItemId: from.id, toBudgetPeriodItemId: to.id, amount });

    const res = await transfer(30).expect(200);
    expect(res.body.message).toBe(`Successfully transferred $30.00 from ${fun.name} to ${dining.name}`);
    expect([await remaining(fun, period), await remaining(dining, period)]).toEqual(['70.00', '80.00']);
    const pair = await pool.query(
      `SELECT transaction_type, amount FROM budget_period_transactions WHERE metadata->>'transfer_uuid' = $1 ORDER BY transaction_type`,
      [res.body.transferUuid],
    );
    expect(pair.rows).toEqual([{ transaction_type: 'move_in', amount: '30.00' }, { transaction_type: 'move_out', amount: '30.00' }]);

    expect((await transfer(70.01).expect(400)).body.error).toBe('Insufficient funds. Available: 70, Requested: 70.01');
    await transfer(-10).expect(400);
    expect([await remaining(fun, period), await remaining(dining, period)]).toEqual(['70.00', '80.00']);
  });

  // The answer echoed the amount as sent, which its own schema refused.
  it('answers the amount it recorded, whatever text the amount was sent as', async () => {
    const fun = await createItem('Fun', { type: 'Envelope', rollover: true, default_budget_amount: 100 });
    const dining = await createItem('Dining', { default_budget_amount: 50 });
    const period = await createPeriod(1);
    const [from, to] = [await periodItem(fun, period), await periodItem(dining, period)];
    for (const [sent, recorded] of [['.5', 0.5], ['5.', 5], ['+5', 5], ['5.000', 5], ['1.10', 1.1], [2.25, 2.25]] as const) {
      const res = await request(app).post(`/api/budget-periods/${period.uuid}/transfer`)
        .send({ fromBudgetPeriodItemId: from.id, toBudgetPeriodItemId: to.id, amount: sent });
      expect(res.status, `${sent}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(answerProblem(budgetItemTransferResponseSchema, res.body), String(sent)).toBeNull();
      expect(res.body.amount, String(sent)).toBe(recorded);
    }
  });

  it("carries an envelope's remaining into the next period; a monthly item starts over", async () => {
    const savings = await createItem('Car repair', { type: 'Envelope', rollover: true, default_budget_amount: 100 });
    const coffee = await createItem('Coffee', { default_budget_amount: 20 });
    const year = nextYear++;
    const january = await createPeriod(1, year);
    const february = await createPeriod(2, year);
    await spend(savings, january, -30);
    await spend(coffee, january, -5);

    expect(await remaining(savings, january)).toBe('70.00');
    expect(await remaining(savings, february)).toBe('170.00');
    expect(await remaining(coffee, january)).toBe('15.00');
    expect(await remaining(coffee, february)).toBe('20.00');
  });

  // "up to this period" compared period ids, which follow creation
  // order, so a month made after later ones counted them and they missed it.
  it('adds up the periods by date when a month is created after later ones', async () => {
    const envelope = await createItem('Vacation', { type: 'Envelope', rollover: true, default_budget_amount: 100 });
    const year = nextYear++;
    const october = await createPeriod(10, year);
    const november = await createPeriod(11, year);
    const september = await createPeriod(9, year);
    expect(september.id).toBeGreaterThan(november.id);
    await spend(envelope, september, -25);

    expect([await remaining(envelope, september), await remaining(envelope, october), await remaining(envelope, november)])
      .toEqual(['75.00', '175.00', '275.00']);
  });

  it("the period summary's totals are its items' rows", async () => {
    const rent = await createItem('Rent', { default_budget_amount: 1500 });
    const fun = await createItem('Fun', { type: 'Envelope', rollover: true, default_budget_amount: 80 });
    const period = await createPeriod(1);
    await spend(rent, period, -1500);
    await spend(fun, period, -12.34);
    await setBudget(fun, period, 90.1);

    const { summary } = (await request(app).get(`/api/budgets/periods/${period.uuid}/summary`).expect(200)).body;
    const { data: items } = (await request(app).get(`/api/budgets/periods/${period.uuid}/items`).expect(200)).body;
    const cents = (v: string | number) => Math.round(Number(v) * 100);
    const total = <T>(rows: T[], pick: (row: T) => string | number) => rows.reduce((sum, row) => sum + cents(pick(row)), 0);
    type SummaryRow = { budgetAmount: number; actualAmount: number; remainingAmount: number };
    type ItemRow = { calculated_budget: string; calculated_actual: string; calculated_remaining: string };

    expect(summary).toHaveLength(items.length);
    expect(total<SummaryRow>(summary, (r) => r.budgetAmount)).toBe(total<ItemRow>(items, (r) => r.calculated_budget));
    expect(total<SummaryRow>(summary, (r) => r.actualAmount)).toBe(total<ItemRow>(items, (r) => r.calculated_actual));
    expect(total<SummaryRow>(summary, (r) => r.remainingAmount)).toBe(total<ItemRow>(items, (r) => r.calculated_remaining));
    // Every item gets a row in a new period (the other tests' too); these two are as set.
    expect(summary.filter((r: { budgetItemId: number }) => r.budgetItemId === rent.id || r.budgetItemId === fun.id)).toEqual([
      expect.objectContaining({ budgetItemId: fun.id, budgetAmount: 90.1, actualAmount: -12.34, remainingAmount: 77.76 }),
      expect.objectContaining({ budgetItemId: rent.id, budgetAmount: 1500, actualAmount: -1500, remainingAmount: 0 }),
    ]);
  });

  it("moves an account's period balance to the next period as a pair that nets to zero", async () => {
    const year = nextYear++;
    const january = await createPeriod(1, year);
    const february = await createPeriod(2, year);
    const before = (await one<{ balance: string }>('SELECT calculate_account_balance($1) AS balance', [account.id])).balance;

    const res = await request(app).post('/api/transfer/period')
      .send({ account_uuid: account.uuid, source_period_uuid: january.uuid, amount: 25.5 })
      .expect(200);
    // Exactly what Close-Out's shared schema reads.
    expect(answerProblem(budgetPeriodTransferResponseSchema, res.body)).toBeNull();
    const pair = await pool.query(
      'SELECT amount, budget_period_id, transaction_date FROM transactions WHERE uuid = ANY($1::uuid[]) ORDER BY amount',
      [[res.body.source_transaction_uuid, res.body.destination_transaction_uuid]],
    );
    expect(pair.rows).toEqual([
      { amount: '-25.50', budget_period_id: january.id, transaction_date: `${year}-01-31` },
      { amount: '25.50', budget_period_id: february.id, transaction_date: `${year}-02-01` },
    ]);
    expect((await one<{ balance: string }>('SELECT calculate_account_balance($1) AS balance', [account.id])).balance).toBe(before);
  });

  // The amount was rounded to the cent (Math.round(amount * 100)): 0.004 passed the
  // "not zero" check and wrote a 0.00 / 0.00 pair, and 12.345 moved 12.35. It's read in
  // whole cents now, as every other amount is.
  it('refuses a period move of more than 2 decimals or of zero, and writes nothing', async () => {
    const year = nextYear++;
    const january = await createPeriod(1, year);
    await createPeriod(2, year);
    const count = async () => (await one<{ n: number }>('SELECT count(*)::int AS n FROM transactions WHERE account_id = $1', [account.id])).n;
    const before = await count();
    const move = (amount: unknown) =>
      request(app).post('/api/transfer/period').send({ account_uuid: account.uuid, source_period_uuid: january.uuid, amount });

    // More than 2 decimals: refused as an amount, not rounded.
    for (const amount of [0.004, '12.345', -0.001]) {
      const res = await move(amount);
      expect(res.status, `${amount}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.code, String(amount)).toBe('INVALID_AMOUNT');
      expect(res.body.error).toMatch(/at most 2 decimal places/);
    }
    // Zero, and text that isn't a decimal number (Number() read '1e2' as 100), are refused by
    // the body's schema.
    for (const amount of [0, '0.00', '-0', '1e2', '']) {
      const res = await move(amount);
      expect(res.status, `${amount}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.code, String(amount)).toBe('VALIDATION_ERROR');
    }
    expect(await count()).toBe(before);

    // Whole cents, as a number or decimal text, move as sent.
    const sent = await move('-7.10').expect(200);
    const pair = await pool.query('SELECT amount FROM transactions WHERE uuid = ANY($1::uuid[]) ORDER BY amount', [
      [sent.body.source_transaction_uuid, sent.body.destination_transaction_uuid],
    ]);
    expect(pair.rows.map((r) => r.amount)).toEqual(['-7.10', '7.10']);
  });

  describe('merging an item into another', () => {
    const merge = (item: Item, into: Item) => request(app).post(`/api/budgets/items/${item.uuid}/merge`).send({ into_uuid: into.uuid });

    // It moved the spending alone: the target took in the merged envelope's
    // lifetime spending with none of its funding, which the archived item kept.
    it("moves an envelope's budgets with its spending, so neither holds money it didn't", async () => {
      const year = nextYear++;
      const january = await createPeriod(1, year);
      const february = await createPeriod(2, year);
      const maintenance = await createItem('Car maintenance', {
        type: 'Envelope', rollover: true, rollover_starting_balance: 50, rollover_starting_balance_date: `${year}-01-01`,
      });
      const car = await createItem('Car', { type: 'Envelope', rollover: true });
      await setBudget(maintenance, january, 100);
      await setBudget(maintenance, february, 100);
      await setBudget(car, january, 500);
      await spend(maintenance, january, -120);
      await spend(maintenance, february, -130);
      expect(await remaining(maintenance, february)).toBe('0.00');

      await merge(maintenance, car).expect(200);
      expect([await remaining(car, january), await remaining(car, february)]).toEqual(['530.00', '500.00']);
      expect(await figures(car, february)).toEqual({ budget: '100.00', actual: '-130.00', remaining: '500.00' });
      const usage = (await request(app).get(`/api/budgets/items/${maintenance.uuid}/usage`).expect(200)).body;
      expect(usage).toMatchObject({ transactions: 0, budget_periods: 0, balance: 0, archived: true, can_delete: true });

      // The starting balance it brought isn't Car's own, which a new date would move.
      await request(app).put(`/api/budgets/items/${car.uuid}`).send({ rollover_starting_balance_date: `${year}-02-01` }).expect(200);
      expect(await remaining(car, january)).toBe('530.00');
    });

    it("keeps an envelope's balance when a monthly item is merged into it, adding what that had left this month", async () => {
      const coffee = await createItem('Coffee', { default_budget_amount: 50 });
      const fun = await createItem('Fun', { type: 'Envelope', rollover: true, default_budget_amount: 30 });
      const year = nextYear++;
      const january = await createPeriod(1, year);
      const february = await createPeriod(2, year);
      await spend(coffee, january, -20);
      await spend(coffee, february, -10);
      await spend(fun, february, -15);
      expect(await remaining(fun, february)).toBe('45.00');
      expect(await remaining(coffee, february)).toBe('40.00');

      await merge(coffee, fun).expect(200);
      // Coffee's $30 left over in January was gone at the month's end; February's $40 moves.
      expect(await remaining(fun, february)).toBe('85.00');
      expect(await figures(fun, february)).toMatchObject({ budget: '80.00', actual: '-25.00' });
      expect((await request(app).get(`/api/budgets/items/${coffee.uuid}/usage`).expect(200)).body).toMatchObject({ balance: 0, archived: true });
    });

    it("sums a monthly item's budgets and spending into a monthly target, period by period", async () => {
      const coffee = await createItem('Coffee', { default_budget_amount: 50 });
      const dining = await createItem('Dining', { default_budget_amount: 200 });
      const period = await createPeriod(1);
      await spend(coffee, period, -20);
      await spend(dining, period, -150);

      await merge(coffee, dining).expect(200);
      expect(await figures(dining, period)).toEqual({ budget: '250.00', actual: '-170.00', remaining: '80.00' });
    });
  });

  // Budgets are never stored, so nothing sets one on the period item.
  it('has no code that stores a budget on the period item', () => {
    const src = join(getDirname(import.meta.url), '../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(path);
        } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
          files.push(path);
        }
      }
    };
    walk(src);
    const storing = /update\s+"?budget_period_items"?\s+set\s+"?(budget|actual|remaining)\b|updateTable\(\s*['"]budget_period_items['"]\s*\)\s*\.set\(\s*\{[^}]*\b(budget|actual|remaining)\s*:/i;
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((path) => storing.test(readFileSync(path, 'utf8')))).toEqual([]);
  });
});
