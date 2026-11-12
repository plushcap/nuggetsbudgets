import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Pool } from 'pg';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import type { DB } from '../db/schema.generated.js';
import { config } from '../config.js';

// No data_encryption_key secret mounted, whatever this machine has.
vi.mock('../utils/data-encryption-secret.js', async (importOriginal) => {
  const missing = () => new Error('no data encryption secret found (looked in: /run/secrets/data_encryption_key)');
  return {
    ...(await importOriginal<typeof import('../utils/data-encryption-secret.js')>()),
    readDataEncryptionSecret: vi.fn(async () => {
      throw missing();
    }),
    readDataEncryptionSecretSync: vi.fn(() => {
      throw missing();
    }),
  };
});
// A signed-in deployment admin, without a database.
vi.mock('../middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth.js')>()),
  authenticateToken: (req: express.Request & { user?: unknown }, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 7, email: 'admin@test.local' };
    next();
  },
}));
vi.mock('../middleware/tenant.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/tenant.js')>()),
  requireDeploymentAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

/**
 * A server without the data_encryption_key secret starts and serves, with backups, bank
 * sync and OneDrive unavailable (productionConfig.ts logs it): those answer 503
 * ENCRYPTION_KEY_UNAVAILABLE when used. OneDriveService read the key in its
 * constructor, which the backup routes run at startup, so the server didn't start at all.
 */
describe('a server without a data encryption key', () => {
  const env = { ...process.env };
  let dir: string;

  beforeAll(async () => {
    // Nor the development fallback.
    delete process.env.ENCRYPTION_KEY;
    dir = await mkdtemp(path.join(os.tmpdir(), 'no-data-key-'));
    process.env.BACKUP_LOCATION = dir;
    process.env.ONEDRIVE_CLIENT_ID = 'client-id';
    process.env.ONEDRIVE_CLIENT_SECRET = 'client-secret';
  });

  afterAll(async () => {
    process.env = { ...env };
    await rm(dir, { recursive: true, force: true });
  });

  it('mounts every route', async () => {
    const { createApp } = await import('../app.js');
    const { mountRoutes } = await import('../routes.js');
    const lifecycleService = new Proxy({}, { get: () => async () => undefined }) as unknown as ApplicationLifecycleService;
    expect(() => mountRoutes(createApp(), { lifecycleService })).not.toThrow();
  });

  it('answers the OneDrive routes that need the key 503 ENCRYPTION_KEY_UNAVAILABLE', async () => {
    const { createOneDriveRoutes } = await import('../routes/onedrive.js');
    const { authenticateToken } = await import('../middleware/auth.js');
    const { OneDriveService } = await import('../services/OneDriveService.js');
    const { BackupService } = await import('../services/BackupService.js');
    // A connected OneDrive (its tokens are sealed: reading them needs the key).
    const pool = {
      connect: async () => ({
        query: async (text: string) => {
          const rows = /onedrive_tokens/.test(text)
            ? [{ access_token: 'c2VhbGVk', refresh_token: 'c2VhbGVk', expires_at: new Date(Date.now() + 3_600_000) }]
            : [];
          return { command: 'SELECT', rowCount: rows.length, rows };
        },
        release: () => {},
      }),
    } as unknown as Pool;
    const fileName = 'nuggets_backup_20261101_030000_000.enc';
    await writeFile(path.join(dir, fileName), 'backup');
    const app = express();
    app.use(express.json());
    // As routes.ts mounts it, behind the (mocked) sign-in.
    const { Kysely, PostgresDialect } = await import('kysely');
    const oneDriveService = new OneDriveService({ db: new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }) });
    app.use('/api/onedrive', authenticateToken, createOneDriveRoutes({ oneDriveService, backupService: new BackupService(pool), config: config() }));

    const unavailable = (res: request.Response) => {
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body).toMatchObject({ code: 'ENCRYPTION_KEY_UNAVAILABLE', error: expect.stringMatching(/data_encryption_key/) });
      expect(JSON.stringify(res.body)).not.toContain('/run/secrets');
    };
    // Connecting (before anyone is sent to Microsoft), uploading a backup, the test upload.
    unavailable(await request(app).get('/api/onedrive/auth'));
    unavailable(await request(app).post('/api/onedrive/upload').send({ fileName }));
    unavailable(await request(app).post('/api/onedrive/test-upload'));
    // What doesn't need the key still answers.
    expect((await request(app).get('/api/onedrive/config')).status).toBe(200);
  });
});
