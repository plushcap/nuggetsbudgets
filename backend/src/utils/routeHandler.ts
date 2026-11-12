import { Request, Response } from 'express';
import { getCurrentTenantId } from '../context/requestContext.js';
import { withTenant } from '../db/withTenant.js';
import { answerMalformedId, hasMalformedId } from '../middleware/routeParams.js';
import { answerError, isLockConflictError } from './apiError.js';
import { DomainError } from '../services/domainErrors.js';
import type { AuthenticatedRequest as MiddlewareAuthenticatedRequest } from '../middleware/auth.js';
import { bodyKeys, createLogger, pathOnly } from './logger.js';

const logger = createLogger({ service: 'RouteHandler' });

// The handler's result is ignored: it answers through `res` (a `return res.json(…)` is fine).
export const asyncHandler = <R extends Request = Request>(fn: (req: R, res: Response) => Promise<unknown>) => {
  return (req: R, res: Response): void => {
    // A malformed id in the path (see rejectMalformedIds) names nothing. Answered here,
    // after every guard on the route, so the caller's access is checked first.
    if (hasMalformedId(res)) {
      answerMalformedId(res);
      return;
    }
    Promise.resolve(fn(req, res)).catch((error: unknown) => {
      // An expected, client-facing failure (a refusal, a DomainError: a 404 for a uuid that
      // names nothing, say) is answered with its own status and code; anything else is
      // logged and answered 500 with a generic message, never the error's own text
      // (utils/apiError.ts). Log lines carry the request's id (utils/logger.ts).
      answerError(error, res, {
        path: pathOnly(req.path),
        method: req.method,
        // Field names only, never values: a query or body can hold a search, a payee or an
        // amount (CLAUDE.md, Logging). Path parameters are ids.
        queryKeys: Object.keys(req.query ?? {}),
        params: req.params,
        body: bodyKeys(req.body),
      });
    });
  };
};

// For authenticated routes: the request middleware/auth.ts declares, with `user` set.
// The wrappers below check it before they run the handler (signedIn).
type AuthenticatedRequest = MiddlewareAuthenticatedRequest & {
  user: NonNullable<MiddlewareAuthenticatedRequest['user']>;
};

// Use with asyncHandler:
type AuthRouteHandler = (req: AuthenticatedRequest, res: Response) => Promise<unknown>;

const isSignedIn = (req: Request): req is AuthenticatedRequest => req.user != null;

/**
 * Run `handler` only for a request authenticateToken has set the user on; answer any
 * other 401 AUTH_REQUIRED, as the guards do. Every route these wrappers run sits behind
 * authenticateToken at its mount (routes.ts; route-authorization.test.ts checks it), so
 * this never answers: it keeps a router mounted without it from running a handler that
 * reads `req.user` as set. Checked before a malformed id is answered, as a guard.
 * The wrapper carries `name`, so the route table (test/routeTable.ts) can tell it apart.
 */
function signedIn(name: string, handler: (req: AuthenticatedRequest, res: Response) => void) {
  const wrapper = (req: Request, res: Response): void => {
    if (!isSignedIn(req)) {
      logger.error({ method: req.method, path: pathOnly(req.originalUrl || req.url) }, 'A signed-in route ran without authenticateToken before it');
      res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      return;
    }
    handler(req, res);
  };
  return Object.defineProperty(wrapper, 'name', { value: name });
}

/** The names the route table shows for the wrappers that need a signed-in user. */
export const SIGNED_IN_HANDLERS = ['authHandler', 'tenantHandler', 'tenantNetworkHandler'] as const;

export const authHandler = (fn: AuthRouteHandler) => {
  return signedIn('authHandler', asyncHandler(fn));
};

/**
 * Like {@link authHandler}, but runs the handler inside `withTenant(activeTenantId)`
 * so `getDb()` resolves to the tenant-scoped transaction (GUC set → RLS-scoped).
 *
 * Requires `resolveTenant` + `requireTenantMember` earlier in the chain to have
 * populated the request context with the active budget; responds 400 if none is
 * selected. Use for any handler that touches tenant-scoped tables.
 */
/** Thrown inside withTenant to roll back a request that answered with an error. */
const rollbackErrorResponse = Symbol('rollbackErrorResponse');

export const tenantHandler = (fn: AuthRouteHandler) => {
  return signedIn('tenantHandler', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = getCurrentTenantId();
    if (tenantId == null) {
      res.status(400).json({ error: 'No active tenant selected', code: 'NO_ACTIVE_TENANT' });
      return;
    }
    // The whole handler runs inside withTenant (so getDb() is in scope), which
    // means res.json() would otherwise flush the response BEFORE the transaction
    // commits — letting a client read-after-write race the COMMIT (and risking an
    // ack for data a crash could lose). Defer the terminal flush by shadowing
    // res.end (the sink all responses funnel through) and replay it after commit.
    // Streamed read chunks (res.write) still go out during the handler, which is
    // fine — those transactions are read-only.
    const origEnd = res.end.bind(res) as (...args: unknown[]) => unknown;
    const captured: { args: unknown[] | null } = { args: null };
    (res as unknown as { end: (...args: unknown[]) => unknown }).end = (...args: unknown[]) => {
      captured.args = args;
      return res;
    };
    try {
      await withTenant(tenantId, async () => {
        await fn(req, res);
        // Commit only a successful answer. A handler that writes and then answers
        // 4xx/5xx must not leave its partial writes behind.
        if (res.statusCode >= 400) throw rollbackErrorResponse;
      });
    } catch (err) {
      if (err !== rollbackErrorResponse) {
        (res as unknown as { end: unknown }).end = origEnd;
        // A streamed response has already sent its status, so asyncHandler can't
        // answer 500; cut the connection rather than end it as if it succeeded.
        if (res.headersSent) res.destroy();
        throw err;
      }
    } finally {
      (res as unknown as { end: unknown }).end = origEnd;
    }
    if (captured.args) origEnd(...captured.args);
  }));
};

/** What a busy lock is answered on a route with no request transaction (tenantNetworkHandler). */
export const PARTLY_SAVED_MESSAGE =
  'Another change was being saved at the same time, so this stopped part way. What it had finished before then is saved; try again to finish the rest.';

/**
 * Like {@link tenantHandler}, but with no transaction around the handler: for one that
 * waits on a third party (a bank sync, a SimpleFin lookup), which must not hold a pooled
 * connection and row locks while it does. The handler gets the active tenant's
 * id and opens short `withTenant(tenantId, …)` transactions around its database work;
 * getDb() isn't available outside them. Nothing rolls back on an error answer, so it
 * writes only what it means to keep.
 *
 * So a lock it couldn't get (a deadlock, a wait past the lock timeout, or a service's busy
 * refusal, RECORD_BUSY or TRANSACTION_BUSY) may come after transactions it committed: the 409
 * says what was finished is saved, not that nothing was.
 */
export const tenantNetworkHandler = (
  fn: (req: AuthenticatedRequest, res: Response, tenantId: number) => Promise<unknown>
) => {
  return signedIn('tenantNetworkHandler', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = getCurrentTenantId();
    if (tenantId == null) {
      res.status(400).json({ error: 'No active tenant selected', code: 'NO_ACTIVE_TENANT' });
      return;
    }
    try {
      await fn(req, res, tenantId);
    } catch (err) {
      const busyCode = isLockConflictError(err)
        ? 'RECORD_BUSY'
        : err instanceof DomainError && err.status === 409 && (err.code === 'RECORD_BUSY' || err.code === 'TRANSACTION_BUSY')
          ? err.code
          : null;
      if (busyCode === null) throw err;
      logger.warn({ err, path: pathOnly(req.path) }, 'A route with no request transaction could not get a lock; what it committed before stays');
      throw new DomainError(409, busyCode, PARTLY_SAVED_MESSAGE);
    }
  }));
};

export type { AuthenticatedRequest, AuthRouteHandler };