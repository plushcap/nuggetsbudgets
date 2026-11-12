import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The import scheduler's timer, under fake timers. The scheduler ticks every
 * SYNC_TICK_MS and syncs the ledgers whose own schedule has come. Its other tests cover
 * the rest: the due-time rules against a real database (syncSchedulerTenants.db.test.ts), a
 * run's time limits (SyncScheduler.timeout.test.ts), and stops, restarts and restores in the
 * lifecycle (SyncScheduler.stop.test.ts). These drive the tick itself:
 *   - a start arms exactly one tick, and a restart replaces it rather than adding one;
 *   - a ledger runs at the first tick at or after its own time, and not again until its next;
 *   - a ledger that's off never runs, beside one that's on;
 *   - a tick while a run is going is skipped: the runs don't overlap;
 *   - a ledger whose sync failed isn't retried before its next scheduled time;
 *   - a ledger whose schedule can't be read is left out, and the others still run;
 *   - a start that can't read the ledgers fails and arms nothing; a stop disarms;
 *   - a tick that can't read the ledgers fails with nothing unhandled, and the tick goes on;
 *   - the next check the status shows moves on with each tick;
 *   - a restart keeps when the scheduler first started (the first run's starting point).
 * Pure unit: the ledgers and their settings are stubbed; nothing touches a database.
 */

interface TenantSettings {
  import_enabled?: string;
  import_sync_frequency?: string;
  import_sync_time?: string;
  import_last_auto_sync?: string | null;
  /** When the scheduler last started its import (stored before each run). */
  import_last_attempt?: string | null;
  /** When import_enabled last changed (the row's updated_at); undefined overrides daily()'s. */
  enabledSince?: string | undefined;
  /** Reading this ledger's settings fails. */
  unreadable?: boolean;
}

const state = vi.hoisted(() => ({
  tenants: new Map<number, TenantSettings>(),
  current: null as number | null,
  tenantListFails: false,
}));

vi.mock('../../db/forEachTenant.js', () => ({
  getActiveTenantIds: async () => {
    if (state.tenantListFails) throw new Error('database unavailable');
    return [...state.tenants.keys()].sort((a, b) => a - b);
  },
}));

vi.mock('../../services/tenantSettings.js', () => ({
  inTenantScope: async <T>(tenantId: number | null, fn: () => Promise<T>): Promise<T> => {
    state.current = tenantId;
    try {
      return await fn();
    } finally {
      state.current = null;
    }
  },
  readTenantSettings: async (keys: readonly string[]) => {
    const tenant = state.tenants.get(state.current!);
    if (!tenant || tenant.unreadable) throw new Error('settings unreadable');
    return Object.fromEntries(keys.map((k) => [k, (tenant as Record<string, unknown>)[k] ?? null]));
  },
  writeTenantSettings: async (values: Record<string, string | null>, _userId: number | null, tenantId: number) => {
    const tenant = state.tenants.get(tenantId);
    if (tenant) Object.assign(tenant, values);
  },
}));

vi.mock('../../db/withTenant.js', () => {
  const query = {
    select: () => query,
    where: () => query,
    executeTakeFirst: async () => {
      const since = state.tenants.get(state.current!)?.enabledSince;
      return since ? { updated_at: since } : undefined;
    },
  };
  return {
    getDb: () => ({ selectFrom: () => query }),
    // The real one leaves the request's context; there is none here.
    runDetached: <T>(fn: () => T): T => fn(),
  };
});

vi.mock('../../utils/appDate.js', () => ({ appTimezone: async () => 'UTC' }));

const { SyncScheduler, SYNC_TICK_MS } = await import('../../services/SyncScheduler.js');
type ImportService = ConstructorParameters<typeof SyncScheduler>[0];
type Scheduler = InstanceType<typeof SyncScheduler>;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A ledger with daily import at 02:00 UTC, last run the day before the clock starts. */
const daily = (overrides: TenantSettings = {}): TenantSettings => ({
  import_enabled: 'true',
  import_sync_frequency: 'daily',
  import_sync_time: '02:00',
  import_last_auto_sync: '2026-11-14T02:00:00.000Z',
  enabledSince: '2026-11-01T00:00:00.000Z',
  ...overrides,
});

/**
 * The import, as runAutomaticSync does it: a successful one records the ledger's
 * import_last_auto_sync. `behave` decides how each call ends.
 */
function setup(behave: (tenantId: number) => Promise<void> = async () => undefined) {
  const runAutomaticSync = vi.fn(async (tenantId: number) => {
    await behave(tenantId);
    const tenant = state.tenants.get(tenantId);
    if (tenant) tenant.import_last_auto_sync = new Date().toISOString();
  });
  const scheduler = new SyncScheduler({ runAutomaticSync } as unknown as ImportService);
  return { scheduler, runAutomaticSync };
}

/** Advance the fake clock to `iso`, running every timer due on the way. */
const advanceTo = (iso: string) => vi.advanceTimersByTimeAsync(new Date(iso).getTime() - Date.now());
const calls = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.map(([id]) => id);

describe('SyncScheduler tick', () => {
  let scheduler: Scheduler | undefined;

  beforeEach(() => {
    // Only what the scheduler uses, so getTimerCount() counts its timers and nothing else
    // (the logger's setImmediate, say).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-15T01:00:00Z'));
    state.tenants.clear();
    state.tenantListFails = false;
  });

  afterEach(async () => {
    // A stop waits up to 30 s for a run in flight: on the fake clock, so advance it.
    const stopping = scheduler?.stopScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    await stopping;
    scheduler = undefined;
    vi.useRealTimers();
  });

  it('a start arms exactly one tick, SYNC_TICK_MS away', async () => {
    state.tenants.set(11, daily());
    const t = setup();
    scheduler = t.scheduler;
    await scheduler.startScheduler();

    expect(vi.getTimerCount()).toBe(1);
    expect(scheduler.isTimerArmed()).toBe(true);
    expect(await scheduler.getNextScheduledSyncTime()).toEqual(new Date(Date.now() + SYNC_TICK_MS));
    expect(t.runAutomaticSync).not.toHaveBeenCalled();
  });

  it('a restart replaces the tick rather than arming a second, so a ledger runs once', async () => {
    state.tenants.set(11, daily());
    const t = setup();
    scheduler = t.scheduler;
    await scheduler.startScheduler();
    await scheduler.updateSchedule();
    await scheduler.startScheduler();
    expect(vi.getTimerCount()).toBe(1);

    await advanceTo('2026-11-15T03:00:00Z');
    expect(calls(t.runAutomaticSync)).toEqual([11]);
  });

  it('runs a ledger at the first tick at or after its own time, then not again until the next day', async () => {
    state.tenants.set(11, daily());
    state.tenants.set(12, daily({ import_sync_time: '04:30' }));
    const t = setup();
    scheduler = t.scheduler;
    await scheduler.startScheduler();

    await advanceTo('2026-11-15T01:59:59Z');
    expect(t.runAutomaticSync).not.toHaveBeenCalled();
    await advanceTo('2026-11-15T02:00:01Z');
    expect(calls(t.runAutomaticSync)).toEqual([11]);
    await advanceTo('2026-11-15T04:30:01Z');
    expect(calls(t.runAutomaticSync)).toEqual([11, 12]);

    // Every tick until the next day finds neither due again.
    await advanceTo('2026-11-16T01:59:59Z');
    expect(t.runAutomaticSync).toHaveBeenCalledTimes(2);
    await advanceTo('2026-11-16T02:00:01Z');
    expect(calls(t.runAutomaticSync)).toEqual([11, 12, 11]);
    expect((await scheduler.getSchedulerStatus()).lastRunOutcome).toBe('success');
  });

  it('never runs a ledger whose import is off, beside one that is on', async () => {
    state.tenants.set(11, daily({ import_enabled: 'false' }));
    state.tenants.set(12, daily());
    const t = setup();
    scheduler = t.scheduler;
    await scheduler.startScheduler();

    await advanceTo('2026-11-17T03:00:00Z');
    expect(calls(t.runAutomaticSync)).toEqual([12, 12, 12]);
  });

  it('skips a tick while a run is going, so runs never overlap', async () => {
    // Ledger 11's sync hangs; ledger 12 falls due while it does.
    state.tenants.set(11, daily());
    state.tenants.set(12, daily({ import_sync_time: '02:03' }));
    let finish!: () => void;
    const t = setup((tenantId) =>
      tenantId === 11 ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve()
    );
    scheduler = t.scheduler;
    await scheduler.startScheduler();

    await advanceTo('2026-11-15T02:00:01Z');
    expect(calls(t.runAutomaticSync)).toEqual([11]);
    expect(await scheduler.hasRunningSyncOperation()).toBe(true);

    // The ticks at 02:05 and 02:10 come while 11's sync is going (it has 10 minutes): they
    // start no second run, so 12 waits though it is due.
    await advanceTo('2026-11-15T02:09:59Z');
    expect(calls(t.runAutomaticSync)).toEqual([11]);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await scheduler.hasRunningSyncOperation()).toBe(false);
    // The next tick after the run ends takes 12, and 11 isn't run again.
    await advanceTo('2026-11-15T02:15:01Z');
    expect(calls(t.runAutomaticSync)).toEqual([11, 12]);
    await advanceTo('2026-11-15T06:00:00Z');
    expect(calls(t.runAutomaticSync)).toEqual([11, 12]);
    expect(scheduler.isTimerArmed()).toBe(true);
  });

  it("doesn't retry a ledger whose sync failed before its next scheduled time", async () => {
    state.tenants.set(11, daily());
    const t = setup(async () => { throw new Error('SimpleFin said no'); });
    scheduler = t.scheduler;
    await scheduler.startScheduler();

    await advanceTo('2026-11-15T02:00:01Z');
    expect(t.runAutomaticSync).toHaveBeenCalledTimes(1);
    expect((await scheduler.getSchedulerStatus()).lastRunOutcome).toBe('failed');

    await advanceTo('2026-11-16T01:59:59Z');
    expect(t.runAutomaticSync).toHaveBeenCalledTimes(1);
    await advanceTo('2026-11-16T02:00:01Z');
    expect(t.runAutomaticSync).toHaveBeenCalledTimes(2);
    expect(scheduler.isTimerArmed()).toBe(true);
  });

  it("leaves out a ledger whose schedule can't be read, and runs the others", async () => {
    state.tenants.set(11, daily({ unreadable: true }));
    state.tenants.set(12, daily());
    const t = setup();
    scheduler = t.scheduler;
    await scheduler.startScheduler();

    await advanceTo('2026-11-15T02:00:01Z');
    expect(calls(t.runAutomaticSync)).toEqual([12]);
  });

  it("fails to start, arming nothing, when the ledgers can't be read", async () => {
    state.tenantListFails = true;
    const t = setup();
    scheduler = t.scheduler;
    await expect(scheduler.startScheduler()).rejects.toThrow('database unavailable');
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduler.isTimerArmed()).toBe(false);
  });

  it("keeps ticking while the ledger list can't be read, with nothing unhandled, and runs the due ledger once it can", async () => {
    // Every tick's run fails while the database is down. Each must be handled: an unhandled
    // rejection per tick was logged as such by the lifecycle.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      state.tenants.set(11, daily());
      const t = setup();
      scheduler = t.scheduler;
      await scheduler.startScheduler();

      state.tenantListFails = true;
      // The ticks from 01:05 through 02:00, with 11 due from 02:00.
      await advanceTo('2026-11-15T02:00:01Z');
      // Node reports an unhandled rejection after the microtasks; setImmediate isn't faked.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(t.runAutomaticSync).not.toHaveBeenCalled();
      expect(await scheduler.getSchedulerStatus()).toMatchObject({ running: true, hasRunningSync: false, lastRunOutcome: 'failed' });

      state.tenantListFails = false;
      await advanceTo('2026-11-15T02:05:01Z');
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls(t.runAutomaticSync)).toEqual([11]);
      expect((await scheduler.getSchedulerStatus()).lastRunOutcome).toBe('success');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('moves the next check on at every tick, so the status never shows one that has passed', async () => {
    state.tenants.set(11, daily());
    const t = setup();
    scheduler = t.scheduler;
    await scheduler.startScheduler();
    const first = Date.now() + SYNC_TICK_MS;
    expect(await scheduler.getNextScheduledSyncTime()).toEqual(new Date(first));

    for (let tick = 1; tick <= 3; tick++) {
      await vi.advanceTimersByTimeAsync(SYNC_TICK_MS);
      const next = new Date(first + tick * SYNC_TICK_MS);
      expect(await scheduler.getNextScheduledSyncTime()).toEqual(next);
      expect((await scheduler.getSchedulerStatus()).nextSyncTime).toEqual(next);
    }
  });

  it('a restart keeps when the scheduler first started, so a run due while it was stopped still happens', async () => {
    // Import on with no record of a run, an attempt or when it was turned on: the first run is
    // the first scheduled time after the scheduler started, 02:00 here.
    state.tenants.set(11, daily({ import_last_auto_sync: null, enabledSince: undefined }));
    const t = setup();
    scheduler = t.scheduler;
    await scheduler.startScheduler(); // 01:00

    // An admin stops it before 02:00 and starts it again after.
    await advanceTo('2026-11-15T01:30:00Z');
    scheduler.stopTimer();
    await advanceTo('2026-11-15T02:30:00Z');
    expect(t.runAutomaticSync).not.toHaveBeenCalled();
    await scheduler.startScheduler();

    // Counted from 01:00, 02:00 has come: the first tick runs it. Counted from the restart,
    // it would wait for 02:00 tomorrow.
    await advanceTo('2026-11-15T02:35:01Z');
    expect(calls(t.runAutomaticSync)).toEqual([11]);
  });

  it('a stop disarms the tick, nothing runs after it, and a start arms it again', async () => {
    state.tenants.set(11, daily());
    const t = setup();
    scheduler = t.scheduler;
    await scheduler.startScheduler();

    scheduler.stopTimer();
    expect(vi.getTimerCount()).toBe(0);
    expect(await scheduler.getSchedulerStatus()).toMatchObject({ running: false, shuttingDown: true, nextSyncTime: null });
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(t.runAutomaticSync).not.toHaveBeenCalled();

    await scheduler.startScheduler();
    expect(vi.getTimerCount()).toBe(1);
    await advanceTo('2026-11-17T02:00:01Z');
    expect(t.runAutomaticSync).toHaveBeenCalledTimes(1);

    await scheduler.stopScheduler();
    expect(vi.getTimerCount()).toBe(0);
  });
});
