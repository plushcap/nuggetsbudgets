import {
  PERSONAL_ACCESS_TOKEN_DEFAULT_LIFETIME,
  PERSONAL_ACCESS_TOKEN_LIFETIMES,
  PERSONAL_ACCESS_TOKEN_SCOPES,
  personalAccessTokenScope,
} from '@nuggets/shared';

/**
 * What a personal access token (an MCP token) may reach, and do there.
 *
 * A token is a long-lived bearer credential that usually sits in an MCP client's config
 * file, so it reaches only what the MCP tools need: the MCP endpoint itself, and the
 * ledger routes (behind resolveTenant + requireTenantMember) that the tools in
 * mcp/src/tools call, one route at a time. Everything else (all of /api/auth, passkeys,
 * sessions, admin, backup, health, organizations, ledger switching and membership,
 * settings, users, import and bank sync, push, OneDrive, reports, export, uploads, and
 * any ledger route no tool calls) needs a signed-in browser's session cookie.
 *
 * The bearer branch of authenticateSession checks every token request here, after the
 * token has verified, so this file is the one place that decides. A route not listed is
 * refused (403 INTERACTIVE_SESSION_REQUIRED), so a new route stays closed to tokens until
 * it's added here. Add one only when an MCP tool calls it, and never an account,
 * credential, admin or cross-ledger route. personal-access-tokens.test.ts replays every
 * tool's call through the real app, and route-authorization.test.ts checks every route
 * against this list and keeps what tokens reach in
 * __snapshots__/route-authorization.token-routes.txt.
 *
 * A token's scope decides what it may do on the routes it reaches: a 'read' token may only
 * make GET/HEAD requests and the read-only POSTs in READ_ONLY_POSTS (403 TOKEN_READ_ONLY
 * otherwise), except to the MCP endpoint
 * (JSON-RPC is POST; its tools call back into the routes below with the same token, so a
 * read token's write tools are refused there).
 */

export const TOKEN_SCOPES = PERSONAL_ACCESS_TOKEN_SCOPES;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const isTokenScope = (value: unknown): value is TokenScope =>
  (TOKEN_SCOPES as readonly unknown[]).includes(value);
/**
 * A stored scope as a TokenScope. The column's CHECK constraint allows only TOKEN_SCOPES,
 * so this throws only on a row the database shouldn't hold; a caller treats it as any
 * other failure (the bearer check answers 401 INVALID_TOKEN).
 */
export function toTokenScope(value: string): TokenScope {
  if (!isTokenScope(value)) throw new Error('personal_access_tokens.scope holds an unknown scope');
  return value;
}

/** The lifetimes a token may be minted with: 30, 90 or 365 days. */
export const TOKEN_LIFETIMES = PERSONAL_ACCESS_TOKEN_LIFETIMES;
export type TokenLifetime = (typeof TOKEN_LIFETIMES)[number];
export const DEFAULT_TOKEN_LIFETIME: TokenLifetime = PERSONAL_ACCESS_TOKEN_DEFAULT_LIFETIME;

/**
 * The ledger routes the MCP tools call, as `METHOD /path` in Express's notation (the
 * route's own pattern). A `:param` segment matches one id: a uuid or a whole number, so
 * it can't stand in for a sibling route's literal segment (`/securities/paginated` is
 * not `/securities/:uuid`). A GET route also takes HEAD, as in Express.
 */
export const TOKEN_ROUTES: readonly string[] = [
  'GET /api/accounts',
  'POST /api/accounts',
  'GET /api/accounts/:uuid',
  'POST /api/accounts/:uuid/adjust-balance',
  'GET /api/accounts/:uuid/balance',
  'GET /api/accounts/:uuid/balance-history',
  'PUT /api/accounts/:uuid/instructions',

  'GET /api/annotations',
  'POST /api/annotations',
  'PATCH /api/annotations/:uuid',
  'GET /api/annotations/inbox',

  'GET /api/budget-periods/management',

  'GET /api/budgets/item-matching-rules',
  'POST /api/budgets/item-matching-rules',
  'DELETE /api/budgets/item-matching-rules/:uuid',
  'PUT /api/budgets/item-matching-rules/:uuid',
  'GET /api/budgets/items',
  'POST /api/budgets/items',
  'PUT /api/budgets/items/:uuid',
  'GET /api/budgets/periods/:uuid/items',
  'GET /api/budgets/periods/:uuid/summary',

  'GET /api/categories',
  'POST /api/categories',
  'PUT /api/categories/:uuid',

  'GET /api/goals',
  'GET /api/goals/:uuid',
  'GET /api/goals/:uuid/balance-history',
  'GET /api/goals/:uuid/progress-history',

  'POST /api/investments/compositions',
  'POST /api/investments/corporate-actions/merger-cash',
  'POST /api/investments/corporate-actions/merger-stock',
  'POST /api/investments/corporate-actions/return-of-capital',
  'POST /api/investments/corporate-actions/spinoff',
  'POST /api/investments/corporate-actions/split',
  'POST /api/investments/cost-basis-method',
  'GET /api/investments/events',
  'POST /api/investments/events/buy',
  'POST /api/investments/events/dividend',
  'POST /api/investments/events/fee',
  'POST /api/investments/events/sell',
  'POST /api/investments/expense-ratio',
  'GET /api/investments/holdings',
  'GET /api/investments/holdings/:securityUuid/lots',
  'PATCH /api/investments/lots/:uuid',
  'POST /api/investments/lots/batch-import',
  'POST /api/investments/prices',
  'POST /api/investments/prices/bulk',
  'GET /api/investments/reports/concentration',
  'GET /api/investments/reports/cost-of-ownership',
  'GET /api/investments/reports/data-freshness',
  'GET /api/investments/reports/dividend-history',
  'GET /api/investments/reports/fees',
  'GET /api/investments/reports/lookthrough',
  'GET /api/investments/reports/lot-suggestions',
  'GET /api/investments/reports/performance',
  'GET /api/investments/reports/realized-gain-loss',
  'GET /api/investments/reports/reconciliation',
  'GET /api/investments/reports/securities-needing-data',
  'GET /api/investments/reports/sell-tax-impact',
  'GET /api/investments/reports/tax-loss-harvest',
  'GET /api/investments/reports/underlying-exposure',
  'GET /api/investments/reports/unrealized-gain-loss',
  'GET /api/investments/reports/value-series',
  'GET /api/investments/reports/wash-sales',
  'GET /api/investments/securities',
  'POST /api/investments/securities',
  'GET /api/investments/securities/:uuid',
  'PUT /api/investments/securities/:uuid',
  'GET /api/investments/securities/:uuid/composition',
  'GET /api/investments/securities/:uuid/price-gaps',
  'GET /api/investments/securities/:uuid/prices',
  'GET /api/investments/securities/:uuid/underlying-holdings',
  'POST /api/investments/securities/bulk-delete',
  'GET /api/investments/securities/cleanup/unused',
  'POST /api/investments/underlying-holdings',
  'POST /api/investments/underlying-tracking',

  'POST /api/merchants',
  'GET /api/merchants/:uuid',
  'PUT /api/merchants/:uuid',
  'POST /api/merchants/:uuid/apply-rules',
  'POST /api/merchants/:uuid/merge',
  'GET /api/merchants/:uuid/rules',
  'POST /api/merchants/:uuid/rules',
  'POST /api/merchants/:uuid/test-rules',
  'GET /api/merchants/paginated',
  'DELETE /api/merchants/rules/:uuid',
  'PUT /api/merchants/rules/:uuid',
  'GET /api/merchants/search',

  'GET /api/notifications/preferences',
  'PUT /api/notifications/preferences',
  'GET /api/notifications/rules',
  'PUT /api/notifications/rules',

  'GET /api/settings/general',

  'GET /api/tags',
  'POST /api/tags',
  'GET /api/tags/:uuid',
  'PUT /api/tags/:uuid',
  'PUT /api/tags/:uuid/report-root',
  'PUT /api/tags/budget-items/:budgetItemUuid/namespace/:rootTagUuid',
  'GET /api/tags/budget-items/:budgetItemUuid/tags',
  'POST /api/tags/budget-items/:budgetItemUuid/tags',
  'DELETE /api/tags/budget-items/:budgetItemUuid/tags/:tagId',
  'GET /api/tags/report-roots',
  'GET /api/tags/transaction/:transactionUuid',

  'POST /api/transactions',
  'GET /api/transactions/:uuid',
  'PUT /api/transactions/:uuid',
  'POST /api/transactions/:uuid/split',
  'DELETE /api/transactions/:uuid/tags/:tagUuid',
  'POST /api/transactions/:uuid/tags/:tagUuid',
  'POST /api/transactions/bulk',
  'PUT /api/transactions/bulk',
  'GET /api/transactions/paginated',

  'POST /api/transfer',
];

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * Listed routes that take a POST but only read (a dry run), so a 'read' token may call
 * them: the MCP tools that call them are read-only.
 */
export const READ_ONLY_POSTS: readonly string[] = [
  'POST /api/merchants/:uuid/test-rules',
];

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

/** Routes (`METHOD /path`) by method, each as its path's segments. */
function byMethod(routes: readonly string[]): Map<string, string[][]> {
  const map = new Map<string, string[][]>();
  for (const route of routes) {
    const [method, path] = route.split(' ');
    if (!method || !path) throw new Error(`Token route "${route}" isn't "METHOD /path"`);
    const list = map.get(method) ?? [];
    list.push(path.toLowerCase().split('/').slice(1));
    map.set(method, list);
  }
  return map;
}
const ROUTES_BY_METHOD = byMethod(TOKEN_ROUTES);
const READ_ONLY_POSTS_BY_METHOD = byMethod(READ_ONLY_POSTS);

/** Whether one of `routes` (by method) matches the request's method and path segments. */
function matchesRoute(routesByMethod: Map<string, string[][]>, method: string, segments: string[]): boolean {
  const upper = method.toUpperCase();
  const routes = routesByMethod.get(upper === 'HEAD' ? 'GET' : upper) ?? [];
  return routes.some(
    (parts) =>
      parts.length === segments.length &&
      parts.every((part, i) => (part.startsWith(':') ? ID_SEGMENT.test(segments[i] ?? '') : part === segments[i]))
  );
}

/**
 * A request path as Express routes it: the raw path (percent-encoding kept, no dot
 * segments resolved), matched case-insensitively, a trailing slash ignored. Returns null
 * for anything ambiguous (not an origin-form path, or an empty, `.` or `..` segment),
 * which is refused.
 */
function segmentsOf(originalUrl: string): string[] | null {
  const path = originalUrl.split(/[?#]/, 1)[0] ?? '';
  if (!path.startsWith('/')) return null;
  const segments = path.toLowerCase().replace(/\/$/, '').split('/').slice(1);
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segments;
}

type RouteAccess = 'mcp' | 'tenant' | 'deny';

/** How a token may use this request: the MCP endpoint, a listed tenant route, or not at all. */
export function tokenRouteAccess(method: string, originalUrl: string): RouteAccess {
  const segments = segmentsOf(originalUrl);
  if (!segments) return 'deny';
  // The MCP endpoint (app.use('/api/mcp')): any method, any path below it.
  if (segments[0] === 'api' && segments[1] === 'mcp') return 'mcp';
  return matchesRoute(ROUTES_BY_METHOD, method, segments) ? 'tenant' : 'deny';
}

export interface TokenRefusal {
  status: 403;
  code: 'INTERACTIVE_SESSION_REQUIRED' | 'TOKEN_READ_ONLY';
  error: string;
}

/**
 * Why a verified token may not make this request, or null when it may. Anything but
 * 'read_write' is treated as read-only.
 */
export function tokenRefusal(method: string, originalUrl: string, scope: string): TokenRefusal | null {
  const access = tokenRouteAccess(method, originalUrl);
  if (access === 'deny') {
    return {
      status: 403,
      code: 'INTERACTIVE_SESSION_REQUIRED',
      error: 'Personal access tokens can only use the MCP endpoint and its data routes. Sign in to the website for this.',
    };
  }
  const readsOnly = READ_METHODS.has(method.toUpperCase()) ||
    matchesRoute(READ_ONLY_POSTS_BY_METHOD, method, segmentsOf(originalUrl) ?? []);
  if (access === 'tenant' && scope !== personalAccessTokenScope.enum.read_write && !readsOnly) {
    return {
      status: 403,
      code: 'TOKEN_READ_ONLY',
      error:
        'This token is read-only, so it cannot make changes. To make changes, create a read-and-write token in Settings → MCP Access.',
    };
  }
  return null;
}
