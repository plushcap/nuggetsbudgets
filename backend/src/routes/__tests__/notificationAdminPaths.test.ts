import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';

/**
 * The deployment's notification routes (SMTP, the scheduler, the queue, the test email and
 * preview) are at /api/admin/notifications, with no ledger: a deployment admin who has
 * none can use them, and the old paths under the ledger's /api/notifications answer 404.
 * A ledger's rules, choices and history stay there. Who else is refused is
 * route-authorization.test.ts's.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const MOVED = [
  ['get', '/settings'],
  ['post', '/settings'],
  ['get', '/status'],
  ['post', '/test'],
  ['get', '/preview/transaction-review'],
  ['post', '/scheduler/start'],
  ['post', '/scheduler/stop'],
  ['post', '/scheduler/restart'],
] as const;

describeDb('/api/admin/notifications', () => {
  let h: RouteHarness;
  let tenant: TestTenant;
  let withoutTenant: string;
  let inTenant: string;

  beforeAll(async () => {
    h = await startRouteHarness('Notification admin paths');
    tenant = await createTestTenant('Notification admin paths');
    const admin = await h.addUser('admin');
    await h.makeDeploymentAdmin(admin.id);
    withoutTenant = await h.signIn(admin.id);
    inTenant = await h.signIn(admin.id, tenant.tenantId);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await tenant?.cleanup();
  });

  it('answers a deployment admin with no ledger', async () => {
    const settings = await h.call(withoutTenant, 'get', '/api/admin/notifications/settings');
    expect(settings.status, settings.text).toBe(200);
    expect(settings.body).toMatchObject({ settings: expect.any(Object), passwordConfigured: expect.any(Boolean) });
    expect(settings.body.settings).not.toHaveProperty('notification_smtp_password');

    const status = await h.call(withoutTenant, 'get', '/api/admin/notifications/status');
    expect(status.status, status.text).toBe(200);
    expect(status.body).toMatchObject({
      configured: expect.any(Boolean),
      enabled: expect.any(Boolean),
      queue: { pending: expect.any(Number), processing: expect.any(Number), sent: expect.any(Number), failed: expect.any(Number) },
    });

    const preview = await h.call(withoutTenant, 'get', '/api/admin/notifications/preview/budget-overspending');
    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toMatch(/^text\/html/);
  });

  it.each(MOVED)('no longer answers %s /api/notifications%s, even in a ledger', async (verb, path) => {
    const res = await h.call(inTenant, verb, `/api/notifications${path}`, verb === 'get' ? undefined : {});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it("still answers the ledger's own notification routes there", async () => {
    expect((await h.call(inTenant, 'get', '/api/notifications/rules')).status).toBe(200);
    expect((await h.call(inTenant, 'get', '/api/notifications/history')).status).toBe(200);
  });
});
