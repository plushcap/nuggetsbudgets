import { runDetached } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { retentionPolicy, runRetention, type RetentionCounts, type RetentionOptions, type RetentionPolicy } from './retention.js';
import type { Scheduler } from '../schedulers/SchedulerRegistry.js';

const logger = createLogger({ service: 'MaintenanceScheduler' });

const HOUR_MS = 60 * 60 * 1000;

export interface MaintenanceSchedulerOptions {
  /** After a start, the first run waits this long, so it doesn't compete with startup. */
  firstRunDelayMs?: number;
  /** Then one run every this long. */
  intervalMs?: number;
  /** What a run does (runRetention; a stand-in in tests). */
  run?: (policy: RetentionPolicy, options: RetentionOptions) => Promise<RetentionCounts>;
}

export interface MaintenanceStatus {
  nextRunAt: Date | null;
  running: boolean;
  lastRunStartedAt: Date | null;
  lastRunFinishedAt: Date | null;
  lastRunOutcome: 'success' | 'failed' | null;
  // Not what a run deleted: those are deployment-wide counts, across every organization,
  // and any signed-in user reads this (GET /api/status). They are in the log.
}

/**
 * Runs the retention job (services/maintenance/retention.ts) once a day,
 * the first time 10 minutes after the server starts, so a server that restarts often
 * still runs it. The timer is re-armed before each run, so a run that fails costs one
 * day, never the schedule, and a run still going when the next is due is skipped. Armed
 * in runDetached: it runs as no request and in no ledger (CLAUDE.md). Stopping
 * waits for a run in progress, which stops between batches.
 */
export class MaintenanceScheduler implements Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private nextRunAt: Date | null = null;
  private current: Promise<void> | null = null;
  private stopping = false;
  private lastRunStartedAt: Date | null = null;
  private lastRunFinishedAt: Date | null = null;
  private lastRunOutcome: 'success' | 'failed' | null = null;
  private readonly firstRunDelayMs: number;
  private readonly intervalMs: number;
  private readonly run: NonNullable<MaintenanceSchedulerOptions['run']>;

  constructor(options: MaintenanceSchedulerOptions = {}) {
    this.firstRunDelayMs = options.firstRunDelayMs ?? 10 * 60 * 1000;
    this.intervalMs = options.intervalMs ?? 24 * HOUR_MS;
    this.run = options.run ?? runRetention;
  }

  /** Arm the first run. Throws, arming nothing, when the retention settings are invalid. */
  async startScheduler(): Promise<void> {
    retentionPolicy();
    this.stopping = false;
    this.clearTimer();
    this.arm(this.firstRunDelayMs);
    logger.info({ nextRunAt: this.nextRunAt?.toISOString(), intervalHours: this.intervalMs / HOUR_MS }, 'Retention scheduled');
  }

  async stopScheduler(): Promise<void> {
    this.stopping = true;
    this.clearTimer();
    if (this.current) {
      logger.info('Waiting for the retention run in progress to stop');
      await this.current;
    }
  }

  getStatus(): MaintenanceStatus {
    return {
      nextRunAt: this.nextRunAt,
      running: this.current !== null,
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunFinishedAt: this.lastRunFinishedAt,
      lastRunOutcome: this.lastRunOutcome,
    };
  }

  private arm(delayMs: number): void {
    this.nextRunAt = new Date(Date.now() + delayMs);
    this.timer = runDetached(() => setTimeout(() => void this.onTimer(), delayMs));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  private async onTimer(): Promise<void> {
    this.timer = null;
    this.nextRunAt = null;
    if (this.stopping) return;
    this.arm(this.intervalMs);
    if (this.current) {
      logger.warn('The previous retention run is still going; skipping this one');
      return;
    }
    this.current = this.runOnce().finally(() => {
      this.current = null;
    });
    await this.current;
  }

  private async runOnce(): Promise<void> {
    this.lastRunStartedAt = new Date();
    try {
      await this.run(retentionPolicy(), { shouldStop: () => this.stopping });
      this.lastRunOutcome = 'success';
    } catch (err) {
      this.lastRunOutcome = 'failed';
      logger.error({ err }, 'Retention run failed');
    } finally {
      this.lastRunFinishedAt = new Date();
    }
  }
}
