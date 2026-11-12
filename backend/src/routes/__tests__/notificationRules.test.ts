import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express, type Request, type Response, type NextFunction } from 'express';
import { defaultNotificationRules } from '@nuggets/shared';
import { createNotificationRoutes } from '../notifications.js';
import { createNotificationLinkRoutes } from '../notificationLinks.js';
import { testTenantContext } from '../../test/tenantContext.js';
import { globalDb } from '../../db/withTenant.js';
import { NotificationRuleService } from '../../services/notifications/NotificationRuleService.js';

/**
 * The rules and preferences API in a tenant of its own: anyone in the tenant
 * reads the rules, only a tenant admin replaces them, everyone sets their own
 * preferences, and the email links work without a session.
 */
describe('Notification rules API', () => {
  const stamp = Date.now();
  let tenantId: number;
  let tenantUuid: string;
  let organizationId: number;
  let userId: number;
  let userUuid: string;
  let app: Express;

  // Stands in for resolveTenant: requireTenantAdmin reads req.tenant.
  const asMember = (isAdmin: boolean) => (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { tenant: unknown }).tenant = { id: tenantId, isAdmin };
    next();
  };

  beforeAll(async () => {
    const organization = await globalDb.insertInto('organizations').values({ name: `Rules org ${stamp}` }).returning('id').executeTakeFirstOrThrow();
    organizationId = organization.id;
    const tenant = await globalDb.insertInto('tenants').values({ name: `Rules ${stamp}`, organization_id: organizationId }).returning(['id', 'uuid']).executeTakeFirstOrThrow();
    tenantId = tenant.id;
    tenantUuid = tenant.uuid;
    const user = await globalDb.insertInto('users').values({ email: `rules-${stamp}@test.local`, password_hash: 'x' }).returning(['id', 'uuid']).executeTakeFirstOrThrow();
    userId = user.id;
    userUuid = user.uuid;
    await globalDb.insertInto('tenant_users').values({ tenant_id: tenantId, user_id: userId }).execute();

    const notifications = createNotificationRoutes({ notificationRuleService: new NotificationRuleService() });
    app = express();
    app.use(express.json());
    app.use('/member/notifications', testTenantContext({ userId, tenantId: tenant.id }), asMember(false), notifications);
    app.use('/admin/notifications', testTenantContext({ userId, tenantId: tenant.id }), asMember(true), notifications);
    app.use('/links', createNotificationLinkRoutes({ notificationRuleService: new NotificationRuleService(async () => 'a-test-secret-that-is-at-least-32-chars') }));
  });

  afterAll(async () => {
    await globalDb.deleteFrom('tenant_users').where('tenant_id', '=', tenantId).execute();
    await globalDb.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await globalDb.deleteFrom('organizations').where('id', '=', organizationId).execute();
    await globalDb.deleteFrom('users').where('id', '=', userId).execute();
  });

  it('gives any member the defaults until rules are saved', async () => {
    const res = await request(app).get('/member/notifications/rules').expect(200);
    expect(res.body).toEqual(defaultNotificationRules);
  });

  it('refuses a member who is not a tenant admin', async () => {
    await request(app).put('/member/notifications/rules').send(defaultNotificationRules).expect(403);
  });

  it('lets a tenant admin replace the rules', async () => {
    const rules = { rules: [{ ...defaultNotificationRules.rules[1], label: 'Overspent' }] };
    const res = await request(app).put('/admin/notifications/rules').send(rules).expect(200);
    expect(res.body).toEqual(rules);
    expect((await request(app).get('/member/notifications/rules')).body).toEqual(rules);
  });

  it('keeps a rule’s Send by, and reads a rule saved without one as both channels', async () => {
    const { sendBy: _omitted, ...withoutSendBy } = defaultNotificationRules.rules[1];
    const saved = await request(app).put('/admin/notifications/rules').send({ rules: [withoutSendBy] }).expect(200);
    expect(saved.body.rules[0].sendBy).toBe('both');

    const phoneOnly = await request(app)
      .put('/admin/notifications/rules')
      .send({ rules: [{ ...defaultNotificationRules.rules[1], label: 'Overspent', sendBy: 'push' }] })
      .expect(200);
    expect(phoneOnly.body.rules[0].sendBy).toBe('push');

    await request(app)
      .put('/admin/notifications/rules')
      .send({ rules: [{ ...defaultNotificationRules.rules[1], sendBy: 'fax' }] })
      .expect(400);
    await request(app).put('/admin/notifications/rules').send({ rules: [{ ...defaultNotificationRules.rules[1], label: 'Overspent' }] }).expect(200);
  });

  it('says what is wrong with a rule, and where', async () => {
    const res = await request(app)
      .put('/admin/notifications/rules')
      .send({ rules: [{ ...defaultNotificationRules.rules[1], when: { fact: 'over_budget', is: 'yes' } }] })
      .expect(400);
    // validateBody's answer: the first problem, and each with the field it names.
    expect(res.body).toMatchObject({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      message: '“over_budget” is true or false.',
      details: [{ field: 'rules.0.when', message: '“over_budget” is true or false.' }],
    });
  });

  it("sets the person's own channels, and refuses a rule the tenant doesn't have", async () => {
    const res = await request(app)
      .put('/member/notifications/preferences')
      .send({ rules: [{ rule: 'over_budget', push: false }] })
      .expect(200);
    expect(res.body.rules).toEqual([{ rule: 'over_budget', label: 'Overspent', kind: 'budget_item', sendBy: 'both', email: true, push: false }]);

    const refused = await request(app).put('/member/notifications/preferences').send({ rules: [{ rule: 'nope', email: false }] }).expect(400);
    expect(refused.body).toMatchObject({ code: 'BAD_REQUEST', message: 'There is no notification “nope”.' });
  });

  it('stops email from a link without a session, and asks first', async () => {
    const token = await new NotificationRuleService(async () => 'a-test-secret-that-is-at-least-32-chars')
      .unsubscribeToken(userUuid, tenantUuid, 'over_budget');

    expect((await request(app).post('/links/inspect').send({ token }).expect(200)).body).toEqual({ label: 'Overspent' });
    // Inspecting changed nothing.
    expect((await request(app).get('/member/notifications/preferences')).body.rules[0].email).toBe(true);

    await request(app).post('/links/unsubscribe').send({ token }).expect(200, { label: 'Overspent' });
    expect((await request(app).get('/member/notifications/preferences')).body.rules[0]).toMatchObject({ email: false, push: false });

    await request(app).post('/links/unsubscribe').send({ token: `${token}x` }).expect(404);
    await request(app).post('/links/unsubscribe').send({ token: 'short' }).expect(400);

    // Someone no longer in the ledger: the link stops working.
    await globalDb.deleteFrom('tenant_users').where('tenant_id', '=', tenantId).where('user_id', '=', userId).execute();
    await request(app).post('/links/inspect').send({ token }).expect(404);
  });

  it('refuses rules nested far deeper than eight before parsing them', async () => {
    // Built as text: JSON.stringify itself overflows the stack at this depth.
    const when = `${'{"not":'.repeat(5000)}{"fact":"over_budget","is":true}${'}'.repeat(5000)}`;
    const res = await request(app)
      .put('/admin/notifications/rules')
      .set('Content-Type', 'application/json')
      .send(`{"rules":[{"key":"deep","label":"Deep","enabled":true,"kind":"budget_item","when":${when}}]}`)
      .expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Nest conditions at most eight deep.' });
  });
});
