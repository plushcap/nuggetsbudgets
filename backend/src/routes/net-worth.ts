// Net worth tracking routes
import { Router } from 'express';
import { netWorthHistoryQuery } from '@nuggets/shared';
import { tenantHandler, type AuthenticatedRequest } from '../utils/routeHandler.js';
import { parsedQuery, validateQuery } from '../middleware/validate.js';
import { requireDeploymentAdmin } from '../middleware/tenant.js';
import { createLogger } from '../utils/logger.js';
import NetWorthService from '../services/NetWorthService.js';

const logger = createLogger({ service: 'NetWorthRoute' });

/**
 * The active ledger's net worth (/api/net-worth): today's, and its history. Mounted
 * behind authenticateToken, resolveTenant and requireTenantMember; clearing and rebuilding
 * the history is a deployment admin's (requireDeploymentAdmin on those two routes). The
 * handlers call NetWorthService; its refusals are answered by the route wrapper.
 */
export function createNetWorthRoutes(): Router {
  const router = Router();
  const netWorth = new NetWorthService();

  // Today's net worth, computed now from the one definition: what the Accounts
  // page and the dashboard show. A GET writes nothing.
  router.get('/current', tenantHandler(async (_req: AuthenticatedRequest, res) => {
    res.json({ current_net_worth: await netWorth.getCurrentNetWorth() });
  }));

  // The history for charting: `limit` periods of `period`, gaps filled unless fill_gaps=false.
  router.get('/history', validateQuery(netWorthHistoryQuery), tenantHandler(async (req: AuthenticatedRequest, res) => {
    const { period, fill_gaps, limit } = parsedQuery(req, netWorthHistoryQuery);
    const history = await netWorth.getNetWorthHistory(period, limit, fill_gaps);
    res.json({
      history,
      meta: { period, limit, fill_gaps, count: history.length },
    });
  }));

  // Clear every net worth snapshot (daily, weekly, monthly).
  router.delete('/clear', requireDeploymentAdmin, tenantHandler(async (req: AuthenticatedRequest, res) => {
    logger.info({ adminId: req.user.userId }, 'Admin clearing all net worth snapshots');
    const deletedCount = await netWorth.clearSnapshots();
    logger.info({ adminId: req.user.userId, deletedCount }, 'Successfully deleted net worth snapshots');
    res.json({
      message: `Successfully deleted ${deletedCount} net worth snapshots (all aggregation levels)`,
      deleted_count: deletedCount,
    });
  }));

  // Rebuild the daily history from the earliest transaction, then its aggregates.
  router.post('/rebuild', requireDeploymentAdmin, tenantHandler(async (req: AuthenticatedRequest, res) => {
    logger.info({ adminId: req.user.userId }, 'Admin rebuilding net worth history');
    const rebuilt = await netWorth.rebuildHistory();
    const range = { earliest_date: rebuilt.startDate, latest_date: rebuilt.endDate, total_days: rebuilt.totalDays };
    res.json(
      rebuilt.aggregates
        ? {
            message: 'Successfully rebuilt net worth history from earliest transaction',
            snapshots_created: rebuilt.snapshotsCreated,
            weekly_aggregates: rebuilt.aggregates.weekly,
            monthly_aggregates: rebuilt.aggregates.monthly,
            ...range,
          }
        : {
            message: 'Snapshots created but aggregation partially failed',
            snapshots_created: rebuilt.snapshotsCreated,
            ...range,
            warning: 'Aggregation may need to be run manually',
          }
    );
  }));

  return router;
}
