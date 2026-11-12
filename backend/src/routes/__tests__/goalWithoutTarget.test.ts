import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { answerProblem, goalListResponseSchema, goalOneResponseSchema, goalProgressHistoryResponseSchema } from '@nuggets/shared';
import { createBudgetRoutes } from '../budgets.js';
import { createGoalRoutes } from '../goals.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A goal made through the budget item routes: `POST /api/budgets/items` with
 * Savings/Goal, or an expense changed to one, sets no target or date (the goal routes require
 * both). The goal answers' strict schemas refused that, so the Goals page threw in development,
 * and the projection read such a goal as reached today. Its answers now say it has none: a
 * null target, date, share and remaining, and no projected date.
 */
describe('A goal with no target or date', () => {
  let tenant: TestTenant;
  let app: Express;

  beforeAll(async () => {
    tenant = await createTestTenant('Goal without target');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budgets', createBudgetRoutes());
    app.use('/api/goals', createGoalRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('is answered by every goal route as one with none, exactly as the shared schemas read it', async () => {
    const made = (await request(app).post('/api/budgets/items')
      .send({ name: 'Made as an item', expense_type: 'Savings', type: 'Goal', subtype: 'Goal' }).expect(201)).body;
    const changed = (await request(app).post('/api/budgets/items').send({ name: 'Expense first' }).expect(201)).body;
    await request(app).put(`/api/budgets/items/${changed.uuid}`).send({ expense_type: 'Savings', type: 'Goal' }).expect(200);

    const list = (await request(app).get('/api/goals').expect(200)).body;
    expect(answerProblem(goalListResponseSchema, list)).toBeNull();
    for (const name of ['Made as an item', 'Expense first']) {
      const goal = list.goals.find((g: { name: string }) => g.name === name);
      expect(goal, name).toMatchObject({
        target_amount: null, target_date: null, progress_percentage: null, remaining_amount: null, projected_completion_date: null, current_progress: 0,
      });
    }

    const one = (await request(app).get(`/api/goals/${made.uuid}`).expect(200)).body;
    expect(answerProblem(goalOneResponseSchema, one)).toBeNull();
    expect(one.goal).toMatchObject({ target_amount: null, target_date: null, progress_percentage: null, remaining_amount: null });
    expect(one.goal.projection).toEqual({
      currentProgress: 0, targetAmount: null, remainingAmount: null,
      pastPerformanceMonths: null, plannedContributionMonths: null, pastPerformanceDate: null, plannedContributionDate: null,
    });
    expect(answerProblem(goalProgressHistoryResponseSchema, (await request(app).get(`/api/goals/${made.uuid}/progress-history`).expect(200)).body)).toBeNull();

    // Given a target and a date, it reads as any goal does.
    await request(app).put(`/api/goals/${made.uuid}`).send({ target_amount: 500, target_date: '2030-01-01' }).expect(200);
    const set = (await request(app).get(`/api/goals/${made.uuid}`).expect(200)).body.goal;
    expect(set).toMatchObject({ target_amount: '500.00', target_date: '2030-01-01', progress_percentage: 0, remaining_amount: 500 });
    expect(set.projection.targetAmount).toBe(500);
  });
});
