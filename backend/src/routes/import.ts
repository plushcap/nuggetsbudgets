import { Router, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { tenantHandler, tenantNetworkHandler } from '../utils/routeHandler.js';
import type { AuthenticatedRequest } from '../utils/routeHandler.js';
import { requireOrgAdmin } from '../middleware/tenant.js';
import { parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import {
  IMPORT_SETTING_KEYS,
  importSettingsUpdateSchema,
  importSyncLogQuery,
  simpleFinAccountTransactionsQuery,
  type ImportSettingsUpdate,
} from '@nuggets/shared';
import { readTenantSettings, writeTenantSettings } from '../services/tenantSettings.js';
import { nextRunForTenant, readTenantImportSchedule } from '../services/SyncScheduler.js';
import { fixMissingBudgetPeriodItemIds } from '../services/maintenance/budgetPeriodItemRepair.js';
import {
  assertLinkedAccount,
  assertMayBeImportUser,
  describeSimpleFinAccounts,
  importUserCandidates,
  readSyncLog,
  simpleFinAccountNotFound,
} from '../services/import/tenantImport.js';
import { getMappingsByBankAccountForTenant } from '../services/OrganizationSimpleFinService.js';
import { getCurrentTenantId } from '../context/requestContext.js';
import type { RouteDependencies } from './dependencies.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ service: 'ImportRoute' });

/**
 * What GET /api/import/settings says about each of a ledger's import settings
 * (tenant_settings). Its descriptions say "tenant", as the backend's text does; the
 * settings page shows them in Ledger wording (getImportSettings, frontend).
 */
const IMPORT_SETTING_INFO: Record<(typeof IMPORT_SETTING_KEYS)[number], { type: string; description: string }> = {
  import_enabled: { type: 'boolean', description: "Import this tenant's bank transactions automatically on the schedule below" },
  import_manual_sync_enabled: { type: 'boolean', description: 'Show the manual sync controls on this page' },
  import_sync_frequency: { type: 'string', description: 'How often the automatic import runs (daily or weekly)' },
  import_sync_time: { type: 'string', description: "Time of day the automatic import runs, in this tenant's time zone (HH:MM)" },
  import_days_back: { type: 'integer', description: 'How many days of history each import asks the bank for (1-180; empty for all it has)' },
  import_user_id: { type: 'integer', description: 'The person recorded as having made what the automatic import writes' },
};

/**
 * The ledger's import settings and schedule, as the status route reports them: every
 * import key it has, and when its next automatic import is due.
 */
async function tenantImportStatus(): Promise<{ settings: Record<string, string | null>; nextSyncTime: Date | null; enabled: boolean }> {
  const settings: Record<string, string | null> = await readTenantSettings([...IMPORT_SETTING_KEYS, 'import_last_auto_sync']);
  const schedule = await readTenantImportSchedule();
  return { settings, nextSyncTime: nextRunForTenant(schedule), enabled: schedule.enabled };
}

// Rate limiter for import sync operations to prevent database overload
const importSyncLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour window
  max: 10, // Max 10 import syncs per hour per user
  keyGenerator: (req) => {
    // Rate limit per user; fall back to IP. Use ipKeyGenerator so IPv6
    // addresses are subnet-collapsed (required by express-rate-limit v8+).
    if (req.user?.userId) {
      return req.user.userId.toString();
    }
    return ipKeyGenerator(req.ip || '');
  },
  handler: (req, res) => {
    logger.warn(
      { userId: req.user?.userId, ip: req.ip },
      'Import sync rate limit exceeded'
    );
    res.status(429).json({
      error: 'Too many import requests. Please wait before trying again.',
      retryAfter: '1 hour'
    });
  },
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false
});


/**
 * Bank sync for the active ledger (/api/import): its status, a manual sync, its log, its
 * schedule and import user, and the organization's SimpleFin accounts. The schedulers
 * themselves are the lifecycle service's.
 */
export function createImportRoutes({
  lifecycleService,
  importService,
}: Pick<RouteDependencies, 'lifecycleService' | 'importService'>): Router {
  const router = Router();

  // SIMPLEFIN INTEGRATION ROUTES

  // GET /api/import/status - Get import system status
  // Routes that wait on SimpleFin run with no transaction open (tenantNetworkHandler).
  router.get('/status', tenantNetworkHandler(async (_req: AuthenticatedRequest, res: Response) => {
    let hasAccessUrl: boolean;
    let isConnected: boolean;
    
    try {
      // Test connection - this will internally check for access URL via Docker secrets or env vars
      logger.debug('Testing connection to SimpleFin');
      isConnected = await importService.testConnection();
      hasAccessUrl = true; // If testConnection didn't throw, we have access URL
      logger.info({ hasAccessUrl, isConnected }, 'SimpleFin connection test completed');
    } catch (error) {
      logger.warn({ err: error }, 'No access URL configured or connection failed');
      hasAccessUrl = false;
      isConnected = false;
    }
    
    // The ledger's own import settings and schedule, read in a short transaction:
    // this route runs with none open while SimpleFin answers.
    const { settings, nextSyncTime, enabled } = await tenantImportStatus();
    const isSchedulerRunning = await lifecycleService.isSchedulerRunning();

    res.json({
      configured: hasAccessUrl,
      connected: isConnected,
      provider: 'simplefin',
      settings,
      scheduler: {
        // `enabled` is this ledger's setting; `running` is whether the deployment's
        // scheduler is running. When they differ persistently the UI says so rather
        // than hide it: a ledger that is enabled with no scheduler never imports.
        enabled,
        running: isSchedulerRunning,
        nextSyncTime: isSchedulerRunning ? nextSyncTime?.toISOString() ?? null : null,
        lastAutomaticSync: settings.import_last_auto_sync || null
      }
    });
  }));

  // GET /api/import/accounts - List import service accounts
  //
  // This and the other discovery routes below (test-sync, simplefin-accounts,
  // simplefin-account-transactions) are for org admins: the SimpleFin connection is the
  // organization's, so its answer covers the bank accounts of every ledger in it.
  router.get('/accounts', requireOrgAdmin, tenantNetworkHandler(async (_req: AuthenticatedRequest, res: Response, tenantId) => {
    // No connection: a 404 (NoSimpleFinConnectionError), answered by the route wrapper.
    const accountSet = await importService.fetchAccounts({ balancesOnly: true });

    // Annotate each bank account with the ledger accounts across the org already
    // mapped to it, so the mapping UI can gray out duplicates (the connect-bank
    // route enforces the same guard server-side).
    const mappings = await getMappingsByBankAccountForTenant(tenantId);
    const accounts = accountSet.accounts.map((account) => ({
      ...account,
      mappings: mappings[account.id] ?? [],
    }));

    res.json({
      success: true,
      accounts,
      errors: accountSet.errlist ?? [],
      connections: accountSet.connections ?? [],
    });
  }));

  // POST /api/import/sync - Manual sync all accounts
  //
  // Syncs of one ledger don't overlap: while one runs (a member's, or the
  // scheduler's), this and POST /sync/:accountUuid answer 409 SYNC_IN_PROGRESS at once
  // instead of waiting for it, and write nothing.
  router.post('/sync', importSyncLimiter, tenantNetworkHandler(async (req: AuthenticatedRequest, res: Response, tenantId) => {
    // No connection: a 404, answered by the route wrapper.
    const outcome = await importService.runFullSync(tenantId, {
      syncType: 'manual',
      syncTrigger: 'user',
      userId: req.user.userId
    });

    // Say how it went, as the sync log does: 'partial' when accounts or transactions
    // couldn't be saved, with what needs a look. A sync in which every account failed
    // answers 200 too (success false).
    const { status, message } = outcome;
    res.json({
      success: status !== 'failed',
      status,
      message:
        status === 'failed' ? `Sync failed: ${message}`
        : status === 'partial' ? `Sync completed with problems: ${message}`
        : message ? `Sync completed: ${message}`
        : 'Sync completed successfully'
    });
  }));

  // POST /api/import/sync/:accountUuid - Manual sync specific account
  router.post('/sync/:accountUuid', importSyncLimiter, tenantNetworkHandler(async (req: AuthenticatedRequest, res: Response, tenantId) => {
    const { accountUuid } = req.params as { accountUuid: string };

    // Another ledger's account, or one not linked to the bank, is not found.
    await assertLinkedAccount(tenantId, accountUuid);

    // Another sync of the ledger is running: a 409, answered by the route wrapper.
    const syncResult = await importService.runSingleAccountSync(tenantId, accountUuid, {
      syncType: 'manual',
      syncTrigger: 'user',
      userId: req.user.userId
    });

    // A failed sync answers 200, with success false, as a full sync does.
    res.json({
      success: syncResult.success,
      status: syncResult.success ? syncResult.status : 'failed',
      message: !syncResult.success ? syncResult.message
        : syncResult.notice ? `Account sync completed: ${syncResult.notice}`
        : 'Account sync completed successfully',
      error: syncResult.error,
      result: syncResult
    });
  }));

  // GET /api/import/sync-log - Get sync log history
  router.get('/sync-log', validateQuery(importSyncLogQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { limit, offset } = parsedQuery(req, importSyncLogQuery);
    const { syncLogs, total } = await readSyncLog({ limit, offset });
    res.json({ success: true, syncLogs, pagination: { limit, offset, total } });
  }));

  // IMPORT SETTINGS ROUTES

  // GET /api/import/settings - the ledger's import settings (tenant_settings).
  router.get('/settings', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const stored: Record<string, string | null> = await readTenantSettings(IMPORT_SETTING_KEYS);
    const settings = Object.fromEntries(
      IMPORT_SETTING_KEYS.map((key) => [key, { value: stored[key] ?? null, ...IMPORT_SETTING_INFO[key] }])
    );
    res.json({ settings });
  }));

  // POST /api/import/settings - change the ledger's import settings. Bank import is the
  // organization's (its SimpleFin connection), so its admins (and deployment
  // admins) set it; each ledger has its own. Only the keys in
  // importSettingsUpdateSchema are accepted.
  router.post('/settings', requireOrgAdmin, validateBody(importSettingsUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { settings } = req.body as { settings: ImportSettingsUpdate };

    // The import stamps this person as who made what it writes, so they must have access
    // to this ledger (a member, or an admin of its organization), not just an account.
    if (settings.import_user_id) await assertMayBeImportUser(Number(settings.import_user_id), getCurrentTenantId()!);

    await writeTenantSettings(settings, req.user.userId);

    // The scheduler reads each ledger's schedule on every tick, so nothing restarts.
    res.json({ success: true, message: 'Settings updated successfully' });
  }));

  // SCHEDULER ROUTES

  // POST /api/import/scheduler/start - turn this ledger's automatic import on (its
  // organization's admins), and start the deployment's scheduler if it isn't running.
  //
  // Persists `import_enabled` itself. The toggle used to start the scheduler at once but
  // only stage the setting until a separate Save, so the setting could stay 'false' while
  // the UI showed it on, and every scheduled run did nothing.
  router.post('/scheduler/start', requireOrgAdmin, tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    await writeTenantSettings({ import_enabled: 'true' }, req.user.userId);
    if (!(await lifecycleService.isSchedulerRunning())) {
      await lifecycleService.startImportScheduler();
    }

    const running = await lifecycleService.isSchedulerRunning();
    const { nextSyncTime } = await tenantImportStatus();
    logger.info({ running }, "Tenant's automatic import turned on via API");

    res.json({
      success: true,
      running,
      nextSyncTime: running ? nextSyncTime?.toISOString() ?? null : null,
      message: 'Automatic import turned on'
    });
  }));

  // POST /api/import/scheduler/stop - turn this ledger's automatic import off (its
  // organization's admins). The scheduler keeps running for the other ledgers.
  router.post('/scheduler/stop', requireOrgAdmin, tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    await writeTenantSettings({ import_enabled: 'false' }, req.user.userId);
    logger.info("Tenant's automatic import turned off via API");

    res.json({
      success: true,
      running: await lifecycleService.isSchedulerRunning(),
      message: 'Automatic import turned off'
    });
  }));

  // UTILITY ROUTES

  // GET /api/import/users - the people who may be this ledger's import user: those with
  // access to it (its members and its organization's admins), unlocked.
  // For its organization's admins, who set it.
  router.get('/users', requireOrgAdmin, tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json({ success: true, users: await importUserCandidates(getCurrentTenantId()!) });
  }));

  // A SimpleFin connection is made per organization, through
  // `POST /api/organizations/:uuid/simplefin/connection`, which stores the access URL
  // encrypted (OrganizationSimpleFinService); nothing here takes one.

  // POST /api/import/test-sync - Test sync without saving data
  router.post('/test-sync', requireOrgAdmin, tenantNetworkHandler(async (_req: AuthenticatedRequest, res: Response) => {
    // No connection: a 404, answered by the route wrapper.
    const accountSet = await importService.fetchAccounts({ balancesOnly: false });
    
    res.json({
      success: true,
      message: 'Test sync completed successfully',
      preview: {
        accountCount: accountSet.accounts.length,
        accounts: accountSet.accounts.map(acc => ({
          id: acc.id,
          name: acc.name,
          balance: acc.balance,
          currency: acc.currency,
          transactionCount: acc.transactions?.length || 0
        })),
        errors: accountSet.errlist ?? []
      }
    });
  }));

  // POST /api/import/fix-budget-period-items - Fix missing budget_period_item_id relationships
  router.post('/fix-budget-period-items', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const result = await fixMissingBudgetPeriodItemIds();
    
    res.json({
      success: true,
      message: `Fixed ${result.updated} transactions with missing budget period item relationships`,
      updated: result.updated,
      errors: result.errors
    });
  }));

  // GET /api/import/simplefin-accounts - Get all SimpleFin accounts with mapping and status info.
  // No connection: a 404 (NoSimpleFinConnectionError); SimpleFin's own failure its 502-504.
  router.get('/simplefin-accounts', requireOrgAdmin, tenantNetworkHandler(async (_req: AuthenticatedRequest, res: Response, tenantId) => {
    // Fetch accounts from SimpleFin (with transactions for last transaction date)
    const sfData = await importService.fetchAccounts({ balancesOnly: false });
    res.json({
      success: true,
      accounts: await describeSimpleFinAccounts(tenantId, sfData),
      errors: sfData.errlist ?? [],
      connections: sfData.connections ?? [],
    });
  }));

  // GET /api/import/simplefin-account-transactions - Live, READ-ONLY drill-down for
  // research. Pulls the last N days (default 60) of raw SimpleFin data for ONE
  // account and returns the transactions as-received (all available fields).
  // Nothing is persisted — this never touches the DB.
  router.get(
    '/simplefin-account-transactions',
    requireOrgAdmin,
    validateQuery(simpleFinAccountTransactionsQuery),
    tenantNetworkHandler(async (req: AuthenticatedRequest, res: Response) => {
      const { account_id: accountId, days } = parsedQuery(req, simpleFinAccountTransactionsQuery);
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

      const sfData = await importService.fetchAccounts({
        balancesOnly: false,
        includePending: true,
        accountId,
        startDate,
        endDate,
      });

      const account = sfData.accounts.find(a => a.id === accountId);
      if (!account) throw simpleFinAccountNotFound(accountId);

      logger.info({ accountId, days, txnCount: account.transactions?.length ?? 0 }, 'SimpleFin account detail fetched (research, not stored)');

      // v2: institution name from connections[] joined via account.conn_id.
      const detailConn = (sfData.connections ?? []).find((c) => c.conn_id === account.conn_id) as
        | { org_name?: string; name?: string }
        | undefined;

      // Return transactions exactly as SimpleFin sent them (all fields, incl. extra).
      res.json({
        success: true,
        account: {
          id: account.id,
          name: account.name,
          org: detailConn?.org_name ?? detailConn?.name ?? null,
          currency: (account as unknown as Record<string, unknown>).currency ?? null,
          balance: account.balance,
          available_balance: (account as unknown as Record<string, unknown>)['available-balance'] ?? null,
          balance_date: account['balance-date'] ? new Date(account['balance-date'] * 1000).toISOString() : null,
        },
        days,
        transactions: account.transactions ?? [],
        errors: sfData.errlist ?? [],
      });
    })
  );

  return router;
}