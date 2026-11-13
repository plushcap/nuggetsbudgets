import { answerProblem, backupStatusResponseSchema } from '@nuggets/shared';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Pool } from 'pg';
import type { BackupService } from '../../services/BackupService.js';
import type { ImportService } from '../../services/ImportService.js';
import type { OneDriveService } from '../../services/OneDriveService.js';

// The other schedulers aren't under test, and they'd load db.ts (Docker secrets).
vi.mock('../../services/SyncScheduler.js', () => ({ SyncScheduler: class {} }));
vi.mock('../../services/NotificationScheduler.js', () => ({ NotificationScheduler: class {} }));
vi.mock('../../services/investments/OrgPriceSyncScheduler.js', () => ({ OrgPriceSyncScheduler: class {} }));
vi.mock('../../services/OneDriveService.js', () => ({
  OneDriveService: class {
    isConfigured = async () => false;
  },
}));

// The backup scheduler reads its settings on globalDb (system_settings): the ones the
// test's lifecycle() was given.
const current = vi.hoisted(() => ({ settings: {} as Record<string, string> }));
vi.mock('../../db/withTenant.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/withTenant.js')>();
  const { Kysely, PostgresDialect } = await import('kysely');
  const client = {
    query: async (_sql: string, params: unknown[] = []) => {
      const rows = Object.entries(current.settings)
        .filter(([key]) => params.includes(key))
        .map(([setting_key, setting_value]) => ({ setting_key, setting_value }));
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
    release: () => {},
  };
  return { ...actual, globalDb: new Kysely({ dialect: new PostgresDialect({ pool: { connect: async () => client } as never }) }) };
});

import { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';

/**
 * What the lifecycle reports about the backup scheduler (GET /api/backup/status, /api/status):
 * whether a backup is actually armed, not whether a scheduler object exists.
 */

function settingsPool(settings: Record<string, string>): Pool {
  const client = {
    query: async (_sql: string, params: unknown[] = []) => {
      const rows = Object.entries(settings)
        .filter(([key]) => params.includes(key))
        .map(([setting_key, setting_value]) => ({ setting_key, setting_value }));
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as Pool;
}

function lifecycle(
  settings: Record<string, string>,
  options: { keyExists?: boolean; legacyKey?: boolean; oneDriveService?: OneDriveService } = {}
) {
  current.settings = settings;
  const keyExists = options.keyExists ?? true;
  const legacyKey = options.legacyKey ?? false;
  const backupService = {
    encryptionState: vi.fn(async () => ({
      recipients: keyExists ? 1 : 0,
      legacyKey,
      mode: keyExists ? 'age' : legacyKey ? 'legacy' : 'none',
    })),
    listBackups: vi.fn(async () => [
      { fileName: 'nuggets_backup_20260109_030000.enc', filePath: '/b', size: 1, created: new Date('2026-01-09T03:00:00Z') },
    ]),
    createBackup: vi.fn(),
    deleteBackup: vi.fn(),
  };
  const service = new ApplicationLifecycleService(
    settingsPool(settings),
    {} as ImportService,
    backupService as unknown as BackupService,
    { oneDriveService: options.oneDriveService }
  );
  const initialize = () =>
    (service as unknown as { schedulers: { get(key: 'backup'): { initialize(): Promise<void> } } }).schedulers.get('backup').initialize();
  return { service, initialize, backupService };
}

describe('ApplicationLifecycleService backup scheduler status', () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  // What GET /api/backup/status serves: the Backup page reads waitingForBackupKey from it.
  it('reports that automatic backups wait for a backup key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
    const settings = { backup_enabled: 'true', backup_time: '03:00', backup_frequency_days: '7', application_timezone: 'UTC' };
    const { service, initialize, backupService } = lifecycle(settings, { keyExists: false });
    await initialize();

    expect(await service.getBackupSchedulerStatus()).toMatchObject({ enabled: true, running: false, waitingForBackupKey: true });
    // As GET /api/backup/status sends it: exactly what the shared schema names.
    const scheduler = JSON.parse(JSON.stringify(await service.getBackupSchedulerStatus()));
    expect(answerProblem(backupStatusResponseSchema, { configured: true, enabled: true, scheduler })).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backupService.createBackup).not.toHaveBeenCalled();
    await service.stopBackupScheduler();
  });

  it('reports no scheduler running while backups are disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
    const settings = { backup_enabled: 'false', backup_time: '03:00', backup_frequency_days: '7', application_timezone: 'UTC' };
    const { service, initialize } = lifecycle(settings);
    await initialize();

    expect(await service.getBackupSchedulerStatus()).toMatchObject({ enabled: false, running: false });
    const scheduler = JSON.parse(JSON.stringify(await service.getBackupSchedulerStatus()));
    expect(answerProblem(backupStatusResponseSchema, { configured: true, enabled: false, scheduler })).toBeNull();
    expect(service.getServiceStatus()).toMatchObject({
      backupSchedulerActive: false,
      services: { backupScheduler: false },
    });
    expect((await service.getApplicationStatus()).backupScheduler).toEqual({ active: false, nextBackup: null, isRunning: false });
    await service.stopBackupScheduler();
  });

  it('reports the armed backup, and keeps the scheduler across a stop and start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
    const settings = { backup_enabled: 'true', backup_time: '03:00', backup_frequency_days: '7', application_timezone: 'UTC' };
    const { service, initialize } = lifecycle(settings);
    await initialize();

    expect(await service.getBackupSchedulerStatus()).toMatchObject({
      enabled: true,
      running: true,
      hasRunningBackup: false,
      nextBackupTime: '2026-01-16T03:00:00.000Z',
      lastRunOutcome: null,
    });
    expect(service.getServiceStatus().backupSchedulerActive).toBe(true);

    await service.stopBackupScheduler();
    expect(await service.getBackupSchedulerStatus()).toMatchObject({ running: false });
    expect(service.getServiceStatus().backupSchedulerActive).toBe(false);

    await service.startBackupScheduler();
    expect(await service.getBackupSchedulerStatus()).toMatchObject({ running: true, nextBackupTime: '2026-01-16T03:00:00.000Z' });

    // POST /scheduler/stop saves backup_enabled=false, then stops the timer: the status
    // reports the saved setting, not the one read when the timer was armed.
    settings.backup_enabled = 'false';
    await service.stopBackupScheduler();
    expect(await service.getBackupSchedulerStatus()).toMatchObject({ enabled: false, running: false });
    settings.backup_enabled = 'true';
    await service.startBackupScheduler();
    expect(await service.getBackupSchedulerStatus()).toMatchObject({ enabled: true, running: true });

    // Saving backup_enabled=false stops it: the restart reads the setting, it doesn't just re-arm.
    settings.backup_enabled = 'false';
    await service.updateBackupSchedulerConfiguration();
    expect(await service.getBackupSchedulerStatus()).toMatchObject({ enabled: false, running: false });
    await service.stopBackupScheduler();
  });

  // index.ts gives the lifecycle the OneDrive service the routes use; the scheduler built a
  // second one, with a second connection setup of its own.
  it('copies a scheduled backup with the OneDrive service it was given', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
    const oneDrive = {
      isConfigured: vi.fn(async () => true),
      getUserIdsWithAutoSync: vi.fn(async () => [7]),
      uploadFile: vi.fn(async () => {}),
    };
    const settings = { backup_enabled: 'true', backup_time: '03:00', backup_frequency_days: '7', application_timezone: 'UTC' };
    const { service, initialize, backupService } = lifecycle(settings, { oneDriveService: oneDrive as unknown as OneDriveService });
    // No backup yet: a catch-up runs shortly after the scheduler starts.
    backupService.listBackups.mockResolvedValue([]);
    backupService.createBackup.mockResolvedValue({ fileName: 'nuggets_backup_20260110_120010.enc', filePath: '/b/new.enc', fileSize: 1 });
    await initialize();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(backupService.createBackup).toHaveBeenCalledOnce();
    expect(oneDrive.uploadFile).toHaveBeenCalledWith(7, '/b/new.enc', 'nuggets_backup_20260110_120010.enc');
    await service.stopBackupScheduler();
  });
});

/**
 * GET /api/health/detailed says whether backups are being made: they used to fail,
 * or wait for a backup key, with nothing but a log line to say so.
 */
describe('ApplicationLifecycleService backup health', () => {
  it('says automatic backups wait for a backup key, and that the newest backup is old', async () => {
    const { service, initialize } = lifecycle({ backup_enabled: 'true', backup_frequency_days: '7' }, { keyExists: false });
    await initialize();
    const health = await service.getBackupHealth();
    expect(health).toMatchObject({ status: 'degraded', automaticBackups: 'waiting-for-backup-key', newestBackupAt: '2026-01-09T03:00:00.000Z' });
    expect(health.problems).toEqual([
      expect.stringMatching(/none can be made: set up a backup key/),
      expect.stringMatching(/The newest backup is \d+ days old/),
    ]);
    await service.stopBackupScheduler();
  });

  it('says when backups still use the old backup key', async () => {
    const { service, initialize, backupService } = lifecycle({ backup_enabled: 'true', backup_frequency_days: '7' }, { keyExists: false, legacyKey: true });
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    backupService.listBackups.mockResolvedValue([{ fileName: 'nuggets_backup_x.enc', filePath: '/b', size: 1, created: recent }]);
    await initialize();
    const health = await service.getBackupHealth();
    expect(health).toMatchObject({ status: 'degraded', automaticBackups: 'on' });
    expect(health.problems).toEqual([expect.stringMatching(/still use the old backup key/)]);
    expect(await service.getBackupSchedulerStatus()).toMatchObject({ usingOldBackupKey: true, waitingForBackupKey: false });
    await service.stopBackupScheduler();
  });

  it('says when automatic backups are off, or there is no backup', async () => {
    const { service, initialize, backupService } = lifecycle({ backup_enabled: 'false' });
    backupService.listBackups.mockResolvedValue([]);
    await initialize();
    expect(await service.getBackupHealth()).toMatchObject({
      status: 'degraded',
      automaticBackups: 'off',
      problems: ['Automatic backups are off', 'There is no backup'],
    });
  });

  it('is healthy with automatic backups on and a recent backup', async () => {
    const { service, initialize, backupService } = lifecycle({ backup_enabled: 'true', backup_frequency_days: '7' });
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    backupService.listBackups.mockResolvedValue([{ fileName: 'nuggets_backup_x.enc', filePath: '/b', size: 1, created: recent }]);
    await initialize();
    expect(await service.getBackupHealth()).toMatchObject({ status: 'healthy', automaticBackups: 'on', problems: [], newestBackupAt: recent.toISOString() });
    await service.stopBackupScheduler();
  });
});
