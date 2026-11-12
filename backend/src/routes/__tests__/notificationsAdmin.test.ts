import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express, type Request, type Response, type NextFunction } from 'express';
import { createNotificationAdminRoutes, createNotificationRoutes, EMAIL_PREVIEW_CSP } from '../notifications.js';
import { requireDeploymentAdmin } from '../../middleware/tenant.js';
import { config } from '../../config.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { EmailDeliveryService, SmtpNotConfiguredError } from '../../services/EmailDeliveryService.js';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';
import { NotificationRuleService } from '../../services/notifications/NotificationRuleService.js';
import { inTenantTransaction } from '../../db/withTenant.js';

/**
 * Who may use the deployment-wide notification endpoints (SMTP settings, the
 * scheduler, test email, preview: /api/admin/notifications, behind
 * requireDeploymentAdmin at its mount) and the tenant's notification history
 * (/api/notifications/history): deployment admins for the first, tenant admins for
 * the second, and no one else. The admin routes are mounted here behind the same
 * requireDeploymentAdmin as in routes.ts.
 */
describe('Notification admin API', () => {
  const stamp = Date.now();
  const notificationType = `admin-test-${stamp}`;
  let tenant: TestTenant;
  // Another household's ledger, to show clearing history stays inside the admin's own.
  let otherTenant: TestTenant;
  let tenantId: number;
  let app: Express;

  const lifecycle = {
    getNotificationSchedulerStatus: vi.fn(async () => ({ running: false, shuttingDown: false, hasRunningOperations: false, settings: null })),
    startNotificationScheduler: vi.fn(async () => {}),
    stopNotificationScheduler: vi.fn(async () => {}),
    restartNotificationScheduler: vi.fn(async () => {}),
    updateNotificationSchedulerConfiguration: vi.fn(async () => {}),
  };

  // Stands in for resolveTenant + requireTenantMember: the gates read these.
  const as = (role: { tenantAdmin: boolean; deploymentAdmin: boolean }) =>
    (req: Request, _res: Response, next: NextFunction) => {
      Object.assign(req, { tenant: { id: tenantId, isAdmin: role.tenantAdmin }, isDeploymentAdmin: role.deploymentAdmin });
      next();
    };

  beforeAll(async () => {
    tenant = await createTestTenant('Notification admin API');
    otherTenant = await createTestTenant('Notification admin other');
    tenantId = tenant.tenantId;

    const notifications = createNotificationRoutes({ notificationRuleService: new NotificationRuleService() });
    const adminNotifications = createNotificationAdminRoutes({
      lifecycleService: lifecycle as unknown as ApplicationLifecycleService,
      config: config(),
    });
    const context = tenant.context();
    app = express();
    app.use(express.json());
    for (const [prefix, role] of [
      ['/member', { tenantAdmin: false, deploymentAdmin: false }],
      ['/tenant-admin', { tenantAdmin: true, deploymentAdmin: false }],
      ['/deployment-admin', { tenantAdmin: true, deploymentAdmin: true }],
    ] as const) {
      app.use(`${prefix}/admin`, context, as(role), requireDeploymentAdmin, adminNotifications);
      app.use(prefix, context, as(role), notifications);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.values(lifecycle).forEach((fn) => fn.mockClear());
  });

  afterAll(async () => {
    await tenant.cleanup();
    await otherTenant.cleanup();
  });

  const addNotification = async (to: TestTenant = tenant) =>
    to.pool.query(
      `INSERT INTO notifications (user_id, recipient_email, notification_type, subject, template_data)
       VALUES ($1, $2, $3, 'Test', '{}')`,
      [to.userId, to.userEmail, notificationType]
    );

  const tenantNotifications = async (of: TestTenant = tenant) =>
    (await of.pool.query('SELECT id FROM notifications')).rows;

  type Call = { method: 'get' | 'post' | 'delete'; path: string; body?: object };

  const deploymentAdminOnly: Call[] = [
    { method: 'get', path: '/admin/settings' },
    { method: 'post', path: '/admin/settings', body: { settings: {} } },
    { method: 'get', path: '/admin/status' },
    { method: 'post', path: '/admin/scheduler/start' },
    { method: 'post', path: '/admin/scheduler/stop' },
    { method: 'post', path: '/admin/scheduler/restart' },
    { method: 'post', path: '/admin/test', body: { recipient: 'someone@example.com', templateType: 'transaction-review' } },
    { method: 'get', path: '/admin/preview/transaction-review' },
  ];

  const tenantAdminOnly: Call[] = [
    { method: 'get', path: '/history' },
    { method: 'delete', path: '/history' },
  ];

  const send = (prefix: string, call: Call) => {
    const req = request(app)[call.method](`${prefix}${call.path}`);
    return call.body ? req.send(call.body) : req;
  };

  describe.each(deploymentAdminOnly)('$method $path', (call) => {
    it.each(['/member', '/tenant-admin'])('refuses %s', async (prefix) => {
      const send$ = vi.spyOn(EmailDeliveryService.prototype, 'sendEmailWithRetry');
      const res = await send(prefix, call).expect(403);
      expect(res.body.code).toBe('DEPLOYMENT_ADMIN_REQUIRED');
      expect(send$).not.toHaveBeenCalled();
      Object.values(lifecycle).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    });

    it('allows a deployment admin', async () => {
      vi.spyOn(EmailDeliveryService.prototype, 'sendEmailWithRetry').mockResolvedValue('test-message-id');
      await send('/deployment-admin', call).expect(200);
    });
  });

  describe.each(tenantAdminOnly)('$method $path', (call) => {
    it('refuses a member', async () => {
      await addNotification();
      const res = await send('/member', call).expect(403);
      expect(res.body.code).toBe('TENANT_ADMIN_REQUIRED');
      expect((await tenantNotifications()).length).toBeGreaterThan(0);
    });

    it('allows a tenant admin', async () => {
      await addNotification();
      await send('/tenant-admin', call).expect(200);
    });
  });

  it('shows a tenant admin the history, with who each went to', async () => {
    await addNotification();
    const res = await request(app).get(`/tenant-admin/history?type=${notificationType}`).expect(200);
    expect(res.body.notifications[0]).toMatchObject({ notification_type: notificationType, user_email: tenant.userEmail });
  });

  it('reads the history query as pageParams did, and refuses a repeated filter', async () => {
    await addNotification();
    const res = await request(app).get(`/tenant-admin/history?type=${notificationType}&limit=abc&page=0`).expect(200);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 20 });
    const repeated = await request(app).get('/tenant-admin/history?status=sent&status=failed').expect(400);
    expect(repeated.body.code).toBe('VALIDATION_ERROR');
  });

  it("lets a tenant admin clear the tenant's history, and only that tenant's", async () => {
    await addNotification();
    await addNotification(otherTenant);
    await request(app).delete('/tenant-admin/history').expect(200);
    expect(await tenantNotifications()).toEqual([]);
    expect(await tenantNotifications(otherTenant)).toHaveLength(1);
  });

  it('sends the test email for a deployment admin', async () => {
    const send$ = vi.spyOn(EmailDeliveryService.prototype, 'sendEmailWithRetry').mockResolvedValue('test-message-id');
    const res = await request(app)
      .post('/deployment-admin/admin/test')
      .send({ recipient: 'someone@example.com', templateType: 'budget-overspending' })
      .expect(200);
    expect(res.body.messageId).toBe('test-message-id');
    expect(send$).toHaveBeenCalledWith('someone@example.com', expect.stringContaining('[TEST]'), expect.any(String), expect.any(String), 1);
  });

  describe('GET /status says email is configured only when it can be sent', () => {
    // isConfigured itself (a host alone isn't enough) is EmailDeliveryService.hostOnly.test.ts;
    // the SMTP settings are shared by every test file, so this file doesn't write them.
    it.each([true, false])('says what isConfigured says (%s), whatever the host', async (answer) => {
      const configured = vi.spyOn(EmailDeliveryService.prototype, 'isConfigured').mockResolvedValue(answer);
      const res = await request(app).get('/deployment-admin/admin/status').expect(200);
      expect(res.body).toMatchObject({ configured: answer, enabled: expect.any(Boolean) });
      expect(configured).toHaveBeenCalled();
    });
  });

  // Sending waits on the mail server, so no ledger transaction may be open meanwhile: it
  // would hold a pooled connection the whole time.
  it('sends the test email with no ledger transaction open', async () => {
    const seen: boolean[] = [];
    vi.spyOn(EmailDeliveryService.prototype, 'sendEmailWithRetry').mockImplementation(async () => {
      seen.push(inTenantTransaction());
      return 'test-message-id';
    });
    await request(app)
      .post('/deployment-admin/admin/test')
      .send({ recipient: 'someone@example.com', templateType: 'transaction-review' })
      .expect(200);
    expect(seen).toEqual([false]);
  });

  it('answers a test email with nothing set up to send it 503 SMTP_NOT_CONFIGURED, in words for the admin', async () => {
    const reason = "Email isn't set up yet: enter the SMTP host and username in the Email Notifications settings.";
    vi.spyOn(EmailDeliveryService.prototype, 'sendEmailWithRetry').mockRejectedValue(new SmtpNotConfiguredError(reason));
    const res = await request(app)
      .post('/deployment-admin/admin/test')
      .send({ recipient: 'someone@example.com', templateType: 'transaction-review' })
      .expect(503);
    expect(res.body).toEqual({ code: 'SMTP_NOT_CONFIGURED', error: reason, message: reason });
  });

  it("answers a test email the mail server didn't take 502 MAIL_SEND_FAILED, with what to check and not the mailer's text", async () => {
    vi.spyOn(EmailDeliveryService.prototype, 'sendEmailWithRetry').mockRejectedValue(
      Object.assign(new Error('Invalid login: 535 Authentication failed for smtp-user-secret'), { code: 'EAUTH', responseCode: 535 })
    );
    const res = await request(app)
      .post('/deployment-admin/admin/test')
      .send({ recipient: 'someone@example.com', templateType: 'transaction-review' })
      .expect(502);
    expect(res.body).toEqual({
      error: 'Failed to send test email',
      code: 'MAIL_SEND_FAILED',
      message: 'The mail server refused the sign-in: check the SMTP username and password',
    });
    expect(res.text).not.toContain('smtp-user-secret');
  });

  it.each([
    [{ templateType: 'transaction-review' }, 'Recipient and templateType are required'],
    [{ recipient: 'someone@example.com' }, 'Recipient and templateType are required'],
    [{ recipient: 'someone@example.com', templateType: 'fax' }, 'Invalid templateType. Must be transaction-review or budget-overspending'],
    [{ recipient: 'someone@example.com\r\nBcc: attacker@example.com', templateType: 'transaction-review' }, 'Must be an email address'],
  ])('refuses a test email for %j: 400 VALIDATION_ERROR, %s', async (body, message) => {
    const send$ = vi.spyOn(EmailDeliveryService.prototype, 'sendEmailWithRetry');
    const res = await request(app).post('/deployment-admin/admin/test').send(body).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message });
    expect(send$).not.toHaveBeenCalled();
  });

  it('refuses a preview of a sample that does not exist', async () => {
    const res = await request(app).get('/deployment-admin/admin/preview/fax').expect(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST', error: 'Invalid templateType. Must be transaction-review or budget-overspending' });
  });

  it("counts the deployment's queue, every ledger's, in the status", async () => {
    await addNotification();
    await addNotification(otherTenant);
    await otherTenant.pool.query("UPDATE notifications SET status = 'failed' WHERE notification_type = $1", [notificationType]);
    const own = Number((await tenant.pool.query("SELECT count(*) FROM notifications WHERE status = 'pending' AND created_at >= now() - interval '7 days'")).rows[0].count);
    const res = await request(app).get('/deployment-admin/admin/status').expect(200);
    // Other files' ledgers queue notifications too, so at least these two.
    expect(res.body.queue.pending).toBeGreaterThanOrEqual(own);
    expect(res.body.queue.failed).toBeGreaterThanOrEqual(1);
    expect(res.body.queue.total).toBeGreaterThanOrEqual(own + 1);
  });

  it('previews the email under its own Content-Security-Policy, which lets it load what it links and nothing else', async () => {
    const res = await request(app).get('/deployment-admin/admin/preview/budget-overspending').expect(200);
    // In place of the backend's deny-all policy (app.ts), which would leave it unstyled.
    expect(res.headers['content-security-policy']).toBe(EMAIL_PREVIEW_CSP);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    // Inline styles are all MJML writes, and its only stylesheet is the Google one the policy names.
    expect(res.text).toMatch(/<style/);
    expect(res.text).not.toMatch(/<script/i);
    const stylesheets = [...res.text.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => new URL(m[1]).origin);
    expect(stylesheets.every((origin) => origin === 'https://fonts.googleapis.com')).toBe(true);
    expect(EMAIL_PREVIEW_CSP).not.toMatch(/script-src/);
  });

  it('leaves the per-person and per-tenant endpoints open to members', async () => {
    await request(app).get('/member/rules').expect(200);
    await request(app).get('/member/preferences').expect(200);
  });
});
