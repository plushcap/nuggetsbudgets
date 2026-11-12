import { NotificationRulesEngine } from './NotificationRulesEngine.js';
import { runDetached } from '../db/withTenant.js';
import { readSystemSettings } from './systemSettings.js';
import { forEachTenant, forEachTenantId } from '../db/forEachTenant.js';
import { createLogger } from '../utils/logger.js';
import type { Scheduler } from './schedulers/SchedulerRegistry.js';

const logger = createLogger({ service: 'NotificationScheduler' });

/** The scheduler's settings, read from system_settings. */
export interface NotificationSchedulerSettings {
  systemEnabled: boolean;
  rulesCheckIntervalMinutes: number;
  queueProcessIntervalMinutes: number;
}

/**
 * NotificationScheduler
 *
 * Schedules periodic notification checks and queue processing.
 * Follows the same pattern as BackupScheduler and SyncScheduler.
 *
 * Two scheduled tasks, each run once per active tenant:
 * - Notification rules check: queue what each rule finds (every X minutes)
 * - Queue processing: send what's queued (every X minutes)
 */
export class NotificationScheduler implements Scheduler {
  private rulesEngine: NotificationRulesEngine;

  // Scheduler intervals
  private rulesCheckInterval: NodeJS.Timeout | null = null;
  private queueProcessInterval: NodeJS.Timeout | null = null;
  // Each job's first run, a minute or two after start. Cleared on stop: a restart that
  // turned notifications off (or on again) must not leave the old one to fire.
  private startupTimers: Set<NodeJS.Timeout> = new Set();

  // Shutdown flag
  private isShuttingDown: boolean = false;

  // Track running operations for graceful shutdown
  private currentOperations: Set<Promise<void>> = new Set();

  // The run of each job still in flight. A run that outlasts its interval (a slow
  // SMTP server, say) is skipped rather than started again beside it.
  private rulesCheckRun: Promise<void> | null = null;
  private queueProcessRun: Promise<void> | null = null;

  constructor(rulesEngine: NotificationRulesEngine) {
    this.rulesEngine = rulesEngine;
  }

  // Start, stop and restart run one at a time: two settings saves at once each
  // armed intervals, and the second overwrote the first's handles, which then could
  // never be cleared, so turning notifications off didn't stop them.
  private control: Promise<unknown> = Promise.resolve();

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.control.then(fn, fn);
    this.control = run.catch(() => {});
    return run;
  }

  /**
   * Start all notification schedulers
   */
  startScheduler(): Promise<void> {
    return this.serialized(() => this.start());
  }

  /**
   * Stop all notification schedulers
   */
  stopScheduler(): Promise<void> {
    return this.serialized(() => this.stop());
  }

  private async start(): Promise<void> {
    try {
      // Clear any timers a previous start armed.
      this.clearTimers();

      // Reset shutdown flag
      this.isShuttingDown = false;

      // Get notification settings
      const settings = await this.getNotificationSettings();

      if (!settings.systemEnabled) {
        logger.info('Notification system is disabled in settings');
        return;
      }

      logger.info({
        rulesCheckInterval: settings.rulesCheckIntervalMinutes,
        queueProcessInterval: settings.queueProcessIntervalMinutes,
      }, 'Starting notification schedulers');

      this.startRulesCheckScheduler(settings.rulesCheckIntervalMinutes);

      // Start queue processing scheduler
      this.startQueueProcessScheduler(settings.queueProcessIntervalMinutes);

      logger.info('All notification schedulers started successfully');

    } catch (error) {
      logger.error({ err: error }, 'Failed to start notification scheduler');
      throw error;
    }
  }

  private clearTimers(): void {
    for (const timer of this.startupTimers) clearTimeout(timer);
    this.startupTimers.clear();
    if (this.rulesCheckInterval) {
      clearInterval(this.rulesCheckInterval);
      this.rulesCheckInterval = null;
      logger.debug('Rules check scheduler cleared');
    }

    if (this.queueProcessInterval) {
      clearInterval(this.queueProcessInterval);
      this.queueProcessInterval = null;
      logger.debug('Queue process scheduler cleared');
    }
  }

  private async stop(): Promise<void> {
    logger.info('Stopping notification schedulers');
    this.isShuttingDown = true;
    this.clearTimers();

    // Wait for any in-flight operations to complete
    if (this.currentOperations.size > 0) {
      logger.info({ operationCount: this.currentOperations.size }, 'Waiting for notification operations to complete');
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.all(this.currentOperations),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Notification operations timeout during shutdown')), 30000);
          }),
        ]);
        logger.info('All notification operations completed');
      } catch (error) {
        logger.warn({ err: error }, 'Notification operations timed out or failed during shutdown');
      } finally {
        clearTimeout(timeout);
      }
    }

    logger.info('Notification schedulers stopped successfully');
  }

  /**
   * Restart schedulers (reload settings)
   */
  updateSchedule(): Promise<void> {
    return this.serialized(async () => {
      logger.info('Updating notification schedules');
      await this.stop();
      await this.start();
    });
  }

  /** A job's first run after start, cleared if the scheduler stops first. */
  private startupTimer(run: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.startupTimers.delete(timer);
      if (!this.isShuttingDown) run();
    }, delayMs);
    this.startupTimers.add(timer);
  }

  /**
   * Start the notification rules check scheduler
   */
  private startRulesCheckScheduler(intervalMinutes: number): void {
    const intervalMs = intervalMinutes * 60 * 1000;

    runDetached(() => {
      // Run after 1 minute delay on startup
      this.startupTimer(() => this.runRulesCheck(), 60000);

      this.rulesCheckInterval = setInterval(() => {
        if (!this.isShuttingDown) {
          this.runRulesCheck();
        }
      }, intervalMs);
    });

    logger.info({ intervalMinutes }, 'Notification rules check scheduler started');
  }

  /**
   * Start queue processing scheduler
   */
  private startQueueProcessScheduler(intervalMinutes: number): void {
    const intervalMs = intervalMinutes * 60 * 1000;

    runDetached(() => {
      // Run after 2 minute delay on startup
      this.startupTimer(() => this.runQueueProcess(), 120000);

      // Then run on interval
      this.queueProcessInterval = setInterval(() => {
        if (!this.isShuttingDown) {
          this.runQueueProcess();
        }
      }, intervalMs);
    });

    logger.info({ intervalMinutes }, 'Queue process scheduler started');
  }

  /**
   * Run the notification rules check
   */
  private runRulesCheck(): void {
    if (this.isShuttingDown) {
      logger.debug('Skipping notification rules check - shutting down');
      return;
    }

    if (this.rulesCheckRun) {
      logger.warn('Previous notification rules check is still running — skipping this one');
      return;
    }
    const operation = this.executeRulesCheck();
    this.rulesCheckRun = operation;
    this.currentOperations.add(operation);

    operation.finally(() => {
      this.currentOperations.delete(operation);
      this.rulesCheckRun = null;
    });
  }

  /**
   * Execute the notification rules check
   */
  private async executeRulesCheck(): Promise<void> {
    try {
      logger.info('Running scheduled notification rules check');
      // Schedulers run outside any request, so process each active tenant in its
      // own tenant context.
      const result = await forEachTenant('notification-rules-check', () =>
        this.rulesEngine.queueDueNotifications()
      );
      logger.info(result, 'Notification rules check completed');
    } catch (error) {
      logger.error({ err: error }, 'Notification rules check failed');
    }
  }

  /**
   * Run queue processing
   */
  private runQueueProcess(): void {
    if (this.isShuttingDown) {
      logger.debug('Skipping queue process - shutting down');
      return;
    }

    if (this.queueProcessRun) {
      logger.warn('Previous notification queue run is still going — skipping this one');
      return;
    }
    const operation = this.executeQueueProcess();
    this.queueProcessRun = operation;
    this.currentOperations.add(operation);

    operation.finally(() => {
      this.currentOperations.delete(operation);
      this.queueProcessRun = null;
    });
  }

  /**
   * Execute queue processing
   */
  private async executeQueueProcess(): Promise<void> {
    try {
      logger.info('Running scheduled queue processing');
      // No transaction around it: it opens short ones around sending.
      const result = await forEachTenantId('notification-queue-process', (tenantId) =>
        this.rulesEngine.processNotificationQueue(tenantId)
      );
      logger.info(result, 'Queue processing completed');
    } catch (error) {
      logger.error({ err: error }, 'Queue processing failed');
    }
  }

  /**
   * Get notification settings from database
   */
  private async getNotificationSettings(): Promise<NotificationSchedulerSettings> {
    const settings = await readSystemSettings([
      'notification_system_enabled',
      'notification_rules_check_interval',
      'notification_queue_process_interval',
    ]);

    return {
      systemEnabled: settings.notification_system_enabled === 'true',
      rulesCheckIntervalMinutes: parseInt(settings.notification_rules_check_interval ?? '') || 15,
      queueProcessIntervalMinutes: parseInt(settings.notification_queue_process_interval ?? '') || 5,
    };
  }

  /**
   * Check if scheduler is running
   */
  isSchedulerRunning(): boolean {
    return this.rulesCheckInterval !== null || this.queueProcessInterval !== null;
  }

  /**
   * Get scheduler status
   */
  async getSchedulerStatus(): Promise<{
    running: boolean;
    shuttingDown: boolean;
    hasRunningOperations: boolean;
    settings: NotificationSchedulerSettings;
  }> {
    const settings = await this.getNotificationSettings();

    return {
      running: this.isSchedulerRunning(),
      shuttingDown: this.isShuttingDown,
      hasRunningOperations: this.currentOperations.size > 0,
      settings,
    };
  }
}
