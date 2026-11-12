import { Router, Response } from 'express';
import {
  billCandidatesQuery,
  billForecastQuery,
  billMonthQuery,
  linkBillPaymentSchema,
  placeBillPaymentSchema,
  resolveBillOccurrenceSchema,
} from '@nuggets/shared';
import { parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { BillService } from '../services/bills/BillService.js';
import { appToday } from '../utils/appDate.js';

/**
 * Bills: what's due each month and whether it's paid, the forecast, and the
 * hand corrections (link, unlink, place, skip, mark paid). Any member of the
 * ledger may use all of it; bills are shared household data. A refusal the service
 * throws (a BillError) propagates to the route wrapper, which answers it.
 */
export function createBillRoutes(): Router {
  const router = Router();
  const bills = new BillService();

  /**
   * The bills due in a month, its totals, and bill payments no due date took.
   * GET /api/bills?month=YYYY-MM (default: this month)
   */
  router.get('/', validateQuery(billMonthQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const today = await appToday();
    const { month } = parsedQuery(req, billMonthQuery);
    res.json(await bills.monthView(month ?? today.slice(0, 7), today));
  }));

  /**
   * Expected bill spending per month, from this month on.
   * GET /api/bills/forecast?months=12 (1 to 24)
   */
  router.get('/forecast', validateQuery(billForecastQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { months } = parsedQuery(req, billForecastQuery);
    res.json(await bills.forecast(months, await appToday()));
  }));

  /**
   * Transactions that could be linked to a due date.
   * GET /api/bills/occurrences/:uuid/candidates?q=words
   */
  router.get('/occurrences/:uuid/candidates', validateQuery(billCandidatesQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { q } = parsedQuery(req, billCandidatesQuery);
    res.json(await bills.candidates(String(req.params.uuid), q, await appToday()));
  }));

  /**
   * Link a transaction to a due date by hand.
   * POST /api/bills/occurrences/:uuid/payments — Body: { transaction_uuid }
   */
  router.post('/occurrences/:uuid/payments', validateBody(linkBillPaymentSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await bills.link(String(req.params.uuid), req.body.transaction_uuid, req.user.userId, await appToday()));
  }));

  /**
   * Unlink a payment from a due date.
   * DELETE /api/bills/occurrences/:uuid/payments/:transactionUuid
   */
  router.delete('/occurrences/:uuid/payments/:transactionUuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await bills.unlink(String(req.params.uuid), String(req.params.transactionUuid), req.user.userId, await appToday()));
  }));

  /**
   * Skip a due date, mark it paid by hand, or undo either (resolution: null).
   * PUT /api/bills/occurrences/:uuid/resolution — Body: { resolution, paid_date?, paid_amount?, note? }
   */
  router.put('/occurrences/:uuid/resolution', validateBody(resolveBillOccurrenceSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await bills.resolve(String(req.params.uuid), req.body, req.user.userId, await appToday()));
  }));

  /**
   * The due dates a payment of this bill could go on: open earlier ones and the next 12 months.
   * GET /api/bills/:uuid/due-dates
   */
  router.get('/:uuid/due-dates', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await bills.dueDates(String(req.params.uuid), await appToday()));
  }));

  /**
   * Place a transaction on one of this bill's due dates, including a future one.
   * POST /api/bills/:uuid/payments — Body: { transaction_uuid, due_date }
   */
  router.post('/:uuid/payments', validateBody(placeBillPaymentSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await bills.place(String(req.params.uuid), req.body.transaction_uuid, req.body.due_date, req.user.userId, await appToday()));
  }));

  return router;
}
