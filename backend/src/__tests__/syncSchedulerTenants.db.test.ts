import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import type { ImportService } from '../services/ImportService.js';

/**
 * The import scheduler runs each ledger on its own schedule: its own on/off switch,
 * time of day, frequency and time zone, from tenant_settings. It used to run every ledger
 * on one deployment-wide schedule.
 *
 * Only this file's two ledgers are walked (getActiveTenantIds is narrowed to them), and
 * the import itself is a stub that records which ledger it was asked to run.
 */

const tenants = vi.hoisted(() => ({ ids: [] as number[] }));
vi.mock('../db/forEachTenant.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/forEachTenant.js')>()),
  getActiveTenantIds: async () => tenants.ids,
}));

const { SyncScheduler, readTenantImportSchedule, nextRunForTenant, dueAt } = await import('../services/SyncScheduler.js');

describe('Import scheduler, per ledger', () => {
  let a: TestTenant;
  let b: TestTenant;
  const ran: number[] = [];
  const importService = {
    runAutomaticSync: async (tenantId: number) => {
      ran.push(tenantId);
    },
  } as unknown as ImportService;

  const set = (tenant: TestTenant, values: Record<string, string>) =>
    Promise.all(
      Object.entries(values).map(([key, value]) =>
        tenant.pool.query(
          `INSERT INTO tenant_settings (setting_key, setting_value) VALUES ($1, $2)
           ON CONFLICT (tenant_id, setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
          [key, value]
        )
      )
    );

  beforeAll(async () => {
    a = await createTestTenant('Scheduler A');
    b = await createTestTenant('Scheduler B');
    tenants.ids = [a.tenantId, b.tenantId];
  });

  afterAll(async () => {
    await Promise.allSettled([a?.cleanup(), b?.cleanup()]);
  });

  it("reads each ledger's own schedule and zone", async () => {
    await set(a, { import_enabled: 'true', import_sync_time: '06:00', import_sync_frequency: 'daily', application_timezone: 'America/New_York' });
    await set(b, { import_enabled: 'false', import_sync_time: '22:30', import_sync_frequency: 'weekly', application_timezone: 'Asia/Tokyo' });
    expect(await readTenantImportSchedule(a.tenantId)).toEqual({
      enabled: true, frequency: 'daily', syncTime: '06:00', timezone: 'America/New_York', lastAutoSync: null,
      lastAttempt: null, enabledSince: expect.any(Date),
    });
    expect(await readTenantImportSchedule(b.tenantId)).toEqual({
      enabled: false, frequency: 'weekly', syncTime: '22:30', timezone: 'Asia/Tokyo', lastAutoSync: null,
      lastAttempt: null, enabledSince: null,
    });
  });

  // The times below are in 2027, after import_enabled was turned on (now), so they count
  // from each ledger's last run.
  it("runs a ledger once its own time has come, and leaves a ledger that's off alone", async () => {
    // A runs daily at 06:00 New York: 10:00 UTC since DST began on 2027-03-14. It last ran
    // just after its slot on 2027-03-16, so its next run is 2027-03-17 10:00 UTC.
    await set(a, { import_last_auto_sync: '2027-03-16T10:01:00.000Z' });
    // B runs weekly at 22:30 Tokyo (13:30 UTC). It last ran on 2027-03-16: next on the 23rd.
    await set(b, { import_last_auto_sync: '2027-03-16T13:31:00.000Z', import_enabled: 'true' });
    const scheduler = new SyncScheduler(importService);

    ran.length = 0;
    await scheduler.checkDueTenants(() => new Date('2027-03-17T09:59:00Z'));
    expect(ran).toEqual([]);

    await scheduler.checkDueTenants(() => new Date('2027-03-17T10:01:00Z'));
    expect(ran).toEqual([a.tenantId]);

    // Not again in the same slot (the stub didn't record a success, as a failed run wouldn't).
    ran.length = 0;
    await scheduler.checkDueTenants(() => new Date('2027-03-17T10:06:00Z'));
    expect(ran).toEqual([]);

    // B's weekly run, not before its day.
    await scheduler.checkDueTenants(() => new Date('2027-03-22T13:31:00Z'));
    expect(ran).toEqual([a.tenantId]); // A's next daily slot passed; B's hasn't
    ran.length = 0;
    await scheduler.checkDueTenants(() => new Date('2027-03-23T13:31:00Z'));
    expect(ran).toEqual([a.tenantId, b.tenantId]);

    // Off means off.
    await set(a, { import_enabled: 'false' });
    ran.length = 0;
    await scheduler.checkDueTenants(() => new Date('2027-03-24T10:01:00Z'));
    expect(ran).toEqual([]);
  });

  it("turning import on doesn't import at once, however long the scheduler has run: the first run is at the next scheduled time", async () => {
    await a.pool.query(`DELETE FROM tenant_settings WHERE setting_key IN ('import_last_auto_sync', 'import_last_attempt', 'import_enabled')`);
    // A time of day an hour before now, in UTC, so the next one is about 23 hours away.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const time = `${String(hourAgo.getUTCHours()).padStart(2, '0')}:${String(hourAgo.getUTCMinutes()).padStart(2, '0')}`;
    await set(a, { import_enabled: 'true', import_sync_time: time, import_sync_frequency: 'daily', application_timezone: 'UTC' });
    const schedule = await readTenantImportSchedule(a.tenantId);
    const scheduler = new SyncScheduler(importService);
    await scheduler.startScheduler();
    await scheduler.stopScheduler();
    const soon = new Date(Date.now() + 60 * 1000);
    expect(scheduler.isDue(a.tenantId, schedule, soon)).toBe(false);
    const next = nextRunForTenant(schedule, soon)!;
    expect(next.getTime() - Date.now()).toBeGreaterThan(22 * 3600 * 1000);
    expect(scheduler.isDue(a.tenantId, schedule, new Date(next.getTime() + 60 * 1000))).toBe(true);
    // Saving the same value again doesn't move when it was turned on.
    await new Promise((r) => setTimeout(r, 20));
    const { writeTenantSettings } = await import('../services/tenantSettings.js');
    await writeTenantSettings({ import_enabled: 'true' }, null, a.tenantId);
    expect((await readTenantImportSchedule(a.tenantId)).enabledSince).toEqual(schedule.enabledSince);
  });

  it("leaves a ledger the run didn't reach due at the next tick, and records it", async () => {
    // A due ledger: daily at 06:00 New York; it last ran the day before.
    await set(a, { import_enabled: 'true', import_sync_time: '06:00', import_sync_frequency: 'daily', application_timezone: 'America/New_York', import_last_auto_sync: '2027-04-01T10:01:00.000Z' });
    await set(b, { import_enabled: 'false' });
    // No time for the run: it reaches no ledger.
    const scheduler = new SyncScheduler(importService, { runTimeoutMs: 0 });
    const now = new Date('2027-04-02T10:01:00Z');
    ran.length = 0;
    await scheduler.checkDueTenants(() => now);
    expect(ran).toEqual([]);
    expect((await scheduler.getSchedulerStatus()).lastRunTenants).toMatchObject({ total: 1, notReached: [a.tenantId] });
    expect(scheduler.isDue(a.tenantId, await readTenantImportSchedule(a.tenantId), new Date(now.getTime() + 5 * 60_000))).toBe(true);
  });

  it('remembers a failed run across a restart: the new scheduler waits for the next scheduled time too', async () => {
    await a.pool.query(`DELETE FROM tenant_settings WHERE setting_key IN ('import_last_auto_sync', 'import_last_attempt')`);
    // Daily at 06:00 New York (10:00 UTC); it last imported the day before.
    await set(a, { import_enabled: 'true', import_sync_time: '06:00', import_sync_frequency: 'daily', application_timezone: 'America/New_York', import_last_auto_sync: '2027-05-10T10:01:00.000Z' });
    await set(b, { import_enabled: 'false' });
    const attempts: number[] = [];
    const failing = {
      runAutomaticSync: async (tenantId: number) => {
        attempts.push(tenantId);
        throw new Error('the bank did not answer');
      },
    } as unknown as ImportService;

    await new SyncScheduler(failing).checkDueTenants(() => new Date('2027-05-11T10:01:00Z'));
    expect(attempts).toEqual([a.tenantId]);
    const stored = await a.pool.query(`SELECT setting_value FROM tenant_settings WHERE setting_key = 'import_last_attempt'`);
    expect(stored.rows).toEqual([{ setting_value: '2027-05-11T10:01:00.000Z' }]);
    const schedule = await readTenantImportSchedule(a.tenantId);
    expect(schedule.lastAttempt).toEqual(new Date('2027-05-11T10:01:00Z'));
    // The status says when it will try again: at the next slot, not now.
    expect(nextRunForTenant(schedule, new Date('2027-05-11T10:06:00Z'))?.toISOString()).toBe('2027-05-12T10:00:00.000Z');

    // A restart: a scheduler with nothing in memory doesn't try again in the same slot...
    const restarted = new SyncScheduler(failing);
    await restarted.checkDueTenants(() => new Date('2027-05-11T10:06:00Z'));
    await restarted.checkDueTenants(() => new Date('2027-05-12T09:59:00Z'));
    expect(attempts).toEqual([a.tenantId]);
    // ...and tries at the next one.
    await restarted.checkDueTenants(() => new Date('2027-05-12T10:01:00Z'));
    expect(attempts).toEqual([a.tenantId, a.tenantId]);
  });

  const times = { syncTime: '02:00', timezone: 'UTC', enabled: true, enabledSince: null, lastAttempt: null };

  it('a run missed while the server was down is due at the next check, and the day\'s run then waits for tomorrow', () => {
    const schedule = { ...times, frequency: 'daily' as const, lastAutoSync: new Date('2027-05-01T02:00:05Z') };
    const now = new Date('2027-05-04T01:05:00Z');
    expect(dueAt(schedule, null, now).getTime()).toBeLessThan(now.getTime());
    expect(nextRunForTenant(schedule, now)?.toISOString()).toBe(now.toISOString());
    // The catch-up ran at 01:05: not again at 02:00 the same day.
    expect(dueAt(schedule, now, now).toISOString()).toBe('2027-05-05T02:00:00.000Z');
  });

  it("weekly doesn't run again the same week when the time of day moves later", () => {
    // Last ran Monday 02:05; the time is now 23:00. The run counts for the scheduled time
    // within 12 hours of it (Sunday 23:00), so the next is the Sunday after, not Monday night.
    const schedule = { ...times, syncTime: '23:00', frequency: 'weekly' as const, lastAutoSync: new Date('2027-05-03T02:05:00Z') };
    expect(dueAt(schedule, null, new Date('2027-05-03T03:00:00Z')).toISOString()).toBe('2027-05-09T23:00:00.000Z');
  });

  it("a weekly run that ends just after midnight doesn't move the weekday", () => {
    const schedule = { ...times, syncTime: '23:58', frequency: 'weekly' as const, lastAutoSync: null };
    // Each run starts at the first 5-minute tick after its time and ends after midnight.
    let due = new Date('2027-05-03T23:58:00Z'); // a Monday
    for (let week = 0; week < 4; week++) {
      const ended = new Date(due.getTime() + 7 * 60 * 1000);
      due = dueAt({ ...schedule, lastAutoSync: ended }, null, ended);
      expect(due.getUTCDay()).toBe(1);
      expect([due.getUTCHours(), due.getUTCMinutes()]).toEqual([23, 58]);
    }
    expect(due.toISOString()).toBe('2027-05-31T23:58:00.000Z');
  });

  it('a daily run that ended just after midnight still counts for the day it was scheduled on', () => {
    const schedule = { ...times, syncTime: '23:50', frequency: 'daily' as const, lastAutoSync: new Date('2027-05-04T00:10:00Z') };
    expect(dueAt(schedule, null, new Date('2027-05-04T01:00:00Z')).toISOString()).toBe('2027-05-04T23:50:00.000Z');
  });
});
