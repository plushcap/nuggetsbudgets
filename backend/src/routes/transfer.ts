import { Router, Response } from 'express';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { validateBody } from '../middleware/validate.js';
import { budgetPeriodTransferSchema, transferCreateSchema, type BudgetPeriodTransferInput } from '@nuggets/shared';
import {
  createTransfer,
  movePeriodBalance,
  type TransferInput,
} from '../services/transactions/index.js';

/**
 * /api/transfer: money moved between two accounts, and a period's balance moved to the
 * next period. The work is in services/transactions/transfers.ts; a refusal it throws,
 * or any other error, propagates to the route wrapper, which answers it (anything but a
 * refusal 500, logged), and the request's transaction rolls back.
 */

export function createTransferRoutes(): Router {
  const router = Router();

  // Create a transfer (two linked transactions)
  router.post('/', validateBody(transferCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await createTransfer(req.body as TransferInput);
    res.json({ success: true, ...result });
  }));

  // Move an account's period balance to the next period: see movePeriodBalance.
  router.post('/period', validateBody(budgetPeriodTransferSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await movePeriodBalance(req.body as BudgetPeriodTransferInput);
    res.json({ success: true, ...result });
  }));

  return router;
}
