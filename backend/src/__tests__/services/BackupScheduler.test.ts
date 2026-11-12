import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from '../../db/schema.generated.js';
import { BackupScheduler } from '../../services/BackupScheduler.js';
import type { BackupService } from '../../services/BackupService.js';
import type { OneDriveService } from '../../services/OneDriveService.js';

/**
 * The backup scheduler under fake timers. Pure unit: system_settings comes from a fake
 * pool and the backups from a fake BackupService, so nothing touches a database or disk.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

type Backup = { fileName: string; filePath: string; size: number; created: Date };

/** A pg Pool that answers the scheduler's system_settings read from `settings`. */
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

function backupAt(iso: string): Backup {
  const created = new Date(iso);
  const fileName = `nuggets_backup_${iso.replace(/\D/g, '').slice(0, 14)}.enc`;
  return { fileName, filePath: `/backups/${fileName}`, size: 1, created };
}

function setup(settings: Record<string, string>, existing: Backup[] = [], options: { keyExists?: boolean } = {}) {
  const backups = [...existing];
  const key = { exists: options.keyExists ?? true };
  const backupService = {
    getBackupKeyStatus: vi.fn(async () => ({ exists: key.exists, downloaded: key.exists })),
    createBackup: vi.fn(async () => {
      const made = backupAt(new Date().toISOString());
      backups.push(made);
      return { fileName: made.fileName, filePath: made.filePath, fileSize: 1 };
    }),
    listBackups: vi.fn(async () => [...backups].sort((a, b) => b.created.getTime() - a.created.getTime())),
    deleteBackup: vi.fn(async (fileName: string) => {
      backups.splice(backups.findIndex((b) => b.fileName === fileName), 1);
    }),
  };
  const oneDrive = { isConfigured: vi.fn(async () => false) };
  const scheduler = new BackupScheduler(backupService as unknown as BackupService, oneDrive as unknown as OneDriveService, {
    db: new Kysely<DB>({ dialect: new PostgresDialect({ pool: settingsPool(settings) }) }),
  });
  return { scheduler, backupService, backups, settings, key };
}

const enabled = (overrides: Record<string, string> = {}) => ({
  backup_enabled: 'true',
  backup_time: '03:00',
  backup_frequency_days: '7',
  backup_retention_days: '90',
  application_timezone: 'UTC',
  ...overrides,
});

/** Advance the fake clock to `iso` (running every timer due on the way). */
const advanceTo = (iso: string) => vi.advanceTimersByTimeAsync(new Date(iso).getTime() - Date.now());

describe('BackupScheduler', () => {
  let scheduler: BackupScheduler | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await scheduler?.stopScheduler();
    scheduler = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('frequencies of 25 days or more (Node clamps longer timers to 1 ms)', () => {
    it.each(['25', '30', '365'])('waits out a %s-day frequency and backs up once per cycle', async (days) => {
      vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const t = setup(enabled({ backup_frequency_days: days }), [backupAt('2026-01-09T03:00:00Z')]);
      scheduler = t.scheduler;
      await scheduler.startScheduler();

      // The old scheduler armed one timer for the whole wait, which Node cut to 1 ms.
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.backupService.createBackup).not.toHaveBeenCalled();

      const due = new Date(Date.parse('2026-01-09T03:00:00Z') + Number(days) * DAY);
      expect(await scheduler.getNextScheduledBackupTime()).toEqual(due);
      await advanceTo(new Date(due.getTime() - 1000).toISOString());
      expect(t.backupService.createBackup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(1);

      // The next cycle is a whole frequency later, again in hops a timer can hold.
      const next = new Date(due.getTime() + Number(days) * DAY);
      expect(await scheduler.getNextScheduledBackupTime()).toEqual(next);
      await advanceTo(new Date(next.getTime() - 1000).toISOString());
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(2);

      const longest = Math.max(...setTimeoutSpy.mock.calls.map((call) => Number(call[1] ?? 0)));
      expect(longest).toBeLessThanOrEqual(DAY);
    });

    it.each(['-5', '0', 'abc', '1000'])('treats a stored frequency of %s as weekly', async (days) => {
      vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
      const t = setup(enabled({ backup_frequency_days: days }), [backupAt('2026-01-09T03:00:00Z')]);
      scheduler = t.scheduler;
      await scheduler.startScheduler();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.backupService.createBackup).not.toHaveBeenCalled();
      expect(await scheduler.getNextScheduledBackupTime()).toEqual(new Date('2026-01-16T03:00:00Z'));
    });
  });

  describe('without a backup key', () => {
    it('waits instead of starting a backup that can only fail, and starts once a key exists', async () => {
      vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
      // A fresh install: backups on, none made yet, no key generated.
      const t = setup(enabled(), [], { keyExists: false });
      scheduler = t.scheduler;
      await scheduler.startScheduler();

      await vi.advanceTimersByTimeAsync(DAY);
      expect(t.backupService.createBackup).not.toHaveBeenCalled();
      expect(await scheduler.getSchedulerStatus()).toMatchObject({ enabled: true, running: false, waitingForBackupKey: true });

      // Generating the key restarts the scheduler (POST /api/backup/key/generate).
      t.key.exists = true;
      await scheduler.updateSchedule();
      expect(await scheduler.getSchedulerStatus()).toMatchObject({ running: true, waitingForBackupKey: false });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(1);
    });

    it('stops waiting when the scheduler is stopped', async () => {
      const t = setup(enabled(), [], { keyExists: false });
      scheduler = t.scheduler;
      await scheduler.startScheduler();
      expect((await scheduler.getSchedulerStatus()).waitingForBackupKey).toBe(true);
      await scheduler.stopScheduler();
      expect((await scheduler.getSchedulerStatus()).waitingForBackupKey).toBe(false);
    });
  });

  describe('status reads', () => {
    it('never start a backup, and report the instant the armed timer fires', async () => {
      vi.setSystemTime(new Date('2026-01-10T01:00:00Z')); // before today's 03:00
      const t = setup(enabled(), [backupAt('2026-01-08T03:00:00Z')]);
      scheduler = t.scheduler;
      await scheduler.startScheduler();

      // The backups go missing (deleted, or the backup directory can't be read). The old
      // getters each queued a catch-up backup when they saw that.
      t.backups.length = 0;
      for (let i = 0; i < 3; i++) {
        await scheduler.getNextScheduledBackupTime();
        await scheduler.getSchedulerStatus();
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.backupService.createBackup).not.toHaveBeenCalled();

      const status = await scheduler.getSchedulerStatus();
      expect(status).toMatchObject({ enabled: true, running: true, hasRunningBackup: false });
      expect(status.nextBackupTime).toEqual(new Date('2026-01-15T03:00:00Z'));

      await advanceTo('2026-01-15T03:00:00Z');
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(1);
    });
  });

  describe('cycles', () => {
    it('counts the next cycle from when the backup was due, even when the timer fires late', async () => {
      vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
      const t = setup(enabled({ backup_time: '23:30' }), [backupAt('2026-01-09T23:30:00Z')]);
      scheduler = t.scheduler;
      await scheduler.startScheduler();
      expect(await scheduler.getNextScheduledBackupTime()).toEqual(new Date('2026-01-16T23:30:00Z'));

      // The machine sleeps through the backup time, into the next day.
      await advanceTo('2026-01-16T23:29:00Z');
      vi.setSystemTime(new Date('2026-01-17T00:10:00Z'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(1);
      expect(await scheduler.getNextScheduledBackupTime()).toEqual(new Date('2026-01-23T23:30:00Z'));
    });

    it.each([
      // zone, backup time, a moment after that day's backup on the eve of a spring-forward,
      // and the two backups the next 48 hours hold (the first just after the skipped time)
      ['America/Havana', '00:30', '2026-03-07T12:00:00Z', ['2026-03-08T05:30:00.000Z', '2026-03-09T04:30:00.000Z']],
      ['Atlantic/Azores', '00:30', '2026-03-28T12:00:00Z', ['2026-03-29T01:30:00.000Z', '2026-03-30T00:30:00.000Z']],
      ['America/Santiago', '00:30', '2026-09-05T12:00:00Z', ['2026-09-06T04:30:00.000Z', '2026-09-07T03:30:00.000Z']],
      ['America/New_York', '02:30', '2026-03-07T12:00:00Z', ['2026-03-08T07:30:00.000Z', '2026-03-09T06:30:00.000Z']],
    ])('backs up once a day across the DST gap in %s at %s', async (zone, time, start, expected) => {
      // The skipped time used to come out as the evening before, in the past, and the
      // scheduler backed up every second until local midnight caught up (1800+ backups).
      vi.setSystemTime(new Date(start));
      // The last backup ran on time that day (24 hours, and one wall-clock day, earlier).
      const lastBackup = new Date(Date.parse(expected[0]) - DAY).toISOString();
      const t = setup(enabled({ backup_time: time, backup_frequency_days: '1', application_timezone: zone }), [backupAt(lastBackup)]);
      scheduler = t.scheduler;
      await scheduler.startScheduler();

      await vi.advanceTimersByTimeAsync(48 * HOUR);
      const made = t.backups.slice(1).map((b) => b.created.toISOString());
      expect(made).toEqual(expected);
    });

    it('never starts a backup within an hour of the last one, even after a restart', async () => {
      vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
      const t = setup(enabled()); // no backups: a catch-up runs 10 s after start
      t.backupService.createBackup.mockRejectedValue(new Error('No backup encryption key has been generated'));
      scheduler = t.scheduler;
      await scheduler.startScheduler();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(1);

      // A settings save restarts the scheduler; there is still no backup, so it catches up,
      // but not straight away.
      await scheduler.updateSchedule();
      await vi.advanceTimersByTimeAsync(HOUR - 2 * 60_000);
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(2);
    });
  });

  describe('clock and dates', () => {
    it('backs up within a frequency when the newest backup is dated in the future', async () => {
      vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
      const t = setup(enabled(), [backupAt('2030-01-01T03:00:00Z')]);
      scheduler = t.scheduler;
      await scheduler.startScheduler();

      expect(await scheduler.getNextScheduledBackupTime()).toEqual(new Date('2026-01-17T03:00:00Z'));
      await advanceTo('2026-01-17T03:00:01Z');
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(1);
    });

    it('backs up within a frequency when the clock moves back', async () => {
      vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
      const t = setup(enabled(), [backupAt('2026-04-19T03:00:00Z')]);
      scheduler = t.scheduler;
      await scheduler.startScheduler();
      expect(await scheduler.getNextScheduledBackupTime()).toEqual(new Date('2026-04-26T03:00:00Z'));

      vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
      await vi.advanceTimersByTimeAsync(DAY); // the next hop notices
      expect(await scheduler.getNextScheduledBackupTime()).toEqual(new Date('2026-01-18T03:00:00Z'));
      await advanceTo('2026-01-18T03:00:01Z');
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(1);
    });
  });

  describe('settings', () => {
    it('backs up on UTC time when the stored timezone is unknown', async () => {
      vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
      const t = setup(enabled({ application_timezone: 'Not/AZone' }), [backupAt('2026-01-09T03:00:00Z')]);
      scheduler = t.scheduler;
      await scheduler.startScheduler();
      expect(await scheduler.getNextScheduledBackupTime()).toEqual(new Date('2026-01-16T03:00:00Z'));

      await advanceTo('2026-01-16T03:00:01Z');
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(1);
      expect(await scheduler.getNextScheduledBackupTime()).toEqual(new Date('2026-01-23T03:00:00Z'));
    });

    it('backs up at the default time when the stored time is not a time', async () => {
      vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
      const t = setup(enabled({ backup_time: '25:99' }), [backupAt('2026-01-09T03:00:00Z')]);
      scheduler = t.scheduler;
      await scheduler.startScheduler();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.backupService.createBackup).not.toHaveBeenCalled();
      expect(await scheduler.getNextScheduledBackupTime()).toEqual(new Date('2026-01-16T03:00:00Z'));
    });
  });

  describe('missed backups', () => {
    it('runs one catch-up at start, even after a restart', async () => {
      vi.setSystemTime(new Date('2026-01-10T01:00:00Z'));
      const t = setup(enabled());
      scheduler = t.scheduler;
      await scheduler.startScheduler();
      await scheduler.updateSchedule(); // a settings save restarts it

      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(1);
      // The catch-up was this cycle's backup: the next one is a frequency later, not tonight.
      expect(await scheduler.getNextScheduledBackupTime()).toEqual(new Date('2026-01-17T03:00:00Z'));
    });

    it('catches up when the newest backup is older than the frequency', async () => {
      vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
      const t = setup(enabled(), [backupAt('2026-01-01T03:00:00Z')]);
      scheduler = t.scheduler;
      await scheduler.startScheduler();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.backupService.createBackup).toHaveBeenCalledTimes(1);
    });
  });

  describe('state and timers', () => {
    it('arms nothing while backups are disabled, and says so', async () => {
      vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
      const t = setup(enabled({ backup_enabled: 'false' }));
      scheduler = t.scheduler;
      await scheduler.startScheduler();

      expect(vi.getTimerCount()).toBe(0);
      expect(await scheduler.isSchedulerRunning()).toBe(false);
      expect(await scheduler.getSchedulerStatus()).toMatchObject({ enabled: false, running: false, nextBackupTime: null });
      await vi.advanceTimersByTimeAsync(30 * DAY);
      expect(t.backupService.createBackup).not.toHaveBeenCalled();
    });

    it('clears every timer it armed when stopped', async () => {
      vi.setSystemTime(new Date('2026-01-10T01:00:00Z'));
      const t = setup(enabled()); // no backups: a catch-up is queued
      scheduler = t.scheduler;
      await scheduler.startScheduler();
      await scheduler.stopScheduler();

      expect(vi.getTimerCount()).toBe(0);
      expect(await scheduler.getSchedulerStatus()).toMatchObject({ running: false, nextBackupTime: null });
    });

    it('records how the last run went, and keeps the schedule after a failure', async () => {
      vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
      const t = setup(enabled(), [backupAt('2026-01-01T03:00:00Z')]);
      t.backupService.createBackup.mockRejectedValueOnce(new Error('pg_dump failed'));
      scheduler = t.scheduler;
      await scheduler.startScheduler();
      await vi.advanceTimersByTimeAsync(60_000);

      const status = await scheduler.getSchedulerStatus();
      expect(status).toMatchObject({ running: true, hasRunningBackup: false, lastRunOutcome: 'failed' });
      expect(status.lastRunStartedAt).toBeInstanceOf(Date);
      expect(status.lastRunFinishedAt).toBeInstanceOf(Date);
      expect(status.nextBackupTime).toEqual(new Date('2026-01-17T03:00:00Z'));

      await advanceTo('2026-01-17T03:00:01Z');
      expect((await scheduler.getSchedulerStatus()).lastRunOutcome).toBe('success');
    });
  });

  describe('retention', () => {
    it('never deletes the newest backups, even when every file reports the epoch as its date', async () => {
      // Node reports birthtime as the epoch on filesystems without it (NFS/SMB shares).
      vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
      const epoch = (name: string): Backup => ({ fileName: name, filePath: `/backups/${name}`, size: 1, created: new Date(0) });
      const old = ['20251201', '20251202', '20251203', '20251204', '20251205'].map((d) => epoch(`nuggets_backup_${d}_030000.enc`));
      const t = setup(enabled(), old);
      t.backupService.createBackup.mockImplementationOnce(async () => {
        const made = epoch('nuggets_backup_20260110_120010.enc');
        t.backups.push(made);
        return { fileName: made.fileName, filePath: made.filePath, fileSize: 1 };
      });
      scheduler = t.scheduler;
      await scheduler.startScheduler();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(t.backupService.createBackup).toHaveBeenCalledTimes(1);
      expect(t.backupService.deleteBackup.mock.calls.map((call) => call[0]).sort()).toEqual([
        'nuggets_backup_20251201_030000.enc',
        'nuggets_backup_20251202_030000.enc',
        'nuggets_backup_20251203_030000.enc',
      ]);
      expect(t.backups.map((b) => b.fileName)).toContain('nuggets_backup_20260110_120010.enc');
    });
  });
});
