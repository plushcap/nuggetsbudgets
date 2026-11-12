import { Router, Response } from 'express';
import { budgetItemHistoryQuery } from '@nuggets/shared';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { parsedQuery, validateQuery } from '../middleware/validate.js';
import { getBudgetItemHistory } from '../services/budgetItems/BudgetItemHistory.js';

/**
 * GET /api/budget-items/:uuid/history?periods=N: a budget item's figures in
 * the ledger's last N periods (budgetItemHistoryQuery: 24 by default, at most 120) and in
 * the current one. The queries are in services/budgetItems/BudgetItemHistory.ts; an item
 * that isn't the ledger's is a 404 (BudgetItemNotFoundError).
 *
 * Its own module, mounted at /api/budget-items, so routes/budgets.ts stays as it is.
 */
export function createBudgetItemHistoryRoutes(): Router {
  const router = Router();

  router.get('/:uuid/history', validateQuery(budgetItemHistoryQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { periods } = parsedQuery(req, budgetItemHistoryQuery);
    res.json(await getBudgetItemHistory(String(req.params.uuid), periods));
  }));

  return router;
}
