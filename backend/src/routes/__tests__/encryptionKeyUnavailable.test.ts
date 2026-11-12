import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Pool } from 'pg';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';

// No data_encryption_key secret mounted, whatever this machine has.
vi.mock('../../utils/data-encryption-secret.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/data-encryption-secret.js')>()),
  readDataEncryptionSecret: vi.fn(async () => {
    throw new Error('no data encryption secret found (looked in: /run/secrets/data_encryption_key)');
  }),
}));
vi.mock('../../services/OneDriveService.js', () => ({
  OneDriveService: class {
    isConfigured = async () => false;
  },
}));

import { createPushRoutes } from '../push.js';
import { createBackupRoutes } from '../backup.js';
import { routeDependencies } from '../dependencies.js';
import { BackupService } from '../../services/BackupService.js';
import { PushNotificationService } from '../../services/PushNotificationService.js';

/**
 * A deployment without the data_encryption_key secret: the routes that need it answer
 * 503 with a code and a plain reason, not a 500, and without the server's paths.
 */
describe('routes that need the data encryption key, without one', () => {
  let app: Express;
  let backupDir: string;
  const stored = { keys: null as { publicKey: string; encryptedPrivateKey: string } | null };

  beforeAll(async () => {
    backupDir = await mkdtemp(path.join(os.tmpdir(), 'no-encryption-key-'));
    vi.stubEnv('BACKUP_LOCATION', backupDir);
    // The stored VAPID keys, without a database.
    vi.spyOn(PushNotificationService.prototype as unknown as { readStoredKeys: () => Promise<unknown> }, 'readStoredKeys')
      .mockImplementation(async () => stored.keys);
    const pool = {
      query: async () => ({ rows: [{ setting_value: 'c3RvcmVkLWJhY2t1cC1rZXk=' }] }),
    } as unknown as Pool;
    app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { user: unknown }).user = { userId: 1, email: 'admin@test.local' };
      next();
    });
    app.use('/api/push', createPushRoutes({ pushService: new PushNotificationService() }));
    app.use('/api/backup', createBackupRoutes(routeDependencies({ lifecycleService: {} as ApplicationLifecycleService, backupService: new BackupService(pool) })));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(backupDir, { recursive: true, force: true });
  });

  const expectUnavailable = (res: request.Response) => {
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body.code).toBe('ENCRYPTION_KEY_UNAVAILABLE');
    expect(res.body.error).toMatch(/data_encryption_key/);
    expect(JSON.stringify(res.body)).not.toContain('/run/secrets');
  };

  it('GET /api/push/public-key answers 503 before any key pair exists', async () => {
    stored.keys = null;
    expectUnavailable(await request(app).get('/api/push/public-key'));
  });

  it('GET /api/push/public-key answers 503 when the stored private key cannot be read', async () => {
    stored.keys = { publicKey: 'BPublicKey', encryptedPrivateKey: 'c3RvcmVk' };
    expectUnavailable(await request(app).get('/api/push/public-key'));
  });

  it('GET /api/backup/key/download answers 503', async () => {
    expectUnavailable(await request(app).get('/api/backup/key/download'));
  });
});
