import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';

/**
 * GET /api/status, the deployment's schedulers, through the real app: answered by the
 * route wrapper like every other route. Its own catch answered a failure
 * "Failed to get application status", where every other route's 500 is the wrapper's.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('GET /api/status', () => {
  const getApplicationStatus = vi.fn();
  const lifecycle = new Proxy(
    { getApplicationStatus },
    {
      get: (target, prop) =>
        prop === 'then' ? undefined : prop in target ? target[prop as keyof typeof target] : async () => undefined,
    }
  ) as unknown as ApplicationLifecycleService;
  let h: RouteHarness;
  let session: string;

  beforeAll(async () => {
    h = await startRouteHarness('Application status', { lifecycleService: lifecycle });
    const admin = await h.addUser('admin');
    await h.makeDeploymentAdmin(admin.id);
    session = await h.signIn(admin.id);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it("answers a deployment admin the lifecycle's status", async () => {
    getApplicationStatus.mockResolvedValueOnce({ services: { initialized: true } });
    const res = await h.call(session, 'get', '/api/status');
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ services: { initialized: true } });
  });

  it("answers a failure as the route wrapper does, without the error's text", async () => {
    getApplicationStatus.mockRejectedValueOnce(new Error('connect ECONNREFUSED db-host-secret:5432'));
    const res = await h.call(session, 'get', '/api/status');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId: res.headers['x-request-id'] });
    expect(res.text).not.toContain('db-host-secret');
  });
});
