import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../utils/session-cookie-config.js';
import { csrfTokenFor } from '../utils/csrfToken.js';
import { png } from '../test/imageFixtures.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import type { BackupService } from '../services/BackupService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * A NUL character in the multipart bodies only a deployment admin sends (nulText.db.test.ts left them
 * untested): the admin's user edit (a profile picture and the names) and an uploaded backup's
 * restore (the file and its key). Postgres can't store a NUL in text, so a name with one was a
 * 500; a key with one went on to the restore. Each is 400 VALIDATION_ERROR naming the field,
 * and the uploaded file is gone.
 *
 * The backup service is a stand-in: nothing here may restore the test database. It records a
 * restore it was asked for and refuses it.
 */

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

const RUN = `admin-nul-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('A NUL character in a deployment admin\'s multipart body', () => {
  let owner: Pool;
  let tenant: TestTenant;
  let server: http.Server;
  let admin: { id: number; uuid: string; token: string };
  let member: { id: number; uuid: string };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuggets-admin-nul-'));
  const restores: string[] = [];
  const backupStub = new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'getTempDir') return () => tempDir;
      if (prop === 'restoreFromFile') {
        return async (filePath: string) => {
          restores.push(filePath);
          throw new Error('test stand-in: no restore');
        };
      }
      return async () => undefined;
    },
  }) as unknown as BackupService;

  const uploads = () => (fs.existsSync(path.join(tempDir, 'uploads')) ? fs.readdirSync(path.join(tempDir, 'uploads')) : []);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= 'admin-nul-test-encryption-key-0123456789abcdef';
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub, backupService: backupStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
    tenant = await createTestTenant('Admin multipart NUL');
    const addUser = async (label: string) => {
      const row = (await owner.query<{ id: number; uuid: string }>(
        `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, $2, 'Test', $3) RETURNING id, uuid`,
        [`${RUN}-${label}@test.local`, bcrypt.hashSync('a passphrase for this test', 4), label]
      )).rows[0]!;
      await owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [tenant.tenantId, row.id]);
      await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, false)', [tenant.organizationId, row.id]);
      return row;
    };
    const adminRow = await addUser('admin');
    await owner.query(
      `INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`,
      [adminRow.id]
    );
    const { token, sessionId } = await sessionService.createSession({ userId: adminRow.id });
    await owner.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenant.tenantId, sessionId]);
    admin = { ...adminRow, token };
    member = await addUser('member');
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (!owner) return;
    try {
      await owner.query(`DELETE FROM deployment_users WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${RUN}%`]);
      await owner.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${RUN}%`]);
      await owner.query(`DELETE FROM organization_users WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${RUN}%`]);
      await owner.query(`DELETE FROM tenant_users WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${RUN}%`]);
      await owner.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
      await tenant?.cleanup();
    } finally {
      await owner.end();
    }
  }, 60_000);

  const asAdmin = (req: request.Test) =>
    req.set('Cookie', `${SESSION_COOKIE_NAME}=${admin.token}`).set('X-CSRF-Token', csrfTokenFor(admin.token));
  const refusal = (res: request.Response) => ({ status: res.status, code: res.body.code, field: res.body.details?.[0]?.field });

  it("refuses a user's name with a NUL in the admin's edit, sent with a picture, and saves it without", async () => {
    const bad = await asAdmin(request(server).put(`/api/admin/users/${member.uuid}`))
      .attach('profile_image', png(), 'face.png')
      .field('first_name', 'Dee\u0000')
      .field('last_name', 'Member');
    expect(refusal(bad), JSON.stringify(bad.body)).toEqual({ status: 400, code: 'VALIDATION_ERROR', field: 'first_name' });
    const stored = await owner.query('SELECT first_name FROM users WHERE id = $1', [member.id]);
    expect(stored.rows[0].first_name).toBe('Test');

    const good = await asAdmin(request(server).put(`/api/admin/users/${member.uuid}`)).field('first_name', 'Dee').field('last_name', 'Member');
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    expect((await owner.query('SELECT first_name FROM users WHERE id = $1', [member.id])).rows[0].first_name).toBe('Dee');
  });

  it("refuses a NUL in the picture's file name or a part's field name in the admin's edit", async () => {
    const answers = [
      await asAdmin(request(server).put(`/api/admin/users/${member.uuid}`)).attach('profile_image', png(), 'fa\u0000ce.png'),
      await asAdmin(request(server).put(`/api/admin/users/${member.uuid}`)).field('first\u0000name', 'x'),
    ];
    expect(answers.map((res) => [res.status, res.body.code])).toEqual([[400, 'VALIDATION_ERROR'], [400, 'VALIDATION_ERROR']]);
  });

  it("refuses an uploaded backup's key with a NUL: no restore starts, and the upload is gone", async () => {
    const res = await asAdmin(request(server).post('/api/backup/restore'))
      .attach('backup', Buffer.from('not really a backup'), 'nuggets_backup.zip.enc')
      .field('encryptionKey', 'key\u0000with a NUL');
    expect(refusal(res), JSON.stringify(res.body)).toEqual({ status: 400, code: 'VALIDATION_ERROR', field: 'encryptionKey' });
    // Give a restore that was started (before the fix) its turn to call the backup service.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(restores).toEqual([]);
    expect(uploads()).toEqual([]);
  });

  it("refuses a NUL in an uploaded backup's file name: no restore starts, and the upload is gone", async () => {
    const res = await asAdmin(request(server).post('/api/backup/restore'))
      .field('encryptionKey', 'a key')
      .attach('backup', Buffer.from('not really a backup'), 'nuggets_back\u0000up.zip.enc');
    expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([400, 'VALIDATION_ERROR']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(restores).toEqual([]);
    expect(uploads()).toEqual([]);
  });
});
