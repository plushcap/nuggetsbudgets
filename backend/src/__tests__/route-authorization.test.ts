import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Every refused request logs a warning, and outside production the logger defaults to
// debug: tens of thousands of lines. Keep them out of CI output unless asked for.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

// The checks below only reach a handler that changes something when a guard is missing,
// but then they would create, restore or re-key real backups. Stand BackupService in with
// no-ops, with no backups or backup settings to list. (A run like that can still change
// deployment-wide state through other handlers, e.g. the deployment's time zone or the
// notification settings, so run these tests on a throwaway database, as CLAUDE.md says.)
vi.mock('../services/BackupService.js', async () => {
  const { tmpdir } = await import('os');
  return {
    BackupService: class {
      static isBackupInProgress = () => false;
      static isRestoreInProgress = () => false;
      constructor() {
        return new Proxy(this, {
          get: (_target, prop) =>
            prop === 'then'
              ? undefined
              : prop === 'listBackups' || prop === 'readEditableSettings'
                ? async () => []
                : prop === 'readSettings'
                  ? async () => ({})
                  : prop === 'getTempDir'
                    ? () => tmpdir()
                    : async () => undefined,
        });
      }
    },
  };
});

import http from 'http';
import request from 'supertest';
import { Pool } from 'pg';
import { buildApp, type Endpoint } from '../test/routeTable.js';
import { sessionService } from '../middleware/auth.js';
import { READ_ONLY_POSTS, TOKEN_ROUTES } from '../middleware/tokenAccess.js';
import { SESSION_COOKIE_NAME } from '../utils/session-cookie-config.js';
// The CSRF token is bound to the session.
import { csrfTokenFor } from '../utils/csrfToken.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { FREE_FORM_PARAMS, INTEGER_ID_PARAMS, UUID_PARAMS, markMalformedIntegerId, markMalformedUuid } from '../middleware/routeParams.js';
import { SIGNED_IN_HANDLERS } from '../utils/routeHandler.js';

/**
 * Route authorization matrix.
 *
 * Every other route test mounts one router behind `testTenantContext`, which fakes the
 * signed-in user and ledger, so the real chain in routes.ts (authenticateToken →
 * resolveTenant → requireTenantMember → requireTenantAdmin / requireOrgAdmin /
 * requireDeploymentAdmin, plus the checks some routers and handlers make themselves) is
 * never run. This file builds the app the way index.ts does (createApp + mountRoutes),
 * lists every route mountRoutes registers, and checks each one against its level in ACCESS:
 *
 *   - no session                           → 401 on every non-public route;
 *   - every signed-in role below the level → 403 (e.g. a member of another ledger on a
 *                                            ledger route, a ledger member on a ledger-admin
 *                                            route); mutations are sent as multipart with a
 *                                            stray file, so an upload parser placed before
 *                                            the guard fails the check;
 *   - every role at or above the level     → not refused (GET routes only, so handlers that
 *                                            change things don't run; see GET_SIDE_EFFECTS);
 *   - a cookie-authenticated mutation with a missing or wrong CSRF header → 403, on every
 *     non-public route;
 *   - first-run admin setup refuses once the deployment has users;
 *   - no upload parser (multer) runs before a route's last guard middleware;
 *   - a personal access token is refused (403 INTERACTIVE_SESSION_REQUIRED) on every
 *     route TOKEN_ROUTES doesn't open to tokens, and a read-only one is refused
 *     (403 TOKEN_READ_ONLY) on every write to a route it does open.
 *
 * A route that matches no ACCESS entry fails the test, as does an entry that decides no
 * route. A new route under an existing `/path/*` entry inherits its level, so the full list
 * of routes and levels is also kept in __snapshots__/route-authorization.routes.txt: a new
 * route fails the test until that file is updated (`npx vitest run -u <this file>`), and the
 * diff shows the level it got. An entry that pins a known gap at today's level says so in
 * its comment. The routes a token may reach
 * (TOKEN_ROUTES) are kept the same way in __snapshots__/route-authorization.token-routes.txt.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

type Level = 'public' | 'user' | 'member' | 'tenantAdmin' | 'orgAdmin' | 'deploymentAdmin';

// Each role is the weakest identity that holds the level of the same rank, so a role may
// use a route exactly when its rank is at least the route's.
const LEVELS: Level[] = ['public', 'user', 'member', 'tenantAdmin', 'orgAdmin', 'deploymentAdmin'];
type Role = 'anonymous' | 'outsider' | 'member' | 'tenantAdmin' | 'orgAdmin' | 'deploymentAdmin';
const ROLES: Role[] = ['anonymous', 'outsider', 'member', 'tenantAdmin', 'orgAdmin', 'deploymentAdmin'];
// anonymous:       no session.
// outsider:        signed in with this ledger selected, but only a plain member of its
//                  organization (which grants no ledger access), and the admin of another
//                  organization and its ledger.
// member:          a plain member of this ledger and of its organization.
// tenantAdmin:     an admin of this ledger (not of its organization).
// orgAdmin:        an admin of this ledger's organization, with no ledger membership.
// deploymentAdmin: a deployment admin, with no organization or ledger membership.

/**
 * Who may call each route, first match wins. `METHOD /path` matches one route (with its
 * `:params` as written in the router); `/path/*` matches that path and everything below it;
 * `*` matches any method.
 */
const ACCESS: Array<[pattern: string, level: Level]> = [
  // Public: reachable without signing in. Keep this list short; each entry needs a reason.
  ['GET /api/csrf-token', 'public'], // the SPA fetches its double-submit token before login
  ['GET /.well-known/*', 'public'], // static 404s for MCP clients probing for OAuth
  ['GET /health', 'public'], // liveness probes
  ['GET /api/health', 'public'],
  ['GET /api/ready', 'public'], // readiness probe: container healthchecks, uptime checks
  ['GET /api/auth/setup-status', 'public'], // first-run bootstrap
  ['GET /api/auth/password-policy', 'public'], // the first-run setup page shows it; no secret
  ['POST /api/auth/setup-admin', 'public'],
  ['POST /api/auth/login', 'public'],
  ['POST /api/passkeys/auth/*', 'public'], // passkey sign-in
  ['GET /api/onedrive/callback', 'public'], // OAuth redirect target
  ['POST /api/notification-links/*', 'public'], // emailed unsubscribe links; the signed token is the credential
  ['ALL /api', 'public'], // the JSON 404 for an /api path no route answers; it reads nothing

  // Deployment admin.
  ['GET /api/health/*', 'deploymentAdmin'],
  ['GET /api/status', 'deploymentAdmin'], // the deployment's schedulers, every ledger's
  ['* /api/backup/*', 'deploymentAdmin'],
  // Settings → Utilities: the schema and applied migrations, in a browser session only.
  ['GET /api/admin/database/schema', 'deploymentAdmin'],
  ['GET /api/admin/database/migrations', 'deploymentAdmin'],
  // The deployment's time zone: a ledger's own is POST /api/settings/general.
  ['GET /api/admin/deployment-settings', 'deploymentAdmin'],
  ['PUT /api/admin/deployment-settings', 'deploymentAdmin'],
  ['* /api/admin/*', 'deploymentAdmin'], // includes /api/admin/test-data, checked at its mount, and /api/admin/notifications
  ['DELETE /api/net-worth/clear', 'deploymentAdmin'], // requireDeploymentAdmin on the route
  ['POST /api/net-worth/rebuild', 'deploymentAdmin'], // requireDeploymentAdmin on the route
  ['* /api/onedrive/*', 'deploymentAdmin'], // where whole-deployment backups go
  ['POST /api/organizations/:uuid/members', 'deploymentAdmin'], // adds an existing user directly; org admins invite

  // Admin of the organization: the active ledger's, or the one named in the URL.
  // The flags routes change global account flags: for someone with access outside the
  // organization, or a deployment admin, only a deployment admin may (checked in the service).
  ['* /api/organizations/*', 'orgAdmin'], // addressed by org uuid; checked by the router's uuid param handler
  ['PATCH /api/tenants/current/members/:uuid/flags', 'orgAdmin'],
  // The organization's SimpleFin connection covers all its ledgers.
  ['GET /api/import/accounts', 'orgAdmin'],
  ['POST /api/import/test-sync', 'orgAdmin'],
  ['GET /api/import/simplefin-accounts', 'orgAdmin'],
  ['GET /api/import/simplefin-account-transactions', 'orgAdmin'],
  ['POST /api/accounts/:uuid/connect-bank', 'orgAdmin'],
  // The ledger's own import schedule and import user, set by the organization's admins.
  ['POST /api/import/settings', 'orgAdmin'],
  ['POST /api/import/scheduler/start', 'orgAdmin'],
  ['POST /api/import/scheduler/stop', 'orgAdmin'],
  ['GET /api/import/users', 'orgAdmin'], // the people with access to the ledger

  // Admin of the active ledger.
  ['* /api/data-management/*', 'tenantAdmin'],
  ['PATCH /api/tenants/current', 'tenantAdmin'],
  ['PATCH /api/tenants/current/balance-adjustment-merchant', 'tenantAdmin'],
  ['GET /api/tenants/current/member-candidates', 'tenantAdmin'],
  ['POST /api/tenants/current/members', 'tenantAdmin'], // only members of the ledger's organization
  ['PATCH /api/tenants/current/members/:uuid', 'tenantAdmin'],
  ['DELETE /api/tenants/current/members/:uuid', 'tenantAdmin'],
  ['PUT /api/notifications/rules', 'tenantAdmin'],
  ['* /api/notifications/history', 'tenantAdmin'],
  ['POST /api/settings/general', 'tenantAdmin'], // the ledger's own time zone

  // Any signed-in user, in any ledger or none: their own account, sessions, devices, tokens.
  ['* /api/auth/*', 'user'],
  ['* /api/passkeys/*', 'user'],
  ['* /api/push/*', 'user'],
  ['* /api/mcp/*', 'user'], // its tools call the routes below with the caller's own token
  ['* /api/invitations/*', 'user'], // accepting an invitation to an organization, before any ledger

  // Members of the active ledger.
  ['GET /api/tenants/current/users', 'member'], // the people who can open the active ledger (was GET /api/users)
  ['* /api/transactions/*', 'member'],
  ['* /api/annotations/*', 'member'],
  ['* /api/transfer/*', 'member'],
  ['* /api/budgets/*', 'member'],
  ['* /api/bills/*', 'member'],
  ['* /api/budget-periods/*', 'member'],
  ['* /api/categories/*', 'member'],
  ['* /api/tags/*', 'member'],
  ['* /api/reports/*', 'member'],
  ['* /api/institutions/*', 'member'],
  ['* /api/merchants/*', 'member'],
  ['GET /api/budget-items/:uuid/history', 'member'], // detail-page summaries
  ['GET /api/merchant-spending/:uuid', 'member'],
  ['* /api/accounts/*', 'member'],
  ['* /api/images/*', 'member'],
  ['* /api/investments/*', 'member'],
  ['* /api/import/*', 'member'],
  ['GET /api/settings/*', 'member'], // the ledger's settings, and the time zone list
  ['* /api/tenants/*', 'member'],
  ['* /api/net-worth/*', 'member'],
  ['* /api/attachments/*', 'member'],
  ['* /api/goals/*', 'member'],
  ['* /api/notifications/*', 'member'],
  ['* /api/export/*', 'member'],
];

// GET routes that write deployment-wide state on first use (it generates the push keys
// when the data-encryption secret is present), so the "allowed" check doesn't call them.
const GET_SIDE_EFFECTS = new Set(['GET /api/push/public-key']);

// GET routes that answer 503 by design when what they report on is missing here: the
// health checks (a test deployment has no secrets), readiness (no services are started
// here) and OneDrive (not configured). Any other 5xx from a route the caller may use is a
// bug.
const MAY_BE_UNAVAILABLE = new Set([
  'GET /api/health/detailed',
  'GET /api/health/security',
  'GET /api/ready',
  'GET /api/onedrive/auth',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Codes the auth and tenant middleware answer with when they fail or find no ledger or
// organization (middleware/auth.ts, middleware/tenant.ts, utils/routeHandler.ts).
const GUARD_FAILURE_CODES = new Set([
  'AUTH_ERROR',
  'TENANT_RESOLVE_ERROR',
  'NO_ACTIVE_TENANT',
  'NO_ACTIVE_ORG',
  'TENANT_AUTH_ERROR',
]);
// The guard middleware, by function name (authenticateToken is authenticateSession).
const GUARDS = new Set([
  'authenticateSession',
  'requireInteractiveSession',
  'requireRecentReauth',
  'resolveTenant',
  'requireTenantMember',
  'requireTenantAdmin',
  'requireOrgAdmin',
  'requireDeploymentAdmin',
]);
const CSRF_TOKEN = 'route-authorization-csrf-token';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function matches(pattern: string, endpoint: Endpoint): boolean {
  const [method, pathPattern] = pattern.split(' ');
  if (method !== '*' && method !== endpoint.method) return false;
  if (pathPattern.endsWith('/*')) {
    const base = pathPattern.slice(0, -2);
    return endpoint.path === base || endpoint.path.startsWith(`${base}/`);
  }
  return endpoint.path === pathPattern;
}

const levelOf = (endpoint: Endpoint): Level | undefined =>
  ACCESS.find(([pattern]) => matches(pattern, endpoint))?.[1];
/**
 * Whether a personal access token may reach a route: the MCP endpoint, or a route
 * TOKEN_ROUTES (middleware/tokenAccess.ts) names exactly. The middleware matches request
 * paths against that list; this compares route patterns as strings, and the requests below
 * check the two agree.
 */
const isMcpEndpoint = (endpoint: Endpoint) => endpoint.path === '/api/mcp' || endpoint.path.startsWith('/api/mcp/');
const tokenMayReach = (endpoint: Endpoint): boolean =>
  isMcpEndpoint(endpoint) || TOKEN_ROUTES.includes(describeEndpoint(endpoint));

const rank = (level: Level) => LEVELS.indexOf(level);
const describeEndpoint = (e: Endpoint) => `${e.method} ${e.path}`;
const byPathThenMethod = (a: Endpoint, b: Endpoint) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0;

// Most scheduler routes go through the lifecycle service; a no-op stand-in keeps a run
// with a missing guard from starting or stopping the schedulers that way.
const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

describeDb('Route authorization matrix', () => {
  let owner: Pool;
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  let server: http.Server;
  let endpoints: Endpoint[];
  let createAppRoutes: number;
  let orgUuid: string;
  const extraUserIds: number[] = [];
  const sessions = new Map<Role, { id: number; token: string }>();
  let memberReadToken: string; // a read-only personal access token of the member, for this ledger

  beforeAll(async () => {
    // OneDriveService needs a key at construction when no Docker secret is present.
    process.env.ENCRYPTION_KEY ??= 'route-authorization-test-encryption-key-0123456789';

    const built = buildApp(lifecycleStub);
    endpoints = built.endpoints;
    createAppRoutes = built.createAppRoutes;
    server = http.createServer(built.app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    owner = new Pool({ connectionString, max: 2 });
    tenant = await createTestTenant('Route authorization');
    otherTenant = await createTestTenant('Route authorization outsider');
    orgUuid = (
      await owner.query<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [tenant.organizationId])
    ).rows[0].uuid;

    const addUser = async (label: string): Promise<number> => {
      const email = `route-authz-${label.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
      const id = (
        await owner.query<{ id: number }>(
          `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Test', $2) RETURNING id`,
          [email, label]
        )
      ).rows[0].id;
      extraUserIds.push(id);
      return id;
    };
    const addOrgUser = (organizationId: number, userId: number, isAdmin: boolean) =>
      owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, $3)', [
        organizationId,
        userId,
        isAdmin,
      ]);

    await addOrgUser(otherTenant.organizationId, otherTenant.userId, true);
    await addOrgUser(tenant.organizationId, otherTenant.userId, false);
    await addOrgUser(tenant.organizationId, tenant.userId, false);
    const tenantAdminId = await addUser('TenantAdmin');
    await owner.query('INSERT INTO tenant_users (tenant_id, user_id, is_admin) VALUES ($1, $2, true)', [
      tenant.tenantId,
      tenantAdminId,
    ]);
    const orgAdminId = await addUser('OrgAdmin');
    await addOrgUser(tenant.organizationId, orgAdminId, true);
    const deploymentAdminId = await addUser('DeploymentAdmin');
    const deploymentAdmin = await owner.query(
      `INSERT INTO deployment_users (user_id, deployment_id, role)
       SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`,
      [deploymentAdminId]
    );
    if (deploymentAdmin.rowCount !== 1) throw new Error('No deployment row to make the deployment admin a member of');

    const userIds: Partial<Record<Role, number>> = {
      outsider: otherTenant.userId,
      member: tenant.userId,
      tenantAdmin: tenantAdminId,
      orgAdmin: orgAdminId,
      deploymentAdmin: deploymentAdminId,
    };
    for (const [role, userId] of Object.entries(userIds) as Array<[Role, number]>) {
      const { token, sessionId } = await sessionService.createSession({ userId });
      // Every signed-in role acts in this test's ledger; for the outsider that's a
      // ledger they don't belong to.
      await owner.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenant.tenantId, sessionId]);
      sessions.set(role, { id: sessionId, token });
    }

    // The member's read-only token, minted as Settings → MCP Access does (signing in
    // counts as the fresh re-authentication minting needs). A token's refusals come
    // before any role check, so the member's token shows them on every route; and if
    // they were missing, the role checks would still keep it out of admin handlers.
    const tenantUuid = (await owner.query<{ uuid: string }>('SELECT uuid FROM tenants WHERE id = $1', [tenant.tenantId]))
      .rows[0].uuid;
    const minted = await request(server)
      .post('/api/auth/mcp-token')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sessions.get('member')!.token}; csrf_token=${CSRF_TOKEN}`)
      .set('X-CSRF-Token', csrfTokenFor(sessions.get('member')!.token))
      .send({ label: 'route-authorization', tenantUuid, scope: 'read', expiresIn: '30d' });
    if (minted.status !== 201) throw new Error(`Minting the member's token failed: ${minted.status} ${JSON.stringify(minted.body)}`);
    memberReadToken = minted.body.token;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!owner) return;
    try {
      const userIds = [...extraUserIds, tenant?.userId, otherTenant?.userId].filter((id) => id != null);
      await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM deployment_users WHERE user_id = ANY($1)', [extraUserIds]);
      await owner.query('DELETE FROM organization_users WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM tenant_users WHERE user_id = ANY($1)', [extraUserIds]);
      // Clean up both ledgers even if one fails, then report the failure.
      const settled = await Promise.allSettled([tenant?.cleanup(), otherTenant?.cleanup()]);
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [extraUserIds]);
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      await owner.end();
    }
  }, 60_000);

  /** A concrete URL for a route: the test org's uuid for organization routes, else a nil uuid. */
  function urlFor(endpoint: Endpoint): string {
    const isOrgRoute = endpoint.path.startsWith('/api/organizations/');
    return endpoint.path.replace(/:(\w+)/g, (_match, name: string) => (isOrgRoute && name === 'uuid' ? orgUuid : NIL_UUID));
  }

  const isId = (name: string) =>
    (UUID_PARAMS as readonly string[]).includes(name) || (INTEGER_ID_PARAMS as readonly string[]).includes(name);

  /** {@link urlFor} with every id that names something in the ledger malformed (the org's own uuid stays). */
  function malformedUrlFor(endpoint: Endpoint): string {
    const isOrgRoute = endpoint.path.startsWith('/api/organizations/');
    return endpoint.path.replace(/:(\w+)/g, (_match, name: string) =>
      isOrgRoute && name === 'uuid' ? orgUuid : isId(name) ? 'not-a-uuid' : NIL_UUID);
  }

  async function send(
    role: Role,
    method: string,
    url: string,
    csrf: 'valid' | 'missing' | 'wrong',
    opts: { strayUpload?: boolean } = {}
  ) {
    const verb = (method === 'ALL' ? 'post' : method.toLowerCase()) as 'get';
    const req = request(server)[verb](url);
    if (opts.strayUpload && !SAFE_METHODS.has(method)) {
      // A field no route accepts: an upload parser that runs before the guard answers 500.
      req.attach('route_authorization_probe', Buffer.from('probe'), 'probe.txt');
    }
    const session = sessions.get(role);
    if (session) {
      if (role === 'outsider') {
        // A refused ledger request clears the session's active ledger; select it again.
        await owner.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenant.tenantId, session.id]);
      }
      req.set('Cookie', `${SESSION_COOKIE_NAME}=${session.token}; csrf_token=${CSRF_TOKEN}`);
      if (csrf === 'valid') req.set('X-CSRF-Token', csrfTokenFor(session.token));
      if (csrf === 'wrong') req.set('X-CSRF-Token', `${csrfTokenFor(session.token)}-forged`);
    }
    return req;
  }

  const outcome = (e: Endpoint, role: Role, res: request.Response) =>
    `${describeEndpoint(e)} as ${role}: ${res.status} ${res.body?.code ?? res.body?.error ?? ''}`.trim();

  it('lists the routes in routes.ts, not app.ts', () => {
    expect(createAppRoutes, 'createApp should register middleware only; mount routes in routes.ts').toBe(0);
    expect(endpoints.length).toBeGreaterThan(300);
  });

  it('gives every route exactly one decided level, and every ACCESS entry a route', () => {
    const unclassified = endpoints.filter((e) => !levelOf(e)).map(describeEndpoint);
    expect(unclassified, 'routes with no ACCESS entry: decide who may call them').toEqual([]);

    // Stale entries, and entries every route of which an earlier entry already decides.
    const deciding = new Set(endpoints.map((e) => ACCESS.findIndex(([pattern]) => matches(pattern, e))));
    const idle = ACCESS.filter((_entry, i) => !deciding.has(i)).map(([pattern]) => pattern);
    expect(idle, 'ACCESS entries that decide no route').toEqual([]);
  });

  it('matches the reviewed list of every route and its level', async () => {
    // A router.param callback runs for the route as its middleware does (the org-admin check
    // on /api/organizations/:uuid is one), so the line names it (test/routeTable.ts). Not
    // rejectMalformedIds' on every router: they mark a malformed id for the route to answer
    // after its guards, and refuse nothing themselves.
    const idMarkers = new Set([markMalformedUuid.name, markMalformedIntegerId.name]);
    const paramGuards = (e: Endpoint) => {
      const params = e.chain.filter((name) => name.startsWith('param:') && !idMarkers.has(/\((\w+)\)$/.exec(name)?.[1] ?? ''));
      return params.length > 0 ? `  [${params.join(', ')}]` : '';
    };
    const lines = [...endpoints]
      .sort(byPathThenMethod)
      .map((e) => `${(levelOf(e) ?? '?').padEnd(16)}${e.method.padEnd(7)}${e.path}${paramGuards(e)}`);
    const header = [
      '# Every route mountRoutes registers, and the level ACCESS in route-authorization.test.ts gives it.',
      '# A new route fails that test until this file is regenerated:',
      '#   npx vitest run -u src/__tests__/route-authorization.test.ts',
      '# Check the level a new route gets here before committing.',
    ];
    await expect([...header, ...lines, ''].join('\n')).toMatchFileSnapshot(
      './__snapshots__/route-authorization.routes.txt'
    );
  });

  it('refuses a request without a session on every non-public route (401)', async () => {
    const wrong: string[] = [];
    for (const e of endpoints) {
      if (levelOf(e) === 'public') continue;
      const res = await send('anonymous', e.method, urlFor(e), 'missing', { strayUpload: true });
      if (res.status !== 401) wrong.push(outcome(e, 'anonymous', res));
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('refuses every signed-in role below a route’s level (403)', async () => {
    const wrong: string[] = [];
    for (const e of endpoints) {
      for (const role of ROLES.slice(1, rank(levelOf(e)!))) {
        const res = await send(role, e.method, urlFor(e), 'valid', { strayUpload: true });
        if (res.status !== 403) wrong.push(outcome(e, role, res));
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  // The test-data routes (dev tooling; clear-all deletes the whole ledger) are refused by
  // the shared requireDeploymentAdmin at their mount, before the ledger is resolved or a
  // tenant transaction opened. Each handler checked it with a copy of its own.
  it('refuses the test-data routes to everyone but a deployment admin with the shared guard', async () => {
    const testData = endpoints.filter((e) => e.path.startsWith('/api/admin/test-data/'));
    expect(testData.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const e of testData) {
      for (const role of ROLES.slice(1, rank('deploymentAdmin'))) {
        const res = await send(role, e.method, urlFor(e), 'valid');
        if (res.status !== 403 || res.body?.code !== 'DEPLOYMENT_ADMIN_REQUIRED') wrong.push(outcome(e, role, res));
      }
    }
    expect(wrong).toEqual([]);
  });

  // Express runs param callbacks before a route's own middleware: a malformed id must not
  // be answered before a guard on the route (or in its handler) has refused the caller.
  it('refuses every signed-in role below a route’s level before it looks at the ids in the path (403)', async () => {
    const wrong: string[] = [];
    for (const e of endpoints) {
      const url = malformedUrlFor(e);
      if (url === urlFor(e)) continue;
      for (const role of ROLES.slice(1, rank(levelOf(e)!))) {
        const res = await send(role, e.method, url, 'valid', { strayUpload: true });
        if (res.status !== 403) wrong.push(outcome(e, role, res));
      }
    }
    expect(wrong).toEqual([]);
  }, 300_000);

  it('lets every role at or above a route’s level through (GET routes)', async () => {
    const wrong: string[] = [];
    for (const e of endpoints) {
      if (e.method !== 'GET' || GET_SIDE_EFFECTS.has(describeEndpoint(e))) continue;
      for (const role of ROLES.slice(rank(levelOf(e)!))) {
        const res = await send(role, e.method, urlFor(e), 'valid');
        // Past the guards the handler sees a nil uuid and an empty ledger, so 400/404 are
        // possible; a refusal, a guard's own failure or a server error is not.
        const unavailable = res.status === 503 && MAY_BE_UNAVAILABLE.has(describeEndpoint(e));
        if (res.status === 401 || res.status === 403 || GUARD_FAILURE_CODES.has(res.body?.code) || (res.status >= 500 && !unavailable)) {
          wrong.push(outcome(e, role, res));
        }
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('classifies every path parameter: an id the routers check, or free-form text its handler checks', () => {
    const known = new Set<string>([...UUID_PARAMS, ...INTEGER_ID_PARAMS, ...FREE_FORM_PARAMS]);
    const names = new Set(endpoints.flatMap((e) => [...e.path.matchAll(/:(\w+)/g)].map((m) => m[1])));
    expect(
      [...names].filter((name) => !known.has(name)).sort(),
      'add each to UUID_PARAMS, INTEGER_ID_PARAMS or FREE_FORM_PARAMS in middleware/routeParams.ts'
    ).toEqual([]);
    // And the other way: a listed name no route has is left over from a route that moved.
    expect(
      [...known].filter((name) => !names.has(name)).sort(),
      'no route has these path parameters: remove them from middleware/routeParams.ts'
    ).toEqual([]);
  });

  it('answers a malformed id in the path with 404, never a 500 or no answer at all', async () => {
    const session = sessions.get('deploymentAdmin')!;
    const wrong: string[] = [];
    for (const e of endpoints) {
      const names = [...e.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
      if (e.method === 'ALL' || !names.some(isId)) continue;
      const url = e.path.replace(/:(\w+)/g, (_match, name: string) => (isId(name) ? 'not-a-uuid' : 'probe'));
      const verb = e.method.toLowerCase() as 'get';
      try {
        const req = request(server)[verb](url)
          .set('Cookie', `${SESSION_COOKIE_NAME}=${session.token}; csrf_token=${CSRF_TOKEN}`)
          .set('X-CSRF-Token', csrfTokenFor(session.token))
          .timeout(10_000);
        // A file no route accepts: an upload parser that runs before the handler must
        // still end in the 404, not in its own error (a 500 from the global handler).
        if (!SAFE_METHODS.has(e.method)) req.attach('route_authorization_probe', Buffer.from('probe'), 'probe.txt');
        const res = await req;
        if (res.status !== 404) wrong.push(outcome(e, 'deploymentAdmin', res));
      } catch (err) {
        wrong.push(`${describeEndpoint(e)} as deploymentAdmin: no answer (${(err as Error).message})`);
      }
    }
    expect(wrong).toEqual([]);
  }, 600_000);

  // A file filter's refusal reached the global error handler as a plain Error: a 500.
  it('answers 400, not 500, for an upload a route refuses', async () => {
    const session = sessions.get('member')!;
    const res = await request(server)
      .post(`/api/merchants/${NIL_UUID}/upload-image`)
      .set('Cookie', `${SESSION_COOKIE_NAME}=${session.token}; csrf_token=${CSRF_TOKEN}`)
      .set('X-CSRF-Token', csrfTokenFor(session.token))
      .attach('merchant_image', Buffer.from('not an image'), 'notes.txt');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'UPLOAD_REJECTED', error: expect.stringMatching(/Only image files/) });
  });

  // express.json's parse error reached the handler as a 500.
  it('answers 400 for a malformed JSON body and 413 for one too large', async () => {
    const session = sessions.get('member')!;
    const post = (body: string) => request(server)
      .post('/api/merchants')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${session.token}; csrf_token=${CSRF_TOKEN}`)
      .set('X-CSRF-Token', csrfTokenFor(session.token))
      .set('Content-Type', 'application/json')
      .send(body);
    const malformed = await post('{"name": ');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'Malformed request body', code: 'INVALID_BODY', requestId: malformed.headers['x-request-id'] });
    const large = await post(JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) }));
    expect(large.status).toBe(413);
  });

  it('answers 400 for a path parameter that is not valid percent-encoding', async () => {
    const session = sessions.get('member')!;
    const res = await request(server)
      .get('/api/tags/%E0%A4%A/summary')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${session.token}; csrf_token=${CSRF_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Malformed request path', code: 'INVALID_PATH', requestId: res.headers['x-request-id'] });
    // Authenticated once: the tags router already did at its mount.
    expect([res.headers['set-cookie'] ?? []].flat().filter((c: string) => c.startsWith(`${SESSION_COOKIE_NAME}=`)).length).toBeLessThanOrEqual(1);
    // Routers that authenticate per route answered it without a session.
    for (const [verb, url] of [['get', '/api/tags/%E0%A4%A/summary'], ['delete', '/api/auth/sessions/%E0%A4%A'], ['get', '/api/admin/users/%E0%A4%A/tokens'], ['put', '/api/passkeys/%E0%A4%A']] as const) {
      const anonymous = await request(server)[verb](url);
      expect(anonymous.status, `${verb} ${url}`).toBe(401);
    }
  });

  it('rejects a cookie-authenticated mutation with a missing or wrong CSRF header on every non-public route', async () => {
    const wrong: string[] = [];
    for (const e of endpoints) {
      if (SAFE_METHODS.has(e.method) || levelOf(e) === 'public') continue;
      for (const csrf of ['missing', 'wrong'] as const) {
        const res = await send('member', e.method, urlFor(e), csrf);
        if (res.status !== 403 || res.body?.code !== 'CSRF_TOKEN_INVALID') {
          wrong.push(`${outcome(e, 'member', res)} (CSRF header ${csrf})`);
        }
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('runs every guard middleware before any upload parser', () => {
    // An upload parser ahead of a guard writes a refused caller's file to disk first. The
    // stray-file probes above catch .single/.array ahead of a guard; this also catches
    // parsers that accept any field, and GET routes.
    const wrong = endpoints
      .filter((e) => {
        const upload = e.chain.indexOf('multerMiddleware');
        const lastGuard = e.chain.reduce((last, name, i) => (GUARDS.has(name) ? i : last), -1);
        return upload !== -1 && upload < lastGuard;
      })
      .map((e) => `${describeEndpoint(e)}: ${e.chain.join(' → ')}`);
    expect(wrong).toEqual([]);
    // The check depends on these names; keep it from passing vacuously.
    expect(endpoints.filter((e) => e.chain.includes('multerMiddleware')).length).toBeGreaterThan(0);
    expect(endpoints.filter((e) => e.chain.includes('authenticateSession')).length).toBeGreaterThan(300);
  });

  it('runs authenticateToken before every handler that takes the signed-in user as set', () => {
    // authHandler, tenantHandler and tenantNetworkHandler type req.user as set; they answer
    // 401 if it isn't, but that should never happen: authenticateToken comes first.
    const wrappers = new Set<string>(SIGNED_IN_HANDLERS);
    const wrapped = endpoints.filter((e) => e.chain.some((name) => wrappers.has(name)));
    const wrong = wrapped
      .filter((e) => !e.chain.slice(0, e.chain.findIndex((name) => wrappers.has(name))).includes('authenticateSession'))
      .map((e) => `${describeEndpoint(e)}: ${e.chain.join(' → ')}`);
    expect(wrong).toEqual([]);
    expect(wrapped.length, 'the wrappers carry their names (utils/routeHandler.ts)').toBeGreaterThan(250);
  });

  it('refuses first-run admin setup once the deployment has users', async () => {
    // Public by design, so the checks above don't call it; its own guard is the user count.
    const res = await request(server).post('/api/auth/setup-admin').send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('USERS_EXIST');
    // As a form, which another site could post: refused before anything else.
    const form = await request(server).post('/api/auth/setup-admin').type('form').send('email=a%40b.c');
    expect(form.status).toBe(415);
    expect(form.body.code).toBe('JSON_REQUIRED');
  });

  it('refuses a form on every path Express routes to a sign-in handler, whatever its case or trailing slash', async () => {
    // Express routes ignoring case and a trailing slash; the JSON check compared the path as
    // written, so a form posted to /api/Auth/Login signed the browser in.
    const wrong: string[] = [];
    for (const path of [
      '/api/Auth/Login', '/API/auth/login', '/api/auth/login/', '/API/AUTH/LOGIN/',
      '/api/Auth/Setup-Admin', '/api/auth/setup-admin/',
      '/api/PassKeys/Auth/Options', '/api/passkeys/auth/options/',
      '/api/Passkeys/Auth/Verify', '/API/passkeys/auth/verify/',
    ]) {
      const res = await request(server).post(path).type('form').send(`email=${encodeURIComponent('someone@test.local')}&password=x`);
      const signedIn = [res.headers['set-cookie'] ?? []].flat().some((c: string) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && !c.startsWith(`${SESSION_COOKIE_NAME}=;`));
      if (res.status !== 415 || res.body.code !== 'JSON_REQUIRED' || signedIn) wrong.push(`${path}: ${res.status} ${res.body?.code}`);
    }
    expect(wrong).toEqual([]);
  });

  it('checks CSRF and personal access tokens on a path whatever its case or trailing slash', async () => {
    const session = sessions.get('member')!;
    const cookie = `${SESSION_COOKIE_NAME}=${session.token}; csrf_token=${CSRF_TOKEN}`;
    for (const path of ['/API/Tags', '/api/TAGS/', '/Api/Tags/']) {
      const res = await request(server).post(path).set('Cookie', cookie).send({ name: 'case-variant' });
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe('CSRF_TOKEN_INVALID');
    }
    const asToken = (req: request.Test) => req.set('Authorization', `Bearer ${memberReadToken}`);
    // A listed route, spelled another way, is still the route tokens may read.
    for (const path of ['/API/Accounts', '/api/accounts/', '/Api/Accounts/']) {
      const res = await asToken(request(server).get(path));
      expect(res.status, path).toBe(200);
    }
    // An unlisted route stays closed to tokens, and a listed write to a read-only one.
    for (const path of ['/API/AUTH/SESSIONS', '/api/auth/sessions/', '/Api/Settings']) {
      const res = await asToken(request(server).get(path));
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe('INTERACTIVE_SESSION_REQUIRED');
    }
    for (const path of ['/API/Tags', '/api/tags/']) {
      const res = await asToken(request(server).post(path)).send({ name: 'case-variant' });
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe('TOKEN_READ_ONLY');
    }
    // A read-only POST stays one.
    const dryRun = await asToken(request(server).post(`/API/Merchants/${NIL_UUID}/Test-Rules/`)).send({});
    expect(dryRun.body.code).not.toBe('TOKEN_READ_ONLY');
    expect(dryRun.body.code).not.toBe('INTERACTIVE_SESSION_REQUIRED');
  });

  it('serves uploaded images only to a signed-in user', async () => {
    const image = { method: 'GET', path: '/uploads/user-profiles/none.png' };
    expect((await send('anonymous', image.method, image.path, 'missing')).status).toBe(401);
    expect((await send('outsider', image.method, image.path, 'missing')).status).toBe(404);
    // What the file server doesn't serve (no such file, a dotfile) is the JSON 404, in the
    // error shape, not its HTML page.
    for (const path of ['/uploads/user-profiles/.hidden.png', '/uploads/merchant-images/.env.png', image.path]) {
      const res = await send('outsider', 'GET', path, 'missing');
      expect(res.status, path).toBe(404);
      expect(res.headers['content-type'], path).toMatch(/^application\/json/);
      expect(res.body, path).toMatchObject({ error: 'Not found', code: 'NOT_FOUND', requestId: expect.any(String) });
    }
    // Not to a personal access token, which reaches only the routes TOKEN_ROUTES opens.
    const byToken = await request(server).get(image.path).set('Authorization', `Bearer ${memberReadToken}`);
    expect(byToken.status).toBe(403);
    expect(byToken.body.code).toBe('INTERACTIVE_SESSION_REQUIRED');
  });

  it('gives every TOKEN_ROUTES entry a route, and matches the reviewed list of routes tokens reach', async () => {
    const routes = new Set(endpoints.map(describeEndpoint));
    expect(TOKEN_ROUTES.filter((route) => !routes.has(route)), 'TOKEN_ROUTES entries that name no route').toEqual([]);
    expect(TOKEN_ROUTES.length, 'TOKEN_ROUTES entries listed twice').toBe(new Set(TOKEN_ROUTES).size);

    const lines = endpoints
      .filter(tokenMayReach)
      .sort(byPathThenMethod)
      .map((e) => `${(isMcpEndpoint(e) ? 'mcp' : SAFE_METHODS.has(e.method) ? 'read' : 'write').padEnd(7)}${e.method.padEnd(7)}${e.path}`);
    const header = [
      '# Every route a personal access token (an MCP token) may reach, per TOKEN_ROUTES in',
      '# middleware/tokenAccess.ts; every other route refuses tokens. mcp: the MCP endpoint (any',
      '# token); read: any token; write: read-and-write tokens only. Regenerate with:',
      '#   npx vitest run -u src/__tests__/route-authorization.test.ts',
      '# A new route here is open to tokens: check that an MCP tool calls it.',
    ];
    await expect([...header, ...lines, ''].join('\n')).toMatchFileSnapshot(
      './__snapshots__/route-authorization.token-routes.txt'
    );
  });

  it('refuses a personal access token on every route it may not reach, and a read-only one on every write', async () => {
    const TOKEN_CODES = new Set(['INTERACTIVE_SESSION_REQUIRED', 'TOKEN_READ_ONLY']);
    const wrong: string[] = [];
    for (const e of endpoints) {
      if (levelOf(e) === 'public') continue; // no sign-in, so nothing reads the token
      if (GET_SIDE_EFFECTS.has(describeEndpoint(e))) continue; // /api/push: refused like the rest of its router
      const verb = (e.method === 'ALL' ? 'post' : e.method.toLowerCase()) as 'get';
      const req = request(server)[verb](urlFor(e)).set('Authorization', `Bearer ${memberReadToken}`);
      const res = await (SAFE_METHODS.has(e.method) ? req : req.send({}));
      const code = res.body?.code;
      const expected = !tokenMayReach(e)
        ? 'INTERACTIVE_SESSION_REQUIRED'
        : !isMcpEndpoint(e) && !SAFE_METHODS.has(e.method) && !READ_ONLY_POSTS.includes(`${e.method} ${e.path}`)
          ? 'TOKEN_READ_ONLY'
          : null;
      if (expected) {
        if (res.status !== 403 || code !== expected) wrong.push(`${outcome(e, 'member', res)} (read token; want ${expected})`);
      } else if (res.status === 401 || res.status === 403 || TOKEN_CODES.has(code) || GUARD_FAILURE_CODES.has(code)) {
        // A token may read these routes, and the member may use them.
        wrong.push(`${outcome(e, 'member', res)} (read token; want it let through)`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
