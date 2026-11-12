import {
  answerProblem,
  testAccountsResponseSchema,
  testBudgetItemsResponseSchema,
  testBudgetPeriodsResponseSchema,
  testCategoriesResponseSchema,
  testDataClearedResponseSchema,
  testDataGeneratedResponseSchema,
  testInstitutionsResponseSchema,
  testTransactionsResponseSchema,
} from '@nuggets/shared';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createTestDataRoutes } from '../test-data.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The test-data generator writes through the request's tenant transaction (getDb()), with
 * no pool of its own; who may call it is decided at its mount (routes.ts, checked in
 * route-authorization.test.ts). Here, as a deployment admin past that guard.
 */
describe('the test-data routes, past their guard', () => {
  let app: Express;
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Test-data routes');
    app = express();
    app.use(express.json());
    app.use(tenant.context({ deploymentAdmin: true }));
    app.use('/api/admin/test-data', createTestDataRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('makes budget periods in the active ledger, and only there', async () => {
    const res = await request(app)
      .post('/api/admin/test-data/budget-periods')
      .send({ months: [{ year: 2031, monthNumber: 2 }] })
      .expect(200);
    expect(answerProblem(testBudgetPeriodsResponseSchema, res.body)).toBeNull();
    expect(res.body.periods).toEqual([{ year: 2031, monthNumber: 2, periodId: expect.any(Number) }]);
    const { rows } = await tenant.pool.query(`SELECT tenant_id, start_date::text FROM budget_period WHERE id = $1`, [res.body.periods[0].periodId]);
    expect(rows).toEqual([{ tenant_id: tenant.tenantId, start_date: '2031-02-01' }]);
  });

  // The sample incomes went on the ledger's first account, whatever it was: on a card, the
  // database refused them (no income on a liability), and the error, caught without
  // a savepoint, aborted the request's transaction, a 500.
  it('makes sample transactions when the first account is a liability, with no income on it', async () => {
    const account = async (name: string, accountType: string, group: string, type: string) =>
      (
        await tenant.pool.query<{ id: number }>(
          `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, $2, $3, $4) RETURNING id`,
          [name, accountType, group, type]
        )
      ).rows[0].id;
    const card = await account('Sample card', 'credit_card', 'credit_cards', 'Liability');
    await account('Sample checking', 'checking', 'cash', 'Asset');
    await account('Sample savings', 'savings', 'cash', 'Asset');
    await tenant.pool.query(`INSERT INTO budget_items (name, expense_type) VALUES ('Sample pay', 'Income'), ('Sample food', 'Expense')`);
    await request(app)
      .post('/api/admin/test-data/budget-periods')
      .send({ months: [{ year: 2024, monthNumber: 1 }, { year: 2024, monthNumber: 2 }] })
      .expect(200);

    const res = await request(app).post('/api/admin/test-data/transactions').expect(200);
    expect(answerProblem(testTransactionsResponseSchema, res.body)).toBeNull();
    expect(res.body.transactionsCreated).toBeGreaterThan(0);
    const { rows } = await tenant.pool.query<{ type: string; on_card: boolean; n: number }>(
      `SELECT type, account_id = $1 AS on_card, count(*)::int AS n FROM transactions
        WHERE type IN ('income', 'expense') GROUP BY 1, 2 ORDER BY 1, 2`,
      [card]
    );
    expect(rows.find((r) => r.type === 'income' && r.on_card)).toBeUndefined();
    expect(rows.find((r) => r.type === 'income' && !r.on_card)?.n).toBe(3);
  });

  it('makes categories in the active ledger', async () => {
    const res = await request(app).post('/api/admin/test-data/categories').expect(200);
    expect(answerProblem(testCategoriesResponseSchema, res.body)).toBeNull();
    expect(JSON.stringify(res.body)).toContain('Insurance');
    const { rows } = await tenant.pool.query(`SELECT count(*)::int AS n FROM categories WHERE name = 'Insurance'`);
    expect(rows[0].n).toBe(1);
  });

  // Each answer is what its @nuggets/shared schema says.
  it('answers the rest of its routes as their schemas say', async () => {
    const answers: Array<[string, 'post' | 'delete', import('zod').ZodType]> = [
      ['/api/admin/test-data/account-institutions', 'post', testInstitutionsResponseSchema],
      ['/api/admin/test-data/accounts', 'post', testAccountsResponseSchema],
      ['/api/admin/test-data/budget-items', 'post', testBudgetItemsResponseSchema],
      ['/api/admin/test-data/generate-all', 'post', testDataGeneratedResponseSchema],
      ['/api/admin/test-data/clear-all', 'delete', testDataClearedResponseSchema],
    ];
    for (const [path, verb, schema] of answers) {
      const res = await request(app)[verb](path);
      expect(res.status, `${path}: ${res.text}`).toBe(200);
      expect(answerProblem(schema, res.body), path).toBeNull();
    }
  }, 30_000);
});
