import { answerProblem, backupCreateStatusResponseSchema, backupKeyStatusResponseSchema } from '@nuggets/shared';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Pool } from 'pg';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';

vi.mock('../../services/OneDriveService.js', () => ({
  OneDriveService: class {
    isConfigured = async () => false;
  },
}));

import { createBackupRoutes } from '../backup.js';
import { BackupService } from '../../services/BackupService.js';
import { routeDependencies } from '../dependencies.js';

/**
 * The backup routes that feed the scheduler: settings it can hold, one backup at a time
 * across manual and scheduled runs, and the on/off switch that the scheduler reads.
 * Pure unit: the pool is a fake that records the writes.
 */

/** A pool that records every query; the advisory try-lock answers `locked`. */
function recordingPool() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const state = { locked: true };
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: state.locked }] };
      return { command: 'SELECT', rowCount: 0, rows: [] };
    },
    release: () => {},
    on: () => {},
    off: () => {},
  };
  const pool = { connect: async () => client, query: client.query } as unknown as Pool;
  const writes = () =>
    queries.filter((q) => /insert into "?system_settings"?/i.test(q.sql)).map((q) => q.params.slice(0, 2));
  return { pool, queries, writes, state };
}

describe('backup routes and the scheduler', () => {
  let app: Express;
  let backupDir: string;
  const db = recordingPool();
  const lifecycle = {
    getBackupSchedulerStatus: vi.fn(async () => ({ waitingForBackupKey: false })),
    updateBackupSchedulerConfiguration: vi.fn(async () => undefined),
    startBackupScheduler: vi.fn(async () => undefined),
    stopBackupScheduler: vi.fn(async () => undefined),
  };

  beforeAll(async () => {
    backupDir = await mkdtemp(path.join(os.tmpdir(), 'backup-routes-'));
    vi.stubEnv('BACKUP_LOCATION', backupDir);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user: unknown }).user = { userId: 1, email: 'admin@test.local' };
      next();
    });
    const lifecycleService = lifecycle as unknown as ApplicationLifecycleService;
    app.use('/api/backup', createBackupRoutes(routeDependencies({ lifecycleService, backupService: new BackupService(db.pool) })));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(backupDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.queries.length = 0;
    vi.clearAllMocks();
  });

  describe('POST /key/generate', () => {
    it('arms a scheduler that is waiting for a backup key', async () => {
      const generate = vi.spyOn(BackupService.prototype, 'generateBackupKey').mockResolvedValue(undefined as never);
      lifecycle.getBackupSchedulerStatus.mockResolvedValueOnce({ waitingForBackupKey: true });
      await request(app).post('/api/backup/key/generate').expect(200);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(lifecycle.updateBackupSchedulerConfiguration).toHaveBeenCalledTimes(1);
    });

    // Restarting an armed scheduler while its catch-up backup runs queued another
    // backup an hour later.
    it('leaves an armed scheduler alone when the key is rotated', async () => {
      vi.spyOn(BackupService.prototype, 'generateBackupKey').mockResolvedValue(undefined as never);
      await request(app).post('/api/backup/key/generate').expect(200);
      expect(lifecycle.updateBackupSchedulerConfiguration).not.toHaveBeenCalled();
    });
  });

  describe('POST /settings', () => {
    it.each(['0', '366', '-5', 'abc', '7.5', ''])('refuses backup_frequency_days %j and writes nothing', async (value) => {
      const res = await request(app)
        .post('/api/backup/settings')
        .send({ settings: { backup_time: '03:00', backup_frequency_days: value } })
        .expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/backup_frequency_days/) });
      expect(db.writes()).toEqual([]);
      expect(lifecycle.updateBackupSchedulerConfiguration).not.toHaveBeenCalled();
    });

    it.each([
      ['backup_retention_days', '0'],
      ['backup_retention_days', '366'],
      ['backup_time', '25:00'],
      ['backup_time', 'soon'],
      ['backup_enabled', 'yes'],
    ])('refuses %s %j', async (key, value) => {
      const res = await request(app).post('/api/backup/settings').send({ settings: { [key]: value } }).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(new RegExp(key)) });
      expect(db.writes()).toEqual([]);
    });

    it.each([
      ['notification_smtp_port', '0'],
      ['import_sync_time', '99:99'],
      ['backup_data_key', 'not-the-key'],
      ['BACKUP_ENABLED', 'true'],
    ])('refuses %s, which is not a backup setting it may change', async (key, value) => {
      await request(app).post('/api/backup/settings').send({ settings: { [key]: value } }).expect(400);
      expect(db.writes()).toEqual([]);
    });

    it.each([{}, { settings: 'backup_enabled=true' }, { settings: null }])('refuses %j: Settings object is required', async (body) => {
      const res = await request(app).post('/api/backup/settings').send(body).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Settings object is required' });
      expect(db.writes()).toEqual([]);
    });

    it('saves a monthly schedule and restarts the scheduler', async () => {
      await request(app)
        .post('/api/backup/settings')
        .send({ settings: { backup_enabled: 'true', backup_time: '03:00', backup_frequency_days: '30', backup_retention_days: 365 } })
        .expect(200);
      expect(db.writes()).toEqual([
        ['backup_enabled', 'true'],
        ['backup_time', '03:00'],
        ['backup_frequency_days', '30'],
        ['backup_retention_days', '365'],
      ]);
      expect(lifecycle.updateBackupSchedulerConfiguration).toHaveBeenCalledOnce();
    });
  });

  describe('GET /settings', () => {
    it('asks only for the settings the page may change, not the encrypted backup key', async () => {
      await request(app).get('/api/backup/settings').expect(200);
      const read = db.queries.find((q) => /from "?system_settings"?/i.test(q.sql));
      // In the backup category (its first parameter), and only the keys the page may change.
      expect(read?.sql).toMatch(/"category" = \$1 and "setting_key" in \(/i);
      const [category, ...keys] = read?.params.flat() ?? [];
      expect(category).toBe('backup');
      expect(keys).toEqual(expect.arrayContaining(['backup_enabled', 'backup_time', 'backup_frequency_days', 'backup_retention_days']));
      expect(keys).not.toContain('backup_data_key');
    });
  });

  describe('POST /scheduler/start and /scheduler/stop', () => {
    it('save backup_enabled, which the scheduler reads when it starts', async () => {
      await request(app).post('/api/backup/scheduler/start').expect(200);
      expect(db.writes()).toEqual([['backup_enabled', 'true']]);
      expect(lifecycle.startBackupScheduler).toHaveBeenCalledOnce();

      db.queries.length = 0;
      await request(app).post('/api/backup/scheduler/stop').expect(200);
      expect(db.writes()).toEqual([['backup_enabled', 'false']]);
      expect(lifecycle.stopBackupScheduler).toHaveBeenCalledOnce();
    });
  });

  describe('POST /create', () => {
    it('answers 409 while a scheduled backup is running', async () => {
      // The scheduler's own BackupService, stuck connecting.
      let connect!: (client: unknown) => void;
      const scheduled = new BackupService({ connect: () => new Promise((resolve) => (connect = resolve)) } as unknown as Pool);
      const run = scheduled.createBackup().catch((error: unknown) => error);

      const res = await request(app).post('/api/backup/create').expect(409);
      // The refusal a restore gives while a backup runs (BackupInProgressError).
      expect(res.body).toEqual({ error: 'A backup is already in progress', code: 'BACKUP_IN_PROGRESS', message: 'A backup is already in progress' });

      connect({ query: async () => ({ rows: [{ locked: false }] }), release: () => {}, on: () => {}, off: () => {} });
      await run;
      expect(BackupService.isBackupInProgress()).toBe(false);
    });

    it('reports a manual backup refused by another server as failed', async () => {
      db.state.locked = false;
      try {
        await request(app).post('/api/backup/create').expect(202);
        await vi.waitFor(async () => {
          const status = await request(app).get('/api/backup/create-status').expect(200);
          expect(status.body).toMatchObject({ status: 'failed', error: expect.stringMatching(/already in progress/) });
          // Exactly what the shared schema names.
          expect(answerProblem(backupCreateStatusResponseSchema, status.body)).toBeNull();
        });
      } finally {
        db.state.locked = true;
      }
    });
  });

  it('answers the backup key status as the shared schema names it', async () => {
    const res = await request(app).get('/api/backup/key/status').expect(200);
    expect(res.body).toEqual({ exists: false, downloaded: false });
    expect(answerProblem(backupKeyStatusResponseSchema, res.body)).toBeNull();
  });
});
