import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../utils/session-cookie-config.js';
import { csrfTokenFor } from '../utils/csrfToken.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * A ledger's settings are its own. Two ledgers in two organizations, through the
 * real app: what ledger B's people set (its time zone, its bank import schedule and import
 * user) must not change what ledger A reads, and the deployment-wide `system_settings`
 * rows must not move. These settings used to be single `system_settings` rows, so a
 * change made while acting in one ledger changed every ledger on the deployment.
 *
 * B's user administers ledger B and its organization; a deployment admin is checked too,
 * since the most a ledger-scoped write may reach is still its own ledger.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

// The deployment-wide rows these settings used to live in, compared before and after.
const DEPLOYMENT_KEYS = [
  'application_timezone',
  'import_enabled',
  'import_manual_sync_enabled',
  'import_sync_frequency',
  'import_sync_time',
  'import_days_back',
  'import_user_id',
];

describeDb('Ledger settings stay in their ledger', () => {
  let server: http.Server;
  let owner: Pool;
  let a: TestTenant;
  let b: TestTenant;
  const tokens: Record<'a' | 'b', string> = { a: '', b: '' };
  let deploymentBefore: unknown[] = [];

  const deploymentRows = async () =>
    (
      await owner.query(
        'SELECT setting_key, setting_value FROM system_settings WHERE setting_key = ANY($1) ORDER BY setting_key',
        [DEPLOYMENT_KEYS]
      )
    ).rows;

  function send(who: 'a' | 'b', method: 'get' | 'post', url: string, body?: object) {
    const req = request(server)[method](url)
      .set('Cookie', `${SESSION_COOKIE_NAME}=${tokens[who]}; csrf_token=x`)
      .set('X-CSRF-Token', csrfTokenFor(tokens[who]))
      .timeout(15_000);
    return body ? req.send(body) : req;
  }

  const zoneOf = async (who: 'a' | 'b') => {
    const res = await send(who, 'get', '/api/settings/general').expect(200);
    return (res.body as Array<{ setting_key: string; setting_value: string }>).find(
      (s) => s.setting_key === 'application_timezone'
    )?.setting_value;
  };
  const importSettingsOf = async (who: 'a' | 'b') => {
    const res = await send(who, 'get', '/api/import/settings').expect(200);
    const settings = res.body.settings as Record<string, { value: string | null }>;
    return Object.fromEntries(Object.entries(settings).map(([key, s]) => [key, s.value]));
  };

  beforeAll(async () => {
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    owner = new Pool({ connectionString, max: 2 });
    a = await createTestTenant('Settings A');
    b = await createTestTenant('Settings B');
    for (const [key, tenant] of [['a', a], ['b', b]] as const) {
      await owner.query('UPDATE tenant_users SET is_admin = true WHERE tenant_id = $1 AND user_id = $2', [
        tenant.tenantId,
        tenant.userId,
      ]);
      await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true)', [
        tenant.organizationId,
        tenant.userId,
      ]);
      const { token, sessionId } = await sessionService.createSession({ userId: tenant.userId });
      await owner.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenant.tenantId, sessionId]);
      tokens[key] = token;
    }
    deploymentBefore = await deploymentRows();

    // A's own settings, set by A's admin: what B's writes below must leave alone.
    await send('a', 'post', '/api/settings/general', { settings: { application_timezone: 'America/Chicago' } }).expect(200);
    await send('a', 'post', '/api/import/settings', {
      settings: { import_days_back: '30', import_sync_time: '01:15', import_enabled: 'false', import_user_id: String(a.userId) },
    }).expect(200);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!owner) return;
    try {
      const userIds = [a?.userId, b?.userId].filter((id) => id != null);
      await owner.query('DELETE FROM deployment_users WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM organization_users WHERE user_id = ANY($1)', [userIds]);
      const settled = await Promise.allSettled([a?.cleanup(), b?.cleanup()]);
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      await owner.end();
    }
  }, 60_000);

  it("B's time zone is B's alone: A's answers, and A's day in SQL, keep A's zone", async () => {
    await send('b', 'post', '/api/settings/general', { settings: { application_timezone: 'Asia/Tokyo' } }).expect(200);

    expect(await zoneOf('b')).toBe('Asia/Tokyo');
    expect(await zoneOf('a')).toBe('America/Chicago');
    // app_timezone(), which app_today() and every "today" in SQL read, in each ledger.
    expect((await a.pool.query('SELECT app_timezone() AS zone')).rows[0].zone).toBe('America/Chicago');
    expect((await b.pool.query('SELECT app_timezone() AS zone')).rows[0].zone).toBe('Asia/Tokyo');
  });

  it("B's import settings are B's alone", async () => {
    await send('b', 'post', '/api/import/settings', {
      settings: { import_days_back: '90', import_sync_time: '04:45', import_enabled: 'true', import_user_id: String(b.userId) },
    }).expect(200);

    expect(await importSettingsOf('b')).toMatchObject({
      import_days_back: '90',
      import_sync_time: '04:45',
      import_enabled: 'true',
      import_user_id: String(b.userId),
    });
    expect(await importSettingsOf('a')).toMatchObject({
      import_days_back: '30',
      import_sync_time: '01:15',
      import_enabled: 'false',
      import_user_id: String(a.userId),
    });
  });

  it("refuses A's user as B's import user: imports are stamped with someone who has access to the ledger", async () => {
    const res = await send('b', 'post', '/api/import/settings', { settings: { import_user_id: String(a.userId) } }).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect((await importSettingsOf('b')).import_user_id).toBe(String(b.userId));
  });

  it("lists only people with access to B's ledger to pick the import user from", async () => {
    const res = await send('b', 'get', '/api/import/users').expect(200);
    const ids = (res.body.users as Array<{ id: number }>).map((u) => u.id);
    expect(ids).toContain(b.userId);
    expect(ids).not.toContain(a.userId);
    expect(JSON.stringify(res.body)).not.toContain(a.userEmail);
  });

  it("B turning its automatic import off and on doesn't touch A's", async () => {
    await send('a', 'post', '/api/import/settings', { settings: { import_enabled: 'true' } }).expect(200);
    await send('b', 'post', '/api/import/scheduler/stop').expect(200);
    expect((await importSettingsOf('b')).import_enabled).toBe('false');
    expect((await importSettingsOf('a')).import_enabled).toBe('true');

    await send('a', 'post', '/api/import/settings', { settings: { import_enabled: 'false' } }).expect(200);
    await send('b', 'post', '/api/import/scheduler/start').expect(200);
    expect((await importSettingsOf('b')).import_enabled).toBe('true');
    expect((await importSettingsOf('a')).import_enabled).toBe('false');
  });

  it("each ledger's import status reports its own schedule, with automatic import off and on", async () => {
    const res = await send('a', 'get', '/api/import/status').expect(200);
    expect(res.body.settings.import_sync_time).toBe('01:15');
    expect(res.body.scheduler.enabled).toBe(false);
    // On: this route runs with no transaction open, so the schedule is read in one of its own.
    const on = await send('b', 'get', '/api/import/status').expect(200);
    expect(on.body.settings.import_sync_time).toBe('04:45');
    expect(on.body.scheduler.enabled).toBe(true);
  });

  it('a deployment admin acting in ledger B still changes only ledger B', async () => {
    await owner.query(
      `INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`,
      [b.userId]
    );
    try {
      await send('b', 'post', '/api/settings/general', { settings: { application_timezone: 'Europe/Paris' } }).expect(200);
      await send('b', 'post', '/api/import/settings', { settings: { import_days_back: '7' } }).expect(200);
      expect(await zoneOf('b')).toBe('Europe/Paris');
      expect(await zoneOf('a')).toBe('America/Chicago');
      expect((await importSettingsOf('a')).import_days_back).toBe('30');
    } finally {
      await owner.query('DELETE FROM deployment_users WHERE user_id = $1', [b.userId]);
    }
  });

  it("refuses a ledger member who isn't an admin", async () => {
    await owner.query('UPDATE tenant_users SET is_admin = false WHERE tenant_id = $1 AND user_id = $2', [b.tenantId, b.userId]);
    await owner.query('UPDATE organization_users SET is_admin = false WHERE organization_id = $1 AND user_id = $2', [
      b.organizationId,
      b.userId,
    ]);
    try {
      await send('b', 'post', '/api/settings/general', { settings: { application_timezone: 'Asia/Kolkata' } }).expect(403);
      await send('b', 'post', '/api/import/settings', { settings: { import_days_back: '9' } }).expect(403);
      // Reading stays open to members.
      expect(await zoneOf('b')).toBe('Europe/Paris');
    } finally {
      await owner.query('UPDATE tenant_users SET is_admin = true WHERE tenant_id = $1 AND user_id = $2', [b.tenantId, b.userId]);
      await owner.query('UPDATE organization_users SET is_admin = true WHERE organization_id = $1 AND user_id = $2', [
        b.organizationId,
        b.userId,
      ]);
    }
  });

  it('left the deployment-wide settings as they were', async () => {
    expect(await deploymentRows()).toEqual(deploymentBefore);
  });
});
