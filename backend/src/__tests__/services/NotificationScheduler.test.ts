import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NotificationRulesEngine } from '../../services/NotificationRulesEngine.js';

// The settings the scheduler reads, as system_settings rows.
const settings = { enabled: 'true' };
vi.mock('../../db/withTenant.js', () => {
  const query = {
    select: () => query,
    where: () => query,
    execute: async () => [
      { setting_key: 'notification_system_enabled', setting_value: settings.enabled },
      { setting_key: 'notification_rules_check_interval', setting_value: '15' },
      { setting_key: 'notification_queue_process_interval', setting_value: '5' },
    ],
  };
  // systemSettings.ts reads on currentDbOrGlobal().
  const db = { selectFrom: () => query };
  return { globalDb: db, currentDbOrGlobal: () => db, runDetached: (fn: () => void) => fn() };
});
vi.mock('../../db/forEachTenant.js', () => ({
  forEachTenant: async (_job: string, fn: () => Promise<unknown>) => {
    await fn();
    return {};
  },
  forEachTenantId: async (_job: string, fn: (tenantId: number) => Promise<unknown>) => {
    await fn(1);
    return {};
  },
}));

import { NotificationScheduler } from '../../services/NotificationScheduler.js';

/**
 * Each job first runs a minute (rules) or two (queue) after start. Those timers weren't
 * tracked, so they fired after a stop or restart.
 */
describe('NotificationScheduler startup runs', () => {
  let scheduler: NotificationScheduler;
  const engine = {
    queueDueNotifications: vi.fn(async () => undefined),
    processNotificationQueue: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    settings.enabled = 'true';
    vi.clearAllMocks();
    scheduler = new NotificationScheduler(engine as unknown as NotificationRulesEngine);
  });

  afterEach(async () => {
    await scheduler.stopScheduler();
    vi.useRealTimers();
  });

  it('runs nothing once notifications are turned off, however soon after start', async () => {
    await scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(30_000);

    settings.enabled = 'false';
    await scheduler.updateSchedule();
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(engine.queueDueNotifications).not.toHaveBeenCalled();
    expect(engine.processNotificationQueue).not.toHaveBeenCalled();
  });

  it('runs each job once after a restart, not once per start', async () => {
    await scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    await scheduler.updateSchedule();

    // The restart's first runs: rules at +60 s, queue at +120 s. The first start's are gone.
    await vi.advanceTimersByTimeAsync(121_000);
    expect(engine.queueDueNotifications).toHaveBeenCalledTimes(1);
    expect(engine.processNotificationQueue).toHaveBeenCalledTimes(1);
  });

  // Two saves at once each armed intervals, the second overwrote the
  // first's handles, and turning notifications off couldn't clear them.
  it('stops every job after two settings saves at once and then turning notifications off', async () => {
    await scheduler.startScheduler();
    await Promise.all([scheduler.updateSchedule(), scheduler.updateSchedule()]);
    settings.enabled = 'false';
    await scheduler.updateSchedule();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(engine.queueDueNotifications).not.toHaveBeenCalled();
    expect(engine.processNotificationQueue).not.toHaveBeenCalled();
  });

  it('runs each job at its interval, not twice as often, after two saves at once', async () => {
    await scheduler.startScheduler();
    await Promise.all([scheduler.updateSchedule(), scheduler.updateSchedule()]);
    // Rules every 15 minutes and the queue every 5 (the settings above): an hour after
    // the restart, that's 4 and 12, plus each job's first run.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(engine.queueDueNotifications).toHaveBeenCalledTimes(5);
    expect(engine.processNotificationQueue).toHaveBeenCalledTimes(13);
  });

  it('runs nothing after it is stopped', async () => {
    await scheduler.startScheduler();
    await scheduler.stopScheduler();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(engine.queueDueNotifications).not.toHaveBeenCalled();
    expect(engine.processNotificationQueue).not.toHaveBeenCalled();
  });
});
