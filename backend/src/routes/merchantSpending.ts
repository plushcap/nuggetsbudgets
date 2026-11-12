import { Router, Response } from 'express';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { getMerchantSpending } from '../services/merchants/merchantSpending.js';

/**
 * GET /api/merchant-spending/:uuid: the merchant page's charts and header
 * counts. The queries are in services/merchants/merchantSpending.ts.
 *
 * Its own module, mounted at /api/merchant-spending, so routes/merchants.ts stays as it is.
 */
export function createMerchantSpendingRoutes(): Router {
  const router = Router();

  router.get('/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const spending = await getMerchantSpending(String(req.params.uuid));
    if (!spending) {
      res.status(404).json({ error: 'Merchant not found' });
      return;
    }
    res.json(spending);
  }));

  return router;
}
