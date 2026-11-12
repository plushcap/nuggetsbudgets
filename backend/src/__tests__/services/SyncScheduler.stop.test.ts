import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { Pool } from 'pg';
import type { BackupService } from '../../services/BackupService.js';

/**
 * Only a shutdown or a restore stops a scheduled bank sync that is going. Saving the
 * import schedule (the lifecycle's updateSchedulerConfiguration → updateSchedule), an admin's restart or an
 * admin's stop re-arm or disarm the timer, and the run goes on through every ledger: it
 * used to stop after the ledger it was on, leave the rest for a day, and be logged as
 * "timed out". A run a shutdown does stop is recorded as stopped, not timed out.
 */
const tenants = vi.hoisted(() => ({ ids: [] as number[] }));
vi.mock('../../db/forEachTenant.js', () => ({ getActiveTenantIds: vi.fn(async () => tenants.ids) }));
// The scheduler stores each ledger's import attempt before it runs it; these tests
// have no database.
vi.mock('../../services/tenantSettings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/tenantSettings.js')>()),
  writeTenantSettings: vi.fn(async () => {}),
}));

const logged = vi.hoisted(() => [] as Array<{ level: string; msg: string }>);
vi.mock('../../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/logger.js')>();
  const record = (level: string) => (...args: unknown[]) => {
    logged.push({ level, msg: String(args.find((a) => typeof a === 'string') ?? '') });
  };
  const fake = {
    trace: record('trace'), debug: record('debug'), info: record('info'),
    warn: record('warn'), error: record('error'), fatal: record('fatal'),
    child: () => fake,
  };
  return { ...actual, createLogger: () => fake };
});

// The lifecycle's other schedulers are stand-ins: a restore's pause and resume start and
// stop them too, and these tests have no database.
vi.mock('../../services/BackupScheduler.js', () => ({
  BackupScheduler: class {
    async startScheduler() {}
    isTimerArmed() { return false; }
    async getNextScheduledBackupTime() { return null; }
    async stopScheduler() {}
  },
}));
vi.mock('../../services/NotificationScheduler.js', () => ({
  NotificationScheduler: class {
    async startScheduler() {}
    isSchedulerRunning() { return false; }
    async stopScheduler() {}
  },
}));
vi.mock('../../services/OneDriveService.js', () => ({ OneDriveService: class {} }));
vi.mock('../../services/NotificationRulesEngine.js', () => ({ NotificationRulesEngine: class {} }));
vi.mock('../../services/NotificationQueueService.js', () => ({ NotificationQueueService: class {} }));
vi.mock('../../services/EmailTemplateService.js', () => ({ EmailTemplateService: class { registerHelpers() {} } }));
vi.mock('../../services/EmailDeliveryService.js', () => ({ EmailDeliveryService: class {} }));
vi.mock('../../services/PushNotificationService.js', () => ({ PushNotificationService: class {} }));

const { SyncScheduler } = await import('../../services/SyncScheduler.js');
const { ApplicationLifecycleService } = await import('../../services/ApplicationLifecycleService.js');
type ImportService = ConstructorParameters<typeof SyncScheduler>[0];
type Scheduler = InstanceType<typeof SyncScheduler>;

const TENANT_MS = 300;

/** Each ledger's sync takes TENANT_MS (`slow` ones take `slowMs`). */
function importService(opts: { slow?: number[]; slowMs?: number } = {}) {
  const started: number[] = [];
  const finished: number[] = [];
  const service = {
    runAutomaticSync: vi.fn((tenantId: number) => {
      started.push(tenantId);
      const ms = opts.slow?.includes(tenantId) ? opts.slowMs ?? TENANT_MS : TENANT_MS;
      return new Promise<void>((resolve) => setTimeout(() => {
        finished.push(tenantId);
        resolve();
      }, ms));
    }),
  };
  return { service: service as unknown as ImportService, started, finished };
}

const performScheduledSync = (scheduler: Scheduler) =>
  (scheduler as unknown as { performScheduledSync(): Promise<void> }).performScheduledSync();

/** The lifecycle's own SyncScheduler, as POST /api/import/scheduler/* reach it. */
const syncSchedulerOf = (lifecycle: InstanceType<typeof ApplicationLifecycleService>) =>
  (lifecycle as unknown as { schedulers: { get(key: 'import'): { current: Scheduler } } }).schedulers.get('import').current;

function lifecycleWith(service: ImportService) {
  return new ApplicationLifecycleService({} as Pool, service, {} as BackupService, { exit: () => {} });
}

const timedOutLogs = () => logged.filter((l) => l.level === 'error' && /timed out/i.test(l.msg));

describe('a scheduled bank sync in progress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logged.length = 0;
    tenants.ids = [1, 2, 3, 4];
    // Every ledger's import is due. The scheduler reads each ledger's schedule from
    // tenant_settings; these tests have no database. Which ledgers are due is
    // syncSchedulerTenants.db.test.ts's.
    vi.spyOn(SyncScheduler.prototype as unknown as { dueTenants(): Promise<number[]> }, 'dueTenants')
      .mockImplementation(async () => tenants.ids);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('goes through every ledger when the import schedule is saved during it', async () => {
    const { service, started } = importService();
    const scheduler = new SyncScheduler(service);
    await scheduler.startScheduler();
    const run = performScheduledSync(scheduler);

    await vi.advanceTimersByTimeAsync(100);
    // What the lifecycle's updateSchedulerConfiguration does (no route calls it since each
    // ledger's schedule is read on every run; the re-arm must still leave a run alone).
    const saving = scheduler.updateSchedule();
    await vi.advanceTimersByTimeAsync(4 * TENANT_MS);
    await saving;
    await run;

    expect(started).toEqual([1, 2, 3, 4]);
    const status = await scheduler.getSchedulerStatus();
    expect(status.lastRunOutcome).toBe('success');
    expect(status.lastRunTenants).toEqual({ total: 4, succeeded: [1, 2, 3, 4], failed: [], timedOut: [], notReached: [], stillRunning: [] });
    // The new schedule is armed.
    expect(status.running).toBe(true);
    expect(status.shuttingDown).toBe(false);
    expect(timedOutLogs()).toEqual([]);
  });

  it('does not wait for the run to save the schedule', async () => {
    const { service } = importService({ slow: [1], slowMs: 60_000 });
    const scheduler = new SyncScheduler(service);
    const run = performScheduledSync(scheduler);
    await vi.advanceTimersByTimeAsync(100);

    let saved = false;
    const saving = scheduler.updateSchedule().then(() => { saved = true; });
    await vi.advanceTimersByTimeAsync(10);
    // The request that saved it answers now, not when ledger 1 is done.
    expect(saved).toBe(true);
    await saving;
    await vi.advanceTimersByTimeAsync(60_000 + 4 * TENANT_MS);
    await run;
  });

  it('goes through every ledger when an admin stops the scheduler during it, and arms nothing', async () => {
    const { service, started } = importService();
    const lifecycle = lifecycleWith(service);
    await lifecycle.startImportScheduler();
    const run = performScheduledSync(syncSchedulerOf(lifecycle));

    await vi.advanceTimersByTimeAsync(100);
    const stopping = lifecycle.stopImportScheduler(); // the lifecycle's stop (the registry's disarm)
    await vi.advanceTimersByTimeAsync(4 * TENANT_MS);
    await stopping;
    await run;

    expect(started).toEqual([1, 2, 3, 4]);
    const status = await syncSchedulerOf(lifecycle).getSchedulerStatus();
    expect(status.lastRunOutcome).toBe('success');
    expect(status.running).toBe(false);
    expect(status.nextSyncTime).toBeNull();
  });

  it('stops after the ledger it is on at a shutdown, and is recorded as stopped, not timed out', async () => {
    const { service, started, finished } = importService();
    const scheduler = new SyncScheduler(service);
    await scheduler.startScheduler();
    const run = performScheduledSync(scheduler);

    await vi.advanceTimersByTimeAsync(100);
    const stopping = scheduler.stopScheduler(); // what a shutdown does
    await vi.advanceTimersByTimeAsync(4 * TENANT_MS);
    await stopping;
    await run;

    // Ledger 1's sync finished; none was started after the stop.
    expect(started).toEqual([1]);
    expect(finished).toEqual([1]);
    const status = await scheduler.getSchedulerStatus();
    expect(status.lastRunOutcome).toBe('stopped');
    expect(status.lastRunTenants).toEqual({ total: 4, succeeded: [1], failed: [], timedOut: [], notReached: [2, 3, 4], stillRunning: [] });
    expect(status.running).toBe(false);
    expect(timedOutLogs()).toEqual([]);
    expect(logged.some((l) => l.level === 'warn' && /stopped/i.test(l.msg))).toBe(true);
  });

  it('stops for a restore, and does not go on when the schedulers start again before its ledger is done', async () => {
    // Ledger 1 takes longer than the 30 s the pause waits for it.
    const { service, started } = importService({ slow: [1], slowMs: 60_000 });
    const lifecycle = lifecycleWith(service);
    await lifecycle.startImportScheduler();
    const run = performScheduledSync(syncSchedulerOf(lifecycle));

    await vi.advanceTimersByTimeAsync(100);
    const pausing = lifecycle.pauseSchedulersForRestore();
    await vi.advanceTimersByTimeAsync(31_000);
    await pausing;
    // The restore is done; the schedulers start again while ledger 1 is still syncing.
    const resuming = lifecycle.resumeSchedulersAfterRestore();
    await vi.advanceTimersByTimeAsync(60_000 + 4 * TENANT_MS);
    await resuming;
    await run;

    expect(started).toEqual([1]);
    const status = await syncSchedulerOf(lifecycle).getSchedulerStatus();
    expect(status.lastRunOutcome).toBe('stopped');
    expect(status.lastRunTenants).toMatchObject({ succeeded: [1], notReached: [2, 3, 4] });
    // The resumed scheduler is armed for its next run.
    expect(status.running).toBe(true);
  });

  it('still records a ledger that ran past its limit as timed out when a shutdown stops the run', async () => {
    const { service, started } = importService({ slow: [1], slowMs: 5_000 });
    const scheduler = new SyncScheduler(service, { tenantTimeoutMs: 1_000 });
    const run = performScheduledSync(scheduler);

    // Ledger 1 runs past its 1 s; the run goes on to ledger 2, and the shutdown comes then.
    await vi.advanceTimersByTimeAsync(1_100);
    const stopping = scheduler.stopScheduler();
    await vi.advanceTimersByTimeAsync(6_000);
    await stopping;
    await run;

    expect(started).toEqual([1, 2]);
    const status = await scheduler.getSchedulerStatus();
    expect(status.lastRunOutcome).toBe('timed_out');
    expect(status.lastRunTenants).toMatchObject({ succeeded: [2], timedOut: [1], notReached: [3, 4] });
  });
});
