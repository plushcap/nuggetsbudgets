import { Router, Response } from 'express';
import { budgetPeriodManagedCreateSchema, budgetItemTransferSchema } from '@nuggets/shared';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { validateBody } from '../middleware/validate.js';
import { BudgetService } from '../services/BudgetService.js';
import { tenantMoneyText } from '../services/tenantMoneyFormat.js';
import {
  budgetPeriodsForManagement,
  periodItemBudgetActivity,
  periodItemTransactions,
} from '../services/budgetPeriods/BudgetPeriodReads.js';

/**
 * /api/budget-periods: the budget-period settings page (its periods with their counts,
 * creating, archiving, restoring and deleting one), and the budget page's transfers and item
 * activity.
 * Each route checks its input (a shared schema) and calls a service:
 * BudgetService for every change to budget data, services/budgetPeriods/ for the reads.
 * A period or period item is named by its uuid. A refusal the service
 * throws (not found 404, a month that has its period or a busy row 409, missing funds
 * 400) propagates to the route wrapper, which answers it and rolls back what was written.
 */
export function createBudgetPeriodRoutes(): Router {
  const router = Router();
  const budgetService = new BudgetService();

  /**
   * GET /api/budget-periods/management
   * Get all budget periods with statistics for management interface
   */
  router.get('/management', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await budgetPeriodsForManagement());
  }));

  /**
   * POST /api/budget-periods
   * Create a new budget period, taking in the month's transactions that have no period
   * (not one a member took out of a period), unless associate_transactions is false
   */
  router.post('/', validateBody(budgetPeriodManagedCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { year, month, auto_rollover, associate_transactions } = req.body;
    const created = await budgetService.createMonthPeriod(year, month, req.user.userId, {
      autoRollover: auto_rollover,
      associateTransactions: associate_transactions,
    });
    res.status(201).json({
      success: true,
      message: 'Budget period created successfully',
      period_id: created.period.id,
      budget_items_created: created.budgetItemsCreated,
      transactions_associated: created.transactionsAssociated,
    });
  }));

  /**
   * DELETE /api/budget-periods/:uuid
   * Delete a budget period that has no transactions, with its items and budget events. One
   * that has transactions is refused (409 BUDGET_PERIOD_HAS_TRANSACTIONS): archive it instead.
   */
  router.delete('/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await budgetService.deletePeriod(String(req.params.uuid));
    res.json({
      success: true,
      message: `Budget period "${result.name}" deleted successfully`,
      budget_items_deleted: result.budgetItemsDeleted,
      budget_transactions_deleted: result.budgetTransactionsDeleted,
    });
  }));

  /**
   * POST /api/budget-periods/:uuid/archive
   * Archive a budget period: hidden from the period pickers, its transactions and budget kept.
   */
  router.post('/:uuid/archive', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const period = await budgetService.archivePeriod(String(req.params.uuid));
    res.json({ success: true, message: `Budget period "${period.name}" archived`, period });
  }));

  /**
   * POST /api/budget-periods/:uuid/restore
   * Restore an archived budget period to the period pickers.
   */
  router.post('/:uuid/restore', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const period = await budgetService.restorePeriod(String(req.params.uuid));
    res.json({ success: true, message: `Budget period "${period.name}" restored`, period });
  }));

  /**
   * POST /api/budget-periods/:periodUuid/transfer
   * Transfer money between budget items within a period
   */
  router.post('/:periodUuid/transfer', validateBody(budgetItemTransferSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await budgetService.transferInPeriod(String(req.params.periodUuid), req.body, req.user.userId);
    // The amount recorded, not the text as sent: ".5", "+5" or "5.000" was echoed back, which
    // the answer's own schema refuses.
    res.json({
      success: true,
      message: `Successfully transferred ${await tenantMoneyText(result.amount)} from ${result.fromName} to ${result.toName}`,
      transferUuid: result.eventUuid,
      fromItem: result.fromName,
      toItem: result.toName,
      amount: result.amount,
    });
  }));

  /**
   * GET /api/budget-periods/items/:budgetPeriodItemUuid/budget-activity
   * Get budget activity (transfers, budget updates) for a budget item
   */
  router.get('/items/:budgetPeriodItemUuid/budget-activity', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await periodItemBudgetActivity(String(req.params.budgetPeriodItemUuid)));
  }));

  /**
   * GET /api/budget-periods/items/:budgetPeriodItemUuid/transactions
   * Get actual transactions for a budget item
   */
  router.get('/items/:budgetPeriodItemUuid/transactions', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await periodItemTransactions(String(req.params.budgetPeriodItemUuid)));
  }));

  return router;
}
