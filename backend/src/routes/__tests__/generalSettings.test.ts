import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createSettingsRoutes, generalSettingsError } from '../settings.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import type { TenantRequest } from '../../middleware/tenant.js';

/**
 * General Settings: the ledger's own time zone (tenant_settings). The page saves
 * every setting at once, so a check on the zone could refuse the whole page for a zone
 * stored before the check; and a refused setting left the ones written before it saved.
 * Who may call the route is route-authorization.test.ts's, and keeping two ledgers
 * apart is settings-isolation.db.test.ts's; this checks what an admin's request does.
 */
describe('/api/settings/general', () => {
  let tenant: TestTenant;
  let app: Express;
  const owner = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

  const tenantZone = async () =>
    (
      await tenant.pool.query(`SELECT setting_value FROM tenant_settings WHERE setting_key = 'application_timezone'`)
    ).rows[0]?.setting_value ?? null;
  const deploymentZone = async () =>
    (await owner.query(`SELECT setting_value FROM system_settings WHERE setting_key = 'application_timezone'`)).rows[0]
      ?.setting_value ?? null;

  beforeAll(async () => {
    tenant = await createTestTenant('General settings');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use((req, _res, next) => {
      (req as TenantRequest).tenant = { id: tenant.tenantId, isAdmin: true };
      next();
    });
    app.use('/api/settings', createSettingsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await owner.end();
  });

  it("answers the deployment's zone while the ledger has none of its own", async () => {
    expect(await tenantZone()).toBeNull();
    const res = await request(app).get('/api/settings/general').expect(200);
    expect(res.body).toEqual([
      expect.objectContaining({ setting_key: 'application_timezone', setting_value: await deploymentZone() }),
      // The ledger's currency and locale, USD in en-US until it sets them (tenantMoneyFormat.db.test.ts).
      expect.objectContaining({ setting_key: 'application_currency', setting_value: 'USD' }),
      expect.objectContaining({ setting_key: 'application_locale', setting_value: 'en-US' }),
    ]);
  });

  it('writes nothing when one setting is refused', async () => {
    const res = await request(app)
      .post('/api/settings/general')
      .send({ settings: { application_timezone: 'Europe/Paris', not_a_setting: 'x' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await tenantZone()).toBeNull();
  });

  it("saves the ledger's zone, and leaves the deployment's alone", async () => {
    const before = await deploymentZone();
    await request(app).post('/api/settings/general').send({ settings: { application_timezone: 'Europe/Paris' } }).expect(200);
    expect(await tenantZone()).toBe('Europe/Paris');
    expect(await deploymentZone()).toBe(before);
    const res = await request(app).get('/api/settings/general').expect(200);
    expect(res.body[0].setting_value).toBe('Europe/Paris');
  });

  it('refuses a zone that is not one, and a value that is not a string', async () => {
    await request(app).post('/api/settings/general').send({ settings: { application_timezone: 'CET' } }).expect(400);
    await request(app).post('/api/settings/general').send({ settings: { application_timezone: 7 } }).expect(400);
    await request(app).post('/api/settings/general').send({ settings: 'application_timezone=UTC' }).expect(400);
    expect(await tenantZone()).toBe('Europe/Paris');
  });

  // The shape is checked by the shared schema: a body without a settings object.
  it('refuses a body without a settings object, naming the field', async () => {
    for (const body of [{}, { settings: ['application_timezone'] }, { settings: null }]) {
      const res = await request(app).post('/api/settings/general').send(body).expect(400);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Settings object is required',
        details: [{ field: 'settings', message: 'Settings object is required' }],
      });
    }
    expect(await tenantZone()).toBe('Europe/Paris');
  });

  it('saves the page with a stored zone the check would refuse now, unchanged', async () => {
    await tenant.pool.query(`UPDATE tenant_settings SET setting_value = 'CET' WHERE setting_key = 'application_timezone'`);
    await request(app).post('/api/settings/general').send({ settings: { application_timezone: 'CET' } }).expect(200);
    expect(await tenantZone()).toBe('CET');
  });

  it("doesn't refuse a stored zone the check would refuse now, only a change to one", async () => {
    const stored = new Map<string, string | null>([['application_timezone', 'CET']]);
    expect(await generalSettingsError([['application_timezone', 'CET']], stored)).toBeNull();
    expect(await generalSettingsError([['application_timezone', 'EST']], stored)).toMatch(/IANA time zone/);
    expect(await generalSettingsError([['application_timezone', 'Europe/Paris']], stored)).toBeNull();
    expect(await generalSettingsError([['not_a_setting', 'x']], stored)).toMatch(/does not exist/);
  });
});
