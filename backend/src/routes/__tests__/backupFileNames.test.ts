import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Pool } from 'pg';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';

vi.mock('../../services/OneDriveService.js', () => ({ OneDriveService: class { isConfigured = async () => false; } }));

import { createBackupRoutes } from '../backup.js';
import { routeDependencies } from '../dependencies.js';
import { BackupService } from '../../services/BackupService.js';
import { contentDisposition } from '../../utils/uploadSafety.js';

/**
 * Download, delete and restore take a backup's file name from the URL: only
 * a file listed in the backup directory may be reached, never a path out of it. A real
 * BackupService on a temp directory; no database.
 */
describe('backup routes and file names', () => {
  let app: Express;
  let root: string;
  let backups: string;
  const listed = 'nuggets_backup_20261101_030000_000.enc';

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'backup-names-'));
    backups = path.join(root, 'backups');
    vi.stubEnv('BACKUP_LOCATION', backups);
    vi.stubEnv('BACKUP_TEMP_DIR', path.join(root, 'temp'));
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user: unknown }).user = { userId: 1, email: 'admin@test.local' };
      next();
    });
    const backupService = new BackupService({ query: vi.fn() } as unknown as Pool);
    app.use('/api/backup', createBackupRoutes(routeDependencies({ lifecycleService: {} as ApplicationLifecycleService, backupService })));
    await mkdir(backups);
    await writeFile(path.join(backups, listed), 'encrypted');
    // Outside the backup directory, where a ../ name would point.
    await writeFile(path.join(root, 'outside.enc'), 'not a backup');
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each(['../outside.enc', '..%2Foutside.enc', '%2E%2E%2Foutside.enc', '..%5Coutside.enc'])('refuses %s', async (name) => {
    await request(app).get(`/api/backup/download/${name}`).expect(404);
    await request(app).delete(`/api/backup/${name}`).expect(404);
    await request(app).post(`/api/backup/restore/${name}`).send({}).expect(404);
    expect(await readdir(root)).toContain('outside.enc');
  });

  it('downloads and deletes a listed backup', async () => {
    const res = await request(app).get(`/api/backup/download/${listed}`).expect(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${listed}"; filename*=UTF-8''${listed}`);
    await request(app).delete(`/api/backup/${listed}`).expect(200);
    expect(await readdir(backups)).toEqual([]);
  });

  // Any .enc file in the directory is listed, and its name went into the header as it was:
  // a quote ended the name early, and a character outside Latin-1 made Node refuse
  // the header, so the download failed with a 500.
  it.each(['before "the move".enc', 'r\u00e9sum\u00e9 \u9818\u53ce\u66f8.enc'])('names a download of %s with contentDisposition()', async (name) => {
    await writeFile(path.join(backups, name), 'encrypted');
    try {
      const res = await request(app).get(`/api/backup/download/${encodeURIComponent(name)}`).responseType('blob').expect(200);
      expect(res.headers['content-disposition']).toBe(contentDisposition('attachment', name));
      expect(res.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="[^"]*"; /);
      expect(Buffer.from(res.body).toString()).toBe('encrypted');
    } finally {
      await rm(path.join(backups, name), { force: true });
    }
  });

  // The backup key's download built its header by hand: it names it the same way now.
  it('names the backup key download with contentDisposition()', async () => {
    const key = vi.spyOn(BackupService.prototype, 'getBackupKeyForDownload').mockResolvedValue('the-key');
    try {
      const res = await request(app).get('/api/backup/key/download').expect(200);
      expect(res.headers['content-disposition']).toBe(contentDisposition('attachment', 'nuggets-backup-key.txt'));
      expect(res.text).toBe('the-key');
    } finally {
      key.mockRestore();
    }
  });

  // The upload is the restore job's to delete once a restore starts with it; any other
  // answer leaves nothing behind in the temp directory.
  it('deletes an uploaded backup whose restore was refused', async () => {
    const uploads = path.join(root, 'temp', 'uploads');
    const refused = await request(app)
      .post('/api/backup/restore')
      .field('encryptionKey', 'k'.repeat(2000))
      .attach('backup', Buffer.from('not a real backup'), 'refused.enc')
      .expect(400);
    expect(refused.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'encryptionKey must be text' });
    await vi.waitFor(async () => expect(await readdir(uploads)).toEqual([]));

    const noFile = await request(app).post('/api/backup/restore').field('encryptionKey', 'k').expect(400);
    expect(noFile.body).toMatchObject({ code: 'BAD_REQUEST', error: 'No backup file provided' });
  });

  // It was opened after the headers, with no 'error' listener: the stream's ENOENT was an
  // uncaught exception, which stops the server.
  it('answers 404 for a listed backup gone before its download opened', async () => {
    const gone = 'nuggets_backup_20261102_030000_000.enc';
    const find = vi
      .spyOn(BackupService.prototype, 'findBackup')
      .mockResolvedValueOnce({ fileName: gone, filePath: path.join(backups, gone), size: 9, created: new Date() });
    try {
      const res = await request(app).get(`/api/backup/download/${gone}`).expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND', error: 'Backup file not found' });
      expect(res.headers['content-disposition']).toBeUndefined();
    } finally {
      find.mockRestore();
    }
  });

  it('deleteBackup takes a bare .enc name only', async () => {
    const service = new BackupService({} as Pool, { backupLocation: backups, tempDir: path.join(root, 'temp') });
    await expect(service.deleteBackup('../outside.enc')).rejects.toThrow('Invalid backup file name');
    await expect(service.deleteBackup('outside.txt')).rejects.toThrow('Invalid backup file name');
    expect(await service.findBackup('../outside.enc')).toBeNull();
  });
});
