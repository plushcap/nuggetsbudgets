import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import type { DB } from '../db/schema.generated.js';
import { Server } from 'http';
import { ImportService } from './ImportService.js';
import { readSystemSetting } from './systemSettings.js';
import { SyncScheduler, type SyncRunOutcome } from './SyncScheduler.js';
import { BackupService } from './BackupService.js';
import { BackupScheduler } from './BackupScheduler.js';
import { NotificationScheduler, type NotificationSchedulerSettings } from './NotificationScheduler.js';
import { OrgPriceSyncScheduler } from './investments/OrgPriceSyncScheduler.js';
import { MaintenanceScheduler, type MaintenanceStatus } from './maintenance/MaintenanceScheduler.js';
import { SchedulerRegistry } from './schedulers/SchedulerRegistry.js';
import { OneDriveService } from './OneDriveService.js';
import { createLogger } from '../utils/logger.js';
import { terminatePgTools } from '../utils/pgTools.js';
import { stopSchemaDownloads } from './databaseDiagnostics.js';
import { getRestoreStatus, getVerifyStatus, isRestoreRunning, isVerifyRunning, restoreJobSettled, verifyJobSettled } from './restoreJob.js';
import type { BackupHealth } from '../middleware/health-checks.js';
import { ProductionConfigError, refuseSetting } from '../utils/productionConfig.js';
import { strictSetting } from '../config.js';
import { shippedSchemaVersions } from '../db/schemaReady.js';
import { BASELINE } from '../db/baseline.js';
import { allowConnectionsFix, isDatabaseUnreachable } from '../utils/dbErrors.js';

const logger = createLogger({ service: 'ApplicationLifecycle' });

/** How long /api/ready waits for the database before it reports it unavailable. */
const READINESS_DB_TIMEOUT_MS = 2000;

/**
 * How long a shutdown waits for a running backup before stopping its pg_dump,
 * then for the stopped one to wind up. Inside SHUTDOWN_TIMEOUT_MS. (A restore is
 * stopped at once if it hasn't begun replacing the data, and waited for if it has.)
 */
const BACKUP_SHUTDOWN_WAIT_MS = 35_000;
const BACKUP_STOPPED_WAIT_MS = 10_000;

/** How often a shutdown asks a restore it is stopping to stop again (interruptRestore). */
const RESTORE_INTERRUPT_INTERVAL_MS = 1000;

/**
 * How long a shutdown may take (SHUTDOWN_TIMEOUT_MS, default 55 s: the 2 s drain, then a
 * backup or restore given 35 s to finish, 10 s to stop and 5 s to wind up, while the
 * requests in flight finish and the schedulers stop, then the pool) and, of that, how long
 * the server goes on serving while it reports not ready (SHUTDOWN_DRAIN_MS, default 2 s
 * in production, 0 elsewhere), so a proxy that polls /api/ready stops sending requests
 * first. The compose files give the backend a stop_grace_period of 60 s, above the
 * timeout, so the process exits on its own before Docker kills it. Both are read as
 * config.ts defines them (their defaults and ranges are there); that the drain is shorter
 * than the timeout is checked here, which index.ts runs at startup.
 */
export function shutdownSettings(env: NodeJS.ProcessEnv = process.env): { timeoutMs: number; drainMs: number } {
  const timeoutMs = strictSetting('SHUTDOWN_TIMEOUT_MS', env, refuseSetting);
  const drainMs = strictSetting('SHUTDOWN_DRAIN_MS', env, refuseSetting);
  if (drainMs >= timeoutMs) {
    throw new ProductionConfigError([
      `SHUTDOWN_DRAIN_MS (${drainMs}) must be less than SHUTDOWN_TIMEOUT_MS (${timeoutMs}), or every shutdown runs out of time`,
    ]);
  }
  return { timeoutMs, drainMs };
}

/** Whether the background services have started; see initializeServices. */
export type StartupState = 'starting' | 'ready' | 'failed';

/** What GET /api/ready answers (middleware/health-checks.ts). */
export interface Readiness {
  ready: boolean;
  checks: {
    /** The background services (schedulers) started. */
    startup: StartupState;
    shuttingDown: boolean;
    /** The database answered within READINESS_DB_TIMEOUT_MS. */
    database: 'ok' | 'unavailable';
    /** The baseline and every migration this code ships are applied ('unknown' when the database didn't answer). */
    migrations: 'ok' | 'pending' | 'unknown';
  };
}

export interface LifecycleOptions {
  /** Ends the process: process.exit, except in tests. */
  exit?: (code: number) => void;
  /** Where this code's migration files are, for the readiness check (default ./migrations). */
  migrationsDir?: string;
  /** How long the readiness check's database answer is reused (default 1000 ms). */
  readinessCacheMs?: number;
  /**
   * OneDrive, where the backup scheduler copies each backup: the one the routes use
   * (index.ts passes it to both), else a new one.
   */
  oneDriveService?: OneDriveService | undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `promise`, or a rejection once `ms` have passed. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * ApplicationLifecycleService
 *
 * Manages application startup and shutdown lifecycle including:
 * - Service initialization and dependencies, retried at startup (initializeServices)
 * - Readiness: whether this server can serve now (GET /api/ready)
 * - Graceful shutdown: not ready, then no new connections, the requests in flight and
 *   the schedulers' runs finish, then the database pool closes, within a deadline
 * - Signal handling for container orchestration
 */
export class ApplicationLifecycleService {
  private server: Server | null = null;
  /** The background schedulers, in the order they start (see the constructor). */
  private readonly schedulers: SchedulerRegistry<{
    import: SyncScheduler;
    backup: BackupScheduler;
    notifications: NotificationScheduler;
    prices: OrgPriceSyncScheduler;
    retention: MaintenanceScheduler;
  }>;
  private isShuttingDown = false;
  /** Something asked for a failed exit while a shutdown was already running. */
  private failedDuringShutdown = false;
  private shutdownTimeout: NodeJS.Timeout | null = null;
  private startupState: StartupState = 'starting';
  /** Whether the database answered the last check (readiness, status); null before one. */
  private lastDatabaseOk: boolean | null = null;
  /** Whether the last readiness check found the server ready, to log only changes. */
  private lastReady: boolean | null = null;
  private readonly exit: (code: number) => void;
  private readonly migrationsDir: string | undefined;
  /** The migrations this code ships; read once, on the first readiness check. */
  private expectedMigrations: string[] | undefined;
  /** The readiness check's database query, shared by concurrent probes (probeDatabase). */
  private dbProbe: { result: Promise<number>; settledAt: number | null } | null = null;
  private readonly readinessCacheMs: number;
  private readonly oneDriveService: OneDriveService;
  // Typed query builder for this service's own reads (its settings, the readiness probe);
  // the pool itself it ends at shutdown.
  private db: Kysely<DB>;

  constructor(
    private pool: Pool,
    private importService: ImportService,
    private backupService: BackupService,
    options: LifecycleOptions = {}
  ) {
    // The schema comes from the migration runner (scripts/migrate.ts), before startup.
    this.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.migrationsDir = options.migrationsDir;
    this.readinessCacheMs = options.readinessCacheMs ?? 1000;
    this.oneDriveService = options.oneDriveService ?? new OneDriveService();
    this.schedulers = new SchedulerRegistry(
      {
        // It arms one tick for every ledger; each run reads each ledger's own
        // import_enabled and schedule (tenant_settings).
        import: {
          name: 'import scheduler',
          lifetime: 'kept',
          create: () => new SyncScheduler(this.importService),
          // An admin's stop or restart only disarms the timer; a run in progress goes on.
          // Its startScheduler clears the armed timer itself.
          disarm: (scheduler) => scheduler.stopTimer(),
          describe: async (scheduler) => ({
            armed: scheduler.isTimerArmed(),
            nextSync: (await scheduler.getNextScheduledSyncTime())?.toISOString() ?? null,
          }),
        },
        // Likewise `backup_enabled`, so the status reports what is actually armed.
        backup: {
          name: 'backup scheduler',
          lifetime: 'kept',
          create: () => new BackupScheduler(this.backupService, this.oneDriveService),
          describe: async (scheduler) => ({
            armed: scheduler.isTimerArmed(),
            nextBackup: (await scheduler.getNextScheduledBackupTime())?.toISOString() ?? null,
          }),
        },
        notifications: {
          name: 'notification scheduler',
          lifetime: 'whileStarted',
          create: () => this.createNotificationScheduler(),
          arm: async (scheduler) => {
            if ((await this.getSetting('notification_system_enabled')) === 'true') {
              await scheduler.startScheduler();
              return true;
            }
            logger.info('Notification scheduler disabled in settings');
            return false;
          },
        },
        // Always started: it ticks every few minutes and only acts on the organizations
        // that have the price sync on, so there is no global setting to gate it.
        prices: { name: 'price-sync scheduler', lifetime: 'kept', create: () => new OrgPriceSyncScheduler() },
        // The daily retention job (services/maintenance/retention.ts). Always
        // started: what it deletes is set by the RETENTION_* settings.
        retention: {
          name: 'retention scheduler',
          lifetime: 'kept',
          create: () => new MaintenanceScheduler({ backupFileNames: () => this.backupService.listBackupFileNames() }),
        },
      },
      () => this.isShuttingDown
    );
  }

  /** Read a single system_settings value (or undefined if unset). */
  private async getSetting(key: string): Promise<string | undefined> {
    return (await readSystemSetting(key, this.db)) ?? undefined;
  }

  /**
   * Start the background services: the import, backup, notification, price-sync and
   * retention schedulers (the registry, in its order). One that fails to start (the database unreachable for a moment, say) is
   * tried again, `attempts` times in all, with a doubling delay; until all have started,
   * /api/ready answers 503. If one still fails because the database can't be reached,
   * this throws, and index.ts shuts the server down with exit code 1 so that the
   * container's restart policy starts it again, rather than let it serve on with no bank
   * sync, backups or alerts. If it fails for another reason (a setting it
   * can't use, a bug), another start would fail the same way: the server serves on, so
   * the setting can be fixed in the app, and /api/ready reports "failed" (503, the
   * container unhealthy) until a restart.
   */
  async initializeServices(
    { attempts = 5, retryDelayMs = 2000 }: { attempts?: number; retryDelayMs?: number } = {}
  ): Promise<void> {
    const services = this.schedulers.all().map((scheduler) => ({
      name: scheduler.name,
      start: () => scheduler.initialize(),
    }));

    this.startupState = 'starting';
    logger.info('Initializing application services');

    // What a backup or restore killed mid-way left: plaintext dumps in temp, scratch
    // databases. Best effort: it logs what it couldn't check, and doesn't throw.
    await this.backupService.sweepLeftovers();

    let pending = services;
    for (let attempt = 1; ; attempt++) {
      const failed: Array<(typeof services)[number] & { err: unknown }> = [];
      for (const service of pending) {
        if (this.isShuttingDown) return;
        try {
          await service.start();
        } catch (err) {
          logger.error({ err, service: service.name, attempt, attempts }, 'A background service did not start');
          failed.push({ ...service, err });
        }
      }
      if (failed.length === 0) break;
      if (attempt >= attempts) {
        this.startupState = 'failed';
        const names = failed.map((f) => f.name).join(', ');
        if (failed.some((f) => isDatabaseUnreachable(f.err))) {
          throw new Error(`These background services did not start after ${attempts} attempts, the database unreachable: ${names}`);
        }
        logger.fatal(
          { failed: failed.map((f) => f.name), attempts },
          'Serving without background services that cannot start; /api/ready reports failed until they do (restart after fixing the cause)'
        );
        return;
      }
      const retryInMs = retryDelayMs * 2 ** (attempt - 1);
      logger.warn(
        { failed: failed.map((f) => f.name), attempt, attempts, retryInMs },
        'Trying the background services that did not start again'
      );
      await sleep(retryInMs);
      pending = failed;
    }

    if (this.isShuttingDown) return;
    this.startupState = 'ready';
    logger.info('All services initialized successfully');
  }

  /** Whether the background services have started (initializeServices). */
  getStartupState(): StartupState {
    return this.startupState;
  }

  /** Whether a shutdown has begun. */
  isShutdownInProgress(): boolean {
    return this.isShuttingDown;
  }

  /** The notification scheduler and the services it sends with. */
  private async createNotificationScheduler(): Promise<NotificationScheduler> {
    const { NotificationRulesEngine } = await import('./NotificationRulesEngine.js');
    const { NotificationQueueService } = await import('./NotificationQueueService.js');
    const { EmailTemplateService } = await import('./EmailTemplateService.js');
    const { EmailDeliveryService } = await import('./EmailDeliveryService.js');
    const { PushNotificationService } = await import('./PushNotificationService.js');

    const queueService = new NotificationQueueService();
    const templateService = new EmailTemplateService();
    const deliveryService = new EmailDeliveryService();
    // Register Handlebars helpers
    templateService.registerHelpers();
    const rulesEngine = new NotificationRulesEngine(
      queueService,
      templateService,
      deliveryService,
      new PushNotificationService()
    );
    return new NotificationScheduler(rulesEngine);
  }

  /** The retention job's schedule and last run (null before it is set up). */
  getRetentionStatus(): MaintenanceStatus | null {
    return this.schedulers.get('retention').current?.getStatus() ?? null;
  }

  /**
   * Set the HTTP server reference for graceful shutdown
   */
  setServer(server: Server): void {
    this.server = server;
  }

  /**
   * Whether this server can serve requests now (GET /api/ready): its background
   * services have started, it isn't shutting down, the database answers within 2 s, and
   * every migration this code ships is applied. /api/health only says the process is up.
   */
  async readiness(): Promise<Readiness> {
    let database: Readiness['checks']['database'] = 'unavailable';
    let migrations: Readiness['checks']['migrations'] = 'unknown';
    try {
      const pending = await this.probeDatabase();
      database = 'ok';
      migrations = pending > 0 ? 'pending' : 'ok';
    } catch (err) {
      if (this.lastDatabaseOk !== false) logger.warn({ err }, 'Readiness: the database did not answer');
    }
    this.lastDatabaseOk = database === 'ok';

    const checks = { startup: this.startupState, shuttingDown: this.isShuttingDown, database, migrations };
    const ready = checks.startup === 'ready' && !checks.shuttingDown && database === 'ok' && migrations !== 'pending';
    if (this.lastReady !== null && this.lastReady !== ready) {
      logger.info({ ready, checks }, ready ? 'Ready to serve again' : 'Not ready to serve');
    }
    this.lastReady = ready;
    return { ready, checks };
  }

  /**
   * How many of the migrations this code ships aren't applied, within
   * READINESS_DB_TIMEOUT_MS. /api/ready is public and not rate limited, so probes share
   * one query: a probe in flight is reused, and so is its answer for readinessCacheMs
   * (1 s), however many requests arrive.
   */
  private probeDatabase(): Promise<number> {
    const last = this.dbProbe;
    if (last && (last.settledAt === null || Date.now() - last.settledAt < this.readinessCacheMs)) return last.result;
    const probe = {
      result: withTimeout(this.pendingMigrationCount(), READINESS_DB_TIMEOUT_MS, 'The database'),
      settledAt: null as number | null,
    };
    const settle = () => {
      probe.settledAt = Date.now();
    };
    probe.result.then(settle, settle);
    this.dbProbe = probe;
    return probe.result;
  }

  /** The baseline's and the migration files' versions, read once (the code doesn't change while it runs). */
  private shippedMigrations(): string[] {
    this.expectedMigrations ??= shippedSchemaVersions(this.migrationsDir);
    return this.expectedMigrations;
  }

  /**
   * The shipped migrations schema_migrations doesn't list: every one the runner would
   * apply, an older one merged late included, not only those newer than the newest. And the
   * rows older than the baseline: a database at the baseline has none, and the runner
   * refuses one that has (a v2.4.0 database not cut over yet lacks the baseline's row, so it
   * counts already). A row newer than every file (an older image rolled back to) doesn't.
   */
  private async pendingMigrationCount(): Promise<number> {
    const { rows } = await sql<{ pending: number }>`
      SELECT (SELECT count(*)::int
                FROM unnest(${this.shippedMigrations()}::text[]) AS f(version)
               WHERE NOT EXISTS (SELECT 1 FROM schema_migrations m WHERE m.version = f.version))
           + (SELECT count(*)::int FROM schema_migrations m
               WHERE m.version < ${BASELINE.version}
                 AND EXISTS (SELECT 1 FROM schema_migrations b WHERE b.version = ${BASELINE.version})) AS pending`.execute(this.db);
    return rows[0]?.pending ?? 0;
  }

  /** Whether the database answers a trivial query within READINESS_DB_TIMEOUT_MS. */
  private async databaseAnswers(): Promise<boolean> {
    try {
      await withTimeout(sql`SELECT 1`.execute(this.db), READINESS_DB_TIMEOUT_MS, 'The database');
      this.lastDatabaseOk = true;
    } catch (err) {
      logger.warn({ err }, 'The database did not answer the status check');
      this.lastDatabaseOk = false;
    }
    return this.lastDatabaseOk;
  }

  /**
   * Register all process signal handlers
   */
  registerSignalHandlers(): void {
    // Handle different termination signals
    process.on('SIGTERM', () => void this.shutdown('SIGTERM')); // Docker stop, systemd
    process.on('SIGINT', () => void this.shutdown('SIGINT'));   // Ctrl+C
    process.on('SIGUSR2', () => void this.shutdown('SIGUSR2')); // Nodemon restart

    // Handle uncaught exceptions and unhandled promise rejections
    process.on('uncaughtException', (error) => {
      logger.fatal({ err: error }, 'Uncaught exception');
      void this.shutdown('uncaughtException', 1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      // Log but do NOT shut down. A single un-awaited promise rejection anywhere
      // (a stray background .then without .catch, a scheduler edge case) should
      // not take down a long-running service. uncaughtException above still
      // triggers shutdown, since a truly uncaught throw can leave corrupt state.
      logger.error({ promise, reason }, 'Unhandled promise rejection (logged, not fatal)');
    });
  }

  /**
   * Shut down gracefully, then exit with `exitCode` (1 if anything went wrong):
   * 1. Report not ready (/api/ready answers 503) while still serving for
   *    SHUTDOWN_DRAIN_MS, so a proxy that polls it stops sending requests here.
   * 2. Stop accepting connections and let the requests in flight finish (responses
   *    now close their connection, see routes.ts), while a backup or restore finishes or
   *    is stopped (drainBackupsAndRestores) and the schedulers stop and their runs
   *    finish.
   * 3. Close the database pool.
   * From the start no backup or restore starts (503 SHUTTING_DOWN). All within
   * SHUTDOWN_TIMEOUT_MS: past it, the connections still open are closed, any pg_dump /
   * pg_restore is stopped and the process exits with 1. It exits with 1 too whenever a
   * backup or restore is still running as it exits. The compose stop_grace_period (60 s)
   * is longer.
   */
  async shutdown(reason: string, exitCode = 0): Promise<void> {
    // Prevent multiple shutdown attempts. One asked for with a failure (an uncaught
    // exception during the shutdown) still makes the one in progress exit 1.
    if (this.isShuttingDown) {
      if (exitCode !== 0) this.failedDuringShutdown = true;
      logger.warn({ reason }, 'Shutdown already in progress, ignoring signal');
      return;
    }
    this.isShuttingDown = true;
    // Before anything else, so nothing starts in the drain: no backup or restore, and a
    // restore that hasn't begun replacing the data stops at its next step.
    BackupService.refuseNewOperations();
    // No schema download starts, and one running stops: it can take longer than
    // the shutdown may, and is made again in a moment once the server is back.
    stopSchemaDownloads();

    let timeoutMs = 55_000;
    let drainMs = 0;
    try {
      ({ timeoutMs, drainMs } = shutdownSettings());
    } catch (err) {
      // Checked at startup (index.ts); a shutdown goes ahead on the defaults regardless.
      logger.error({ err }, 'Invalid shutdown settings; using the defaults');
    }
    logger.info({ reason, timeoutMs, drainMs }, 'Shutting down: no longer ready');

    const shutdownStart = Date.now();
    let failed = exitCode !== 0;

    this.shutdownTimeout = setTimeout(() => {
      logger.error({ reason, timeoutMs }, 'Shutdown did not finish in time; closing the connections left and exiting');
      this.reportRunningAtExit();
      this.server?.closeAllConnections();
      // pg_dump / pg_restore run in their own process group: don't leave them running.
      terminatePgTools();
      this.exitAfterShutdown(1);
    }, timeoutMs);

    try {
      if (drainMs > 0 && this.server?.listening) {
        logger.info({ drainMs }, 'Draining: still serving while reporting not ready');
        await sleep(drainMs);
      }

      await Promise.all([this.closeServer(), this.drainBackupsAndRestores(), this.stopSchedulers()]);

      // Close the database pool once nothing uses it. Owned here (not db.ts) so SIGINT
      // and SIGTERM tear down identically and don't race a second handler.
      logger.info('Closing database pool');
      try {
        await this.pool.end();
        logger.info('Database pool closed');
      } catch (err) {
        failed = true;
        logger.error({ err }, 'Error closing database pool');
      }
    } catch (error) {
      failed = true;
      logger.error({ err: error }, 'Error during graceful shutdown');
    }

    if (this.shutdownTimeout) {
      clearTimeout(this.shutdownTimeout);
      this.shutdownTimeout = null;
    }
    // A backup or restore still running (a backup past its pg_dump that didn't wind up):
    // it is cut short, so not a clean exit.
    if (this.reportRunningAtExit()) failed = true;
    failed ||= this.failedDuringShutdown;
    logger.info({ shutdownTimeMs: Date.now() - shutdownStart, exitCode: failed ? 1 : 0 }, 'Graceful shutdown completed');
    this.exitAfterShutdown(failed ? 1 : 0);
  }

  /**
   * How every shutdown ends. A schema download's pg_dump, told to stop when the
   * shutdown began, that hasn't exited yet (stuck in its cancel request) is killed first:
   * it is in a process group of its own, so it would outlive the server.
   */
  private exitAfterShutdown(code: number): void {
    terminatePgTools('SIGKILL', ['download']);
    this.exit(code);
  }

  /**
   * Stop accepting connections and wait for the requests in flight to finish. Idle
   * keep-alive connections are closed now and as they go idle, so they don't hold the
   * close open until they time out.
   */
  private closeServer(): Promise<void> {
    const server = this.server;
    if (!server || !server.listening) return Promise.resolve();
    logger.info('Stopping HTTP server: no new connections; the requests in flight finish');
    return new Promise<void>((resolve) => {
      const sweep = setInterval(() => server.closeIdleConnections(), 250);
      server.close((err) => {
        clearInterval(sweep);
        if (err) {
          logger.error({ err }, 'Error stopping HTTP server');
        } else {
          logger.info('HTTP server stopped');
        }
        resolve();
      });
      server.closeIdleConnections();
    });
  }

  /**
   * What a shutdown does with a running backup or restore:
   * - a backup gets BACKUP_SHUTDOWN_WAIT_MS to finish; then its pg_dump is stopped (it runs
   *   in its own process group, so the stop signal didn't reach it), and it gets
   *   BACKUP_STOPPED_WAIT_MS more to wind up;
   * - a restore that hasn't begun replacing the data won't now (refuseNewOperations), so it
   *   is stopped rather than waited for: it drops its scratch database, and the data stays
   *   as it was;
   * - a restore that is replacing the data (swapping the databases, then the upload files,
   *   or putting them back) is waited for, up to the shutdown's deadline: stopped part way it
   *   can leave the database refusing connections.
   * Then the restore job winds up: one accepted just before the shutdown ends without
   * starting, and one that replaced the data checks the serving role again.
   */
  private async drainBackupsAndRestores(): Promise<void> {
    const operation = BackupService.runningOperation();
    const restoreJob = isRestoreRunning();

    if (operation?.kind === 'backup') {
      logger.info({ waitMs: BACKUP_SHUTDOWN_WAIT_MS }, 'A backup is running: waiting for it to finish');
      if (await BackupService.waitForIdle(BACKUP_SHUTDOWN_WAIT_MS)) {
        logger.info('The backup finished');
      } else {
        const stopped = terminatePgTools();
        logger.warn(
          { stopped, waitMs: BACKUP_STOPPED_WAIT_MS },
          stopped > 0
            ? 'The backup did not finish in time: stopped its pg_dump'
            : 'The backup did not finish in time and is past its pg_dump: waiting for it to wind up'
        );
        if (await BackupService.waitForIdle(BACKUP_STOPPED_WAIT_MS)) logger.info('The backup ended');
      }
    } else if (operation?.kind === 'restore' && operation.replacingData) {
      logger.warn(
        { phase: getRestoreStatus().phase, database: operation.database },
        'A restore is replacing the data: waiting for it to finish, up to the shutdown deadline'
      );
      await BackupService.idle();
    } else if (operation?.kind === 'restore' || operation?.kind === 'verify') {
      logger.warn(
        { operation: operation.kind, phase: operation.kind === 'verify' ? getVerifyStatus().phase : getRestoreStatus().phase },
        operation.kind === 'verify'
          ? 'Stopping the verify: it drops its scratch database, and the data is not touched'
          : 'Stopping the restore: it had not begun replacing the data, which stays as it was'
      );
      // Again until it has ended, in case it started a query or pg_restore just after a call.
      while (BackupService.runningOperation()) {
        try {
          await BackupService.interruptRestore();
        } catch (err) {
          logger.warn({ err }, "Could not end the restore's work on its scratch database; it stops at its next step");
        }
        await Promise.race([BackupService.idle(), sleep(RESTORE_INTERRUPT_INTERVAL_MS)]);
      }
    }

    // A verify accepted just before the shutdown ends without starting; one stopped above has ended.
    if (isVerifyRunning()) await verifyJobSettled();

    if (restoreJob) {
      await restoreJobSettled();
      const { status, databaseChanged } = getRestoreStatus();
      if (status === 'completed') logger.info('The restore finished: the data is the backup\'s');
      else if (databaseChanged) logger.error({ status }, 'The restore failed after it replaced the data (see its error above)');
      else logger.info({ status }, 'The restore ended without replacing the data, which is unchanged');
    }
  }

  /**
   * Log the backup or restore still running as the process exits, and what that leaves.
   * True when there is one: the shutdown then exits with 1.
   */
  private reportRunningAtExit(): boolean {
    const operation = BackupService.runningOperation();
    if (operation?.kind === 'backup') {
      logger.error(
        { operation: 'backup' },
        'Exiting while a backup is still running: it is cut short, so its file may be missing; the next start removes its temp files'
      );
      return true;
    }
    if (operation?.replacingData) {
      logger.fatal(
        { operation: 'restore', phase: getRestoreStatus().phase, database: operation.database },
        'Exiting while a restore is replacing the data, so it is cut short. If the database then refuses connections ' +
          '("not currently accepting connections"), the swap was cut short and the data is still the one from before ' +
          `the restore: ${allowConnectionsFix(operation.database)} Otherwise the data is the backup's, and its upload ` +
          "files may be only partly in place (the ones replaced are in the temp directory's before-restore/uploads)."
      );
      return true;
    }
    if (operation?.kind === 'verify') {
      logger.error(
        { operation: 'verify', phase: getVerifyStatus().phase },
        'Exiting while a backup is being verified; the data is not touched. The next start removes its scratch database'
      );
      return true;
    }
    if (operation || isRestoreRunning()) {
      logger.error(
        { operation: 'restore', phase: getRestoreStatus().phase },
        'Exiting while a restore is still running; it had not begun replacing the data, which is unchanged. The next start removes its scratch database'
      );
      return true;
    }
    return false;
  }

  /** Stop every scheduler, letting a run in progress finish; one failing doesn't stop the rest. */
  private stopSchedulers(): Promise<void> {
    return this.schedulers.stopAllForShutdown();
  }

  /**
   * Get current service status for health checks
   */
  getServiceStatus(): {
    schedulerActive: boolean;
    backupSchedulerActive: boolean;
    notificationSchedulerActive: boolean;
    isShuttingDown: boolean;
    services: {
      httpServer: boolean;
      syncScheduler: boolean;
      backupScheduler: boolean;
      notificationScheduler: boolean;
      /** Whether the database answered the last check; null before one. */
      database: boolean | null;
    };
  } {
    // `schedulerActive` means "a run is actually armed", not "the object was
    // constructed" — the latter is true even for a scheduler that will never fire.
    const syncArmed = this.schedulers.get('import').current?.isTimerArmed() ?? false;
    const backupArmed = this.schedulers.get('backup').current?.isTimerArmed() ?? false;
    const notifications = this.schedulers.get('notifications').current !== null;

    return {
      schedulerActive: syncArmed,
      backupSchedulerActive: backupArmed,
      notificationSchedulerActive: notifications,
      isShuttingDown: this.isShuttingDown,
      services: {
        httpServer: this.server !== null,
        syncScheduler: syncArmed,
        backupScheduler: backupArmed,
        notificationScheduler: notifications,
        database: this.lastDatabaseOk,
      }
    };
  }

  /**
   * Stop every scheduler for a restore: while the data is replaced, a bank sync or a
   * notification run would write to the data being replaced, or fail half-way. The
   * retention job deletes rows too.
   */
  async pauseSchedulersForRestore(): Promise<void> {
    logger.info('Stopping the schedulers for a restore');
    // Each scheduler's stopScheduler: it also stops a run in progress (a bank sync after
    // the ledger it is on), which an admin's stop of the import scheduler doesn't.
    await this.schedulers.pauseAll();
  }

  /** Start the schedulers again after a restore, from the restored settings. */
  async resumeSchedulersAfterRestore(): Promise<void> {
    if (this.isShuttingDown) return;
    logger.info('Starting the schedulers again after a restore');
    await this.schedulers.resumeAll();
  }

  // The admin controls of each scheduler (routes/import.ts, backup.ts, notifications.ts).
  // A scheduler's controls run one at a time, and a start or restart is refused during a
  // shutdown (ManagedScheduler).

  /**
   * Disarm the import scheduler's timer. A run in progress goes on through its ledgers;
   * only a shutdown or a restore stops one.
   */
  stopImportScheduler(): Promise<void> {
    return this.schedulers.get('import').stop();
  }

  startImportScheduler(): Promise<void> {
    return this.schedulers.get('import').start();
  }

  /** Re-read the import settings (after they change). */
  updateSchedulerConfiguration(): Promise<void> {
    return this.schedulers.get('import').update();
  }

  async getNextScheduledSyncTime(): Promise<Date | null> {
    return (await this.schedulers.get('import').current?.getNextScheduledSyncTime()) ?? null;
  }

  async isSchedulerRunning(): Promise<boolean> {
    return (await this.schedulers.get('import').current?.isSchedulerRunning()) ?? false;
  }

  stopBackupScheduler(): Promise<void> {
    return this.schedulers.get('backup').stop();
  }

  startBackupScheduler(): Promise<void> {
    return this.schedulers.get('backup').start();
  }

  /** Re-read the backup settings (after they change). */
  updateBackupSchedulerConfiguration(): Promise<void> {
    return this.schedulers.get('backup').update();
  }

  async getNextScheduledBackupTime(): Promise<Date | null> {
    return (await this.schedulers.get('backup').current?.getNextScheduledBackupTime()) ?? null;
  }

  async isBackupSchedulerRunning(): Promise<boolean> {
    return (await this.schedulers.get('backup').current?.isSchedulerRunning()) ?? false;
  }

  /**
   * Get backup scheduler status
   */
  async getBackupSchedulerStatus(): Promise<{
    enabled: boolean;
    /** A backup is armed, not merely a scheduler constructed. */
    running: boolean;
    hasRunningBackup: boolean;
    nextBackupTime?: string;
    lastRunStartedAt: string | null;
    lastRunFinishedAt: string | null;
    lastRunOutcome: 'success' | 'failed' | null;
    /** Backups are on but none can run until a backup key is set up. */
    waitingForBackupKey: boolean;
    /** Backups are made with the old backup key until a backup key is set up (an upgraded install). */
    usingOldBackupKey: boolean;
  }> {
    const backupScheduler = this.schedulers.get('backup').current;
    if (!backupScheduler) {
      return {
        enabled: false,
        running: false,
        hasRunningBackup: false,
        lastRunStartedAt: null,
        lastRunFinishedAt: null,
        lastRunOutcome: null,
        waitingForBackupKey: false,
        usingOldBackupKey: false,
      };
    }

    const status = await backupScheduler.getSchedulerStatus();
    return {
      enabled: status.enabled,
      running: status.running,
      hasRunningBackup: status.hasRunningBackup,
      ...(status.nextBackupTime && { nextBackupTime: status.nextBackupTime.toISOString() }),
      lastRunStartedAt: status.lastRunStartedAt?.toISOString() ?? null,
      lastRunFinishedAt: status.lastRunFinishedAt?.toISOString() ?? null,
      lastRunOutcome: status.lastRunOutcome,
      waitingForBackupKey: status.waitingForBackupKey,
      usingOldBackupKey: status.usingOldBackupKey,
    };
  }

  /**
   * Whether backups are being made, for GET /api/health/detailed: automatic backups
   * on, a backup key to make them with, the last one not failed, and a backup no older than
   * the frequency (and a day).
   */
  async getBackupHealth(): Promise<BackupHealth> {
    const scheduler = await this.getBackupSchedulerStatus();
    const newest = (await this.backupService.listBackups())[0]?.created ?? null;
    const frequencyDays = Number.parseInt((await this.getSetting('backup_frequency_days')) ?? '', 10) || 7;
    const problems: string[] = [];
    if (!scheduler.enabled) {
      problems.push('Automatic backups are off');
    } else if (scheduler.waitingForBackupKey) {
      problems.push('Automatic backups are on but none can be made: set up a backup key on the Backup page');
    }
    const encryption = await this.backupService.encryptionState().catch(() => null);
    if (encryption?.mode === 'legacy') {
      problems.push('Backups still use the old backup key: set up a backup key on the Backup page, so the server can no longer open its backups');
    }
    if (scheduler.lastRunOutcome === 'failed') {
      problems.push(`The last automatic backup failed (${scheduler.lastRunFinishedAt}); see the server log`);
    }
    if (!newest) {
      problems.push('There is no backup');
    } else {
      const ageDays = (Date.now() - newest.getTime()) / (24 * 60 * 60 * 1000);
      if (ageDays > frequencyDays + 1) problems.push(`The newest backup is ${Math.floor(ageDays)} days old`);
    }
    return {
      status: problems.length === 0 ? 'healthy' : 'degraded',
      automaticBackups: !scheduler.enabled ? 'off' : scheduler.waitingForBackupKey ? 'waiting-for-backup-key' : 'on',
      lastRunOutcome: scheduler.lastRunOutcome,
      lastRunFinishedAt: scheduler.lastRunFinishedAt,
      newestBackupAt: newest?.toISOString() ?? null,
      nextBackupAt: scheduler.nextBackupTime ?? null,
      problems,
    };
  }

  /**
   * Get comprehensive application status for monitoring/admin
   */
  async getApplicationStatus(): Promise<{
    application: {
      status: 'starting' | 'running' | 'failed' | 'shutting_down';
      uptime: number;
    };
    /**
     * The import scheduler: armed (`isRunning`), whether any ledger had automatic import on
     * at its last check, and its last run, as the retention job reports its own. Not the
     * last run's ledgers: they are other ledgers' tenant ids, and any signed-in user reads
     * this (GET /api/status); they are in the log.
     */
    scheduler: {
      active: boolean;
      nextSync: Date | null;
      isRunning: boolean;
      enabled: boolean;
      lastRunStartedAt: Date | null;
      lastRunFinishedAt: Date | null;
      lastRunOutcome: SyncRunOutcome | null;
    };
    backupScheduler: {
      active: boolean;
      nextBackup: Date | null;
      isRunning: boolean;
    };
    notificationScheduler: {
      active: boolean;
      isRunning: boolean;
    };
    /** The daily retention job: its next run and how the last one went. */
    retentionScheduler: MaintenanceStatus | null;
    services: {
      httpServer: boolean;
      /** The database answered a query just now (within 2 s). */
      database: boolean;
      syncScheduler: boolean;
      backupScheduler: boolean;
      notificationScheduler: boolean;
    };
  }> {
    const nextSync = await this.getNextScheduledSyncTime();
    const isRunning = await this.isSchedulerRunning();
    const nextBackup = await this.getNextScheduledBackupTime();
    const isBackupRunning = await this.isBackupSchedulerRunning();
    const isNotificationRunning = await this.isNotificationSchedulerRunning();
    const database = await this.databaseAnswers();
    const syncScheduler = this.schedulers.get('import').current !== null;
    const importStatus = await this.schedulers.get('import').current?.getSchedulerStatus();
    const notificationScheduler = this.schedulers.get('notifications').current !== null;

    return {
      application: {
        status: this.isShuttingDown
          ? 'shutting_down'
          : this.startupState === 'ready' ? 'running' : this.startupState,
        uptime: process.uptime()
      },
      scheduler: {
        active: syncScheduler,
        nextSync,
        isRunning,
        enabled: importStatus?.enabled ?? false,
        lastRunStartedAt: importStatus?.lastRunStartedAt ?? null,
        lastRunFinishedAt: importStatus?.lastRunFinishedAt ?? null,
        lastRunOutcome: importStatus?.lastRunOutcome ?? null,
      },
      backupScheduler: {
        active: isBackupRunning,
        nextBackup,
        isRunning: isBackupRunning
      },
      notificationScheduler: {
        active: notificationScheduler,
        isRunning: isNotificationRunning
      },
      retentionScheduler: this.getRetentionStatus(),
      services: {
        httpServer: this.server !== null,
        database,
        syncScheduler,
        // The scheduler object now always exists; what matters is whether a backup is armed.
        backupScheduler: isBackupRunning,
        notificationScheduler
      }
    };
  }

  restartNotificationScheduler(): Promise<void> {
    return this.schedulers.get('notifications').restart();
  }

  stopNotificationScheduler(): Promise<void> {
    return this.schedulers.get('notifications').stop();
  }

  startNotificationScheduler(): Promise<void> {
    return this.schedulers.get('notifications').start();
  }

  async isNotificationSchedulerRunning(): Promise<boolean> {
    return this.schedulers.get('notifications').current?.isSchedulerRunning() ?? false;
  }

  /** Re-read the notification settings (after they change). */
  updateNotificationSchedulerConfiguration(): Promise<void> {
    return this.schedulers.get('notifications').update();
  }

  /**
   * Get notification scheduler status
   */
  async getNotificationSchedulerStatus(): Promise<{
    running: boolean;
    shuttingDown: boolean;
    hasRunningOperations: boolean;
    settings: NotificationSchedulerSettings | null;
  }> {
    const notificationScheduler = this.schedulers.get('notifications').current;
    if (!notificationScheduler) {
      return {
        running: false,
        shuttingDown: false,
        hasRunningOperations: false,
        settings: null
      };
    }

    return await notificationScheduler.getSchedulerStatus();
  }
}
