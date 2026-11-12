import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request tenant context.
 *
 * Carries the authenticated identity and the active tenant (budget) for the
 * lifetime of a request via AsyncLocalStorage, so DB helpers and services can
 * read "who / where am I" without threading it through every call signature.
 *
 * `requireTenantMember` enters it, and `getCurrentTenantId()` reads the request's tenant
 * from it.
 */
export interface RequestContext {
  /** Authenticated user id (users.id). */
  userId: number;
  /** Active tenant (budget) id, or null when no budget is selected. */
  tenantId: number | null;
  /** Deployment-level admin (deployment_users.role = 'admin'): cross-tenant authority. */
  isDeploymentAdmin: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `ctx` as the active request context for its async call tree. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The current request context, or undefined outside a `runWithRequestContext` scope. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Current authenticated user id, or undefined when there is no active context. */
export function getCurrentUserId(): number | undefined {
  return storage.getStore()?.userId;
}

/**
 * The tenant of the active `withTenant` transaction (db/withTenant.ts), which is the
 * tenant RLS scopes every query to. Set by withTenant only.
 */
const tenantScope = new AsyncLocalStorage<number>();

/** Run `fn` as tenant `tenantId`'s work; withTenant calls this inside its transaction. */
export function runInTenantScope<T>(tenantId: number, fn: () => T): T {
  return tenantScope.run(tenantId, fn);
}

/**
 * Active tenant id for the current context: the tenant of the enclosing `withTenant`
 * transaction, else the request's. A number, `null` (a request with no ledger
 * selected), or `undefined` (no context at all). Callers that require a tenant must
 * distinguish these.
 *
 * The transaction's tenant comes first because it's the one the queries see. A
 * background job (forEachTenant) runs in withTenant with no request, and one armed
 * from a request would otherwise see that request's tenant for every tenant it
 * processes: it used one family's bank connection for all of them.
 */
export function getCurrentTenantId(): number | null | undefined {
  return tenantScope.getStore() ?? storage.getStore()?.tenantId;
}

/**
 * What every log line of an HTTP request carries (utils/logger.ts adds it): the request's
 * id, and once authenticateToken knows it, the user's. Entered for the whole request by
 * middleware/requestScope.ts, before any route, so unlike {@link RequestContext} it is
 * there on public and auth-only routes too.
 */
export interface RequestScope {
  /** The request's id: pino-http's `req.id`, also answered as the X-Request-Id header. */
  requestId: string;
  /** The authenticated user (users.id), set by authenticateToken. */
  userId?: number;
}

const requestScope = new AsyncLocalStorage<RequestScope>();

/** Run `fn` as part of the request `scope` describes (its async call tree included). */
export function runInRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return requestScope.run(scope, fn);
}

/** The current request's scope, or undefined outside one (a background job, startup). */
export function getRequestScope(): RequestScope | undefined {
  return requestScope.getStore();
}

/** The current request's id, or undefined outside a request. */
export function getRequestId(): string | undefined {
  return requestScope.getStore()?.requestId;
}

/** Record who the current request is from, so its later log lines name them. */
export function noteRequestUser(userId: number): void {
  const scope = requestScope.getStore();
  if (scope) scope.userId = userId;
}

/**
 * Run `fn` outside any request context and tenant scope. For timers a request arms
 * (a scheduler started from an admin route): a timer keeps the context it was created
 * in, so its runs would act as that request's user, ledger and admin rights, and log
 * as that request.
 */
export function runOutsideRequestContext<T>(fn: () => T): T {
  return storage.exit(() => tenantScope.exit(() => requestScope.exit(fn)));
}

/** Whether the current request is acting as a deployment admin. */
export function isDeploymentAdminContext(): boolean {
  return storage.getStore()?.isDeploymentAdmin ?? false;
}
