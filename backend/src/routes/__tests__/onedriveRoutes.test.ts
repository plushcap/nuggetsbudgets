import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtemp, readdir, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { createOneDriveRoutes } from '../onedrive.js';
import { OneDriveService } from '../../services/OneDriveService.js';
import type { BackupService } from '../../services/BackupService.js';
import { config } from '../../config.js';

/**
 * The signed-in OneDrive routes' refusals and checks: each is a DomainError or
 * validateBody's answer, not a `{ success: false }` body of the route's own; the test
 * upload leaves no file behind, whether it went or not. No database: the service's
 * storage is stubbed.
 */
describe('/api/onedrive (signed in)', () => {
  let app: Express;
  let temp: string;
  const service = new OneDriveService();
  const findBackup = vi.fn();

  beforeAll(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'onedrive-routes-'));
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user: unknown }).user = { userId: 3, email: 'admin@test.local' };
      next();
    });
    app.use(
      '/api/onedrive',
      createOneDriveRoutes({
        oneDriveService: service,
        backupService: { findBackup } as unknown as BackupService,
        config: { ...config(), TEMP_PATH: temp },
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    findBackup.mockReset();
  });

  afterAll(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('answers a connect before the app is registered 503 ONEDRIVE_NOT_CONFIGURED', async () => {
    vi.spyOn(service, 'isConfigured').mockResolvedValue(false);
    const res = await request(app).get('/api/onedrive/auth').expect(503);
    expect(res.body).toEqual({
      error: 'OneDrive integration not configured',
      code: 'ONEDRIVE_NOT_CONFIGURED',
      message: 'OneDrive integration not configured',
    });
  });

  it.each([
    [{ clientId: '', redirectUri: 'https://nuggets.example/api/onedrive/callback' }, 'Client ID is required'],
    [{ clientId: 'id', redirectUri: 'https://nuggets.example/elsewhere' }, 'Redirect URI must be https://<your domain>/api/onedrive/callback'],
    [{ clientId: 'id', redirectUri: 'not a url' }, 'Redirect URI must be a valid URL'],
  ])('refuses the app registration %j: %s', async (body, message) => {
    const save = vi.spyOn(service, 'saveClientConfig').mockResolvedValue();
    const res = await request(app).put('/api/onedrive/config').send(body).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message });
    expect(save).not.toHaveBeenCalled();
  });

  it('saves a registration it accepts, trimmed', async () => {
    const save = vi.spyOn(service, 'saveClientConfig').mockResolvedValue();
    await request(app)
      .put('/api/onedrive/config')
      .send({ clientId: ' id ', redirectUri: 'https://nuggets.example/api/onedrive/callback' })
      .expect(200, { success: true, message: 'OneDrive configuration saved' });
    expect(save).toHaveBeenCalledWith({ clientId: 'id', redirectUri: 'https://nuggets.example/api/onedrive/callback' });
  });

  it('refuses an auto-sync setting that is not a boolean', async () => {
    const res = await request(app).post('/api/onedrive/settings').send({ autoSyncEnabled: 'yes' }).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'autoSyncEnabled must be a boolean' });
  });

  it('copies only a listed backup: 400 without a name, 404 for one not listed', async () => {
    const upload = vi.spyOn(service, 'uploadFile').mockResolvedValue();
    expect((await request(app).post('/api/onedrive/upload').send({}).expect(400)).body).toMatchObject({ message: 'fileName is required' });
    findBackup.mockResolvedValue(null);
    expect((await request(app).post('/api/onedrive/upload').send({ fileName: '../x.enc' }).expect(404)).body).toMatchObject({
      code: 'NOT_FOUND',
      error: 'Backup file not found',
    });
    expect(upload).not.toHaveBeenCalled();

    findBackup.mockResolvedValue({ fileName: 'b.enc', filePath: '/backups/b.enc', size: 1, created: new Date() });
    await request(app).post('/api/onedrive/upload').send({ fileName: 'b.enc' }).expect(200);
    expect(upload).toHaveBeenCalledWith(3, '/backups/b.enc', 'b.enc');
  });

  it('deletes its test file when the test upload fails, and answers the 500 without the error text', async () => {
    vi.spyOn(service, 'uploadFile').mockRejectedValue(new Error('Graph 401 for drive secret-drive-id'));
    const res = await request(app).post('/api/onedrive/test-upload').expect(500);
    expect(res.body).toMatchObject({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    expect(res.text).not.toContain('secret-drive-id');
    expect(await readdir(temp)).toEqual([]);
  });

  it('deletes its test file when the test upload goes', async () => {
    const upload = vi.spyOn(service, 'uploadFile').mockResolvedValue();
    await request(app).post('/api/onedrive/test-upload').expect(200);
    expect(upload).toHaveBeenCalledWith(3, expect.stringContaining(temp), expect.stringMatching(/^nuggets_test_\d+\.txt$/));
    expect(await readdir(temp)).toEqual([]);
  });
});
