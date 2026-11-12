import { globalDb, withTenant } from './withTenant.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ service: 'forEachTenant' });

/**
 * Ids of all tenants a background job should process: active tenants of active
 * organizations. A suspended organization's ledgers are closed to its members
 * (loadTenantAccess), so they don't sync or send notifications either.
 *
 * Read via {@link globalDb}: `tenants` and `organizations` have no RLS.
 */
export async function getActiveTenantIds(): Promise<number[]> {
  const rows = await globalDb
    .selectFrom('tenants as t')
    .innerJoin('organizations as o', 'o.id', 't.organization_id')
    .select('t.id')
    .where('t.status', '=', 'active')
    .where('o.status', '=', 'active')
    .orderBy('t.id')
    .execute();
  return rows.map((r) => r.id);
}

/**
 * Ids of the active organizations, for a job that acts for an organization (the price
 * sync): a suspended or deleted organization's ledgers are closed to its members, so it
 * runs no jobs either, as {@link getActiveTenantIds} leaves its ledgers out.
 * `organizations` is control plane, read via {@link globalDb}.
 */
export async function getActiveOrganizationIds(): Promise<number[]> {
  const rows = await globalDb.selectFrom('organizations').select('id').where('status', '=', 'active').orderBy('id').execute();
  return rows.map((r) => r.id);
}

/**
 * Ids of every organization, whatever its status, for a job that visits each
 * organization's own rows (the price-sync schedule and history) in a
 * `withOrganization` transaction of its own: under RLS no query reads two
 * organizations' rows. `organizations` is control plane, read via {@link globalDb}.
 */
export async function getAllOrganizationIds(): Promise<number[]> {
  const rows = await globalDb.selectFrom('organizations').select('id').orderBy('id').execute();
  return rows.map((r) => r.id);
}

export interface ForEachTenantResult {
  total: number;
  succeeded: number;
  failed: number;
}

/**
 * Run `fn` once per active tenant, each inside `withTenant(tenantId)` so `getDb()`
 * resolves to that tenant's transaction (GUC set → RLS-scoped).
 *
 * Schedulers run outside any HTTP request — and therefore outside the
 * AsyncLocalStorage that `tenantHandler` populates — so they must establish tenant
 * context per tenant. A failure in one tenant is logged and does not
 * abort the rest; per-tenant counts are returned and logged.
 */
export async function forEachTenant(
  job: string,
  fn: (tenantId: number) => Promise<unknown>
): Promise<ForEachTenantResult> {
  const tenantIds = await getActiveTenantIds();
  let succeeded = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      await withTenant(tenantId, () => fn(tenantId));
      succeeded++;
    } catch (err) {
      failed++;
      logger.error({ err, tenantId, job }, 'Per-tenant scheduled job failed');
    }
  }

  logger.info({ job, total: tenantIds.length, succeeded, failed }, 'Completed per-tenant scheduled job');
  return { total: tenantIds.length, succeeded, failed };
}

/**
 * Like {@link forEachTenant}, but without a transaction around `fn`: for a job that
 * does network I/O (sending email or push, fetching from a bank), which must not run
 * while a tenant transaction holds a pooled connection and row locks. `fn`
 * opens its own short `withTenant(tenantId, …)` for each piece of database work.
 */
export async function forEachTenantId(
  job: string,
  fn: (tenantId: number) => Promise<unknown>
): Promise<ForEachTenantResult> {
  const tenantIds = await getActiveTenantIds();
  let succeeded = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      await fn(tenantId);
      succeeded++;
    } catch (err) {
      failed++;
      logger.error({ err, tenantId, job }, 'Per-tenant scheduled job failed');
    }
  }

  logger.info({ job, total: tenantIds.length, succeeded, failed }, 'Completed per-tenant scheduled job');
  return { total: tenantIds.length, succeeded, failed };
}
