import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';
import { addMonths } from '../../utils/calendarDate.js';

/**
 * A goal's projected completion is a calendar date in the years a request's may be in
 * (1800–2999), or none. A cent a month toward a million is a hundred million
 * months away: addMonths made an Invalid Date there and threw, so GET /api/goals answered 500
 * for the whole list; a dollar a month gave the year 85,000-odd as "+085359-…", which isn't a
 * 'YYYY-MM-DD' date.
 */
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('Goal projection range', () => {
  let h: RouteHarness;
  let tenant: TestTenant;
  let member: string;
  let today: string;

  const createGoal = async (name: string, monthly: number) => {
    const res = await h.call(member, 'post', '/api/goals', {
      name,
      target_amount: 1_000_000,
      target_date: '2030-01-01',
      estimated_monthly_contribution: monthly,
    });
    expect(res.status, res.text).toBe(201);
    return res.body.goal.uuid as string;
  };

  beforeAll(async () => {
    h = await startRouteHarness('Goal projection range');
    tenant = await createTestTenant('Goal projection range');
    member = await h.signIn(tenant.userId, tenant.tenantId);
    today = (await tenant.pool.query<{ today: string }>('SELECT app_today()::text AS today')).rows[0].today;
  });

  afterAll(async () => {
    const settled = await Promise.allSettled([h?.close(), tenant?.cleanup()]);
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failed) throw failed.reason;
  });

  it('has no completion date past 2999, and the goals list still answers', async () => {
    const cent = await createGoal('A cent a month', 0.01);
    const dollar = await createGoal('A dollar a month', 1);
    const plenty = await createGoal('Plenty a month', 10_000);

    const listed = await h.call(member, 'get', '/api/goals');
    expect(listed.status, listed.text).toBe(200);
    const projected = (uuid: string) =>
      listed.body.goals.find((g: { uuid: string }) => g.uuid === uuid).projected_completion_date as string | null;
    expect(projected(cent)).toBeNull();
    expect(projected(dollar)).toBeNull();
    // A hundred months is a date.
    expect(projected(plenty)).toBe(addMonths(today, 100));

    for (const uuid of [cent, dollar]) {
      const detail = await h.call(member, 'get', `/api/goals/${uuid}`);
      expect(detail.status, detail.text).toBe(200);
      expect(detail.body.goal.projection).toMatchObject({ plannedContributionDate: null, pastPerformanceDate: null });
    }
  });
});
