import { createLogger } from '../../utils/logger.js';
import { runDetached } from '../../db/withTenant.js';
import {
  PriceSyncInProgressError,
  priceSyncService,
  todayInTimezone,
  type PriceSyncService,
  type PriceSyncSettings,
} from './PriceSyncService.js';
import type { Scheduler } from '../schedulers/SchedulerRegistry.js';

const logger = createLogger({ service: 'OrgPriceSyncScheduler' });

const TICK_MS = 5 * 60 * 1000; // check every 5 minutes

/**
 * Tick-based scheduler for organization price sync. Every 5 minutes it reads the
 * enabled per-org settings and runs any org whose configured local time has
 * arrived and that hasn't already run today (deduped via last_run_at). The tick
 * model keeps per-org schedules + the on/off switch + live settings changes
 * simple (no restart-on-settings-change needed). Mirrors NotificationScheduler.
 */
export class OrgPriceSyncScheduler implements Scheduler {
  private tick: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private current: Promise<unknown> | null = null;
  private checking = false;

  constructor(private readonly svc: PriceSyncService = priceSyncService) {}

  async startScheduler(): Promise<void> {
    this.isShuttingDown = false;
    this.clearTimer();
    this.tick = runDetached(() =>
      setInterval(() => {
        if (!this.isShuttingDown) void this.checkDueOrgs();
      }, TICK_MS)
    );
    logger.info({ tickMinutes: TICK_MS / 60000 }, 'Org price-sync scheduler started');
    // The first check runs now, but isn't waited for: it fetches prices for every org
    // that is due, which can take minutes, and the server isn't ready until its
    // schedulers have started. It catches its own errors; stopScheduler waits
    // for a run it started. Before it, the runs a stopped server left 'running' are
    // marked failed.
    runDetached(() => void this.failStaleRuns().then(() => this.checkDueOrgs()));
  }

  private async failStaleRuns(): Promise<void> {
    try {
      await this.svc.failStaleRunsOfIdleOrgs?.();
    } catch (err) {
      logger.warn({ err }, 'Could not mark the price-sync runs a stopped server left running as failed');
    }
  }

  async stopScheduler(): Promise<void> {
    this.isShuttingDown = true;
    this.clearTimer();
    if (this.current) {
      try {
        await Promise.race([
          this.current,
          new Promise((_, reject) => setTimeout(() => reject(new Error('price-sync drain timeout')), 30_000)),
        ]);
      } catch (err) {
        logger.warn({ err }, 'Price-sync run did not finish during shutdown');
      }
    }
    logger.info('Org price-sync scheduler stopped');
  }

  private clearTimer(): void {
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
  }

  /** Whether an enabled org is due to run now (local time reached + not run today). */
  isDue(s: Pick<PriceSyncSettings, 'schedule_time' | 'timezone' | 'last_run_at'>, now: Date = new Date()): boolean {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: s.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const nowHhmm = `${hh}:${mm}`;
    if (nowHhmm < s.schedule_time) return false;
    if (s.last_run_at) {
      const ranDay = todayInTimezone(s.timezone, new Date(s.last_run_at));
      if (ranDay === todayInTimezone(s.timezone, now)) return false; // already ran today
    }
    return true;
  }

  private async checkDueOrgs(): Promise<void> {
    if (this.isShuttingDown) return;
    // A run can outlast the tick. An org's run is marked only when it finishes, so a
    // tick that started meanwhile would run the same org again.
    if (this.checking) {
      logger.info('Previous price-sync tick still running; skipping this one');
      return;
    }
    this.checking = true;
    try {
      const enabled = await this.svc.listEnabledSettings();
      for (const s of enabled) {
        if (this.isShuttingDown) break;
        if (!this.isDue(s)) continue;
        logger.info({ orgId: s.organization_id }, 'Org price sync is due — running');
        this.current = this.svc
          .runForOrg(s.organization_id, { trigger: 'scheduler' })
          .catch((err) => {
            // A manual run of the org (or another server's) is going: that run does it.
            if (err instanceof PriceSyncInProgressError) {
              logger.info({ orgId: s.organization_id }, 'Skipping the scheduled price sync: a run of this organization is already going');
              return;
            }
            logger.error({ err, orgId: s.organization_id }, 'Scheduled price sync failed');
          });
        await this.current;
        this.current = null;
      }
    } catch (err) {
      logger.error({ err }, 'Price-sync scheduler tick failed');
    } finally {
      this.checking = false;
    }
  }
}
