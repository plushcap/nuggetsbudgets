import express from 'express';
import logger, { pathOnly } from './utils/logger.js';
import { CSRFProtection } from './middleware/security-enhanced.js';
import {
  basicHealthCheck,
  detailedHealthCheck,
  securityHealthCheck,
  databaseHealthCheck,
  setBackupHealthSource,
  readinessCheck,
} from './middleware/health-checks.js';
import { authenticateToken, requireInteractiveSession } from './middleware/auth.js';
import { resolveTenant, requireTenantMember, requireTenantAdmin, requireDeploymentAdmin } from './middleware/tenant.js';
import { answerMalformedId, hasMalformedId, rejectMalformedIds as ids } from './middleware/routeParams.js';
import { answerError, sendError } from './utils/apiError.js';
import { authHandler } from './utils/routeHandler.js';
import { createTransactionsRoutes } from './routes/transactions.js';
import { createAnnotationsRoutes } from './routes/annotations.js';
import { createTransferRoutes } from './routes/transfer.js';
import { createBudgetRoutes } from './routes/budgets.js';
import { createBudgetItemHistoryRoutes } from './routes/budgetItemHistory.js';
import { createBillRoutes } from './routes/bills.js';
import { createCategoriesRoutes } from './routes/categories.js';
import { createTagsRoutes } from './routes/tags.js';
import { createReportsRoutes } from './routes/reports.js';
import { createInstitutionsRoutes } from './routes/institutions.js';
import { createMerchantsRoutes } from './routes/merchants.js';
import { createMerchantSpendingRoutes } from './routes/merchantSpending.js';
import { createAccountsRoutes } from './routes/accounts.js';
import { createImagesRoutes } from './routes/images.js';
import { createImportRoutes } from './routes/import.js';
import { createBudgetPeriodRoutes } from './routes/budget-periods.js';
import { createInvestmentsRoutes } from './routes/investments.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createTenantRoutes } from './routes/tenants.js';
import { createOrganizationRoutes } from './routes/organizations.js';
import { createInvitationRoutes } from './routes/invitations.js';
import { createAuthPublicRoutes, createAuthRoutes } from './routes/auth.js';
import { createPasskeyRoutes, createPasskeySignInRoutes } from './routes/passkeys.js';
import { createAdminRoutes } from './routes/admin.js';
import { createNetWorthRoutes } from './routes/net-worth.js';
import { createTestDataRoutes } from './routes/test-data.js';
import { createAttachmentRoutes } from './routes/attachments.js';
import { createBackupRoutes } from './routes/backup.js';
import { createAdminDatabaseRoutes } from './routes/adminDatabase.js';
import { createDeploymentSettingsRoutes } from './routes/deploymentSettings.js';
import { createGoalRoutes } from './routes/goals.js';
import { createOneDriveCallbackRoutes, createOneDriveRoutes } from './routes/onedrive.js';
import { createNotificationAdminRoutes, createNotificationRoutes } from './routes/notifications.js';
import { createPushRoutes } from './routes/push.js';
import { createNotificationLinkRoutes } from './routes/notificationLinks.js';
import { createExportRoutes } from './routes/export.js';
import { createDataManagementRoutes } from './routes/data-management.js';
import { createMcpHttpHandler } from 'nuggets-mcp';
import { routeDependencies, type MountDependencies } from './routes/dependencies.js';

export type { MountDependencies, RouteDependencies } from './routes/dependencies.js';

/**
 * Register public endpoints, all `/api/*` resource routers, the MCP handler,
 * and the error handler onto the given app. Must be called after the
 * middleware stack (createApp) and after the services are constructed.
 *
 * Every router is built by its module's `createXRoutes(deps)` and mounted here with its
 * guards (authenticateToken, then the ledger's resolveTenant / requireTenantMember, then
 * an admin check), so a router's own routes add only what is particular to one of them.
 * Public routes (signing in, first-run setup, OneDrive's OAuth callback, the notification
 * links) have routers of their own, mounted before the guarded ones beside them.
 */
export function mountRoutes(app: express.Application, given: MountDependencies): void {
  const deps = routeDependencies(given);
  const { lifecycleService, config } = deps;
  // GET /api/health/detailed reports whether backups are being made.
  setBackupHealthSource(() => lifecycleService.getBackupHealth());

  // While shutting down, each answer closes its connection, so keep-alive clients
  // reconnect (to the next server) instead of holding this one open.
  app.use((_req, res, next) => {
    if (lifecycleService.isShutdownInProgress() === true) res.setHeader('Connection', 'close');
    next();
  });

  // CSRF token generation endpoint (public)
  app.get('/api/csrf-token', CSRFProtection.generateEndpoint());

  // =============== MCP-RELATED WELL-KNOWN ENDPOINTS ===============
  // MCP clients (e.g. mcp-remote) probe these OAuth metadata URLs at the
  // resource server's base URL during connection setup. We don't support
  // OAuth (static bearer tokens via /api/auth/mcp-token instead), so we
  // return 404 JSON. Without this, Caddy's SPA fallback would return the
  // React index.html with status 200, and the client's `res.json()` would
  // crash on `<!DOCTYPE`.
  //
  // NOTE: this also requires the reverse proxy (Caddy) to route
  // /.well-known/* to the backend instead of the SPA.
  const noOauthHandler = (_req: express.Request, res: express.Response) => {
    res.status(404).json({
      error: 'oauth_not_supported',
      message: 'This MCP server uses static bearer tokens. Mint one in the website at Settings → MCP Access.',
    });
  };
  app.get('/.well-known/oauth-authorization-server', noOauthHandler);
  app.get('/.well-known/oauth-protected-resource', noOauthHandler);
  // Some clients also probe these path-suffixed variants. Cover them.
  app.get('/.well-known/oauth-authorization-server/api/mcp', noOauthHandler);
  app.get('/.well-known/oauth-protected-resource/api/mcp', noOauthHandler);

  // =============== ENHANCED HEALTH CHECK ENDPOINTS ===============
  // Public probes — minimal, non-sensitive, unauthenticated. Liveness (`/api/health`):
  // the process answers. Readiness (`/api/ready`): it can serve — services started, not
  // shutting down, database answering, migrations applied. The container healthchecks
  // use readiness, and so should an uptime check.
  app.get('/health', basicHealthCheck);
  app.get('/api/health', basicHealthCheck);
  app.get('/api/ready', readinessCheck(lifecycleService));

  // The detailed / security / database variants expose internals (recent
  // security events with user IDs + client IPs, environment/version, user and
  // account counts), so they require a deployment admin.
  app.get('/api/health/detailed', authenticateToken, requireDeploymentAdmin, detailedHealthCheck);
  app.get('/api/health/security', authenticateToken, requireDeploymentAdmin, securityHealthCheck);

  // Application status: the deployment's schedulers (backups, import, retention), their
  // next and last runs. Deployment-wide, so a deployment admin's: a member of one ledger
  // would otherwise learn when other households' syncs and backups ran. No page calls it.
  app.get('/api/status', authenticateToken, requireDeploymentAdmin, authHandler(async (_req, res) => {
    res.json(await lifecycleService.getApplicationStatus());
  }));

  // Database-specific health check (exposes table/user/account counts) — admin only.
  app.get('/api/health/database', authenticateToken, requireDeploymentAdmin, databaseHealthCheck);

  // =============== MODULAR ROUTES ===============
  // Mount modular routes with authentication
  app.use('/api/transactions', authenticateToken, resolveTenant, requireTenantMember, ids(createTransactionsRoutes()));
  app.use('/api/annotations', authenticateToken, resolveTenant, requireTenantMember, ids(createAnnotationsRoutes()));
  app.use('/api/transfer', authenticateToken, resolveTenant, requireTenantMember, ids(createTransferRoutes()));
  app.use('/api/budgets', authenticateToken, resolveTenant, requireTenantMember, ids(createBudgetRoutes()));
  app.use('/api/bills', authenticateToken, resolveTenant, requireTenantMember, ids(createBillRoutes()));
  app.use('/api/budget-periods', authenticateToken, resolveTenant, requireTenantMember, ids(createBudgetPeriodRoutes()));
  app.use('/api/categories', authenticateToken, resolveTenant, requireTenantMember, ids(createCategoriesRoutes()));
  app.use('/api/tags', authenticateToken, resolveTenant, requireTenantMember, ids(createTagsRoutes()));
  app.use('/api/reports', authenticateToken, resolveTenant, requireTenantMember, ids(createReportsRoutes()));
  app.use('/api/institutions', authenticateToken, resolveTenant, requireTenantMember, ids(createInstitutionsRoutes()));
  app.use('/api/merchants', authenticateToken, resolveTenant, requireTenantMember, ids(createMerchantsRoutes()));
  // Detail-page summaries, one request each: their own prefixes and modules.
  app.use('/api/budget-items', authenticateToken, resolveTenant, requireTenantMember, ids(createBudgetItemHistoryRoutes()));
  app.use('/api/merchant-spending', authenticateToken, resolveTenant, requireTenantMember, ids(createMerchantSpendingRoutes()));
  app.use('/api/accounts', authenticateToken, resolveTenant, requireTenantMember, ids(createAccountsRoutes()));
  app.use('/api/images', authenticateToken, resolveTenant, requireTenantMember, ids(createImagesRoutes()));
  app.use('/api/investments', authenticateToken, resolveTenant, requireTenantMember, ids(createInvestmentsRoutes()));
  app.use('/api/import', authenticateToken, resolveTenant, requireTenantMember, ids(createImportRoutes(deps)));
  // A ledger's own settings: resolved and checked like every ledger route.
  app.use('/api/settings', authenticateToken, resolveTenant, requireTenantMember, ids(createSettingsRoutes()));

  // Multi-tenant management. Control-plane tables are
  // global, so these routers use globalDb via authHandler (not tenantHandler).
  // /api/tenants manages the ACTIVE budget (requireTenantMember sets req.tenant);
  // /api/organizations is addressed by org uuid and authorizes in its uuid param handler.
  app.use('/api/tenants', authenticateToken, resolveTenant, requireTenantMember, ids(createTenantRoutes()));
  app.use('/api/organizations', authenticateToken, resolveTenant, ids(createOrganizationRoutes()));
  // Accepting an invitation to an organization: any signed-in user, with or without a ledger.
  app.use('/api/invitations', authenticateToken, ids(createInvitationRoutes()));

  // A person's own account. Signing in and first-run setup are public, so they have a
  // router of their own, mounted first; everything else is behind authenticateToken.
  app.use('/api/auth', createAuthPublicRoutes());
  app.use('/api/auth', authenticateToken, createAuthRoutes());
  // Passkeys, likewise: signing in with one is public; a person's own are behind authenticateToken.
  app.use('/api/passkeys', createPasskeySignInRoutes());
  app.use('/api/passkeys', authenticateToken, createPasskeyRoutes());
  app.use('/api/net-worth', authenticateToken, resolveTenant, requireTenantMember, ids(createNetWorthRoutes()));
  // Development tooling: its clear-all deletes the whole active ledger, so a production
  // server mounts it only when ENABLE_TEST_DATA=true, and only a deployment admin may use
  // it, checked before anything else.
  if (config.NODE_ENV !== 'production' || config.ENABLE_TEST_DATA) {
    app.use('/api/admin/test-data', authenticateToken, requireDeploymentAdmin, resolveTenant, requireTenantMember, ids(createTestDataRoutes()));
  }
  app.use('/api/attachments', authenticateToken, resolveTenant, requireTenantMember, ids(createAttachmentRoutes()));
  // Backup routes are admin-only: restore/download/delete are destructive or
  // exfiltrate the whole database, beyond the shared-read model.
  app.use('/api/backup', authenticateToken, requireDeploymentAdmin, ids(createBackupRoutes(deps)));
  // Settings → Utilities: the database's schema and applied migrations, to attach to
  // a report when a migration fails. Deployment admins in a signed-in browser only, never a
  // personal access token.
  app.use('/api/admin/database', authenticateToken, requireDeploymentAdmin, requireInteractiveSession, createAdminDatabaseRoutes());
  // The deployment's own settings: its time zone, for ledgers without their own and
  // for deployment jobs such as the backup schedule. Deployment admins only.
  app.use('/api/admin/deployment-settings', authenticateToken, requireDeploymentAdmin, createDeploymentSettingsRoutes(deps));
  // The deployment's email notifications: SMTP, the scheduler, the queue, the test email
  // and preview. No ledger: they read the deployment's settings and the schedulers. A
  // ledger's rules and history stay at /api/notifications.
  app.use('/api/admin/notifications', authenticateToken, requireDeploymentAdmin, createNotificationAdminRoutes(deps));
  // The rest of the deployment admin's console: every user and every organization. After
  // the /api/admin/… routers above, which have guards of their own, so those requests
  // don't meet these too.
  app.use('/api/admin', authenticateToken, requireDeploymentAdmin, createAdminRoutes());
  app.use('/api/goals', authenticateToken, resolveTenant, requireTenantMember, ids(createGoalRoutes()));
  // OneDrive, where backups go, is a deployment admin's to set up. Microsoft sends
  // the admin's browser to the OAuth callback, which is public, so it is mounted first.
  app.use('/api/onedrive', createOneDriveCallbackRoutes(deps));
  app.use('/api/onedrive', authenticateToken, requireDeploymentAdmin, createOneDriveRoutes(deps));
  // A ledger's notification rules, each person's choices, and its history.
  app.use('/api/notifications', authenticateToken, resolveTenant, requireTenantMember, ids(createNotificationRoutes(deps)));
  app.use('/api/push', authenticateToken, ids(createPushRoutes(deps))); // a person's own devices; not tenant-scoped
  app.use('/api/notification-links', createNotificationLinkRoutes(deps)); // email unsubscribe links: the signed token is the credential
  app.use('/api/export', authenticateToken, resolveTenant, requireTenantMember, ids(createExportRoutes()));
  // Bulk data deletion is admin-only (destructive mass delete).
  app.use('/api/data-management', authenticateToken, resolveTenant, requireTenantMember, requireTenantAdmin, ids(createDataManagementRoutes(deps)));

  // MCP server — exposes Nuggets tools over MCP Streamable HTTP at POST /api/mcp.
  // Mounted under /api so it travels through the same reverse-proxy rule as the
  // rest of the API. Gated by the same auth middleware; Bearer JWT is expected.
  // MCP-layer failures (a request the transport couldn't handle, a tool call that failed
  // other than by the API's answer) are logged here with the request's id.
  const mcpBaseUrl = config.MCP_API_BASE_URL || `http://127.0.0.1:${config.PORT}`;
  app.use('/api/mcp', authenticateToken, createMcpHttpHandler({ baseUrl: mcpBaseUrl, logger: logger.child({ service: 'MCP' }) }));

  logger.info('API routes mounted successfully');

  // An /api path no route answers: a JSON 404 in the error shape, not Express's HTML
  // "Cannot GET" page.
  app.use('/api', (_req: express.Request, res: express.Response) => {
    sendError(res, 404, 'NOT_FOUND', 'No such API route');
  });

  // Error handling middleware (must be registered last). Every answer here is in the one
  // error shape, `{ error, code, requestId }` (utils/apiError.ts).
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // A path that names nothing is a 404 whatever failed after the guards (e.g. an
    // upload parser that runs before the handler that would answer it).
    if (hasMalformedId(res)) {
      answerMalformedId(res);
      return;
    }
    // A path parameter that isn't valid percent-encoding ('/api/tags/%E0%A4%A'): Express
    // marks its URIError 400, without `expose`. It's thrown while matching the route, so
    // before a router's own authenticateToken: the session is checked here first, and a
    // caller without one gets the 401 any protected route gives. A router that
    // authenticates at its mount already did.
    const { status } = err as { status?: unknown };
    if (err instanceof URIError && status === 400) {
      if ((req as { user?: unknown }).user) {
        sendError(res, 400, 'INVALID_PATH', 'Malformed request path');
        return;
      }
      Promise.resolve(
        authenticateToken(req as Parameters<typeof authenticateToken>[0], res, () => {
          sendError(res, 400, 'INVALID_PATH', 'Malformed request path');
        })
      ).catch((authError: unknown) => {
        answerError(authError, res, { method: req.method, path: pathOnly(req.path), during: 'session check for a malformed path' });
      });
      return;
    }
    // A refusal (a DomainError), a refused upload (400, or 413 when too large) or body (400/413),
    // or anything else: logged with its stack and answered 500 INTERNAL_ERROR "Internal
    // server error", never the error's text (not in development either: the log has it,
    // under the answer's requestId).
    answerError(err, res, { method: req.method, path: pathOnly(req.path) });
  });
}
