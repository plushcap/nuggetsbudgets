import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

/**
 * Answer 404 for a path id that can't name anything, once the caller is authorized.
 *
 * Handlers pass `:uuid`-style params straight to SQL. Postgres rejects a value that isn't
 * a uuid (or an integer, for the numeric ids), and the request used to fail with a 500.
 * A malformed id names nothing, so it is answered like an id that doesn't exist.
 *
 * Register it on routers mounted behind `authenticateToken` (and the ledger guards). Express
 * runs param callbacks before a route's own middleware, so they only mark the request; the
 * handler wrapper (`asyncHandler`, under `authHandler`/`tenantHandler`) answers the 404 after
 * every guard on the route has passed. Routers that authenticate per route (auth, passkeys,
 * admin) put {@link requireWellFormedIds} after their guards, or check with {@link isUuid}.
 */

/**
 * Path params that hold a uuid. A new one belongs here, and one no route uses any more
 * leaves (route-authorization.test.ts checks both, for the three lists).
 */
export const UUID_PARAMS = [
  'uuid',
  'accountUuid',
  'budgetItemUuid',
  'budgetPeriodItemUuid',
  'invitationUuid',
  'memberUuid',
  'merchantUuid',
  'periodUuid',
  'rootTagUuid',
  'securityUuid',
  'tagUuid',
  'transactionUuid',
] as const;

/** Path params that hold a numeric (integer) id. */
export const INTEGER_ID_PARAMS = ['tagId'] as const;

/** Path params that are neither, which their handlers check themselves. */
export const FREE_FORM_PARAMS = ['credentialId', 'fileName', 'templateType'] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT4_MAX = 2147483647;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);

/** A positive integer that fits Postgres's `integer`, written plainly (no sign, no leading zero). */
export const isIntegerId = (value: unknown): boolean =>
  typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= INT4_MAX;

const notFound = (res: Response) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });

const MALFORMED_ID = Symbol('malformedId');

/** True when a param callback found a malformed id in this request's path. */
export const hasMalformedId = (res: Response): boolean => res.locals[MALFORMED_ID as unknown as string] === true;

/** Answer a request whose path holds a malformed id. Call it after the route's guards. */
export const answerMalformedId = notFound;

const markMalformed = (res: Response) => {
  res.locals[MALFORMED_ID as unknown as string] = true;
};

const malformedParam = (params: Record<string, unknown>): boolean =>
  Object.entries(params).some(([name, value]) =>
    ((UUID_PARAMS as readonly string[]).includes(name) && !isUuid(value)) ||
    ((INTEGER_ID_PARAMS as readonly string[]).includes(name) && !isIntegerId(value)));

/**
 * The same check as route middleware, for routers that authenticate per route: put it
 * after the route's guards (and before any upload parser).
 */
export const requireWellFormedIds: RequestHandler = (req, res, next) => {
  if (malformedParam(req.params)) notFound(res);
  else next();
};

const registered = new WeakSet<Router>();

// Mark, don't answer: the route's own guards haven't run yet. Named, so the route table's
// view (test/routeTable.ts) can tell these from a param callback that refuses a request.
export function markMalformedUuid(_req: Request, res: Response, next: NextFunction, value: unknown): void {
  if (!isUuid(value)) markMalformed(res);
  next();
}
export function markMalformedIntegerId(_req: Request, res: Response, next: NextFunction, value: unknown): void {
  if (!isIntegerId(value)) markMalformed(res);
  next();
}

export function rejectMalformedIds<T extends Router>(router: T): T {
  // Module-level routers are mounted again by every app a test builds.
  if (registered.has(router)) return router;
  registered.add(router);
  for (const name of UUID_PARAMS) router.param(name, markMalformedUuid);
  for (const name of INTEGER_ID_PARAMS) router.param(name, markMalformedIntegerId);
  return router;
}
