import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ service: 'ApplicationLifecycle' });

/**
 * A background scheduler, as the lifecycle drives it (SyncScheduler, BackupScheduler,
 * NotificationScheduler, OrgPriceSyncScheduler, MaintenanceScheduler). Each arms its own
 * timers, created in runDetached so a start from an admin's request doesn't run as that
 * request, and a start re-arms one that is already armed.
 */
export interface Scheduler {
  /** Arm it from the current settings (nothing, when they turn it off). Throws when it can't read them. */
  startScheduler(): Promise<void>;
  /** Disarm it, and wait for a run in progress to finish. */
  stopScheduler(): Promise<void>;
  /** Re-read its settings and re-arm; the settings routes call it after a change. */
  updateSchedule?(): Promise<void>;
}

/** How the lifecycle builds, arms and keeps one scheduler. */
export interface SchedulerSpec<S extends Scheduler> {
  /** Its name in logs and errors, e.g. 'import scheduler'. */
  name: string;
  create(): S | Promise<S>;
  /** Arm it; startScheduler unless a setting decides (the notification scheduler's). False when it left it unarmed. */
  arm?(scheduler: S): Promise<boolean>;
  /**
   * How an admin's stop or restart disarms it. By default stopScheduler, which also ends a
   * run in progress; the import scheduler only disarms its timer. A restore's pause
   * and a shutdown always call stopScheduler.
   */
  disarm?(scheduler: S): void | Promise<void>;
  /** What to log once it is armed (its next run, say). */
  describe?(scheduler: S): Promise<Record<string, unknown>>;
  /**
   * 'kept': built once and kept across a stop, since it holds its last run's outcome and
   * "exists" never meant "armed"; a start re-arms it.
   * 'whileStarted': kept only once armed, dropped by a stop and built afresh by the next
   * start; a start while it exists does nothing.
   */
  lifetime: 'kept' | 'whileStarted';
}

/** What the lifecycle can do with any scheduler, whatever its type. */
export interface SchedulerControls {
  readonly name: string;
  /** Build it if need be and arm it: startup's start. Throws when it couldn't. */
  initialize(): Promise<void>;
  /** An admin's start, or a restore's resume. */
  start(): Promise<void>;
  /** An admin's stop (the spec's disarm). */
  stop(): Promise<void>;
  /** A restore's pause: stopScheduler, ending a run in progress. */
  pause(): Promise<void>;
  restart(): Promise<void>;
  update(): Promise<void>;
  /** Stop it for a shutdown: disarmed and its run finished, but kept for the status. False when there was none. */
  stopForShutdown(): Promise<boolean>;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One scheduler under the lifecycle's control. */
export class ManagedScheduler<S extends Scheduler> implements SchedulerControls {
  private instance: S | null = null;
  // The controls build, replace and drop the scheduler. Run them one at a time: two
  // restarts at once each built one, and the first was never stopped.
  private controls: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly spec: SchedulerSpec<S>,
    private readonly shuttingDown: () => boolean,
  ) {}

  get name(): string {
    return this.spec.name;
  }

  /** The scheduler, or null before it was first built (or, 'whileStarted', while stopped). */
  get current(): S | null {
    return this.instance;
  }

  async initialize(): Promise<void> {
    if (this.spec.lifetime === 'kept') {
      this.instance ??= await this.spec.create();
      await this.arm(this.instance);
    } else {
      // Kept only once it has started (or is off in the settings), so a scheduler that
      // failed to start isn't reported as active.
      const scheduler = await this.spec.create();
      await this.arm(scheduler);
      this.instance = scheduler;
    }
  }

  start(): Promise<void> {
    return this.control(async () => {
      this.refuseDuringShutdown('start');
      if (!this.instance) {
        await this.initialize();
      } else if (this.spec.lifetime === 'kept') {
        // Re-arm from the current settings rather than return early: the instance
        // outlives a stop, so "exists" never meant "armed".
        await this.arm(this.instance);
      } else {
        logger.info({ scheduler: this.name }, `${capitalized(this.name)} is already running`);
      }
    });
  }

  stop(): Promise<void> {
    return this.control(async () => {
      const scheduler = this.instance;
      if (!scheduler) {
        logger.info({ scheduler: this.name }, `${capitalized(this.name)} was not running`);
        return;
      }
      logger.info({ scheduler: this.name }, `Stopping the ${this.name}`);
      await this.disarm(scheduler);
      if (this.spec.lifetime === 'whileStarted') this.instance = null;
      logger.info({ scheduler: this.name }, `${capitalized(this.name)} stopped`);
    });
  }

  pause(): Promise<void> {
    return this.control(async () => {
      await this.instance?.stopScheduler();
      if (this.spec.lifetime === 'whileStarted') this.instance = null;
    });
  }

  restart(): Promise<void> {
    return this.control(async () => {
      this.refuseDuringShutdown('restart');
      logger.info({ scheduler: this.name }, `Restarting the ${this.name}`);
      if (this.instance) {
        await this.disarm(this.instance);
        if (this.spec.lifetime === 'whileStarted') this.instance = null;
      }
      // A shutdown that began while it stopped (a run in progress to wait for) has stopped
      // the schedulers, or is stopping them, outside this queue: arming one now would leave
      // it armed after the shutdown completed.
      this.refuseDuringShutdown('restart');
      await this.initialize();
      logger.info({ scheduler: this.name }, `${capitalized(this.name)} restarted`);
    });
  }

  update(): Promise<void> {
    return this.control(async () => {
      const scheduler = this.instance;
      if (!scheduler?.updateSchedule) return;
      // A settings change (the backup settings, the deployment's time zone) from a request
      // still in flight during a shutdown re-arms nothing: the shutdown stops the schedulers
      // outside this queue, maybe already. The settings are saved; the next start reads them.
      if (this.shuttingDown()) {
        logger.info({ scheduler: this.name }, `Not re-arming the ${this.name}: the server is shutting down`);
        return;
      }
      await scheduler.updateSchedule();
      // The shutdown began while it re-armed: its stop may have come first.
      if (this.shuttingDown()) {
        logger.info({ scheduler: this.name }, `Stopping the ${this.name} again: the server began shutting down while it re-armed`);
        await scheduler.stopScheduler();
      }
    });
  }

  async stopForShutdown(): Promise<boolean> {
    if (!this.instance) return false;
    await this.instance.stopScheduler();
    return true;
  }

  private async disarm(scheduler: S): Promise<void> {
    await (this.spec.disarm ? this.spec.disarm(scheduler) : scheduler.stopScheduler());
  }

  private async arm(scheduler: S): Promise<void> {
    // Nothing is armed once a shutdown has begun: its stop may already have run.
    if (this.shuttingDown()) {
      logger.info({ scheduler: this.name }, `Not starting the ${this.name}: the server is shutting down`);
      return;
    }
    logger.info({ scheduler: this.name }, `Starting the ${this.name}`);
    if (this.spec.arm) {
      if (!(await this.spec.arm(scheduler))) return;
    } else {
      await scheduler.startScheduler();
    }
    // A shutdown that began while it armed (reading its settings) may have stopped it
    // before its timer was set: stop it again, so nothing stays armed after the shutdown.
    if (this.shuttingDown()) {
      logger.info({ scheduler: this.name }, `Stopping the ${this.name} again: the server began shutting down while it started`);
      await scheduler.stopScheduler();
      return;
    }
    const details = this.spec.describe ? await this.spec.describe(scheduler) : {};
    logger.info({ scheduler: this.name, ...details }, `${capitalized(this.name)} started`);
  }

  private refuseDuringShutdown(action: 'start' | 'restart'): void {
    if (this.shuttingDown()) throw new Error(`Cannot ${action} the ${this.name} during shutdown`);
  }

  private control<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.controls.then(fn, fn);
    this.controls = run.catch(() => {});
    return run;
  }
}

/**
 * The lifecycle's schedulers, by key, in the order they start: startup starts them in
 * this order, a restore pauses and resumes them in it, and a shutdown stops them all at
 * once.
 */
export class SchedulerRegistry<T extends Record<string, Scheduler>> {
  private readonly managed: { [K in keyof T]: ManagedScheduler<T[K]> };

  constructor(specs: { [K in keyof T]: SchedulerSpec<T[K]> }, shuttingDown: () => boolean) {
    this.managed = Object.fromEntries(
      Object.entries(specs).map(([key, spec]) => [key, new ManagedScheduler(spec, shuttingDown)])
    ) as { [K in keyof T]: ManagedScheduler<T[K]> };
  }

  get<K extends keyof T>(key: K): ManagedScheduler<T[K]> {
    return this.managed[key];
  }

  all(): SchedulerControls[] {
    return Object.values(this.managed);
  }

  /** Stop each in turn for a restore; the first that fails stops the pause. */
  async pauseAll(): Promise<void> {
    for (const scheduler of this.all()) await scheduler.pause();
  }

  /** Start each again after a restore, from the restored settings; one that can't start doesn't stop the rest. */
  async resumeAll(): Promise<void> {
    for (const scheduler of this.all()) {
      try {
        await scheduler.start();
      } catch (err) {
        logger.error({ err, scheduler: scheduler.name }, 'Could not start a scheduler again after a restore');
      }
    }
  }

  /** Stop them all at once for a shutdown, letting a run in progress finish; one failing doesn't stop the rest. */
  async stopAllForShutdown(): Promise<void> {
    await Promise.all(
      this.all().map(async (scheduler) => {
        try {
          if (await scheduler.stopForShutdown()) logger.info({ scheduler: scheduler.name }, 'Scheduler stopped');
        } catch (err) {
          logger.error({ err, scheduler: scheduler.name }, 'Error stopping a scheduler');
        }
      })
    );
  }
}
