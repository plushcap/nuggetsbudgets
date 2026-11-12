import { Router, Response } from 'express';
import { sankeyReportQuery } from '@nuggets/shared';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { parsedQuery, validateQuery } from '../middleware/validate.js';
import { SankeyReportService } from '../services/reports/SankeyReportService.js';

/**
 * Reports over the ledger's tags (/api/reports), mounted behind authenticateToken,
 * resolveTenant and requireTenantMember. The query is parsed with its shared schema
 * (@nuggets/shared reports.ts); the report is SankeyReportService's.
 */
export function createReportsRoutes(): Router {
  const router = Router();
  const sankey = new SankeyReportService();

  router.get('/sankey/:rootTagUuid', validateQuery(sankeyReportQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const q = parsedQuery(req, sankeyReportQuery);
    res.json(await sankey.getReport({
      rootTagUuid: req.params.rootTagUuid as string,
      startDate: q.start_date,
      endDate: q.end_date,
      budgetPeriodUuid: q.budget_period_uuid,
      direction: q.direction,
      includeUntagged: q.include_untagged,
      includeTransfers: q.include_transfers,
      flowMeasureOverride: q.flow_measure_override,
    }));
  }));

  return router;
}
