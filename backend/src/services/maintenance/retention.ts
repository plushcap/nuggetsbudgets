/**
 * Retention: what the daily maintenance job deletes.
 *
 * These tables grew for ever. Only rows that nothing reads any more go, and nothing a
 * household entered or that counts money (accounts, transactions, budgets, balances,
 * net-worth history) is touched:
 *
 * | What | Deleted once | Setting (default) |
 * |---|---|---|
 * | `sessions` (global) | expired or revoked that long ago | RETENTION_SESSION_DAYS (30) |
 * | `notifications` (per ledger) | sent or failed and created that long ago; never pending or processing ones | RETENTION_NOTIFICATION_DAYS (90) |
 * | `notification_deliveries` (per ledger) | created that long ago | RETENTION_NOTIFICATION_DELIVERY_DAYS (365, at least 120) |
 * | `import_sync_log` (per ledger) | started that long ago, except the ledger's newest | RETENTION_SYNC_LOG_DAYS (180) |
 * | `organization_price_sync_runs` (per organization) | started that long ago, except the organization's newest | RETENTION_SYNC_LOG_DAYS (180) |
 * | `stored_images` (per ledger) | nothing points at it, a day after it was stored | — |
 *
 * - A notification delivery is what stops the same alert going twice: its subject (a
 *   budget item in the current month, a transaction added in the last week, a bill due
 *   within 60 days, a review reminder at most 30 days apart) can't come round again
 *   after about 90 days, hence the 120-day floor.
 * - The sync logs are the Bank Import and price-sync history pages; the newest row is
 *   kept so they still show when a sync last ran.
 * - An image counts as pointed at when one of the ledger's accounts, budget items (goals)
 *   or merchants names its `/api/images/<uuid>` (ImageService.tenantImageReferences, which
 *   replacing an image checks too). The day's grace covers an upload whose row is written
 *   in a later statement. Profile pictures aren't stored_images
 *   (user_profile_images, one per user, deleted with the user).
 *
 * Each job deletes in batches of `batchSize` rows, each in a transaction of its own, and
 * at most `maxBatches` of them per run, so a first run over a long backlog neither holds
 * locks for long nor runs for ever: the rest goes the next day. Ledger jobs run in that
 * ledger's transaction (getDb(), RLS-scoped), the organization job in that
 * organization's (withOrganization, RLS-scoped), and the global one on globalDb.
 */

import { sql, type RawBuilder } from 'kysely';
import { getDb, globalDb, withOrganization, withTenant } from '../../db/withTenant.js';
import { getAllOrganizationIds } from '../../db/forEachTenant.js';
import { refuseSetting } from '../../utils/productionConfig.js';
import { createLogger } from '../../utils/logger.js';
import { strictSetting } from '../../config.js';
import { tenantImageReferences } from '../ImageService.js';

const logger = createLogger({ service: 'Retention' });

export interface RetentionPolicy {
  sessionDays: number;
  notificationDays: number;
  notificationDeliveryDays: number;
  syncLogDays: number;
}

export interface RetentionLimits {
  /** Rows per DELETE, each in its own transaction. */
  batchSize: number;
  /** Batches per job (per ledger, for the ledger jobs) per run. */
  maxBatches: number;
}

export const DEFAULT_LIMITS: RetentionLimits = { batchSize: 500, maxBatches: 50 };

/** An image nothing points at is kept this long after it was stored. */
const ORPHAN_IMAGE_GRACE_HOURS = 24;

/** The retention settings (see the module comment); checked at startup too (index.ts). */
export function retentionPolicy(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  return {
    // Defaults and ranges (up to 36500 days) are in config.ts.
    sessionDays: strictSetting('RETENTION_SESSION_DAYS', env, refuseSetting),
    notificationDays: strictSetting('RETENTION_NOTIFICATION_DAYS', env, refuseSetting),
    notificationDeliveryDays: strictSetting('RETENTION_NOTIFICATION_DELIVERY_DAYS', env, refuseSetting),
    syncLogDays: strictSetting('RETENTION_SYNC_LOG_DAYS', env, refuseSetting),
  };
}

export interface RetentionOptions {
  limits?: RetentionLimits;
  /** Checked between batches: true stops the run (the scheduler is stopping). */
  shouldStop?: () => boolean;
  /** The ledgers runRetention's per-ledger jobs cover (default, or undefined: every ledger). */
  tenantIds?: number[] | undefined;
  /** The organizations the per-organization job covers (default, or undefined: every organization). */
  organizationIds?: number[] | undefined;
}

/** Rows deleted, by job. */
export type RetentionCounts = Record<string, number>;

const daysAgo = (days: number) => sql`now() - make_interval(days => ${days})`;

/** Run `runBatch` until it deletes fewer than a batch, the bound is reached, or we must stop. */
async function inBatches(
  job: string,
  options: ResolvedOptions,
  runBatch: (limit: number) => Promise<number>,
  context: Record<string, unknown> = {}
): Promise<number> {
  const { batchSize, maxBatches } = options.limits;
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    if (options.shouldStop()) break;
    const deleted = await runBatch(batchSize);
    total += deleted;
    if (deleted < batchSize) return total;
  }
  if (!options.shouldStop()) {
    logger.info({ job, ...context, deleted: total, maxBatches }, 'Retention stopped at its bound for this run; the rest goes next run');
  }
  return total;
}

const affected = (result: { numAffectedRows?: bigint }) => Number(result.numAffectedRows ?? 0n);

/**
 * DELETE the rows of `table` whose ids `pick` selects; `pick` has the batch's LIMIT. The
 * pick is a MATERIALIZED CTE, so it runs once. Written as `WHERE id IN (SELECT … LIMIT n
 * FOR UPDATE SKIP LOCKED)` the planner may rescan the subquery for each row, and every
 * rescan skips the rows the statement already deleted and picks the next ones: under RLS
 * a batch of one deleted every row that qualified.
 */
const deleteBatch = (table: string, pick: RawBuilder<unknown>) =>
  sql`WITH batch AS MATERIALIZED (${pick}) DELETE FROM ${sql.table(table)} t USING batch WHERE t.id = batch.id`;

/**
 * Every ledger, whatever its or its organization's status: a suspended ledger's old rows
 * are as dead as an active one's (tenants is control-plane, no RLS).
 */
async function allTenantIds(): Promise<number[]> {
  return (await globalDb.selectFrom('tenants').select('id').orderBy('id').execute()).map((t) => t.id);
}

type ResolvedOptions = Required<Omit<RetentionOptions, 'tenantIds' | 'organizationIds'>> &
  Pick<RetentionOptions, 'tenantIds' | 'organizationIds'>;

const withDefaults = (options: RetentionOptions): ResolvedOptions => ({
  limits: options.limits ?? DEFAULT_LIMITS,
  shouldStop: options.shouldStop ?? (() => false),
  tenantIds: options.tenantIds,
  organizationIds: options.organizationIds,
});

// ---------------------------------------------------------------------------------------
// Global tables

/**
 * Sessions that ended (expired, or were revoked) more than sessionDays ago. A session
 * revoked by rotation stays usable for a minute; one rotated into points at it
 * (rotated_from_session_id, set to NULL by the foreign key, indexed).
 */
export async function purgeEndedSessions(policy: RetentionPolicy, options: RetentionOptions = {}): Promise<number> {
  return inBatches('sessions', withDefaults(options), async (limit) =>
    affected(
      await deleteBatch('sessions', sql`
        SELECT id FROM sessions
         WHERE expires_at < ${daysAgo(policy.sessionDays)}
            OR (is_revoked AND COALESCE(revoked_at, last_activity_at, created_at) < ${daysAgo(policy.sessionDays)})
         ORDER BY id
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED`).execute(globalDb)
    )
  );
}

// ---------------------------------------------------------------------------------------
// Per-organization tables: each batch is its own withOrganization transaction.

/**
 * One organization's price-sync runs started more than syncLogDays ago, except its
 * newest. RLS keeps it to the organization; organization_id is filtered as well, like
 * the ledger jobs' tenant_id.
 */
export async function purgeOrganizationPriceSyncRuns(
  organizationId: number,
  policy: RetentionPolicy,
  options: RetentionOptions = {}
): Promise<number> {
  return inBatches('organization_price_sync_runs', withDefaults(options), async (limit) =>
    affected(
      await withOrganization(organizationId, (trx) =>
        deleteBatch('organization_price_sync_runs', sql`
          SELECT r.id FROM organization_price_sync_runs r
           WHERE r.organization_id = current_organization_id()
             AND r.started_at < ${daysAgo(policy.syncLogDays)}
             AND EXISTS (SELECT 1 FROM organization_price_sync_runs newer
                          WHERE newer.organization_id = r.organization_id
                            AND (newer.started_at, newer.id) > (r.started_at, r.id))
           ORDER BY r.id
           LIMIT ${limit}
           FOR UPDATE OF r SKIP LOCKED`).execute(trx)
      )
    ),
    { organizationId }
  );
}

/** Every organization's (or `options.organizationIds`') old price-sync runs, one organization at a time. */
export async function purgeOldPriceSyncRuns(policy: RetentionPolicy, options: RetentionOptions = {}): Promise<number> {
  const opts = withDefaults(options);
  let total = 0;
  for (const organizationId of opts.organizationIds ?? (await getAllOrganizationIds())) {
    if (opts.shouldStop()) break;
    total += await purgeOrganizationPriceSyncRuns(organizationId, policy, opts);
  }
  return total;
}

// ---------------------------------------------------------------------------------------
// Per-ledger tables: each batch is its own withTenant transaction.

/** The current ledger's sent or failed notifications created more than notificationDays ago. */
function deleteOldNotifications(policy: RetentionPolicy, limit: number) {
  return deleteBatch('notifications', sql`
    SELECT id FROM notifications
     WHERE tenant_id = current_tenant_id()
       AND status IS NOT NULL AND status NOT IN ('pending', 'processing')
       AND created_at < ${daysAgo(policy.notificationDays)}
     ORDER BY id
     LIMIT ${limit}
     FOR UPDATE SKIP LOCKED`).execute(getDb());
}

/** The current ledger's notification deliveries recorded more than notificationDeliveryDays ago. */
function deleteOldNotificationDeliveries(policy: RetentionPolicy, limit: number) {
  return deleteBatch('notification_deliveries', sql`
    SELECT id FROM notification_deliveries
     WHERE tenant_id = current_tenant_id()
       AND created_at < ${daysAgo(policy.notificationDeliveryDays)}
     ORDER BY id
     LIMIT ${limit}
     FOR UPDATE SKIP LOCKED`).execute(getDb());
}

/** The current ledger's bank-sync log rows started more than syncLogDays ago, except its newest. */
function deleteOldSyncLog(policy: RetentionPolicy, limit: number) {
  return deleteBatch('import_sync_log', sql`
    SELECT l.id FROM import_sync_log l
     WHERE l.tenant_id = current_tenant_id()
       AND COALESCE(l.sync_start_time, l.created_at) < ${daysAgo(policy.syncLogDays)}
       AND EXISTS (SELECT 1 FROM import_sync_log newer
                    WHERE newer.tenant_id = l.tenant_id AND newer.id > l.id)
     ORDER BY l.id
     LIMIT ${limit}
     FOR UPDATE OF l SKIP LOCKED`).execute(getDb());
}

/**
 * The current ledger's images nothing in it points at, stored more than a day ago. RLS
 * (the standard tenant policy) keeps this to the ledger; tenant_id is
 * filtered as well, like the other ledger jobs.
 */
function deleteOrphanTenantImages(limit: number) {
  return deleteBatch('stored_images', sql`
    SELECT si.id FROM stored_images si
     WHERE si.tenant_id = current_tenant_id()
       AND si.created_at < now() - make_interval(hours => ${ORPHAN_IMAGE_GRACE_HOURS})
       AND si.uuid::text NOT IN (
             SELECT uuid FROM (${tenantImageReferences}) refs
              WHERE uuid IS NOT NULL)
     ORDER BY si.id
     LIMIT ${limit}
     FOR UPDATE OF si SKIP LOCKED`).execute(getDb());
}

/** Every per-ledger job, for one ledger. */
export async function purgeTenant(
  tenantId: number,
  policy: RetentionPolicy,
  options: RetentionOptions = {}
): Promise<RetentionCounts> {
  const opts = withDefaults(options);
  const jobs: Array<[string, (limit: number) => Promise<{ numAffectedRows?: bigint }>]> = [
    ['notifications', (limit) => deleteOldNotifications(policy, limit)],
    ['notification_deliveries', (limit) => deleteOldNotificationDeliveries(policy, limit)],
    ['import_sync_log', (limit) => deleteOldSyncLog(policy, limit)],
    ['stored_images', (limit) => deleteOrphanTenantImages(limit)],
  ];
  const counts: RetentionCounts = {};
  for (const [job, run] of jobs) {
    counts[job] = await inBatches(job, opts, async (limit) => affected(await withTenant(tenantId, () => run(limit))), { tenantId });
  }
  return counts;
}

/**
 * One retention run: the global job, then every organization's, then every ledger's (suspended
 * ones too). A job that fails is logged and the others still run; the run then throws, so the
 * scheduler records it.
 */
export async function runRetention(policy: RetentionPolicy, options: RetentionOptions = {}): Promise<RetentionCounts> {
  const opts = withDefaults(options);
  const counts: RetentionCounts = {};
  const failures: string[] = [];
  const add = (job: string, n: number) => {
    counts[job] = (counts[job] ?? 0) + n;
  };
  const attempt = async (job: string, run: () => Promise<void>, context: Record<string, unknown> = {}) => {
    if (opts.shouldStop()) return;
    try {
      await run();
    } catch (err) {
      failures.push(job);
      logger.error({ err, job, ...context }, 'A retention job failed');
    }
  };

  await attempt('sessions', async () => add('sessions', await purgeEndedSessions(policy, opts)));
  counts.organization_price_sync_runs = 0;
  for (const organizationId of opts.organizationIds ?? (await getAllOrganizationIds())) {
    await attempt(`organization ${organizationId}`, async () =>
      add('organization_price_sync_runs', await purgeOrganizationPriceSyncRuns(organizationId, policy, opts)),
    { organizationId });
  }
  for (const tenantId of opts.tenantIds ?? (await allTenantIds())) {
    await attempt(`tenant ${tenantId}`, async () => {
      for (const [job, n] of Object.entries(await purgeTenant(tenantId, policy, opts))) add(job, n);
    }, { tenantId });
  }

  logger.info({ deleted: counts, failed: failures, stopped: opts.shouldStop() || undefined }, 'Retention run finished');
  if (failures.length > 0) throw new Error(`Retention jobs failed: ${failures.join(', ')}`);
  return counts;
}
