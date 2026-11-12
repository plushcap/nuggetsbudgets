import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

/**
 * A scheduled bank sync gives each ledger a time limit and the run one in all, and says
 * truly what it did. The run was raced against its 30 minutes only:
 * when they ran out it was recorded as finished (and another could start) while its loop
 * went on through the ledgers it hadn't reached.
 */
const tenants = vi.hoisted(() => ({ ids: [] as number[] }));
// The scheduler stores each ledger's import attempt before it runs it; these tests
// have no database.
vi.mock('../../services/tenantSettings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/tenantSettings.js')>()),
  writeTenantSettings: vi.fn(async () => {}),
}));
vi.mock('../../db/forEachTenant.js', () => {
  const getActiveTenantIds = vi.fn(async () => tenants.ids);
  return {
    getActiveTenantIds,
    // The loop the scheduler used before, over the same ledgers.
    forEachTenantId: async (_job: string, fn: (tenantId: number) => Promise<unknown>) => {
      const ids = await getActiveTenantIds();
      for (const id of ids) {
        try {
          await fn(id);
        } catch {
          // logged by the real one
        }
      }
      return { total: ids.length, succeeded: 0, failed: 0 };
    },
  };
});

const { SyncScheduler } = await import('../../services/SyncScheduler.js');
type ImportService = ConstructorParameters<typeof SyncScheduler>[0];

const MINUTE = 60_000;

/** An ImportService whose ledgers 2, 3 and 4 hang until released; 1 and 5 finish at once. */
function importService() {
  const started: number[] = [];
  const releases: Array<() => void> = [];
  const service = {
    runAutomaticSync: vi.fn((tenantId: number) => {
      started.push(tenantId);
      if (tenantId >= 2 && tenantId <= 4) return new Promise<void>((resolve) => releases.push(resolve));
      return Promise.resolve();
    }),
  };
  return { service: service as unknown as ImportService, started, releaseAll: () => releases.forEach((r) => r()) };
}

describe('a scheduled sync that runs out of time', () => {
  beforeEach(() => {
    // Every ledger's import is due (the scheduler reads each ledger's schedule from
    // tenant_settings; these tests have no database).
    vi.spyOn(SyncScheduler.prototype as unknown as { dueTenants(): Promise<number[]> }, 'dueTenants')
      .mockImplementation(async () => tenants.ids);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('gives each ledger its limit, starts none once the run’s time is up, and says which', async () => {
    vi.useFakeTimers();
    tenants.ids = [1, 2, 3, 4, 5];
    const { service, started, releaseAll } = importService();
    const scheduler = new SyncScheduler(service);
    const run = (scheduler as unknown as { performScheduledSync(): Promise<void> }).performScheduledSync();

    // 10 minutes for each hanging ledger: 2, 3 and 4 take the run's 30 minutes.
    for (let i = 0; i < 31; i++) await vi.advanceTimersByTimeAsync(MINUTE);
    await run;

    const status = await scheduler.getSchedulerStatus();
    expect(status.lastRunOutcome).toBe('timed_out');
    // The three that ran over are still going: the scheduler says a sync is running.
    expect(status.hasRunningSync).toBe(true);

    // When they finish, the run doesn't go on to ledger 5: it is over.
    releaseAll();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(started).toEqual([1, 2, 3, 4]);
    expect((await scheduler.getSchedulerStatus()).hasRunningSync).toBe(false);
    expect(status.lastRunTenants).toEqual({
      total: 5,
      succeeded: [1],
      failed: [],
      timedOut: [2, 3, 4],
      notReached: [5],
      stillRunning: [],
    });
  });

  it('skips, in the next run, a ledger whose sync from the last one is still going', async () => {
    vi.useFakeTimers();
    tenants.ids = [1, 2];
    const { service, started, releaseAll } = importService();
    const scheduler = new SyncScheduler(service, { tenantTimeoutMs: MINUTE, runTimeoutMs: 10 * MINUTE });
    const performScheduledSync = () => (scheduler as unknown as { performScheduledSync(): Promise<void> }).performScheduledSync();

    const first = performScheduledSync();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await first;
    expect((await scheduler.getSchedulerStatus()).lastRunTenants).toMatchObject({ succeeded: [1], timedOut: [2] });

    const second = performScheduledSync();
    await vi.advanceTimersByTimeAsync(MINUTE);
    await second;
    expect((await scheduler.getSchedulerStatus()).lastRunTenants).toMatchObject({ succeeded: [1], timedOut: [], stillRunning: [2] });
    expect(started).toEqual([1, 2, 1]);
    releaseAll();
  });

  it("leaves the last run's report alone when a tick finds no ledger due", async () => {
    tenants.ids = [1];
    const { service } = importService();
    const scheduler = new SyncScheduler(service);
    const performScheduledSync = () => (scheduler as unknown as { performScheduledSync(): Promise<void> }).performScheduledSync();
    await performScheduledSync();
    const after = await scheduler.getSchedulerStatus();
    expect(after.lastRunTenants).toMatchObject({ total: 1, succeeded: [1] });

    tenants.ids = [];
    await new Promise((resolve) => setTimeout(resolve, 5));
    await performScheduledSync();
    const idle = await scheduler.getSchedulerStatus();
    expect(idle.lastRunFinishedAt).toEqual(after.lastRunFinishedAt);
    expect(idle.lastRunStartedAt).toEqual(after.lastRunStartedAt);
    expect(idle.lastRunTenants).toEqual(after.lastRunTenants);
  });
});
