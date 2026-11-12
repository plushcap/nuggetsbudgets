import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import {
  accountBalanceAdjustedResponseSchema,
  accountBalanceResponseSchema,
  accountRowResponseSchema,
  answerProblem,
} from '@nuggets/shared';
import type { z } from 'zod';
import { createAccountsRoutes } from '../accounts.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The account writes' and balance answers against their `@nuggets/shared` schemas:
 * Add and Edit Account, the balance card and Adjust Balance read them, which
 * nothing parsed.
 */
describe('Account answers', () => {
  let tenant: TestTenant;
  let app: Express;
  const fits = (schema: z.ZodType, body: unknown) => expect(answerProblem(schema, body)).toBeNull();

  beforeAll(async () => {
    tenant = await createTestTenant('Account answers');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/accounts', createAccountsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('answers a create, an update, the balance and Adjust Balance as their schemas say', async () => {
    const created = await request(app)
      .post('/api/accounts')
      .send({ name: 'Answers checking', account_type: 'checking', account_group: 'cash', type: 'Asset', initial_balance: '25.50' })
      .expect(201);
    fits(accountRowResponseSchema, created.body);
    const uuid = created.body.uuid as string;
    const updated = await request(app)
      .put(`/api/accounts/${uuid}`)
      .send({ name: 'Answers checking', account_type: 'checking', account_group: 'cash', type: 'Asset', notes: 'main' })
      .expect(200);
    fits(accountRowResponseSchema, updated.body);
    const balance = await request(app).get(`/api/accounts/${uuid}/balance`).expect(200);
    expect(balance.body).toMatchObject({ balance: 25.5, balance_unavailable: false });
    fits(accountBalanceResponseSchema, balance.body);
    const adjusted = await request(app).post(`/api/accounts/${uuid}/adjust-balance`).send({ targetBalance: 30 }).expect(200);
    expect(adjusted.body).toMatchObject({ adjusted: true, adjustment: 4.5 });
    fits(accountBalanceAdjustedResponseSchema, adjusted.body);
    const unchanged = await request(app).post(`/api/accounts/${uuid}/adjust-balance`).send({ targetBalance: 30 }).expect(200);
    expect(unchanged.body.adjusted).toBe(false);
    fits(accountBalanceAdjustedResponseSchema, unchanged.body);
  });
});
