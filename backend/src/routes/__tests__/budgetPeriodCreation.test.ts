import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { sql } from 'kysely';
import { createBudgetRoutes } from '../budgets.js';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import { getDb, withTenant } from '../../db/withTenant.js';
import { BudgetService } from '../../services/BudgetService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A ledger has one budget period per month. Creating one that exists, or
 * two requests creating the same month at once, gives the month once: the loser gets the
 * existing period from BudgetService, and a create route answers 409.
 */
describe('Creating a budget period', () => {
  const YEAR = 2032;
  let tenant: TestTenant;
  let app: Express;

  const periodsOf = async (month: number) =>
    (await tenant.pool.query(`SELECT id FROM budget_period WHERE year = $1 AND month_number = $2`, [YEAR, month])).rows.map(
      (r) => r.id as number
    );
  const itemsOf = async (periodId: number) =>
    Number((await tenant.pool.query(`SELECT count(*) FROM budget_period_items WHERE budget_period_id = $1`, [periodId])).rows[0].count);

  /** Polls `check` until it holds, or fails after a while. */
  async function waitFor(what: string, check: () => Promise<boolean>) {
    const deadline = Date.now() + 5_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  beforeAll(async () => {
    tenant = await createTestTenant('Budget period creation');
    for (const name of ['Groceries', 'Rent']) {
      await tenant.pool.query(`INSERT INTO budget_items (name, expense_type, type, default_budget_amount) VALUES ($1, 'Expense', 'Monthly', 100)`, [name]);
    }
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budget-periods', createBudgetPeriodRoutes());
    app.use('/api/budgets', createBudgetRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('creates the month once when a second request gets past the check before the first commits', async () => {
    const service = new BudgetService();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let firstPid = 0;
    let firstCreated!: () => void;
    const created = new Promise<void>((resolve) => (firstCreated = resolve));

    // The first request creates May and keeps its transaction open.
    const first = withTenant(tenant.tenantId, async () => {
      firstPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(getDb())).rows[0].pid;
      const result = await service.createBudgetPeriod(YEAR, 5, tenant.userId);
      firstCreated();
      await held;
      return result;
    });
    await created;
    // The second doesn't see the uncommitted May, so it goes on to insert one, and waits
    // for the first's row.
    const second = withTenant(tenant.tenantId, () => service.createBudgetPeriod(YEAR, 5, tenant.userId));
    try {
      await waitFor('the second insert to wait for the first', async () => {
        const blocked = await tenant.pool.query(`SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [firstPid]);
        return (blocked.rowCount ?? 0) > 0;
      });
    } finally {
      release();
    }
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual({ periodId: expect.any(Number), budgetItemsCreated: 2, created: true });
    expect(b).toEqual({ periodId: a.periodId, budgetItemsCreated: 0, created: false });
    expect(await periodsOf(5)).toEqual([a.periodId]);
    expect(await itemsOf(a.periodId)).toBe(2);
  });

  it('answers 409 for a month that has its period, on both create routes', async () => {
    const res = await request(app).post('/api/budget-periods').send({ year: YEAR, month: 6 });
    expect(res.status).toBe(201);
    const [june] = await periodsOf(6);
    expect(res.body.period_id).toBe(june);

    const again = await request(app).post('/api/budget-periods').send({ year: YEAR, month: 6 });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'BUDGET_PERIOD_EXISTS', error: `Budget period for 6/${YEAR} already exists: June ${YEAR}` });

    const other = await request(app).post('/api/budgets/periods').send({ year: YEAR, month: 6 });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: 'BUDGET_PERIOD_EXISTS' });

    expect(await periodsOf(6)).toEqual([june]);
    expect(await itemsOf(june)).toBe(2);

    const july = await request(app).post('/api/budgets/periods').send({ year: YEAR, month: 7 });
    expect(july.status).toBe(201);
    expect(july.body).toMatchObject({ year: YEAR, month_number: 7, budgetItemsCreated: 2 });
  });

  it("takes in the month's transactions that have no period from the Budget page's route, as from the settings page's", async () => {
    const account = (await tenant.pool.query(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Period checking', 'checking', 'cash', 'Asset') RETURNING id`
    )).rows[0].id as number;
    const transaction = async (date: string, description: string, type = 'expense', periodId: number | null = null) =>
      (await tenant.pool.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_period_id)
         VALUES ($1, -12.34, $2, $3, $4, $5) RETURNING id`,
        [account, date, type, description, periodId]
      )).rows[0].id as number;
    const periodOf = async (id: number) =>
      (await tenant.pool.query(`SELECT budget_period_id FROM transactions WHERE id = $1`, [id])).rows[0].budget_period_id as number | null;

    // November's period, made from the settings page without taking anything in.
    const novemberCreated = await request(app).post('/api/budget-periods').send({ year: YEAR, month: 11, associate_transactions: false });
    expect(novemberCreated.status).toBe(201);
    const november = novemberCreated.body.period_id as number;

    const firstDay = await transaction(`${YEAR}-09-01`, 'First day');
    const lastDay = await transaction(`${YEAR}-09-30`, 'Last day');
    const opening = await transaction(`${YEAR}-09-15`, 'Opening balance', 'starting balance');
    const alreadyPlaced = await transaction(`${YEAR}-09-20`, 'Counted in November', 'expense', november);
    const nextMonth = await transaction(`${YEAR}-10-01`, 'Next month');
    const earlier = await transaction(`${YEAR}-04-30`, 'Earlier month');

    const res = await request(app).post('/api/budgets/periods').send({ year: YEAR, month: 9 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ year: YEAR, month_number: 9, budgetItemsCreated: 2 });
    const september = res.body.id as number;
    expect(await periodsOf(9)).toEqual([september]);

    // September's own days, with no period: taken in.
    expect(await periodOf(firstDay)).toBe(september);
    expect(await periodOf(lastDay)).toBe(september);
    // An opening balance, one already in a period, and other months': left alone.
    expect(await periodOf(opening)).toBeNull();
    expect(await periodOf(alreadyPlaced)).toBe(november);
    expect(await periodOf(nextMonth)).toBeNull();
    expect(await periodOf(earlier)).toBeNull();

    // The settings page's route takes in its month's the same way.
    const october = await request(app).post('/api/budget-periods').send({ year: YEAR, month: 10 });
    expect(october.status).toBe(201);
    expect(october.body.transactions_associated).toBe(1);
    expect(await periodOf(nextMonth)).toBe(october.body.period_id);
    expect(await periodOf(earlier)).toBeNull();
  });

  it('gives one 201 and one 409 to two requests for the same month at once', async () => {
    const send = () => request(app).post('/api/budget-periods').send({ year: YEAR, month: 8 });
    const statuses = (await Promise.all([send(), send()])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const august = await periodsOf(8);
    expect(august).toHaveLength(1);
    expect(await itemsOf(august[0])).toBe(2);
  });
});
