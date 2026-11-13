import { BACKUP_DAYS_RANGE } from '@nuggets/shared';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.generated.js';
import { BackupService, BackupInProgressError, ShuttingDownError } from './BackupService.js';
import { OneDriveService } from './OneDriveService.js';
import { lastScheduledRun } from './backup/backupRuns.js';
import { createLogger } from '../utils/logger.js';
import { globalDb, runDetached } from '../db/withTenant.js';
import { isValidTimeZone, timeOnDayAfter } from '../utils/syncSchedule.js';
import { readSystemSetting, readSystemSettings } from './systemSettings.js';
import type { Scheduler } from './schedulers/SchedulerRegistry.js';

const logger = createLogger({ service: 'BackupScheduler' });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The longest single timer. Node cuts any delay over 2^31-1 ms (about 24.8 days) to
 * 1 ms, so a 30-day frequency armed as one timer ran a backup every millisecond. Longer
 * waits are made of hops, each checking whether the backup is due yet.
 */
const MAX_TIMER_MS = DAY_MS;

/** The shortest timer. */
const MIN_TIMER_MS = 1000;

/**
 * The least time between two backups this timer starts. A due time that came out in the
 * past (a midnight DST gap did, once) re-armed at MIN_TIMER_MS and backed up every second.
 */
const MIN_RUN_GAP_MS = 60 * 60 * 1000;

/** How long after start a catch-up backup (none yet, or the newest is overdue) waits. */
const CATCH_UP_DELAY_MS = 10_000;

/** Retention never deletes the newest backups, whatever dates the files report. */
const MIN_BACKUPS_KEPT = 3;

/**
 * A scheduled backup that finds the backup lock held by a verify (here, or the restore
 * command's in another process) tries again this often, rather than skip the whole period.
 */
const LOCK_RETRY_MS = 5 * 60 * 1000;

/** For at most this long: a lock held longer than that is not a verify. */
const LOCK_RETRY_FOR_MS = 12 * 60 * 60 * 1000;


const DEFAULT_FREQUENCY_DAYS = 7;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_BACKUP_TIME = '03:00';

interface BackupSettings {
  enabled: boolean;
  backupTime: string;
  retentionDays: number;
  frequencyDays: number;
  timezone: string;
}

export interface BackupSchedulerStatus {
  /** `backup_enabled` as saved. */
  enabled: boolean;
  /** A timer is armed for the next backup. */
  running: boolean;
  shuttingDown: boolean;
  hasRunningBackup: boolean;
  /** When the armed timer runs the next backup, or null when nothing is armed. */
  nextBackupTime: Date | null;
  lastRunStartedAt: Date | null;
  lastRunFinishedAt: Date | null;
  lastRunOutcome: 'success' | 'failed' | null;
  /** Backups are on but no backup key exists yet, so nothing is armed until one does. */
  waitingForBackupKey: boolean;
  /** Backups are made with the old backup key: an upgraded install with no backup key set up yet. */
  usingOldBackupKey: boolean;
}

/** An integer setting within `range`, or `fallback` (with a warning) when it isn't one. */
function daysSetting(key: string, raw: string | null | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (Number.isInteger(value) && value >= BACKUP_DAYS_RANGE.min && value <= BACKUP_DAYS_RANGE.max) return value;
  if (raw != null && raw !== '') {
    logger.warn({ key, value: raw, fallback }, 'Backup setting is out of range, using the default');
  }
  return fallback;
}

/**
 * Runs the automatic backup every `backup_frequency_days` days at `backup_time`, in the
 * deployment's time zone (`application_timezone` in system_settings; a ledger's own zone is
 * in tenant_settings).
 *
 * The timer is a self-rescheduling `setTimeout` of at most a day, re-armed from the
 * calendar before each backup is awaited. The next backup is due
 * at the backup time `frequencyDays` calendar days after the last one this scheduler ran,
 * or, at start, after the newest backup there is; with none, or the newest overdue, a
 * catch-up runs shortly after start. That check runs only in `startScheduler`: the status
 * getters read state and never start a backup.
 */
export class BackupScheduler implements Scheduler {
  private db: Kysely<DB>;
  private backupService: BackupService;
  private oneDriveService: OneDriveService;
  private timer: NodeJS.Timeout | null = null;
  private nextRunAt: Date | null = null;
  private isShuttingDown: boolean = false;
  private currentBackupPromise: Promise<void> | null = null;
  private enabled: boolean = false;
  private lastRunStartedAt: Date | null = null;
  private lastRunFinishedAt: Date | null = null;
  private lastRunOutcome: 'success' | 'failed' | null = null;
  private lastKnownSettings: BackupSettings | null = null;
  /** When this timer last started a backup, for MIN_RUN_GAP_MS. */
  private lastTimerRunAt: Date | null = null;
  /** Bumped by every start and stop, so work begun before one can't arm a timer after it. */
  private generation = 0;
  private waitingForBackupKey = false;
  private usingOldBackupKey = false;
  /** A retry of a scheduled backup the backup lock held up (LOCK_RETRY_MS). */
  private retryTimer: NodeJS.Timeout | null = null;

  /**
   * @param options.db where it reads its settings (system_settings, control plane): globalDb,
   *   or a test's stand-in. It needs no connection of its own: BackupService holds the backup lock.
   */
  constructor(backupService: BackupService, oneDriveService: OneDriveService, options: { db?: Kysely<DB> | undefined } = {}) {
    this.db = options.db ?? globalDb;
    this.backupService = backupService;
    this.oneDriveService = oneDriveService;
  }

  async startScheduler(): Promise<void> {
    // A backup still running from before is left to finish: BackupService runs one at a time.
    this.clearTimer();
    this.isShuttingDown = false;
    const generation = ++this.generation;

    this.waitingForBackupKey = false;
    this.usingOldBackupKey = false;
    try {
      const settings = await this.getBackupSettings();
      this.enabled = settings.enabled;
      if (!settings.enabled) {
        logger.info('Automatic backups are disabled (backup_enabled != true) — not arming the backup timer');
        return;
      }

      // Every backup is encrypted to the backup keys, so without one a backup can only
      // fail: a fresh install logged that as an error a minute after starting. Wait for
      // one instead; adding it restarts the scheduler (POST /api/backup/recipients). An
      // upgraded install that has the old key keeps making backups with it meanwhile.
      const encryption = await this.backupService.encryptionState();
      if (generation !== this.generation) return;
      this.usingOldBackupKey = encryption.mode === 'legacy';
      if (encryption.mode === 'none') {
        this.waitingForBackupKey = true;
        logger.warn('Automatic backups are on, but no backup key has been set up yet: they start once one is, in Settings → Database Backup');
        return;
      }
      if (this.usingOldBackupKey) {
        logger.warn('Automatic backups still use the old backup key: set up a backup key in Settings → Database Backup');
      }

      // The one missed-backup check: from the newest backup there is.
      const newest = await this.newestBackupTime();
      const due = newest ? this.dueAfter(newest, settings) : null;
      if (due && due.getTime() > Date.now()) {
        this.arm(this.capped(due, settings, 'The newest backup is dated in the future'), settings, generation);
      } else {
        logger.info({
          newestBackup: newest?.toISOString() ?? null,
          frequencyDays: settings.frequencyDays,
        }, 'No backup within the frequency — running a catch-up backup shortly');
        this.arm(new Date(Date.now() + CATCH_UP_DELAY_MS), settings, generation);
      }
    } catch (error) {
      // Nothing is armed: say so, as the sync scheduler does.
      logger.error({ err: error }, 'Error starting backup scheduler');
      throw error;
    }
  }

  async stopScheduler(): Promise<void> {
    logger.info('Stopping backup scheduler');
    this.isShuttingDown = true;
    this.generation++;
    this.waitingForBackupKey = false;
    this.usingOldBackupKey = false;
    this.clearTimer();

    // Wait for any currently running backup operation to complete
    if (this.currentBackupPromise) {
      logger.info('Waiting for current backup operation to complete');
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.currentBackupPromise,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Backup timeout during shutdown')), 60000); // 60s timeout for backups
          })
        ]);
        logger.info('Current backup operation completed');
      } catch (error) {
        logger.warn({ err: error }, 'Current backup operation timed out or failed during shutdown');
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }

    logger.info('Backup scheduler stopped successfully');
  }

  /** Re-read the settings and re-arm (or disarm, when backups were turned off). */
  async updateSchedule(): Promise<void> {
    logger.info('Updating backup schedule');
    await this.startScheduler();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.nextRunAt = null;
  }

  /** The backup time `frequencyDays` calendar days after the day `from` falls on. */
  private dueAfter(from: Date, settings: BackupSettings, days = settings.frequencyDays): Date {
    return timeOnDayAfter(from, days, settings.backupTime, settings.timezone, DEFAULT_BACKUP_TIME);
  }

  /**
   * `due`, or a frequency from today when it is later than that: a backup dated in the
   * future, or a clock moved back, would otherwise stop automatic backups until then.
   */
  private capped(due: Date, settings: BackupSettings, reason: string): Date {
    const cap = this.dueAfter(new Date(), settings);
    if (due.getTime() <= cap.getTime()) return due;
    logger.warn({ due: due.toISOString(), cap: cap.toISOString() }, `${reason} — backing up a frequency from today instead`);
    return cap;
  }

  /**
   * The backup after one due at `dueAt`: a frequency after the day it was due, so a timer
   * that fires late (past midnight, after a sleep) doesn't push the schedule back. When
   * that is less than MIN_RUN_GAP_MS away, a frequency from today, a day later at a time
   * until it isn't.
   */
  private nextAfter(dueAt: Date, settings: BackupSettings): Date {
    const now = new Date();
    const earliest = now.getTime() + MIN_RUN_GAP_MS;
    let next = this.dueAfter(dueAt, settings);
    for (let days = settings.frequencyDays; next.getTime() < earliest && days <= settings.frequencyDays + 2; days++) {
      next = this.dueAfter(now, settings, days);
    }
    return next;
  }

  /**
   * `due`, or later: not within MIN_RUN_GAP_MS of the last backup this timer started (say a
   * restart right after one that left no file). A last run "in the future" means the clock
   * moved back, and doesn't count.
   */
  private notTooSoon(due: Date): Date {
    const last = this.lastTimerRunAt?.getTime();
    if (last !== undefined && last <= Date.now() && due.getTime() < last + MIN_RUN_GAP_MS) {
      return new Date(last + MIN_RUN_GAP_MS);
    }
    return due;
  }

  private arm(due: Date, settings: BackupSettings, generation: number): void {
    if (this.isShuttingDown || generation !== this.generation) return;
    this.clearTimer();
    const next = this.notTooSoon(due);
    this.nextRunAt = next;
    this.armHop();

    logger.info({
      nextBackupTime: next.toISOString(),
      nextBackupLocal: next.toLocaleString('en-US', { timeZone: settings.timezone }),
      timezone: settings.timezone,
      frequencyDays: settings.frequencyDays,
    }, 'Next automatic backup scheduled');
  }

  /** One timer towards `nextRunAt`: the rest of the wait, between MIN_TIMER_MS and MAX_TIMER_MS. */
  private armHop(): void {
    if (!this.nextRunAt) return;
    const remaining = this.nextRunAt.getTime() - Date.now();
    const delay = Math.min(Math.max(remaining, MIN_TIMER_MS), MAX_TIMER_MS);
    // Armed with no request, tenant transaction or tenant scope: a start from an
    // admin's request otherwise ran every backup with that request's finished transaction
    // as getDb().
    this.timer = runDetached(() =>
      setTimeout(() => {
        void this.onTimerFired();
      }, delay)
    );
  }

  /**
   * Timer callback: another hop when the backup isn't due yet; otherwise re-read the
   * settings, arm the next cycle, and only then run the backup, so a backup that throws
   * or hangs costs one cycle, never the schedule.
   */
  private async onTimerFired(): Promise<void> {
    this.timer = null;
    if (this.isShuttingDown || !this.nextRunAt) return;

    if (Date.now() < this.nextRunAt.getTime()) {
      if (this.lastKnownSettings) {
        this.nextRunAt = this.notTooSoon(this.capped(this.nextRunAt, this.lastKnownSettings, 'The clock moved back'));
      }
      this.armHop();
      return;
    }

    const generation = this.generation;
    const dueAt = this.nextRunAt;
    this.nextRunAt = null;

    let settings: BackupSettings;
    try {
      settings = await this.getBackupSettings();
      this.enabled = settings.enabled;
    } catch (error) {
      logger.error({ err: error }, 'Could not read backup settings when a backup was due — using the last ones read');
      if (!this.lastKnownSettings) {
        logger.error('No backup settings read before — the backup timer is not re-armed');
        return;
      }
      settings = this.lastKnownSettings;
    }

    if (generation !== this.generation || this.isShuttingDown) return;
    if (!settings.enabled) {
      logger.info('Automatic backups were disabled since the timer was armed — stopping the backup timer');
      return;
    }

    this.lastTimerRunAt = new Date();
    this.arm(this.nextAfter(dueAt, settings), settings, generation);
    await this.performScheduledBackup(settings);
  }

  private async getBackupSettings(): Promise<BackupSettings> {
    const stored = await readSystemSettings(
      ['backup_enabled', 'backup_time', 'backup_retention_days', 'backup_frequency_days', 'application_timezone'] as const,
      this.db
    );
    const timezone = stored.application_timezone;
    const settings: BackupSettings = {
      enabled: stored.backup_enabled === 'true',
      backupTime: stored.backup_time || DEFAULT_BACKUP_TIME,
      retentionDays: daysSetting('backup_retention_days', stored.backup_retention_days, DEFAULT_RETENTION_DAYS),
      frequencyDays: daysSetting('backup_frequency_days', stored.backup_frequency_days, DEFAULT_FREQUENCY_DAYS),
      // An unknown zone would make every date call on it throw.
      timezone: timezone && isValidTimeZone(timezone) ? timezone : 'UTC',
    };

    this.lastKnownSettings = settings;
    return settings;
  }

  private async newestBackupTime(): Promise<Date | null> {
    const backups = await this.backupService.listBackups();
    let newest: Date | null = null;
    for (const backup of backups) {
      if (!newest || backup.created > newest) newest = backup.created;
    }
    return newest;
  }

  private async performScheduledBackup(settings: BackupSettings, retry: { since: number; until: number } | null = null): Promise<void> {
    // Don't start new backup operations if shutting down
    if (this.isShuttingDown) {
      logger.info('Skipping scheduled backup - scheduler is shutting down');
      return;
    }
    // A retry: another process held the lock. If that was a server sharing this backup
    // directory making its own backup, this period has one: don't make a second.
    if (retry) {
      const newest = await this.newestBackupTime().catch(() => null);
      if (newest && newest.getTime() >= retry.since - MIN_RUN_GAP_MS) {
        logger.info({ newestBackup: newest.toISOString() }, 'A backup was made while the lock was held — this period has its backup');
        return;
      }
    }
    if (this.currentBackupPromise) {
      logger.warn('Previous scheduled backup is still running — skipping this cycle');
      return;
    }

    logger.info('Performing scheduled automatic backup');
    const startedAt = new Date();
    const run = (async () => {
      await this.runAutomaticBackup(settings);
      logger.info('Scheduled backup completed successfully');
      // Clean up old backups after successful backup
      await this.cleanupOldBackups(settings);
    })();
    // Tracked for graceful shutdown; settled either way.
    this.currentBackupPromise = run.catch(() => {});

    let outcome: 'success' | 'failed';
    try {
      await run;
      outcome = 'success';
    } catch (error) {
      if (error instanceof BackupInProgressError) {
        if (error.heldBy === 'backup') {
          // A manual backup here is making one right now: that is this period's backup.
          logger.warn({ err: error }, 'Another backup is in progress — skipping this scheduled backup');
          return;
        }
        // A verify (here, or the restore command's), or another process: it ends in minutes,
        // and skipping would cost the whole period's backup. Try again until it has.
        const since = retry?.since ?? startedAt.getTime();
        const until = retry?.until ?? Date.now() + LOCK_RETRY_FOR_MS;
        if (Date.now() + LOCK_RETRY_MS > until) {
          logger.warn({ err: error }, 'The backup lock stayed held — skipping this scheduled backup');
          return;
        }
        logger.info({ heldBy: error.heldBy, retryInMs: LOCK_RETRY_MS }, 'The backup lock is held — trying the scheduled backup again shortly');
        this.armRetry(settings, { since, until });
        return;
      }
      if (error instanceof ShuttingDownError) {
        // Due in the moment before the scheduler was stopped: not a failed backup.
        logger.info('The server is shutting down — skipping this scheduled backup');
        return;
      }
      outcome = 'failed';
      // Logged, not rethrown: the next backup is already armed and must still run.
      logger.error({ err: error }, 'Scheduled backup failed');
    } finally {
      this.currentBackupPromise = null;
    }

    this.lastRunStartedAt = startedAt;
    this.lastRunFinishedAt = new Date();
    this.lastRunOutcome = outcome;
  }

  /** Try a held-up scheduled backup again in LOCK_RETRY_MS, unless the scheduler stops or restarts first. */
  private armRetry(settings: BackupSettings, retry: { since: number; until: number }): void {
    const generation = this.generation;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = runDetached(() =>
      setTimeout(() => {
        this.retryTimer = null;
        if (this.isShuttingDown || generation !== this.generation) return;
        void this.performScheduledBackup(settings, retry);
      }, LOCK_RETRY_MS)
    );
  }

  private async runAutomaticBackup(settings: BackupSettings): Promise<void> {
    // Encrypted to the backup keys, like a manual backup.
    logger.info({ frequencyDays: settings.frequencyDays }, 'Creating automatic backup');
    const result = await this.backupService.createBackup({ trigger: 'scheduled' });
    logger.info({ fileName: result.fileName }, 'Automatic backup created');

    // Auto-upload to OneDrive for all users with auto-sync enabled
    try {
      if (await this.oneDriveService.isConfigured()) {
        for (const userId of await this.oneDriveService.getUserIdsWithAutoSync()) {
          try {
            await this.oneDriveService.uploadFile(userId, result.filePath, result.fileName);
            logger.info({ userId, fileName: result.fileName }, 'Scheduled backup auto-uploaded to OneDrive');
          } catch (error) {
            logger.error({ err: error, userId, fileName: result.fileName }, 'Failed to auto-upload scheduled backup to OneDrive');
          }
        }
      } else {
        // Copies were asked for but there is no app registration to use: none saved (a stack
        // that set it in the environment, which is no longer read), or it can't be read. Say
        // so rather than skip them in silence.
        const waiting = (await this.oneDriveService.getUserIdsWithAutoSync()).length;
        if (waiting > 0) {
          logger.warn(
            { users: waiting, fileName: result.fileName },
            "Scheduled backup not copied to OneDrive: its app registration isn't set up (Settings → Database Backup)"
          );
        }
      }
    } catch (error) {
      logger.warn({ err: error }, 'OneDrive auto-upload check failed during scheduled backup');
    }
  }

  private async cleanupOldBackups(settings: BackupSettings): Promise<void> {
    try {
      logger.info('Cleaning up old backups');

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - settings.retentionDays); // Default 90 days

      // Newest first (names carry the time, so they break ties), and never the newest few:
      // a filesystem that misreports dates must not cost every backup.
      const backups = (await this.backupService.listBackups()).sort(
        (a, b) => b.created.getTime() - a.created.getTime() || b.fileName.localeCompare(a.fileName)
      );
      const oldBackups = backups.slice(MIN_BACKUPS_KEPT).filter(backup => backup.created < cutoffDate);

      if (oldBackups.length === 0) {
        logger.info('No old backups to clean up');
        return;
      }

      logger.info({ oldBackupCount: oldBackups.length, retentionDays: settings.retentionDays }, 'Found old backups to delete');

      for (const backup of oldBackups) {
        try {
          await this.backupService.deleteBackup(backup.fileName);
          logger.info({ fileName: backup.fileName }, 'Deleted old backup');
        } catch (error) {
          logger.error({ err: error, fileName: backup.fileName }, 'Failed to delete backup');
        }
      }

      logger.info({ deletedCount: oldBackups.length }, 'Backup cleanup completed');

    } catch (error) {
      logger.error({ err: error }, 'Error during backup cleanup');
    }
  }

  /**
   * When the armed timer runs the next backup, or null when nothing is armed. Reads
   * state only: it used to run the missed-backup check, so each status read could queue
   * another backup.
   */
  async getNextScheduledBackupTime(): Promise<Date | null> {
    return this.nextRunAt;
  }

  /** True when a timer is armed, not merely when the scheduler exists. */
  isTimerArmed(): boolean {
    return this.timer !== null;
  }

  async isSchedulerRunning(): Promise<boolean> {
    return this.isTimerArmed();
  }

  async hasRunningBackupOperation(): Promise<boolean> {
    return this.currentBackupPromise !== null;
  }

  /**
   * `backup_enabled` as saved now, not as last read: /scheduler/stop saves it, then stops
   * the timer without a re-read. Falls back to the last value read if the read fails.
   */
  private async readEnabled(): Promise<boolean> {
    try {
      this.enabled = (await readSystemSetting('backup_enabled', this.db)) === 'true';
    } catch (error) {
      logger.warn({ err: error }, 'Could not read backup_enabled for the status — reporting the last value read');
    }
    return this.enabled;
  }

  /**
   * The last scheduled run, kept in memory since this process started, else the newest one
   * recorded (backup_runs): the health check's "last run failed" survives a restart.
   */
  private async lastRun(): Promise<{ startedAt: Date | null; finishedAt: Date | null; outcome: 'success' | 'failed' | null }> {
    if (this.lastRunOutcome !== null) {
      return { startedAt: this.lastRunStartedAt, finishedAt: this.lastRunFinishedAt, outcome: this.lastRunOutcome };
    }
    try {
      const recorded = await lastScheduledRun(this.db);
      if (recorded) return recorded;
    } catch (error) {
      logger.warn({ err: error }, 'Could not read the last scheduled backup run');
    }
    return { startedAt: null, finishedAt: null, outcome: null };
  }

  async getSchedulerStatus(): Promise<BackupSchedulerStatus> {
    const last = await this.lastRun();
    return {
      enabled: await this.readEnabled(),
      running: this.isTimerArmed(),
      shuttingDown: this.isShuttingDown,
      hasRunningBackup: await this.hasRunningBackupOperation(),
      nextBackupTime: this.nextRunAt,
      lastRunStartedAt: last.startedAt,
      lastRunFinishedAt: last.finishedAt,
      lastRunOutcome: last.outcome,
      waitingForBackupKey: this.waitingForBackupKey,
      usingOldBackupKey: this.usingOldBackupKey,
    };
  }
}
