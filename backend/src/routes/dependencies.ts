import pool from '../db.js';
import { config, type AppConfig } from '../config.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { BackupService } from '../services/BackupService.js';
import { ImportService } from '../services/ImportService.js';
import { OneDriveService } from '../services/OneDriveService.js';
import { PushNotificationService } from '../services/PushNotificationService.js';
import { NotificationRuleService } from '../services/notifications/NotificationRuleService.js';

/**
 * What the routers are built from: the services they share, and the
 * settings read when they are mounted. Never a pool: a router's queries run on getDb()
 * (or globalDb for the control plane), and a service that needs connections of its own
 * holds the pool itself (BackupService's backup lock, ImportService's sync claim).
 *
 * Every router module exports one factory per router, `createXRoutes(deps)`, which takes
 * the slice it uses (`Pick<RouteDependencies, …>`) or nothing; routes.ts mounts each with
 * its guards. A route test passes the services it wants (a stub, or one on its own pool)
 * and can build the rest with {@link routeDependencies}.
 */
export interface RouteDependencies {
  /** The schedulers (bank sync, backups, notifications): started, stopped, reported on. */
  lifecycleService: ApplicationLifecycleService;
  /** Backups: made, listed, restored, and their settings and key. */
  backupService: BackupService;
  /** Bank sync with SimpleFin. */
  importService: ImportService;
  /** OneDrive, where backups are copied: its app registration and the admin's tokens. */
  oneDriveService: OneDriveService;
  /** Web push to a person's own devices. */
  pushService: PushNotificationService;
  /** Notification rules, and the unsubscribe links in their emails. */
  notificationRuleService: NotificationRuleService;
  /** The settings (config.ts) read when the routes are mounted. */
  config: AppConfig;
}

/** What mountRoutes takes: the lifecycle service, and any of the rest to use instead of a new one. */
export type MountDependencies = Pick<RouteDependencies, 'lifecycleService'> & Partial<RouteDependencies>;

/**
 * `given`, with a new service (on the app's pool, for the two that hold one) for each one
 * it leaves out, and the current settings unless it names others. index.ts passes the
 * services the schedulers use too (bank sync, backups, OneDrive), so a sync or backup
 * started from a route and one the scheduler starts share them.
 */
export function routeDependencies(given: MountDependencies): RouteDependencies {
  return {
    lifecycleService: given.lifecycleService,
    backupService: given.backupService ?? new BackupService(pool),
    importService: given.importService ?? new ImportService(pool),
    oneDriveService: given.oneDriveService ?? new OneDriveService(),
    pushService: given.pushService ?? new PushNotificationService(),
    notificationRuleService: given.notificationRuleService ?? new NotificationRuleService(),
    config: given.config ?? config(),
  };
}
