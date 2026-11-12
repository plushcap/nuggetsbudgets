import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { existsSync } from 'fs';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';

const { assertServingRoleEnforcesRls, restoreFromFile, findBackup, shutdown } = vi.hoisted(() => ({
  assertServingRoleEnforcesRls: vi.fn(),
  restoreFromFile: vi.fn(),
  findBackup: vi.fn(),
  /** Whether BackupService.refuseNewOperations has been called (a shutdown has begun). */
  shutdown: { begun: false },
}));
vi.mock('../../db/servingRole.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/servingRole.js')>()),
  assertServingRoleEnforcesRls,
}));
vi.mock('../../services/BackupService.js', async (importOriginal) => {
  const { tmpdir } = await import('os');
  return {
    ...(await importOriginal<typeof import('../../services/BackupService.js')>()),
    BackupService: class {
      static isBackupInProgress = () => false;
      static isRestoreInProgress = () => false;
      static isRefusingNewOperations = () => shutdown.begun;
      restoreFromFile = restoreFromFile;
      findBackup = findBackup;
      getTempDir = () => tmpdir();
    },
  };
});
vi.mock('../../services/OneDriveService.js', () => ({ OneDriveService: class {} }));

import { createBackupRoutes } from '../backup.js';
import { routeDependencies } from '../dependencies.js';
import appPool from '../../db.js';
import { restoreMaintenanceGate } from '../../middleware/restoreMaintenance.js';
import { restoreJobSettled } from '../../services/restoreJob.js';
import { RlsBypassRoleError } from '../../db/servingRole.js';
import { BackupService, RestoreFailedError, RestoreRefusedError, ShuttingDownError } from '../../services/BackupService.js';

/**
 * A restore through the app runs in the background: POST answers 202, the page polls
 * GET /restore-status, the schedulers stop meanwhile, and everything that would change data
 * gets a 503. Once the data has changed the serving role check runs again, and a
 * failure shuts the server down.
 */
describe('restoring a backup through the app', () => {
  let app: Express;
  const schedulers = { pauseSchedulersForRestore: vi.fn(async () => {}), resumeSchedulersAfterRestore: vi.fn(async () => {}) };
  const done = { manifest: null, signature: 'valid', rowCounts: { tenants: 1 }, previousDatabase: 'db_before_restore', previousUploads: '/x', uploadedFilesRestored: 0 };

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user: unknown }).user = { userId: 1, email: 'admin@test.local' };
      next();
    });
    app.use('/api', restoreMaintenanceGate);
    app.post('/api/tags', (_req, res) => {
      res.status(201).json({});
    });
    const lifecycleService = schedulers as unknown as ApplicationLifecycleService;
    app.use('/api/backup', createBackupRoutes(routeDependencies({ lifecycleService, backupService: new BackupService(appPool) })));
  });

  afterEach(async () => {
    await restoreJobSettled();
    vi.restoreAllMocks();
    assertServingRoleEnforcesRls.mockReset();
    restoreFromFile.mockReset();
    findBackup.mockReset();
    schedulers.pauseSchedulersForRestore.mockClear();
    schedulers.resumeSchedulersAfterRestore.mockClear();
    shutdown.begun = false;
  });

  const upload = () => request(app).post('/api/backup/restore').attach('backup', Buffer.from('not a real backup'), 'probe.enc');
  const status = async () => (await request(app).get('/api/backup/restore-status').expect(200)).body;

  it('answers 202 at once, and reports the outcome', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    restoreFromFile.mockResolvedValue(done);
    assertServingRoleEnforcesRls.mockResolvedValue(undefined);
    expect((await upload().expect(202)).body).toEqual({ success: true, started: true, message: 'Restore started' });
    await restoreJobSettled();
    expect(await status()).toMatchObject({ status: 'completed', fileName: 'probe.enc', databaseChanged: true, previousDatabase: 'db_before_restore' });
    expect(restoreFromFile).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ key: null }));
    // The uploaded file is gone afterwards.
    expect(existsSync(restoreFromFile.mock.calls[0][0])).toBe(false);
    // On the server's own pool: the router has none.
    expect(assertServingRoleEnforcesRls).toHaveBeenCalledWith(appPool);
    expect(schedulers.pauseSchedulersForRestore).toHaveBeenCalledOnce();
    expect(schedulers.resumeSchedulersAfterRestore).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses changes, and a second restore, while one runs; reads still work', async () => {
    let finish!: (value: typeof done) => void;
    restoreFromFile.mockImplementation(
      (_file: string, options: { onPhase: (phase: string) => void }) =>
        new Promise((resolve) => {
          options.onPhase('migrating');
          finish = resolve;
        })
    );
    assertServingRoleEnforcesRls.mockResolvedValue(undefined);
    await upload().expect(202);
    await vi.waitFor(() => expect(restoreFromFile).toHaveBeenCalled());

    expect(await status()).toMatchObject({ status: 'running', phase: 'migrating', fileName: 'probe.enc' });
    const refused = await request(app).post('/api/tags').send({ name: 'x' }).expect(503);
    expect(refused.body).toMatchObject({ code: 'RESTORE_IN_PROGRESS' });
    expect(refused.headers['retry-after']).toBe('30');
    await upload().expect(503);
    await request(app).post('/api/backup/create').expect(503);

    finish(done);
    await restoreJobSettled();
    await request(app).post('/api/tags').send({ name: 'x' }).expect(201);
  });

  it('restores a backup from the server by its name, with the typed key', async () => {
    findBackup.mockImplementation(async (name: string) => (name === 'nuggets_backup_20261101_030000_000.enc' ? { fileName: name, filePath: `/backups/${name}` } : null));
    restoreFromFile.mockResolvedValue(done);
    assertServingRoleEnforcesRls.mockResolvedValue(undefined);
    await request(app).post('/api/backup/restore/nope.enc').send({}).expect(404);
    await request(app).post('/api/backup/restore/nuggets_backup_20261101_030000_000.enc').send({ encryptionKey: ' typed-key ' }).expect(202);
    await restoreJobSettled();
    expect(restoreFromFile).toHaveBeenCalledWith('/backups/nuggets_backup_20261101_030000_000.enc', expect.objectContaining({ key: 'typed-key' }));
    await request(app).post('/api/backup/restore/x.enc').send({ encryptionKey: 42 }).expect(400);
  });

  it('shows a refusal the person can act on, and leaves the check out when nothing changed', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    restoreFromFile.mockRejectedValueOnce(
      new RestoreFailedError('Restore failed: newer', false, { cause: new RestoreRefusedError('Backup schema version 9 is NEWER than this application') })
    );
    // A check that can't run right now mustn't stop the server when nothing changed.
    assertServingRoleEnforcesRls.mockRejectedValue(new Error('Connection terminated unexpectedly'));
    await upload().expect(202);
    await restoreJobSettled();
    expect(await status()).toMatchObject({ status: 'failed', databaseChanged: false, error: 'Backup schema version 9 is NEWER than this application' });
    expect(assertServingRoleEnforcesRls).not.toHaveBeenCalled();
    expect(schedulers.resumeSchedulersAfterRestore).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();

    // Other failures don't show their internals.
    restoreFromFile.mockRejectedValueOnce(new RestoreFailedError('Restore failed: pg_restore: error: …', false, { cause: new Error('pg_restore: error: …') }));
    await upload().expect(202);
    await restoreJobSettled();
    expect((await status()).error).toBe('The restore failed and nothing was changed; see the server log for why');
  });

  it('checks again once the data has changed, and shuts down when it fails', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    restoreFromFile.mockResolvedValue(done);
    assertServingRoleEnforcesRls.mockRejectedValue(new RlsBypassRoleError('only works with one tenant'));
    await upload().expect(202);
    await restoreJobSettled();
    expect(await status()).toMatchObject({ status: 'failed', error: expect.stringMatching(/fails the database role check/) });
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(schedulers.resumeSchedulersAfterRestore).not.toHaveBeenCalled();

    // A failure after the data was replaced, that couldn't be undone: checked too.
    kill.mockClear();
    restoreFromFile.mockRejectedValueOnce(new RestoreFailedError('Restore failed: uploads and swap back', true));
    assertServingRoleEnforcesRls.mockRejectedValue(new Error('Connection terminated unexpectedly'));
    await upload().expect(202);
    await restoreJobSettled();
    expect((await status()).error).toMatch(/could not run/);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  // A shutdown waits for a restore only once it is replacing the data, so none may start
  // once one has begun: it would be stopped part way, or keep the server from exiting.
  it('refuses a restore or a backup once a shutdown has begun: 503 SHUTTING_DOWN', async () => {
    shutdown.begun = true;
    for (const refused of [
      await upload(),
      await request(app).post('/api/backup/restore/nuggets_backup_20261101_030000_000.enc').send({}),
      await request(app).post('/api/backup/create'),
    ]) {
      expect(refused.status, JSON.stringify(refused.body)).toBe(503);
      expect(refused.body).toEqual({ code: 'SHUTTING_DOWN', error: expect.stringMatching(/shutting down/), message: expect.stringMatching(/shutting down/) });
    }
    expect(findBackup).not.toHaveBeenCalled();
    expect(restoreFromFile).not.toHaveBeenCalled();
    expect(schedulers.pauseSchedulersForRestore).not.toHaveBeenCalled();
  });

  it('reports a restore the shutdown stopped before it replaced the data', async () => {
    const message = 'The server shut down before the restore replaced the data, so nothing was changed. Restore the backup again once the server has restarted.';
    restoreFromFile.mockRejectedValueOnce(new RestoreFailedError('Restore failed', false, { cause: new ShuttingDownError(message) }));
    await upload().expect(202);
    await restoreJobSettled();
    expect(await status()).toMatchObject({ status: 'failed', databaseChanged: false, error: message });
    expect(assertServingRoleEnforcesRls).not.toHaveBeenCalled();
  });

  it('needs a file', async () => {
    await request(app).post('/api/backup/restore').expect(400);
    expect(restoreFromFile).not.toHaveBeenCalled();
  });
});
