import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type Kysely, type Transaction } from 'kysely';
import { db } from '../db.js';
import type { DB } from './schema.generated.js';
import { runInTenantScope, runOutsideRequestContext } from '../context/requestContext.js';

/**
 * Per-request tenant transaction.
 *
 * `withTenant` opens a transaction, sets the transaction-local GUC
 * `app.current_tenant_id`, and stores the transaction here so `getDb()` can
 * return it without threading `trx` through every call signature. RLS policies
 * read the GUC, so every statement run via `getDb()` is scoped to that tenant.
 */
const trxStorage = new AsyncLocalStorage<Transaction<DB>>();

/**
 * The innermost transaction and the organization it has set in
 * `app.current_organization_id`, which the organization tables' RLS policies read: a
 * {@link withOrganization} transaction, or a {@link withTenant} one, whose organization
 * is its tenant's (null for a tenant that doesn't exist). `getOrgDb()` returns its
 * transaction, and `withOrganization` joins it when it is already that organization's.
 */
interface OrganizationScope {
  trx: Transaction<DB>;
  organizationId: number | null;
  /** The tenant of a {@link withTenant} transaction; null for a {@link withOrganization} one. */
  tenantId: number | null;
}

const orgStorage = new AsyncLocalStorage<OrganizationScope>();

/**
 * The tenant-scoped DB handle for the current request: the active `withTenant`
 * transaction, whose connection has `app.current_tenant_id` set so RLS scopes
 * every query to the tenant.
 *
 * **Fail-loud:** throws if called with no tenant context. A handler that touches
 * tenant data must run inside `tenantHandler`/`withTenant`; forgetting that
 * surfaces as an immediate error here rather than a silent unscoped query. For
 * genuinely global tables (users, sessions, system_settings, onedrive_tokens,
 * personal_access_tokens, schema_migrations, and the control-plane tables) use
 * {@link globalDb} instead.
 */
export function getDb(): Transaction<DB> {
  const trx = trxStorage.getStore();
  if (!trx) {
    throw new Error(
      'getDb() called with no tenant context. Run inside tenantHandler/withTenant for ' +
        'tenant-scoped tables, or use globalDb for non-tenant tables.'
    );
  }
  return trx;
}

/**
 * The organization-scoped DB handle: the innermost transaction with
 * `app.current_organization_id` set, so RLS scopes the organization tables
 * (organization_simplefin_connections, organization_price_sync_settings,
 * organization_price_sync_runs) to that organization. That is a
 * {@link withOrganization} transaction, or a tenant transaction, whose organization is
 * its tenant's.
 *
 * **Fail-loud** like {@link getDb}: throws with no organization context.
 */
export function getOrgDb(): Transaction<DB> {
  const scope = orgStorage.getStore();
  if (!scope || scope.organizationId === null) {
    throw new Error(
      'getOrgDb() called with no organization context. Run inside withOrganization, or a tenant ' +
        "transaction (its organization is its tenant's), for the organization tables."
    );
  }
  return scope.trx;
}

/** The organization of the innermost transaction ({@link getOrgDb}'s), if there is one. */
export function getCurrentOrganizationId(): number | undefined {
  return orgStorage.getStore()?.organizationId ?? undefined;
}

/**
 * The organization of `tenantId` when the innermost transaction is that tenant's own
 * ({@link withTenant} read it as it began; null for a tenant that doesn't exist), else
 * undefined: code inside the ledger's transaction needs no second pooled connection to
 * read it.
 */
export function organizationOfOpenTenant(tenantId: number): number | null | undefined {
  const scope = orgStorage.getStore();
  return scope && scope.tenantId === tenantId ? scope.organizationId : undefined;
}

/**
 * DB handle for **non-tenant** (global) tables — no `app.current_tenant_id` or
 * `app.current_organization_id` is set. Use only for tables without an RLS policy. A
 * tenant table queried through it fails ("no tenant is set for this query"), and an
 * organization table ("no organization is set"); use {@link getDb} or
 * {@link getOrgDb}.
 */
export const globalDb = db;

/**
 * The current tenant transaction when there is one, else {@link globalDb}. For a
 * read of a control-plane table (system_settings) that should share the
 * caller's transaction, and see what it wrote, rather than take a second
 * connection.
 */
export function currentDbOrGlobal(): Kysely<DB> {
  return trxStorage.getStore() ?? db;
}

/** Whether a tenant transaction is open here (getDb() would return one). */
export function inTenantTransaction(): boolean {
  return trxStorage.getStore() !== undefined;
}

/**
 * Run `fn` with no tenant transaction, request context or tenant scope, so whatever it
 * schedules starts clean. Schedulers arm their timers through this: one armed inside a
 * request (an admin starting the scheduler) would otherwise run every tick as that
 * request, with its finished transaction as getDb().
 */
export function runDetached<T>(fn: () => T): T {
  return trxStorage.exit(() => orgStorage.exit(() => runOutsideRequestContext(fn)));
}

/**
 * Run `fn` inside a transaction with the tenant GUC set, and the organization GUC set
 * to the tenant's own organization, so the ledger's queries also read (and its
 * triggers check) its organization's rows. `set_config(…, true)`
 * is transaction-local, so it resets on COMMIT/ROLLBACK and can never leak to
 * another request reusing the pooled connection. The transaction is also stored
 * in AsyncLocalStorage so `getDb()` and `getOrgDb()` resolve to it for the duration of
 * `fn`, and `getCurrentTenantId()` to `tenantId`. Don't start a nested `getDb().transaction()`
 * (Kysely refuses one on a transaction); use {@link withSavepoint}.
 */
export async function withTenant<T>(
  tenantId: number,
  fn: (trx: Transaction<DB>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    // Bound parameters (not interpolation); set_config's value argument is text. tenants is
    // control plane (no RLS); an unknown tenant sets no organization ('').
    const { rows } = await sql<{ organization_id: string }>`
      select set_config('app.current_tenant_id', ${String(tenantId)}, true),
             set_config('app.current_organization_id',
                        coalesce((select organization_id::text from public.tenants where id = ${tenantId}), ''),
                        true) as organization_id`.execute(trx);
    const organizationId = rows[0]?.organization_id ? Number(rows[0].organization_id) : null;
    const result = await trxStorage.run(trx, () =>
      orgStorage.run({ trx, organizationId, tenantId }, () => runInTenantScope(tenantId, () => fn(trx)))
    );
    await assertTransactionUsable(trx);
    return result;
  });
}

/**
 * Run `fn` with the organization GUC `app.current_organization_id` set to
 * `organizationId`, so RLS scopes the organization tables to it ({@link getOrgDb}).
 *
 * Joins the current transaction when it is already that organization's: a ledger's
 * transaction reading its own organization's rows (withTenant sets its organization), or
 * a withOrganization inside another of the same organization. `fn` then commits or rolls
 * back with that transaction. With no transaction open, it opens one of its own, which
 * sets no tenant: `getDb()` throws inside it rather than hand out another connection's.
 *
 * Inside a transaction of another organization (a ledger's, or a withOrganization's) it
 * throws: it would open a second pooled connection, whose writes commit even if the
 * outer transaction rolls back, and inside which `getCurrentTenantId()` still answers the
 * outer ledger. Run it after that transaction, or for its own organization.
 *
 * Like withTenant, keep network I/O (SimpleFin, the price provider) out of it.
 */
export async function withOrganization<T>(
  organizationId: number,
  fn: (trx: Transaction<DB>) => Promise<T>
): Promise<T> {
  const current = orgStorage.getStore();
  if (current && current.organizationId === organizationId) return fn(current.trx);
  if (current) {
    throw new Error(
      `withOrganization(${organizationId}) was called inside a transaction of ` +
        `${current.organizationId === null ? 'a tenant with no organization' : `organization ${current.organizationId}`}: ` +
        'it would open a second connection, whose writes commit apart from that transaction. ' +
        "Run it outside the transaction, or for the transaction's own organization."
    );
  }
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.current_organization_id', ${String(organizationId)}, true)`.execute(trx);
    const result = await trxStorage.exit(() => orgStorage.run({ trx, organizationId, tenantId: null }, () => fn(trx)));
    await assertTransactionUsable(trx);
    return result;
  });
}

/**
 * Throw if the transaction was aborted by a database error that something caught and
 * swallowed. PostgreSQL then refuses every later statement and answers COMMIT with a
 * ROLLBACK, without an error, so the work would be reported as saved when none of it
 * was. Use {@link withSavepoint} for a statement whose failure is allowed.
 */
async function assertTransactionUsable(trx: Transaction<DB>): Promise<void> {
  try {
    await sql`select 1`.execute(trx);
  } catch (err) {
    if ((err as { code?: string }).code === '25P02') {
      throw new Error(
        'A database error was caught inside this tenant or organization transaction, so PostgreSQL aborted it and nothing was saved',
        { cause: err }
      );
    }
    throw err;
  }
}

let savepointSeq = 0;

/**
 * Run `fn` in a savepoint of the current tenant transaction, so that a database error
 * inside it can be caught and the transaction carry on. Without one, the first error
 * aborts the whole transaction (see {@link assertTransactionUsable}). On error, rolls
 * back to the savepoint and rethrows. Savepoints nest as a stack, so don't run two of
 * these concurrently on one transaction (e.g. under Promise.all).
 */
export async function withSavepoint<T>(fn: () => Promise<T>): Promise<T> {
  const trx = getDb();
  const name = sql.id(`nuggets_sp_${++savepointSeq}`);
  await sql`SAVEPOINT ${name}`.execute(trx);
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(trx);
    await sql`RELEASE SAVEPOINT ${name}`.execute(trx);
    throw err;
  }
  await sql`RELEASE SAVEPOINT ${name}`.execute(trx);
  return result;
}
