import { ImportService } from './ImportService.js';
import { getDb, runDetached } from '../db/withTenant.js';
import { getActiveTenantIds } from '../db/forEachTenant.js';
import { createLogger } from '../utils/logger.js';
import { appTimezone } from '../utils/appDate.js';
import { inTenantScope, readTenantSettings, writeTenantSettings } from './tenantSettings.js';
import { nextSyncTime, normalizeFrequency, timeOnDayAfter, type SyncFrequency } from '../utils/syncSchedule.js';
import type { Scheduler } from './schedulers/SchedulerRegistry.js';

const logger = createLogger({ service: 'SyncScheduler' });

/** How often the scheduler looks for ledgers whose import is due. */
export const SYNC_TICK_MS = 5 * 60 * 1000;

/**
 * A single run may not wedge the scheduler forever. `runFullSync` already aborts its
 * SimpleFin fetches after 60s, but a blocked DB statement has no such bound. So each
 * ledger's sync gets TENANT_TIMEOUT_MS, and the run RUN_TIMEOUT_MS in all: a ledger past
 * its limit is left to finish on its own (its sync claim keeps another from starting on
 * it) and the run goes on to the next; once the run's time is up it starts no more, and
 * records which ledgers timed out and which it didn't reach. A ledger
 * not reached is still due at the next tick.
 */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const TENANT_TIMEOUT_MS = 10 * 60 * 1000;

/** What the last run did with each ledger it found due (tenant ids). */
export interface SyncRunTenants {
  /** The ledgers whose import was due. */
  total: number;
  succeeded: number[];
  failed: number[];
  /** Ran past TENANT_TIMEOUT_MS (or the run's time left): left to finish on its own. */
  timedOut: number[];
  /** Not started: the run's time was up, or the scheduler was stopped (a shutdown or a restore). */
  notReached: number[];
  /** Not started: still running from an earlier run, past its limit there. */
  stillRunning: number[];
}

export interface SyncSchedulerOptions {
  runTimeoutMs?: number;
  tenantTimeoutMs?: number;
}

/**
 * How the last run ended: `timed_out` when a ledger ran past its limit or the run's time
 * was up before it reached them all; `stopped` when a shutdown or a restore stopped it
 * before it reached them all; `failed` when every ledger it ran failed.
 */
export type SyncRunOutcome = 'success' | 'failed' | 'timed_out' | 'stopped';

/** A ledger's automatic import schedule, from its own settings. */
export interface TenantImportSchedule {
  enabled: boolean;
  frequency: SyncFrequency;
  /** Local time of day, HH:MM, in the ledger's time zone. */
  syncTime: string;
  timezone: string;
  /** When the scheduler last imported the ledger successfully. */
  lastAutoSync: Date | null;
  /**
   * When the scheduler last started the ledger's import, whether it succeeded or not
   * (import_last_attempt): a failed one isn't tried again before the next scheduled time,
   * across a restart too.
   */
  lastAttempt: Date | null;
  /** When automatic import was last turned on (the import_enabled row last changed). */
  enabledSince: Date | null;
}

export interface SyncSchedulerStatus {
  /** Whether any ledger had automatic import on at the last check. */
  enabled: boolean;
  /** The tick that looks for due ledgers is armed. */
  running: boolean;
  /** Stopped: arms no tick until started again. */
  shuttingDown: boolean;
  hasRunningSync: boolean;
  /** When the next check runs, or null when nothing is armed. */
  nextSyncTime: Date | null;
  lastRunStartedAt: Date | null;
  lastRunFinishedAt: Date | null;
  lastRunOutcome: SyncRunOutcome | null;
  /** The last run's ledgers, by outcome; null before the first run. */
  lastRunTenants: SyncRunTenants | null;
}

function parseInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The current ledger's import schedule, read in its own transaction (or the open one),
 * with its time zone as app_timezone() has it. `tenantId` names the ledger when no tenant
 * scope does.
 */
export async function readTenantImportSchedule(tenantId: number | null = null): Promise<TenantImportSchedule> {
  const read = async () => {
    const settings = await readTenantSettings([
      'import_enabled',
      'import_sync_frequency',
      'import_sync_time',
      'import_last_auto_sync',
      'import_last_attempt',
    ]);
    const enabled = settings.import_enabled === 'true';
    const enabledRow = enabled
      ? await getDb()
          .selectFrom('tenant_settings')
          .select('updated_at')
          .where('setting_key', '=', 'import_enabled')
          .executeTakeFirst()
      : undefined;
    return {
      enabled,
      frequency: normalizeFrequency(settings.import_sync_frequency),
      syncTime: settings.import_sync_time || '02:00',
      timezone: await appTimezone(),
      lastAutoSync: parseInstant(settings.import_last_auto_sync),
      lastAttempt: parseInstant(settings.import_last_attempt),
      enabledSince: enabledRow ? new Date(enabledRow.updated_at) : null,
    };
  };
  // In the ledger's transaction: the open one, or a short one of its own (the status
  // route runs with none open).
  return inTenantScope(tenantId, read);
}

type ScheduleTimes = Pick<TenantImportSchedule, 'frequency' | 'syncTime' | 'timezone'>;

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

/**
 * The scheduled run after one at `ran`. Both count from the scheduled time the run
 * belonged to (the one within 12 hours of it), so a run that ends just after midnight
 * still counts for the day it was scheduled on. Weekly: that time a week on. Daily: the
 * first scheduled time at least 12 hours after the run, so a catch-up run just before the
 * day's time doesn't run again at it.
 */
export function nextRunAfterRun(schedule: ScheduleTimes, ran: Date): Date {
  if (schedule.frequency === 'weekly') {
    const slot = nextSyncTime(schedule.syncTime, 'daily', schedule.timezone, new Date(ran.getTime() - TWELVE_HOURS_MS));
    return timeOnDayAfter(slot, 7, schedule.syncTime, schedule.timezone);
  }
  return nextSyncTime(schedule.syncTime, 'daily', schedule.timezone, new Date(ran.getTime() + TWELVE_HOURS_MS));
}

/** The first scheduled time strictly after `from` (the first run after turning import on). */
export function firstRunAfter(schedule: ScheduleTimes, from: Date): Date {
  return nextSyncTime(schedule.syncTime, 'daily', schedule.timezone, from);
}

/**
 * When the ledger's next automatic import is due: after its last run (or last attempt, when
 * one failed since), and never before the first scheduled time after import was turned on.
 * With neither, the first scheduled time after `fallback`.
 */
export function dueAt(schedule: TenantImportSchedule, lastAttempt: Date | null, fallback: Date): Date {
  const candidates: Date[] = [];
  if (schedule.lastAutoSync) candidates.push(nextRunAfterRun(schedule, schedule.lastAutoSync));
  if (lastAttempt) candidates.push(nextRunAfterRun(schedule, lastAttempt));
  if (schedule.enabledSince) candidates.push(firstRunAfter(schedule, schedule.enabledSince));
  if (candidates.length === 0) candidates.push(firstRunAfter(schedule, fallback));
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
}

/**
 * When the ledger's next automatic import is due, as the status route shows it; null when
 * its automatic import is off. A run that is overdue (missed while the server was down)
 * is due now: the next check runs it. One that failed waits for the next scheduled time.
 */
export function nextRunForTenant(schedule: TenantImportSchedule, now: Date = new Date()): Date | null {
  if (!schedule.enabled) return null;
  const next = dueAt(schedule, schedule.lastAttempt, now);
  return next.getTime() < now.getTime() ? now : next;
}


/**
 * Runs each ledger's automatic bank import on its own schedule.
 *
 * Every SYNC_TICK_MS a run reads each active ledger's schedule (import_enabled,
 * import_sync_frequency, import_sync_time, its time zone and when it last imported) and
 * syncs the ledgers whose next run has come ({@link dueAt}), one after another, outside any
 * transaction, each within its time limit. Turning import on doesn't import at
 * once: the first run is at the next scheduled time. A ledger started and failed isn't
 * retried before its following scheduled time: the start is stored as the ledger's
 * import_last_attempt before it runs, so a restart doesn't retry it either; one a
 * run didn't reach is due again at the next tick. Settings are read on every run, so a
 * change takes effect without a restart.
 *
 * Only a shutdown or a restore (stopScheduler) stops a run in progress, after the ledger
 * it is on. Saving the schedule or a restart re-arms the tick (startScheduler), and an
 * admin's stop disarms it (stopTimer); a run in progress goes on through its ledgers.
 */
export class SyncScheduler implements Scheduler {
  private importService: ImportService;
  private tick: NodeJS.Timeout | null = null;
  private nextTickAt: Date | null = null;
  /** Stopped: no tick may be armed until startScheduler. Doesn't touch a run in progress. */
  private isShuttingDown = false;
  private currentSyncPromise: Promise<void> | null = null;
  /**
   * Stops the run in progress after the ledger it is on. Only stopScheduler (a shutdown,
   * a restore) aborts it; each run has its own, so starting the scheduler again doesn't
   * set a stopped run going again.
   */
  private currentRunStop: AbortController | null = null;
  private startedAt: Date | null = null;
  /**
   * When each ledger's sync was last started, so a failure waits for its next scheduled
   * time; stored too (import_last_attempt), and kept here for a ledger whose store failed.
   */
  private lastAttempt = new Map<number, Date>();
  private anyEnabled = false;
  private lastRunStartedAt: Date | null = null;
  private lastRunFinishedAt: Date | null = null;
  private lastRunOutcome: SyncRunOutcome | null = null;
  private lastRunTenants: SyncRunTenants | null = null;
  /** Ledger syncs that ran past their limit and haven't finished yet, by tenant id. */
  private readonly overrunning = new Map<number, Promise<void>>();
  private readonly runTimeoutMs: number;
  private readonly tenantTimeoutMs: number;

  constructor(importService: ImportService, options: SyncSchedulerOptions = {}) {
    this.importService = importService;
    this.runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
    this.tenantTimeoutMs = options.tenantTimeoutMs ?? TENANT_TIMEOUT_MS;
  }

  /**
   * Arm the tick, replacing the one armed. Throws when the ledgers can't be read (the
   * database is down), so startup tries again and an admin's start fails rather than
   * report a scheduler that isn't working. A run in progress goes on.
   */
  async startScheduler(): Promise<void> {
    try {
      this.clearTimer();
      this.isShuttingDown = false;
      await getActiveTenantIds();
    } catch (error) {
      logger.error({ err: error }, 'Error starting sync scheduler');
      throw error;
    }
    this.startedAt ??= new Date();
    this.armTick();
    logger.info({ tickMinutes: SYNC_TICK_MS / 60000 }, 'Import scheduler armed');
  }

  private armTick(): void {
    if (this.isShuttingDown) return;
    // One timer at a time: a start and a restart can both get here.
    this.clearTimer();
    this.nextTickAt = new Date(Date.now() + SYNC_TICK_MS);
    this.tick = runDetached(() =>
      setInterval(() => {
        this.nextTickAt = new Date(Date.now() + SYNC_TICK_MS);
        void this.performScheduledSync();
      }, SYNC_TICK_MS)
    );
  }

  private clearTimer(): void {
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
    this.nextTickAt = null;
  }

  /**
   * Disarm the tick and arm none until started again (an admin's stop). A run in
   * progress goes on through its ledgers.
   */
  stopTimer(): void {
    logger.info('Disarming the import scheduler; a run in progress goes on');
    this.isShuttingDown = true;
    this.clearTimer();
  }

  /**
   * Stop for a shutdown or a restore: disarm the tick, and stop the run in progress after
   * the ledger it is on (a ledger's sync isn't cut off part-way), waiting up to 30 s for
   * that. The run records the ledgers it didn't reach, and ends `stopped`.
   */
  async stopScheduler(): Promise<void> {
    logger.info('Stopping sync scheduler');
    this.isShuttingDown = true;
    this.clearTimer();
    this.currentRunStop?.abort();

    if (this.currentSyncPromise) {
      logger.info('Waiting for current sync operation to stop after the tenant it is on');
      try {
        await Promise.race([
          this.currentSyncPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Sync timeout during shutdown')), 30000)),
        ]);
        logger.info('Current sync operation completed');
      } catch (error) {
        logger.warn({ err: error }, 'Current sync operation timed out or failed during shutdown');
      }
    }
    logger.info('Sync scheduler stopped successfully');
  }

  /**
   * Re-arm (the settings routes call it after a change). Settings are read on every run,
   * so this doesn't wait for, or stop, a run in progress.
   */
  async updateSchedule(): Promise<void> {
    logger.info('Updating sync schedule');
    await this.startScheduler();
  }

  /**
   * Whether ledger `tenantId`'s import is due at `now`, given its schedule. Exposed for the
   * tests; each run calls it for every active ledger.
   */
  isDue(tenantId: number, schedule: TenantImportSchedule, now: Date = new Date()): boolean {
    if (!schedule.enabled) return false;
    const fallback = this.startedAt ?? now;
    const remembered = this.lastAttempt.get(tenantId) ?? null;
    const lastAttempt = [remembered, schedule.lastAttempt].reduce<Date | null>(
      (latest, at) => (at && (!latest || at > latest) ? at : latest),
      null
    );
    return dueAt(schedule, lastAttempt, fallback).getTime() <= now.getTime();
  }

  /** The active ledgers whose import is due at `now`, in tenant id order. */
  private async dueTenants(now: Date): Promise<number[]> {
    const due: number[] = [];
    let anyEnabled = false;
    for (const tenantId of await getActiveTenantIds()) {
      let schedule: TenantImportSchedule;
      try {
        schedule = await readTenantImportSchedule(tenantId);
      } catch (err) {
        logger.error({ err, tenantId }, "Could not read the tenant's import schedule");
        continue;
      }
      anyEnabled ||= schedule.enabled;
      if (this.isDue(tenantId, schedule, now)) due.push(tenantId);
    }
    this.anyEnabled = anyEnabled;
    return due;
  }

  /** A run: sync every ledger whose import is due. Exposed for the tests. */
  async checkDueTenants(now: () => Date = () => new Date()): Promise<void> {
    await this.performScheduledSync(now);
  }

  private async performScheduledSync(now: () => Date = () => new Date()): Promise<void> {
    // Stopped (a shutdown, a restore, an admin's stop): no new run.
    if (this.isShuttingDown) {
      logger.info('Skipping scheduled sync - scheduler is stopped');
      return;
    }
    // A previous run still in flight: overlapping them would double-import.
    if (this.currentSyncPromise) {
      logger.info('Previous import run is still going; skipping this tick');
      return;
    }

    const stop = new AbortController();
    this.currentRunStop = stop;
    const run = this.syncDueTenants(stop.signal, now);
    // What stopScheduler waits for. It settles either way: the `await run` below handles a
    // failed run (the ledger list unreadable, say), and this copy of it, rejecting too,
    // would be an unhandled rejection on every tick until the database is back.
    this.currentSyncPromise = run.then(
      () => {},
      () => {}
    );
    // Whether a run happened: a tick with no ledger due leaves the last run's report alone.
    let ran = false;
    try {
      const result = await run;
      if (!result) return; // nothing was due
      ran = true;
      const { tenants, stopped } = result;
      this.lastRunTenants = tenants;
      // Ledgers left out because the scheduler stopped are its doing, not a time limit's.
      const timedOut = tenants.timedOut.length > 0 || (tenants.notReached.length > 0 && !stopped);
      const allFailed = tenants.failed.length > 0 && tenants.succeeded.length === 0;
      this.lastRunOutcome = timedOut ? 'timed_out' : stopped ? 'stopped' : allFailed ? 'failed' : 'success';
      if (timedOut) {
        logger.error(
          { ...tenants, stopped },
          stopped
            ? 'Scheduled sync timed out: some tenants ran past their time, and the scheduler stopped before the rest'
            : 'Scheduled sync timed out: some tenants ran past their time, or were not reached'
        );
      } else if (stopped) {
        logger.warn({ ...tenants }, 'Scheduled sync stopped before every tenant: the scheduler is stopping (a shutdown or a restore)');
      } else {
        logger.info({ total: tenants.total, failed: tenants.failed.length }, 'Scheduled sync completed');
      }
    } catch (error) {
      // Logged, not rethrown: the tick stays armed and the next one must still run.
      ran = true;
      this.lastRunOutcome = 'failed';
      logger.error({ err: error }, 'Scheduled sync failed');
    } finally {
      if (ran) this.lastRunFinishedAt = new Date();
      this.currentSyncPromise = null;
      if (this.currentRunStop === stop) this.currentRunStop = null;
    }
  }

  /**
   * Sync each due ledger in turn, each in at most tenantTimeoutMs and all of them in
   * runTimeoutMs; resolves by then, with what happened to each, or with null when none
   * was due. Background jobs run outside any HTTP request, so each ledger's sync is named
   * its tenant. No transaction around it: a sync opens short ones around its
   * writes, none while SimpleFin answers. `stop` aborted (stopScheduler) starts no
   * further ledger; `stopped` says the run ended so.
   */
  private async syncDueTenants(
    stop: AbortSignal,
    now: () => Date
  ): Promise<{ tenants: SyncRunTenants; stopped: boolean } | null> {
    const tenantIds = await this.dueTenants(now());
    if (tenantIds.length === 0) return null;
    logger.info({ due: tenantIds.length }, 'Performing scheduled automatic sync');
    this.lastRunStartedAt = new Date();
    const deadline = Date.now() + this.runTimeoutMs;
    const tenants: SyncRunTenants = {
      total: tenantIds.length,
      succeeded: [],
      failed: [],
      timedOut: [],
      notReached: [],
      stillRunning: [],
    };

    for (const [index, tenantId] of tenantIds.entries()) {
      if (stop.aborted) {
        tenants.notReached.push(...tenantIds.slice(index));
        return { tenants, stopped: true };
      }
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) {
        tenants.notReached.push(...tenantIds.slice(index));
        break;
      }
      if (this.overrunning.has(tenantId)) {
        logger.warn({ tenantId }, 'Skipping this tenant: its sync from an earlier run is still going');
        tenants.stillRunning.push(tenantId);
        continue;
      }

      // Started: a failure waits for the ledger's next scheduled time, after a restart too.
      // Stored in a short transaction of the ledger's own, before the bank is asked.
      const attemptedAt = now();
      this.lastAttempt.set(tenantId, attemptedAt);
      try {
        await writeTenantSettings({ import_last_attempt: attemptedAt.toISOString() }, null, tenantId);
      } catch (err) {
        logger.error({ err, tenantId }, "Could not store the tenant's import attempt: a restart before its next scheduled time may try it again");
      }
      const sync = this.importService.runAutomaticSync(tenantId);
      let timer: NodeJS.Timeout | undefined;
      const limit = Math.min(this.tenantTimeoutMs, timeLeft);
      const outcome = await Promise.race([
        sync.then(
          () => 'succeeded' as const,
          (err: unknown) => {
            logger.error({ err, tenantId, job: 'automatic-sync' }, 'Per-tenant scheduled job failed');
            return 'failed' as const;
          }
        ),
        new Promise<'timedOut'>((resolve) => {
          timer = setTimeout(() => resolve('timedOut'), limit);
        }),
      ]);
      clearTimeout(timer);
      tenants[outcome].push(tenantId);

      if (outcome === 'timedOut') {
        logger.error({ tenantId, limitMs: limit }, "A tenant's scheduled sync ran past its time limit; going on without it");
        const settled = sync
          .catch((err: unknown) => logger.error({ err, tenantId }, "A tenant's overrunning scheduled sync failed"))
          .then(() => {
            this.overrunning.delete(tenantId);
            logger.warn({ tenantId }, "A tenant's overrunning scheduled sync has finished");
          });
        this.overrunning.set(tenantId, settled);
      }
    }

    return { tenants, stopped: false };
  }

  /** When the next check for due ledgers runs, or null when nothing is armed. */
  async getNextScheduledSyncTime(): Promise<Date | null> {
    return this.tick ? this.nextTickAt : null;
  }

  /** True when the tick is armed — not merely when the object exists. */
  isTimerArmed(): boolean {
    return this.tick !== null;
  }

  async isSchedulerRunning(): Promise<boolean> {
    return this.isTimerArmed();
  }

  /** A run is going, or a ledger's sync that ran past its limit hasn't finished yet. */
  async hasRunningSyncOperation(): Promise<boolean> {
    return this.currentSyncPromise !== null || this.overrunning.size > 0;
  }

  async getSchedulerStatus(): Promise<SyncSchedulerStatus> {
    return {
      enabled: this.anyEnabled,
      running: this.isTimerArmed(),
      shuttingDown: this.isShuttingDown,
      hasRunningSync: await this.hasRunningSyncOperation(),
      nextSyncTime: await this.getNextScheduledSyncTime(),
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunFinishedAt: this.lastRunFinishedAt,
      lastRunOutcome: this.lastRunOutcome,
      lastRunTenants: this.lastRunTenants,
    };
  }
}
