import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createBudgetRoutes } from '../budgets.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// The database accepts only the known expense types and priorities. The routes
// answer a value it would refuse with a 400, not a failed statement's 500.
describe('Budget item expense type and priority', () => {
  let app: Express;
  let tenant: TestTenant;
  let itemUuid = '';

  beforeAll(async () => {
    tenant = await createTestTenant('Budget item vocabulary');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budgets', createBudgetRoutes());
    const res = await request(app).post('/api/budgets/items')
      .send({ name: `Vocabulary ${Date.now()}`, expense_type: 'Expense', type: 'Monthly', priority: 'Essential' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    itemUuid = res.body.uuid ?? res.body.data?.uuid;
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('refuses an unknown one on create', async () => {
    for (const body of [{ expense_type: 'Spending' }, { priority: 'Urgent' }]) {
      const res = await request(app).post('/api/budgets/items').send({ name: `Bad ${Date.now()}`, type: 'Monthly', ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    }
  });

  it('refuses an unknown one on edit, and takes a known one', async () => {
    const bad = await request(app).put(`/api/budgets/items/${itemUuid}`).send({ priority: 'Urgent' });
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect(bad.body.error).toMatch(/priority must be one of/);
    const good = await request(app).put(`/api/budgets/items/${itemUuid}`).send({ priority: 'Optional', expense_type: 'Savings' });
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    const cleared = await request(app).put(`/api/budgets/items/${itemUuid}`).send({ priority: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
  });
});
