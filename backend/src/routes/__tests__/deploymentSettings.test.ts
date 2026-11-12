import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import pool from '../../db.js';
import { createImportRoutes } from '../import.js';
import { createNotificationAdminRoutes } from '../notifications.js';
import { requireDeploymentAdmin } from '../../middleware/tenant.js';
import { config } from '../../config.js';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import type { TenantRequest } from '../../middleware/tenant.js';
import { IMPORT_SETTING_KEYS, NOTIFICATION_SETTING_KEYS } from '@nuggets/shared';
import { ImportService } from '../../services/ImportService.js';

/**
 * Each settings route writes only its own keys: the import route used to upsert any
 * key it was sent, the SMTP host included. The notification settings are deployment-wide
 * (`system_settings`), so only a deployment admin may change them. The import settings are
 * the ledger's own (`tenant_settings`), set by its organization's admins.
 *
 * Who may call each route is also pinned by route-authorization.test.ts; this checks what
 * the routes write. system_settings is shared by every test file, so the rows touched here
 * are put back afterwards.
 */

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

// Every key a test here sends, including the ones it expects refused (a regression would
// write them), so afterAll can put each row back exactly as it was.
const TOUCHED = [
  ...IMPORT_SETTING_KEYS,
  ...NOTIFICATION_SETTING_KEYS,
  'backup_retention_days',
];

describe('Settings routes write only their own keys', () => {
  let tenant: TestTenant;
  let owner: Pool;
  let app: Express;
  let saved: Record<string, unknown>[] = [];

  const setting = async (key: string) =>
    (
      await owner.query<{ setting_value: string | null; category: string | null }>(
        'SELECT setting_value, category FROM system_settings WHERE setting_key = $1',
        [key]
      )
    ).rows[0];
  /** The ledger's own value (tenant_settings), as its RLS-scoped pool sees it. */
  const tenantSetting = async (key: string) =>
    (await tenant.pool.query<{ setting_value: string | null }>('SELECT setting_value FROM tenant_settings WHERE setting_key = $1', [key]))
      .rows[0]?.setting_value;

  const setDeploymentAdmin = async (isAdmin: boolean) => {
    if (isAdmin) {
      const res = await owner.query(
        `INSERT INTO deployment_users (user_id, deployment_id, role)
         SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`,
        [tenant.userId]
      );
      if (res.rowCount !== 1) throw new Error('No deployment row to make the user an admin of');
    } else {
      await owner.query('DELETE FROM deployment_users WHERE user_id = $1', [tenant.userId]);
    }
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Deployment settings');
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
    saved = (await owner.query('SELECT * FROM system_settings WHERE setting_key = ANY($1)', [TOUCHED])).rows;
    // An admin of the ledger's organization, as the org-admin routes require.
    await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true)', [
      tenant.organizationId,
      tenant.userId,
    ]);

    app = express();
    app.use(express.json());
    app.use(tenant.context());
    // What requireTenantMember sets for an admin of the ledger's organization, so the
    // org-admin case is the real one: the routes used to let exactly this caller in.
    app.use((req, _res, next) => {
      (req as TenantRequest).org = { id: tenant.organizationId, isAdmin: true };
      next();
    });
    app.use('/api/import', createImportRoutes({ lifecycleService: lifecycleStub, importService: new ImportService(pool) }));
    // Behind requireDeploymentAdmin, as routes.ts mounts it.
    app.use('/api/admin/notifications', requireDeploymentAdmin, createNotificationAdminRoutes({ lifecycleService: lifecycleStub, config: config() }));
  });

  afterAll(async () => {
    if (!owner) return; // createTestTenant failed and cleaned up after itself
    try {
      // Put every row back as it was, all columns included.
      await owner.query('DELETE FROM system_settings WHERE setting_key = ANY($1)', [TOUCHED]);
      for (const row of saved) {
        const columns = Object.keys(row);
        await owner.query(
          `INSERT INTO system_settings (${columns.map((c) => `"${c}"`).join(', ')})
           VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          columns.map((c) => row[c])
        );
      }
      await owner.query('DELETE FROM deployment_users WHERE user_id = $1', [tenant.userId]);
      await owner.query('DELETE FROM organization_users WHERE user_id = $1', [tenant.userId]);
      await tenant.cleanup();
    } finally {
      await owner.end();
    }
  });

  describe('as an organization admin who is not a deployment admin', () => {
    it("saves the ledger's import settings it is sent, and no deployment-wide row", async () => {
      const deploymentBefore = await Promise.all(IMPORT_SETTING_KEYS.map(setting));
      await request(app)
        .post('/api/import/settings')
        .send({ settings: { import_days_back: '45', import_sync_time: '03:15', import_user_id: String(tenant.userId) } })
        .expect(200);
      expect(await tenantSetting('import_days_back')).toBe('45');
      expect(await tenantSetting('import_sync_time')).toBe('03:15');
      expect(await tenantSetting('import_user_id')).toBe(String(tenant.userId));

      await request(app).post('/api/import/settings').send({ settings: { import_days_back: '', import_user_id: '' } }).expect(200);
      expect(await tenantSetting('import_days_back')).toBe('');
      expect(await tenantSetting('import_user_id')).toBe('');
      expect(await Promise.all(IMPORT_SETTING_KEYS.map(setting))).toEqual(deploymentBefore);
    });

    it("turns the ledger's automatic import on and off", async () => {
      await request(app).post('/api/import/scheduler/start').expect(200);
      expect(await tenantSetting('import_enabled')).toBe('true');
      await request(app).post('/api/import/scheduler/stop').expect(200);
      expect(await tenantSetting('import_enabled')).toBe('false');
    });

    it('rejects a key that is not an import setting, and writes nothing', async () => {
      const host = await setting('notification_smtp_host');
      const daysBack = await tenantSetting('import_days_back');
      const res = await request(app)
        .post('/api/import/settings')
        .send({ settings: { import_days_back: '12', notification_smtp_host: 'smtp.attacker.example' } })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(await setting('notification_smtp_host')).toEqual(host);
      expect(await tenantSetting('import_days_back')).toEqual(daysBack);
    });

    it.each([
      ['import_days_back', '0'],
      ['import_days_back', '181'],
      ['import_days_back', '30abc'],
      ['import_days_back', 30],
      ['import_sync_time', '25:00'],
      ['import_sync_time', '2am'],
      ['import_sync_frequency', 'hourly'],
      ['import_enabled', 'yes'],
      ['import_manual_sync_enabled', true],
      ['import_user_id', '0'],
      ['import_user_id', '1 OR 1=1'],
      ['import_user_id', '2147483648'],
      ['import_user_id', '99999999999999999999'],
    ])('rejects %s = %j', async (key, value) => {
      const before = await tenantSetting(key);
      await request(app).post('/api/import/settings').send({ settings: { [key]: value } }).expect(400);
      expect(await tenantSetting(key)).toEqual(before);
    });

    it('rejects an import user that does not exist, or has no access to the ledger', async () => {
      const before = await tenantSetting('import_user_id');
      await request(app).post('/api/import/settings').send({ settings: { import_user_id: '2147483000' } }).expect(400);
      const outsider = await owner.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Out', 'Sider') RETURNING id`,
        [`outsider-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`]
      );
      try {
        await request(app).post('/api/import/settings').send({ settings: { import_user_id: String(outsider.rows[0].id) } }).expect(400);
      } finally {
        await owner.query('DELETE FROM users WHERE id = $1', [outsider.rows[0].id]);
      }
      expect(await tenantSetting('import_user_id')).toEqual(before);
    });

    it('rejects a body without a settings object', async () => {
      await request(app).post('/api/import/settings').send({}).expect(400);
      await request(app).post('/api/import/settings').send({ settings: 'import_enabled=true' }).expect(400);
    });

    it('refuses to change the notification settings', async () => {
      const before = await setting('notification_email_from_name');
      const res = await request(app)
        .post('/api/admin/notifications/settings')
        .send({ settings: { notification_email_from_name: 'Org admin' } })
        .expect(403);
      expect(res.body.code).toBe('DEPLOYMENT_ADMIN_REQUIRED');
      expect(await setting('notification_email_from_name')).toEqual(before);
    });
  });

  describe('as a deployment admin', () => {
    beforeAll(() => setDeploymentAdmin(true));
    afterAll(() => setDeploymentAdmin(false));

    it('saves the notification settings it is sent', async () => {
      await request(app)
        .post('/api/admin/notifications/settings')
        .send({ settings: { notification_email_from_name: 'Isolation test sender' } })
        .expect(200);
      expect(await setting('notification_email_from_name')).toEqual({
        setting_value: 'Isolation test sender',
        category: 'notifications',
      });
    });

    it('rejects a key that is not a notification setting, and writes nothing', async () => {
      const retention = await setting('backup_retention_days');
      const name = await setting('notification_email_from_name');
      await request(app)
        .post('/api/admin/notifications/settings')
        .send({ settings: { notification_email_from_name: 'Changed', backup_retention_days: '-100000' } })
        .expect(400);
      expect(await setting('backup_retention_days')).toEqual(retention);
      expect(await setting('notification_email_from_name')).toEqual(name);
    });

    it.each([
      ['notification_smtp_port', '0'],
      ['notification_smtp_port', '70000'],
      ['notification_smtp_host', 'smtp.example.com:25'],
      ['notification_logo_url', 'javascript:alert(1)'],
      ['notification_email_from_address', 'not an address'],
      ['notification_system_enabled', 'on'],
      ['notification_email_from_name', 'Name\r\nBcc: attacker@example.com'],
      ['notification_email_from_address', 'a@b.example>, <attacker@example.com'],
      ['notification_email_from_address', 'a@b\u0000'],
      ['notification_email_from_address', 'nug\u001fgets@localhost'],
    ])('rejects %s = %j', async (key, value) => {
      const before = await setting(key);
      await request(app).post('/api/admin/notifications/settings').send({ settings: { [key]: value } }).expect(400);
      expect(await setting(key)).toEqual(before);
    });
  });
});
