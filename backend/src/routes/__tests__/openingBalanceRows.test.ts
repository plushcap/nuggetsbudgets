import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import globalPool from '../../db.js';
import { createDataManagementRoutes } from '../data-management.js';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { BackupService } from '../../services/BackupService.js';


/**
 * An account's opening balance is a 'starting balance' transaction, which
 * has no budget period. Code that picks transactions by "no budget period, in this date
 * range" must leave it alone: deleting it would change the balance by its whole amount,
 * and it isn't the month's activity.
 */
describe('Opening balance transactions', () => {
  let tenant: TestTenant;
  let app: Express;
  let accountId: number;

  const add = async (type: string, amount: number, date: string) =>
    (
      await tenant.pool.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, status)
         VALUES ($1, $2, $3::date, $4, $4, 'cleared') RETURNING id`,
        [accountId, amount, date, type]
      )
    ).rows[0].id as number;
  const row = async (id: number) =>
    (await tenant.pool.query('SELECT id, budget_period_id FROM transactions WHERE id = $1', [id])).rows[0];

  beforeAll(async () => {
    tenant = await createTestTenant('Opening balance rows');
    accountId = (
      await tenant.pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Opening', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0].id;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/data-management', createDataManagementRoutes({ backupService: new BackupService(globalPool) }));
    app.use('/api/budget-periods', createBudgetPeriodRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('survive a bulk delete of their date range', async () => {
    const opening = await add('starting balance', 250, '2025-06-01');
    const spend = await add('expense', -40, '2025-06-01');
    const body = { dateFrom: '2025-06-01', dateTo: '2025-06-01', excludeBudgetPeriod: true, createBackup: false };
    const preview = await request(app).post('/api/data-management/preview-delete-transactions').send(body).expect(200);
    expect(JSON.stringify(preview.body)).toMatch(/"count":1\b/);
    await request(app).post('/api/data-management/delete-transactions').send({ ...body, selectionKey: preview.body.selectionKey }).expect(200);
    expect(await row(opening)).toBeDefined();
    expect(await row(spend)).toBeUndefined();
  });

  it("stay out of a new budget period's transactions", async () => {
    const opening = await add('starting balance', 100, '2025-04-09');
    const spend = await add('expense', -10, '2025-04-09');
    await request(app).post('/api/budget-periods').send({ year: 2025, month: 4, associate_transactions: true }).expect((r) => {
      if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
    });
    expect((await row(opening)).budget_period_id).toBeNull();
    expect((await row(spend)).budget_period_id).not.toBeNull();
  });
});
