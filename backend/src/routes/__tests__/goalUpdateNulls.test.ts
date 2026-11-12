import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { answerProblem, goalOneResponseSchema } from '@nuggets/shared';
import { createGoalRoutes } from '../goals.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * PUT /api/goals/:uuid takes null for the two fields a goal may have none of, its description
 * and its monthly contribution, and clears them (request types take null where the
 * API does). The route accepted null and read it as "not sent", so they couldn't be cleared;
 * a field left out still keeps its value.
 */
describe('Updating a goal with null', () => {
  let tenant: TestTenant;
  let app: Express;

  beforeAll(async () => {
    tenant = await createTestTenant('Goal update nulls');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/goals', createGoalRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('clears the description and the monthly contribution, and keeps what is left out', async () => {
    const created = (await request(app).post('/api/goals')
      .send({ name: 'House', description: 'A deposit', target_amount: 10000, target_date: '2030-01-01', estimated_monthly_contribution: 250 })
      .expect(201)).body.goal;
    expect(created).toMatchObject({ description: 'A deposit', estimated_monthly_contribution: '250.00' });

    const cleared = await request(app).put(`/api/goals/${created.uuid}`).send({ description: null, estimated_monthly_contribution: null }).expect(200);
    expect(answerProblem(goalOneResponseSchema, cleared.body)).toBeNull();
    expect(cleared.body.goal).toMatchObject({ name: 'House', description: null, estimated_monthly_contribution: null, target_amount: '10000.00' });

    const renamed = await request(app).put(`/api/goals/${created.uuid}`).send({ name: 'Bigger house' }).expect(200);
    expect(renamed.body.goal).toMatchObject({ name: 'Bigger house', description: null, estimated_monthly_contribution: null });
    const described = await request(app).put(`/api/goals/${created.uuid}`).send({ description: 'Again', estimated_monthly_contribution: '75.5' }).expect(200);
    expect(described.body.goal).toMatchObject({ description: 'Again', estimated_monthly_contribution: '75.50' });
  });
});
