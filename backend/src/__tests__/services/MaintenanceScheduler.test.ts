import { describe, it, expect, vi, afterEach } from 'vitest';
import { MaintenanceScheduler } from '../../services/maintenance/MaintenanceScheduler.js';
import type { RetentionOptions } from '../../services/maintenance/retention.js';

/**
 * The retention job runs on a schedule: the cleanups existed, but nothing
 * called them. First a few minutes after a start, then once a day; a run that fails
 * doesn't stop the schedule; stopping waits for a run in progress and tells it to stop.
 */
describe('MaintenanceScheduler', () => {
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.RETENTION_SESSION_DAYS;
  });

  it('runs 10 minutes after it starts, then every 24 hours', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async (_policy: unknown, _options: RetentionOptions) => ({ sessions: 2 }));
    const scheduler = new MaintenanceScheduler({ run });
    await scheduler.startScheduler();
    expect(scheduler.getStatus().nextRunAt?.getTime()).toBe(Date.now() + 10 * MIN);

    await vi.advanceTimersByTimeAsync(10 * MIN - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual({ sessionDays: 30, notificationDays: 90, notificationDeliveryDays: 365, syncLogDays: 180 });
    expect(scheduler.getStatus()).toMatchObject({ lastRunOutcome: 'success', running: false });
    expect(scheduler.getStatus()).not.toHaveProperty('lastRunDeleted');

    await vi.advanceTimersByTimeAsync(DAY);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(run).toHaveBeenCalledTimes(4);
    await scheduler.stopScheduler();
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(run).toHaveBeenCalledTimes(4);
    expect(scheduler.getStatus().nextRunAt).toBeNull();
  });

  it('keeps its schedule after a run that fails', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      throw new Error('database away');
    });
    const scheduler = new MaintenanceScheduler({ run, firstRunDelayMs: 1000, intervalMs: DAY });
    await scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(1000);
    expect(scheduler.getStatus().lastRunOutcome).toBe('failed');
    await vi.advanceTimersByTimeAsync(DAY);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.stopScheduler();
  });

  it('skips a run while the previous one is still going, and stopping waits for it and stops it', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let options: RetentionOptions | undefined;
    const run = vi.fn((_policy: unknown, opts: RetentionOptions) => {
      options = opts;
      return new Promise<Record<string, number>>((resolve) => {
        finish = () => resolve({});
      });
    });
    const scheduler = new MaintenanceScheduler({ run, firstRunDelayMs: 1000, intervalMs: 5000 });
    await scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(1000);
    expect(scheduler.getStatus().running).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1); // the second was due, but the first is going

    expect(options?.shouldStop?.()).toBe(false);
    let stopped = false;
    const stopping = scheduler.stopScheduler().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(options?.shouldStop?.()).toBe(true);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(scheduler.getStatus()).toMatchObject({ running: false, nextRunAt: null });
  });

  it('refuses to start with invalid retention settings', async () => {
    process.env.RETENTION_SESSION_DAYS = '0';
    const scheduler = new MaintenanceScheduler({ run: vi.fn() });
    await expect(scheduler.startScheduler()).rejects.toThrow('RETENTION_SESSION_DAYS must be a whole number from 1');
    expect(scheduler.getStatus().nextRunAt).toBeNull();
  });
});
