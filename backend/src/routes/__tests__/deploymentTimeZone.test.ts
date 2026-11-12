import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { Pool } from 'pg';
import { answerProblem, deploymentSettingsResponseSchema, deploymentSettingsSavedResponseSchema } from '@nuggets/shared';
import { withTenant } from '../../db/withTenant.js';
import { createDeploymentSettingsRoutes } from '../deploymentSettings.js';
import { readSystemSetting } from '../../services/systemSettings.js';
import { clampTenantsOnDeploymentZone } from '../../services/goalDayRanges.js';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The deployment's time zone, set by its admins: GET and PUT
 * /api/admin/deployment-settings, one allowlisted key, application_timezone, checked with
 * isAppTimeZone; a change re-arms the backup schedule, which runs in that zone. Who may
 * call them (deployment admins only, no token) is route-authorization.test.ts's.
 *
 * system_settings is shared by every test file, and its zone is every ledger's without
 * one of its own: each request here runs in a transaction that is rolled back once it
 * has answered, so no other file sees a change. The answer reads the row back in it.
 *
 * Every save clamps the goal ranges of each ledger that follows the zone,
 * each in a transaction of its own, and says how many it couldn't: here that is mocked
 * (goalDayRangesDeploymentZone.db.test.ts has what it does), or it would visit every other
 * file's ledgers and not see the uncommitted zone.
 */

const clamped = vi.hoisted(() => ({ zones: [] as Array<string | null> }));
vi.mock('../../services/goalDayRanges.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/goalDayRanges.js')>()),
  // The zone as stored when it runs: it runs once the zone is written.
  clampTenantsOnDeploymentZone: vi.fn(async () => {
    clamped.zones.push((await readSystemSetting('application_timezone')) ?? null);
    return { total: 3, failed: 0 };
  }),
}));

class Rollback extends Error {}

describe('/api/admin/deployment-settings', () => {
  let tenant: TestTenant;
  let owner: Pool;
  let app: Express;
  const lifecycle = { updateBackupSchedulerConfiguration: vi.fn(async () => undefined) };

  const storedZone = async () =>
    (await owner.query<{ setting_value: string | null }>(`SELECT setting_value FROM system_settings WHERE setting_key = 'application_timezone'`))
      .rows[0]?.setting_value ?? null;

  beforeAll(async () => {
    tenant = await createTestTenant('Deployment time zone');
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 1 });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user: unknown }).user = { userId: tenant.userId, email: 'admin@test.local' };
      next();
    });
    // The request in a transaction of its own, rolled back once it has answered.
    app.use((_req, res, next) => {
      void withTenant(tenant.tenantId, () =>
        new Promise<never>((_resolve, reject) => {
          res.once('finish', () => reject(new Rollback()));
          res.once('close', () => reject(new Rollback()));
          next();
        })
      ).catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
    });
    app.use('/api/admin/deployment-settings', createDeploymentSettingsRoutes({ lifecycleService: lifecycle as unknown as ApplicationLifecycleService }));
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await owner?.end();
  });

  beforeEach(() => {
    lifecycle.updateBackupSchedulerConfiguration.mockClear();
    vi.mocked(clampTenantsOnDeploymentZone).mockClear();
    clamped.zones.length = 0;
  });

  it("answers the deployment's zone", async () => {
    const res = await request(app).get('/api/admin/deployment-settings').expect(200);
    expect(res.body).toEqual({ settings: { application_timezone: (await storedZone()) ?? 'UTC' } });
    expect(answerProblem(deploymentSettingsResponseSchema, res.body)).toBeNull();
  });

  it('sets it, answers what is stored, and arms the backup schedule again in it', async () => {
    const before = await storedZone();
    const zone = before === 'Pacific/Auckland' ? 'America/Chicago' : 'Pacific/Auckland';
    const res = await request(app).put('/api/admin/deployment-settings').send({ settings: { application_timezone: zone } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ success: true, settings: { application_timezone: zone } });
    expect(answerProblem(deploymentSettingsSavedResponseSchema, res.body)).toBeNull();
    expect(lifecycle.updateBackupSchedulerConfiguration).toHaveBeenCalledTimes(1);
    // The ledgers that follow it were clamped, once the zone was written.
    expect(clamped.zones).toEqual([zone]);
    // Rolled back: no other test file saw it.
    await vi.waitFor(async () => expect(await storedZone()).toBe(before));
  });

  // Saving the zone again retries the ledgers a save couldn't clamp.
  it("clamps the ledgers' goal ranges when the zone is saved as it is, too", async () => {
    const stored = (await storedZone()) ?? 'UTC';
    const res = await request(app).put('/api/admin/deployment-settings').send({ settings: { application_timezone: stored } }).expect(200);
    expect(clamped.zones).toEqual([stored]);
    expect(res.body).toEqual({ success: true, settings: { application_timezone: stored } });
  });

  it("says how many ledgers it couldn't clamp, the zone written", async () => {
    const before = await storedZone();
    const zone = before === 'Pacific/Auckland' ? 'America/Chicago' : 'Pacific/Auckland';
    vi.mocked(clampTenantsOnDeploymentZone).mockResolvedValueOnce({ total: 3, failed: 2 });
    const res = await request(app).put('/api/admin/deployment-settings').send({ settings: { application_timezone: zone } }).expect(200);
    expect(res.body).toEqual({
      success: true,
      settings: { application_timezone: zone },
      tenants_not_clamped: 2,
      notice: "2 tenants' goal history could not be moved to the new time zone; save the time zone again to retry.",
    });
    expect(answerProblem(deploymentSettingsSavedResponseSchema, res.body)).toBeNull();
  });

  it.each([
    ['a name no zone has', 'Mars/Olympus_Mons'],
    ['an offset', '+05:00'],
    ['an abbreviation Postgres reads as a fixed offset', 'EST'],
    ['an empty name', ''],
  ])('refuses %s, writing nothing', async (_what, zone) => {
    const before = await storedZone();
    const res = await request(app).put('/api/admin/deployment-settings').send({ settings: { application_timezone: zone } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      error: 'application_timezone must be an IANA time zone such as America/New_York',
    });
    expect(lifecycle.updateBackupSchedulerConfiguration).not.toHaveBeenCalled();
    expect(clampTenantsOnDeploymentZone).not.toHaveBeenCalled();
    expect(await storedZone()).toBe(before);
  });

  it('refuses any other key, alone or beside the zone, and a body without settings', async () => {
    for (const settings of [{ smtp_host: 'mail.example.com' }, { application_timezone: 'Europe/Paris', backup_time: '01:00' }]) {
      const res = await request(app).put('/api/admin/deployment-settings').send({ settings });
      expect(res.status, JSON.stringify(settings)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      // validateBody's answer: the reason in `message` and in its field's detail.
      expect(res.body.message).toMatch(/^Setting '(smtp_host|backup_time)' is not a deployment setting$/);
      expect(res.body.details?.[0]?.field).toBe('settings');
    }
    const missing = await request(app).put('/api/admin/deployment-settings').send({});
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Settings object is required' });
    expect(lifecycle.updateBackupSchedulerConfiguration).not.toHaveBeenCalled();
  });

  it('answers an empty change with the settings as they are', async () => {
    const res = await request(app).put('/api/admin/deployment-settings').send({ settings: {} }).expect(200);
    expect(res.body).toEqual({ success: true, settings: { application_timezone: (await storedZone()) ?? 'UTC' } });
    expect(lifecycle.updateBackupSchedulerConfiguration).not.toHaveBeenCalled();
  });
});
