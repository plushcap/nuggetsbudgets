import { describe, it, expect } from 'vitest';
import { OrgPriceSyncScheduler } from '../OrgPriceSyncScheduler.js';
import { PriceSyncInProgressError, type PriceSyncService } from '../PriceSyncService.js';

// isDue is pure (given `now`); the svc is unused by it.
const sched = new OrgPriceSyncScheduler({} as unknown as PriceSyncService);
const TZ = 'America/New_York'; // June → EDT (UTC-4)

describe('OrgPriceSyncScheduler.isDue', () => {
  it('is not due before the scheduled local time', () => {
    const now = new Date('2026-06-26T20:00:00Z'); // 16:00 ET
    expect(sched.isDue({ schedule_time: '17:00', timezone: TZ, last_run_at: null }, now)).toBe(false);
  });

  it('is due at/after the scheduled local time when not yet run today', () => {
    const now = new Date('2026-06-26T22:00:00Z'); // 18:00 ET
    expect(sched.isDue({ schedule_time: '17:00', timezone: TZ, last_run_at: null }, now)).toBe(true);
  });

  it('is not due again once it has run today', () => {
    const now = new Date('2026-06-26T22:00:00Z'); // 18:00 ET, 2026-06-26 local
    const ranEarlierToday = new Date('2026-06-26T21:30:00Z').toISOString(); // 17:30 ET same day
    expect(sched.isDue({ schedule_time: '17:00', timezone: TZ, last_run_at: ranEarlierToday }, now)).toBe(false);
  });

  it('is due again the next day even if it ran yesterday', () => {
    const now = new Date('2026-06-27T22:00:00Z'); // next day 18:00 ET
    const ranYesterday = new Date('2026-06-26T21:30:00Z').toISOString();
    expect(sched.isDue({ schedule_time: '17:00', timezone: TZ, last_run_at: ranYesterday }, now)).toBe(true);
  });
});

describe('OrgPriceSyncScheduler ticks', () => {
  it("doesn't start an org's run again while the last tick is still running it", async () => {
    let finish: () => void = () => {};
    const runs: number[] = [];
    const svc = {
      listEnabledSettings: async () => [{ organization_id: 7, schedule_time: '00:00', timezone: 'UTC', last_run_at: null }],
      runForOrg: (orgId: number) => {
        runs.push(orgId);
        return new Promise<void>((resolve) => (finish = resolve));
      },
    } as unknown as PriceSyncService;
    const scheduler = new OrgPriceSyncScheduler(svc);
    const tick = () => (scheduler as unknown as { checkDueOrgs: () => Promise<void> }).checkDueOrgs();

    const first = tick();
    await new Promise((r) => setTimeout(r, 0));
    await tick(); // the next tick, while the first run is still going
    finish();
    await first;
    expect(runs).toEqual([7]);
  });

  // A manual run of the org (or another server's) holds it; the tick skips it.
  it('skips an org whose run is already going elsewhere, without an error', async () => {
    const runs: number[] = [];
    const svc = {
      listEnabledSettings: async () => [
        { organization_id: 7, schedule_time: '00:00', timezone: 'UTC', last_run_at: null },
        { organization_id: 8, schedule_time: '00:00', timezone: 'UTC', last_run_at: null },
      ],
      runForOrg: async (orgId: number) => {
        runs.push(orgId);
        if (orgId === 7) throw new PriceSyncInProgressError();
      },
    } as unknown as PriceSyncService;
    const scheduler = new OrgPriceSyncScheduler(svc);
    await (scheduler as unknown as { checkDueOrgs: () => Promise<void> }).checkDueOrgs();
    expect(runs).toEqual([7, 8]);
  });

  // The server isn't ready until its schedulers have started: starting doesn't wait
  // for the first check's price fetches, and stopping waits for the run it started.
  it('starts without waiting for the first check, and stops after the run it started', async () => {
    let finish: () => void = () => {};
    const svc = {
      listEnabledSettings: async () => [{ organization_id: 7, schedule_time: '00:00', timezone: 'UTC', last_run_at: null }],
      runForOrg: () => new Promise<void>((resolve) => (finish = resolve)),
    } as unknown as PriceSyncService;
    const scheduler = new OrgPriceSyncScheduler(svc);
    await scheduler.startScheduler(); // would hang here if it waited for the run
    await new Promise((r) => setTimeout(r, 0));
    let stopped = false;
    const stopping = scheduler.stopScheduler().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
  });
});
