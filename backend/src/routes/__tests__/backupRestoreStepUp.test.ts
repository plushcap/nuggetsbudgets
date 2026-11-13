import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { mkdtemp, readdir, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Pool } from 'pg';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';

vi.mock('../../services/OneDriveService.js', () => ({ OneDriveService: class { isConfigured = async () => false; } }));
// Nothing here may start one; a test that reached it would fail on the call count.
const jobs = vi.hoisted(() => ({ startRestoreJob: vi.fn(), startVerifyJob: vi.fn() }));
vi.mock('../../services/restoreJob.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/restoreJob.js')>()),
  startRestoreJob: jobs.startRestoreJob,
  startVerifyJob: jobs.startVerifyJob,
}));

import { createBackupRoutes } from '../backup.js';
import { routeDependencies } from '../dependencies.js';
import { BackupService } from '../../services/BackupService.js';
import { sessionService } from '../../middleware/auth.js';
import { answerError } from '../../utils/apiError.js';

/**
 * Step-up on restore, with the real requireRecentReauth: both restores (an uploaded backup,
 * and one in the backup directory) need a session that confirmed its password or passkey in
 * the last few minutes, since a restore replaces every account, password and key with the
 * backup's. It is checked before the upload is read (a name the upload filter refuses proves
 * it: read first, it would answer 400), before the body is validated (a body the schema
 * refuses, likewise) and before the service is reached. A verify, uploaded or on the server,
 * changes nothing and needs none. A personal access token gets no restore.
 */
describe('backup restore routes and step-up', () => {
  let app: Express;
  let tempDir: string;
  const who = { patId: undefined as string | undefined };
  const listedName = 'nuggets_backup_20261101_030000_000.tar.age';
  const FILE_KEY = Buffer.alloc(16, 7).toString('base64');

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'backup-restore-step-up-'));
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { userId: 1, email: 'admin@test.local' }, session: { id: 7 }, patId: who.patId });
      next();
    });
    const lifecycle = {} as unknown as ApplicationLifecycleService;
    const backupService = new BackupService({} as Pool, { tempDir, backupLocation: tempDir });
    app.use('/api/backup', createBackupRoutes(routeDependencies({ lifecycleService: lifecycle, backupService })));
    // As the app's error handler answers an upload the filter refused: 400 UPLOAD_REJECTED.
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => answerError(err, res));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    jobs.startRestoreJob.mockReset();
    jobs.startVerifyJob.mockReset();
    who.patId = undefined;
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** What the upload left in the temp directory: nothing, when it was never read. */
  const uploaded = async () => readdir(path.join(tempDir, 'uploads')).catch(() => [] as string[]);

  const RESTORES = ['POST /restore', 'POST /restore/:fileName'];
  const restores = () => [
    request(app)
      .post('/api/backup/restore')
      .field('fileKey', FILE_KEY)
      .attach('backup', Buffer.from('not a backup at all'), 'notes.txt'),
    request(app).post(`/api/backup/restore/${listedName}`).send({ fileKey: FILE_KEY }),
  ];
  /** A body the restore schema refuses (a file key that isn't one). */
  const badBody = () => request(app).post(`/api/backup/restore/${listedName}`).send({ fileKey: 42 });

  it('refuses a restore without a recent confirmation, before the upload, the body or the service', async () => {
    const recent = vi.spyOn(sessionService, 'isRecentlyReauthenticated').mockResolvedValue(false);
    const find = vi.spyOn(BackupService.prototype, 'findBackup');
    const before = await uploaded();
    for (const [i, res] of (await Promise.all(restores())).entries()) {
      expect(res.status, RESTORES[i]).toBe(403);
      expect(res.body.code, RESTORES[i]).toBe('REAUTH_REQUIRED');
    }
    const refusedBody = await badBody();
    expect(refusedBody.status).toBe(403);
    expect(refusedBody.body.code).toBe('REAUTH_REQUIRED');
    expect(recent).toHaveBeenCalledTimes(3);
    expect(recent).toHaveBeenCalledWith(7);
    expect(find).not.toHaveBeenCalled();
    expect(jobs.startRestoreJob).not.toHaveBeenCalled();
    expect(await uploaded()).toEqual(before);
  });

  it('refuses a personal access token a restore outright', async () => {
    who.patId = 'jti-of-a-token';
    const recent = vi.spyOn(sessionService, 'isRecentlyReauthenticated');
    for (const [i, res] of (await Promise.all(restores())).entries()) {
      expect(res.status, RESTORES[i]).toBe(403);
      expect(res.body.code, RESTORES[i]).toBe('INTERACTIVE_SESSION_REQUIRED');
    }
    expect(recent).not.toHaveBeenCalled();
    expect(jobs.startRestoreJob).not.toHaveBeenCalled();
  });

  it('with a recent confirmation, goes on to the upload and the backup directory', async () => {
    vi.spyOn(sessionService, 'isRecentlyReauthenticated').mockResolvedValue(true);
    const find = vi.spyOn(BackupService.prototype, 'findBackup').mockResolvedValue(null);
    const [upload, listed] = await Promise.all(restores());
    // The upload filter's refusal, and the directory's: both past the step-up.
    expect(upload.status, JSON.stringify(upload.body)).toBe(400);
    expect(upload.body.code).toBe('UPLOAD_REJECTED');
    expect(listed.status, JSON.stringify(listed.body)).toBe(404);
    expect(find).toHaveBeenCalledWith(listedName);
    // The body the step-up was checked before is one the schema refuses.
    const refusedBody = await badBody();
    expect(refusedBody.status, JSON.stringify(refusedBody.body)).toBe(400);
    expect(refusedBody.body.code).toBe('VALIDATION_ERROR');
    expect(jobs.startRestoreJob).not.toHaveBeenCalled();
  });

  it('starts a restore from the backup directory once confirmed', async () => {
    vi.spyOn(sessionService, 'isRecentlyReauthenticated').mockResolvedValue(true);
    vi.spyOn(BackupService.prototype, 'findBackup').mockResolvedValue({
      fileName: listedName,
      filePath: path.join(tempDir, listedName),
    } as Awaited<ReturnType<BackupService['findBackup']>>);
    const res = await request(app).post(`/api/backup/restore/${listedName}`).send({ fileKey: FILE_KEY });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(jobs.startRestoreJob).toHaveBeenCalledTimes(1);
    expect(jobs.startRestoreJob.mock.calls[0]?.[1]).toMatchObject({ fileName: listedName, userId: 1, deleteAfter: false });
  });

  it('verifies without one, uploaded or on the server: a verify changes nothing', async () => {
    const recent = vi.spyOn(sessionService, 'isRecentlyReauthenticated').mockResolvedValue(false);
    vi.spyOn(BackupService.prototype, 'findBackup').mockResolvedValue({
      fileName: listedName,
      filePath: path.join(tempDir, listedName),
    } as Awaited<ReturnType<BackupService['findBackup']>>);
    const listed = await request(app).post(`/api/backup/verify/${listedName}`).send({ fileKey: FILE_KEY });
    expect(listed.status, JSON.stringify(listed.body)).toBe(202);
    const upload = await request(app)
      .post('/api/backup/verify')
      .field('fileKey', FILE_KEY)
      .attach('backup', Buffer.from('a backup, as far as the route can tell'), listedName);
    expect(upload.status, JSON.stringify(upload.body)).toBe(202);
    expect(jobs.startVerifyJob).toHaveBeenCalledTimes(2);
    expect(jobs.startVerifyJob.mock.calls[1]?.[1]).toMatchObject({ fileName: listedName, deleteAfter: true });
    expect(recent).not.toHaveBeenCalled();
  });
});
