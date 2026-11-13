import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Pool } from 'pg';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';

vi.mock('../../services/OneDriveService.js', () => ({ OneDriveService: class { isConfigured = async () => false; } }));

import { createBackupRoutes } from '../backup.js';
import { routeDependencies } from '../dependencies.js';
import { BackupService } from '../../services/BackupService.js';
import { sessionService } from '../../middleware/auth.js';

/**
 * Step-up on the backup keys, with the real requireRecentReauth: adding or removing a backup
 * key, and downloading the old key, need a session that confirmed its password or passkey in
 * the last few minutes, checked before the body is read or the service is reached. A key of
 * someone's own would make every later backup readable to them. Marking a key checked adds
 * nothing, and needs no step-up. A personal access token gets none of them.
 */
describe('backup key routes and step-up', () => {
  let app: Express;
  let backupDir: string;
  const who = { patId: undefined as string | undefined };
  const uuid = '019a6f00-0000-7000-8000-000000000001';

  beforeAll(async () => {
    backupDir = await mkdtemp(path.join(os.tmpdir(), 'backup-step-up-'));
    vi.stubEnv('BACKUP_LOCATION', backupDir);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { userId: 1, email: 'admin@test.local' }, session: { id: 7 }, patId: who.patId });
      next();
    });
    const lifecycle = {
      getBackupSchedulerStatus: vi.fn(async () => ({ waitingForBackupKey: false, usingOldBackupKey: false })),
      updateBackupSchedulerConfiguration: vi.fn(async () => undefined),
    } as unknown as ApplicationLifecycleService;
    app.use('/api/backup', createBackupRoutes(routeDependencies({ lifecycleService: lifecycle, backupService: new BackupService({} as Pool) })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    who.patId = undefined;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(backupDir, { recursive: true, force: true });
  });

  const STEP_UP = ['POST /recipients', 'DELETE /recipients/:uuid', 'GET /key/download'];
  const stepUpRoutes = () => [
    request(app).post('/api/backup/recipients').send({ recipient: 'not even a key' }),
    request(app).delete(`/api/backup/recipients/${uuid}`),
    request(app).get('/api/backup/key/download'),
  ];

  it('refuses without a recent confirmation, before the body or the service', async () => {
    const recent = vi.spyOn(sessionService, 'isRecentlyReauthenticated').mockResolvedValue(false);
    const add = vi.spyOn(BackupService.prototype, 'addRecipient');
    const remove = vi.spyOn(BackupService.prototype, 'removeRecipient');
    const download = vi.spyOn(BackupService.prototype, 'getBackupKeyForDownload');
    for (const [i, res] of (await Promise.all(stepUpRoutes())).entries()) {
      expect(res.status, STEP_UP[i]).toBe(403);
      expect(res.body.code, STEP_UP[i]).toBe('REAUTH_REQUIRED');
    }
    expect(recent).toHaveBeenCalledTimes(3);
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('refuses a personal access token outright', async () => {
    who.patId = 'jti-of-a-token';
    for (const [i, res] of (await Promise.all(stepUpRoutes())).entries()) {
      expect(res.status, STEP_UP[i]).toBe(403);
      expect(res.body.code, STEP_UP[i]).toBe('INTERACTIVE_SESSION_REQUIRED');
    }
  });

  it('with a recent confirmation, validates the body, and marks a key checked with none', async () => {
    vi.spyOn(sessionService, 'isRecentlyReauthenticated').mockResolvedValue(true);
    const refused = await request(app).post('/api/backup/recipients').send({ recipient: 'not even a key', label: 'x' });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).not.toContain('not even a key');

    vi.spyOn(sessionService, 'isRecentlyReauthenticated').mockResolvedValue(false);
    const checked = vi.spyOn(BackupService.prototype, 'markRecipientChecked').mockResolvedValue({
      uuid,
      recipient: 'age1…',
      label: 'Spare',
      kind: 'post-quantum',
      hardware: false,
      fingerprint: 'abcd abcd abcd abcd',
      checkedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      createdBy: null,
    });
    await request(app).post(`/api/backup/recipients/${uuid}/checked`).expect(200);
    expect(checked).toHaveBeenCalledWith(uuid);
  });
});
