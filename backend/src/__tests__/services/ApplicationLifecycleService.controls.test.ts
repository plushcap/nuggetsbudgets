import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { BackupService } from '../../services/BackupService.js';
import type { ImportService } from '../../services/ImportService.js';

/**
 * The lifecycle's controls for each scheduler: what an admin's start, stop,
 * restart and update do, what a restore's pause and resume do, and what the status
 * reports. The schedulers are stand-ins that record what is asked of them. Written
 * against the per-scheduler methods before they were replaced by a registry.
 */

type Call = string;
const control = vi.hoisted(() => ({
  calls: [] as Call[],
  built: {} as Record<string, number>,
  /** Every stand-in built, to see which are armed. */
  instances: [] as { name: string; n: number; armed: boolean }[],
  stopDelayMs: 0,
  /** How long a start takes before its timer is armed (reading its settings, say). */
  startDelayMs: 0,
  /** How long an update (a settings change) takes before it re-arms the timer. */
  updateDelayMs: 0,
}));

function standIn(name: string) {
  return class {
    readonly n: number;
    armed = false;
    readonly name = name;
    constructor() {
      control.built[name] = (control.built[name] ?? 0) + 1;
      this.n = control.built[name];
      control.instances.push(this);
    }
    async startScheduler() {
      control.calls.push(`${name}#${this.n}.start`);
      if (control.startDelayMs) await new Promise((resolve) => setTimeout(resolve, control.startDelayMs));
      this.armed = true;
    }
    async stopScheduler() {
      control.calls.push(`${name}#${this.n}.stop`);
      if (control.stopDelayMs) await new Promise((resolve) => setTimeout(resolve, control.stopDelayMs));
      this.armed = false;
    }
    async updateSchedule() {
      control.calls.push(`${name}#${this.n}.update`);
      // As the real ones do: re-read the settings and re-arm.
      if (control.updateDelayMs) await new Promise((resolve) => setTimeout(resolve, control.updateDelayMs));
      this.armed = true;
    }
    isTimerArmed() {
      return this.armed;
    }
  };
}

vi.mock('../../services/SyncScheduler.js', () => ({
  SyncScheduler: class extends standIn('import') {
    // An admin's stop or restart only disarms the timer; a run in progress goes on.
    stopTimer() { control.calls.push(`import#${this.n}.stopTimer`); this.armed = false; }
    async getNextScheduledSyncTime() { return this.armed ? new Date('2026-11-03T02:00:00Z') : null; }
    async isSchedulerRunning() { return this.armed; }
    async getSchedulerStatus() {
      return {
        enabled: true, running: this.armed, shuttingDown: !this.armed, hasRunningSync: false, nextSyncTime: null,
        lastRunStartedAt: new Date('2026-11-02T02:00:00Z'), lastRunFinishedAt: new Date('2026-11-02T02:01:00Z'),
        lastRunOutcome: 'success', lastRunTenants: { total: 1, succeeded: [7], failed: [], timedOut: [], notReached: [], stillRunning: [] },
      };
    }
  },
}));
vi.mock('../../services/BackupScheduler.js', () => ({
  BackupScheduler: class extends standIn('backup') {
    async getNextScheduledBackupTime() { return this.armed ? new Date('2026-11-04T03:00:00Z') : null; }
    async isSchedulerRunning() { return this.armed; }
    async getSchedulerStatus() {
      return {
        enabled: true, running: this.armed, hasRunningBackup: false, nextBackupTime: undefined,
        lastRunStartedAt: null, lastRunFinishedAt: null, lastRunOutcome: null, waitingForBackupKey: false,
      };
    }
  },
}));
vi.mock('../../services/NotificationScheduler.js', () => ({
  NotificationScheduler: class extends standIn('notifications') {
    isSchedulerRunning() { return this.armed; }
    async getSchedulerStatus() { return { running: this.armed, shuttingDown: false, hasRunningOperations: false, settings: null }; }
  },
}));
vi.mock('../../services/investments/OrgPriceSyncScheduler.js', () => ({ OrgPriceSyncScheduler: standIn('prices') }));
vi.mock('../../services/maintenance/MaintenanceScheduler.js', () => ({
  MaintenanceScheduler: class extends standIn('retention') {
    getStatus() { return { nextRunAt: null, running: false, lastRun: null }; }
  },
}));
vi.mock('../../services/OneDriveService.js', () => ({ OneDriveService: class {} }));
vi.mock('../../services/NotificationRulesEngine.js', () => ({ NotificationRulesEngine: class {} }));
vi.mock('../../services/NotificationQueueService.js', () => ({ NotificationQueueService: class {} }));
vi.mock('../../services/EmailTemplateService.js', () => ({ EmailTemplateService: class { registerHelpers() {} } }));
vi.mock('../../services/EmailDeliveryService.js', () => ({ EmailDeliveryService: class {} }));
vi.mock('../../services/PushNotificationService.js', () => ({ PushNotificationService: class {} }));

import { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';

/** A pool whose system_settings hold `settings`, and whose other queries answer nothing. */
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
  return { connect: async () => client, end: async () => {} } as unknown as Pool;
}

function lifecycle(settings: Record<string, string> = { notification_system_enabled: 'true' }) {
  const backupService = { sweepLeftovers: async () => {}, listBackups: async () => [] } as unknown as BackupService;
  const exit = vi.fn();
  const service = new ApplicationLifecycleService(settingsPool(settings), {} as ImportService, backupService, { exit, migrationsDir: '/nonexistent' });
  return { service, exit, settings };
}

/** The calls made since the last take. */
function take(): Call[] {
  return control.calls.splice(0);
}

/** The schedulers armed now, as `name#n`. */
function armed(): string[] {
  return control.instances.filter((s) => s.armed).map((s) => `${s.name}#${s.n}`);
}

beforeEach(() => {
  control.calls = [];
  control.built = {};
  control.instances = [];
  control.stopDelayMs = 0;
  control.startDelayMs = 0;
  control.updateDelayMs = 0;
  process.env.SHUTDOWN_DRAIN_MS = '0';
});

describe('ApplicationLifecycleService scheduler controls', () => {
  it('starts every scheduler once at startup, in order', async () => {
    const { service } = lifecycle();
    await service.initializeServices();
    expect(take()).toEqual(['import#1.start', 'backup#1.start', 'notifications#1.start', 'prices#1.start', 'retention#1.start']);
    expect(service.getStartupState()).toBe('ready');
  });

  it("doesn't start the notification scheduler while notifications are off, but keeps it", async () => {
    const { service } = lifecycle({ notification_system_enabled: 'false' });
    await service.initializeServices();
    expect(take()).not.toContain('notifications#1.start');
    expect(control.built.notifications).toBe(1);
    expect(service.getServiceStatus().notificationSchedulerActive).toBe(true);
  });

  describe('the import scheduler', () => {
    it('answers nothing before it exists, and is built by a start', async () => {
      const { service } = lifecycle();
      expect(await service.getNextScheduledSyncTime()).toBeNull();
      expect(await service.isSchedulerRunning()).toBe(false);
      await service.stopImportScheduler();
      await service.updateSchedulerConfiguration();
      expect(take()).toEqual([]);
      await service.startImportScheduler();
      expect(take()).toEqual(['import#1.start']);
      expect(await service.isSchedulerRunning()).toBe(true);
    });

    it('keeps one scheduler across stop, start and update', async () => {
      const { service } = lifecycle();
      await service.initializeServices();
      take();

      await service.stopImportScheduler();
      expect(await service.isSchedulerRunning()).toBe(false);
      expect(await service.getNextScheduledSyncTime()).toBeNull();
      expect(service.getServiceStatus()).toMatchObject({ schedulerActive: false, services: { syncScheduler: false } });
      // Its enabled flag and last run, as the retention job reports its own; not the run's
      // ledgers (other ledgers' tenant ids), which any signed-in user would read.
      expect((await service.getApplicationStatus()).scheduler).toEqual({
        active: true, nextSync: null, isRunning: false, enabled: true,
        lastRunStartedAt: new Date('2026-11-02T02:00:00Z'), lastRunFinishedAt: new Date('2026-11-02T02:01:00Z'), lastRunOutcome: 'success',
      });

      await service.startImportScheduler();
      await service.updateSchedulerConfiguration();
      // Only stopTimer: the admin controls leave a run in progress going.
      expect(take()).toEqual(['import#1.stopTimer', 'import#1.start', 'import#1.update']);
      expect(control.built.import).toBe(1);
      expect(await service.getNextScheduledSyncTime()).toEqual(new Date('2026-11-03T02:00:00Z'));
      expect(service.getServiceStatus()).toMatchObject({ schedulerActive: true, services: { syncScheduler: true } });
    });
  });

  describe('the backup scheduler', () => {
    it('keeps one scheduler across stop, start and update', async () => {
      const { service } = lifecycle();
      expect(await service.getBackupSchedulerStatus()).toMatchObject({ enabled: false, running: false });
      expect(await service.getNextScheduledBackupTime()).toBeNull();
      await service.initializeServices();
      take();

      await service.stopBackupScheduler();
      expect(await service.getBackupSchedulerStatus()).toMatchObject({ running: false });
      await service.startBackupScheduler();
      await service.updateBackupSchedulerConfiguration();
      expect(take()).toEqual(['backup#1.stop', 'backup#1.start', 'backup#1.update']);
      expect(control.built.backup).toBe(1);
      expect(await service.getNextScheduledBackupTime()).toEqual(new Date('2026-11-04T03:00:00Z'));
      expect((await service.getApplicationStatus()).backupScheduler).toEqual({
        active: true, nextBackup: new Date('2026-11-04T03:00:00Z'), isRunning: true,
      });
    });
  });

  describe('the notification scheduler', () => {
    it('is dropped by a stop and built again by a start; a start while it exists does nothing', async () => {
      const { service } = lifecycle();
      expect(await service.getNotificationSchedulerStatus()).toEqual({ running: false, shuttingDown: false, hasRunningOperations: false, settings: null });
      await service.initializeServices();
      take();

      await service.startNotificationScheduler();
      expect(take()).toEqual([]);

      await service.stopNotificationScheduler();
      expect(service.getServiceStatus().notificationSchedulerActive).toBe(false);
      expect(await service.isNotificationSchedulerRunning()).toBe(false);
      expect(await service.getNotificationSchedulerStatus()).toMatchObject({ running: false, settings: null });
      await service.stopNotificationScheduler();
      await service.updateNotificationSchedulerConfiguration();

      await service.startNotificationScheduler();
      await service.updateNotificationSchedulerConfiguration();
      await service.restartNotificationScheduler();
      expect(take()).toEqual([
        'notifications#1.stop',
        'notifications#2.start',
        'notifications#2.update',
        'notifications#2.stop',
        'notifications#3.start',
      ]);
      expect(await service.isNotificationSchedulerRunning()).toBe(true);
    });

    it('runs the controls one at a time, so two restarts at once stop each scheduler they replace', async () => {
      const { service } = lifecycle();
      await service.initializeServices();
      take();
      control.stopDelayMs = 20;
      await Promise.all([service.restartNotificationScheduler(), service.restartNotificationScheduler(), service.stopNotificationScheduler()]);
      expect(take()).toEqual([
        'notifications#1.stop',
        'notifications#2.start',
        'notifications#2.stop',
        'notifications#3.start',
        'notifications#3.stop',
      ]);
      expect(service.getServiceStatus().notificationSchedulerActive).toBe(false);
    });
  });

  describe('a restore', () => {
    it('stops every scheduler in turn, then starts each again from the settings', async () => {
      const { service } = lifecycle();
      await service.initializeServices();
      take();

      await service.pauseSchedulersForRestore();
      expect(take()).toEqual(['import#1.stop', 'backup#1.stop', 'notifications#1.stop', 'prices#1.stop', 'retention#1.stop']);
      await service.resumeSchedulersAfterRestore();
      expect(take()).toEqual(['import#1.start', 'backup#1.start', 'notifications#2.start', 'prices#1.start', 'retention#1.start']);
    });

    it("carries on starting the others when one can't start", async () => {
      const { service } = lifecycle();
      await service.initializeServices();
      await service.pauseSchedulersForRestore();
      take();
      const failing = (await import('../../services/SyncScheduler.js')).SyncScheduler.prototype;
      const spy = vi.spyOn(failing, 'startScheduler').mockRejectedValueOnce(new Error('settings unreadable'));
      await service.resumeSchedulersAfterRestore();
      expect(take()).toEqual(['backup#1.start', 'notifications#2.start', 'prices#1.start', 'retention#1.start']);
      spy.mockRestore();
    });
  });

  describe('during a shutdown', () => {
    it('refuses to start or restart a scheduler, and resumes nothing after a restore', async () => {
      const { service } = lifecycle();
      await service.initializeServices();
      const shutdown = service.shutdown('SIGTERM');
      await expect(service.startImportScheduler()).rejects.toThrow(/during shutdown/);
      await expect(service.startBackupScheduler()).rejects.toThrow(/during shutdown/);
      await expect(service.startNotificationScheduler()).rejects.toThrow(/during shutdown/);
      await expect(service.restartNotificationScheduler()).rejects.toThrow(/during shutdown/);
      await shutdown;
      take();
      await service.resumeSchedulersAfterRestore();
      expect(take()).toEqual([]);
    });

    it('arms nothing after a shutdown that began while a restart waited for its slow stop', async () => {
      const { service, exit } = lifecycle();
      await service.initializeServices();
      take();
      // The restart's stop waits for a run in progress; the shutdown comes in the meantime.
      control.stopDelayMs = 50;
      const restart = service.restartNotificationScheduler().then(() => 'restarted', (err: Error) => err.message);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(take()).toEqual(['notifications#1.stop']);
      await service.shutdown('SIGTERM');
      expect(exit).toHaveBeenCalledWith(0);

      expect(await restart).toBe('Cannot restart the notification scheduler during shutdown');
      expect(take().filter((call) => call.endsWith('.start'))).toEqual([]);
      expect(armed()).toEqual([]);
    });

    it('stops a scheduler again that a start was still arming when the shutdown stopped it', async () => {
      const { service } = lifecycle();
      await service.initializeServices();
      await service.stopBackupScheduler();
      await service.stopNotificationScheduler();
      take();
      control.startDelayMs = 50;
      const starts = Promise.all([service.startBackupScheduler(), service.startNotificationScheduler()]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(take()).toEqual(['backup#1.start', 'notifications#2.start']);
      await service.shutdown('SIGTERM');
      await starts;

      expect(armed()).toEqual([]);
      expect(take()).toEqual(expect.arrayContaining(['backup#1.stop', 'notifications#2.stop']));
    });

    it('re-arms nothing for a settings change that comes after the shutdown stopped the schedulers', async () => {
      const { service } = lifecycle();
      await service.initializeServices();
      // A request in flight when the shutdown stopped the schedulers (the server waits for
      // it to finish): saving the backup settings or the deployment's time zone, say.
      await service.shutdown('SIGTERM');
      take();
      await service.updateBackupSchedulerConfiguration();
      await service.updateNotificationSchedulerConfiguration();
      await service.updateSchedulerConfiguration();
      expect(take()).toEqual([]);
      expect(armed()).toEqual([]);
    });

    it('stops a scheduler again that a settings change was still re-arming when the shutdown stopped it', async () => {
      const { service } = lifecycle();
      await service.initializeServices();
      take();
      control.updateDelayMs = 50;
      const update = service.updateBackupSchedulerConfiguration();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(take()).toEqual(['backup#1.update']);
      await service.shutdown('SIGTERM');
      await update;
      expect(armed()).toEqual([]);
    });

    it('stops every scheduler, the notification scheduler without dropping it', async () => {
      const { service, exit } = lifecycle();
      await service.initializeServices();
      take();
      await service.shutdown('SIGTERM');
      expect(take().sort()).toEqual(['backup#1.stop', 'import#1.stop', 'notifications#1.stop', 'prices#1.stop', 'retention#1.stop']);
      expect(service.getServiceStatus().notificationSchedulerActive).toBe(true);
      expect(exit).toHaveBeenCalledWith(0);
    });
  });
});
