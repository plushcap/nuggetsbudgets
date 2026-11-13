import { Router } from 'express';
import {
  budgetAmountUpdateSchema,
  budgetEventsQuery,
  budgetItemCreateSchema,
  budgetItemMatchingRuleSchema,
  budgetItemMatchingRulesQuery,
  budgetItemUpdateSchema,
  budgetPeriodCreateSchema,
  budgetPeriodItemsQuery,
  mergeBudgetItemSchema,
} from '@nuggets/shared';
import BudgetService from '../services/BudgetService.js';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import { BudgetItemArchiveService } from '../services/budgetItems/BudgetItemArchiveService.js';
import { createBudgetItem, listBudgetItems, updateBudgetItem } from '../services/budgetItems/BudgetItemEditor.js';
import { BudgetItemMatchingRules } from '../services/budgetItems/BudgetItemMatchingRules.js';
import {
  budgetEvents,
  budgetPeriodItems,
  budgetPeriodSummary,
  envelopeTransfers,
  envelopeBalanceThroughPeriod,
  listBudgetPeriods,
} from '../services/budgetPeriods/BudgetPeriodReads.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ service: 'BudgetsRoute' });

/**
 * /api/budgets: budget items, budget periods and their items, the budget event log, and
 * the budget items' matching rules. Each route checks its input (a shared
 * schema) and calls a service: BudgetService for every change to budget data (the only
 * writer of the event log), services/budgetPeriods/ for the period reads,
 * services/budgetItems/ for the items and their rules. The services take no pool: they run
 * on the request's tenant transaction. A refusal they throw (not found 404, a value they
 * can't take 400, a change the item's money doesn't allow 409) propagates to the route
 * wrapper, which answers it and rolls back what was written.
 */
export function createBudgetRoutes(): Router {
  const router = Router();
  const budgetService = new BudgetService();
  const archives = new BudgetItemArchiveService();
  const rules = new BudgetItemMatchingRules();

  // ====================================================================
  // BUDGET ITEMS ENDPOINTS
  // ====================================================================

  // Get all budget items
  router.get('/items', tenantHandler(async (_req: AuthenticatedRequest, res) => {
    res.json(await listBudgetItems());
  }));

  // Create budget item. budgetItemCreateSchema (shared) checks its name, vocabulary and
  // dates; the other fields pass through.
  router.post('/items', validateBody(budgetItemCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res) => {
    res.status(201).json(await createBudgetItem(req.body, req.user.userId));
  }));

  // Update budget item: the fields sent, under the item's row lock (BudgetItemEditor).
  router.put('/items/:uuid', validateBody(budgetItemUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res) => {
    const uuid = String(req.params.uuid);
    logger.info({ uuid, updateKeys: Object.keys(req.body) }, 'Updating budget item');
    res.json(await updateBudgetItem(uuid, req.body, req.user.userId));
  }));

  /**
   * What archiving, deleting or merging an item touches: its transactions,
   * rules, budget history and envelope balance.
   * GET /api/budgets/items/:uuid/usage
   */
  router.get('/items/:uuid/usage', tenantHandler(async (req: AuthenticatedRequest, res) => {
    res.json(await archives.usage(String(req.params.uuid)));
  }));

  /**
   * Archive: hide it everywhere new work happens, keeping its history. An
   * envelope with a balance is refused (409).
   * POST /api/budgets/items/:uuid/archive
   */
  router.post('/items/:uuid/archive', tenantHandler(async (req: AuthenticatedRequest, res) => {
    await archives.archive(String(req.params.uuid), req.user.userId);
    res.json({ message: 'Budget item archived' });
  }));

  /** POST /api/budgets/items/:uuid/restore */
  router.post('/items/:uuid/restore', tenantHandler(async (req: AuthenticatedRequest, res) => {
    await archives.restore(String(req.params.uuid), req.user.userId);
    res.json({ message: 'Budget item restored' });
  }));

  /**
   * Move its transactions (and rules) to another item, then archive it.
   * POST /api/budgets/items/:uuid/merge — Body: { into_uuid, move_rules? }
   */
  router.post('/items/:uuid/merge', validateBody(mergeBudgetItemSchema), tenantHandler(async (req: AuthenticatedRequest, res) => {
    res.json(await archives.merge(String(req.params.uuid), req.body.into_uuid, req.body.move_rules, req.user.userId));
  }));

  /**
   * Delete an item nothing references. One with transactions or budget
   * history is refused (409): archive or merge it instead.
   * DELETE /api/budgets/items/:uuid
   */
  router.delete('/items/:uuid', tenantHandler(async (req: AuthenticatedRequest, res) => {
    await archives.delete(String(req.params.uuid), req.user.userId);
    res.json({ message: 'Budget item deleted successfully' });
  }));

  // ====================================================================
  // BUDGET PERIODS ENDPOINTS
  // ====================================================================

  // Get all budget periods
  router.get('/periods', tenantHandler(async (_req: AuthenticatedRequest, res) => {
    res.json(await listBudgetPeriods());
  }));

  // Get budget period summary
  router.get('/periods/:uuid/summary', tenantHandler(async (req: AuthenticatedRequest, res) => {
    res.json({ summary: await budgetPeriodSummary(String(req.params.uuid)) });
  }));

  // Create budget period: the period's row, and how many items it was given. It takes in
  // the month's transactions that have no period yet (not one a member took out of a period),
  // as POST /api/budget-periods does (the same BudgetService.createMonthPeriod). A month that
  // has its period is a 409 (BudgetPeriodExistsError).
  //
  // Note: this app is transaction-based; envelope rollover doesn't apply. The SQL
  // function `create_budget_period_with_items` still has an `p_auto_rollover` parameter
  // for legacy reasons but currently hardcodes `starting = 0`. We let the service's
  // default ride and don't expose a misleading flag to clients.
  router.post('/periods', validateBody(budgetPeriodCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res) => {
    const { period, budgetItemsCreated } = await budgetService.createMonthPeriod(req.body.year, req.body.month, req.user.userId);
    res.status(201).json({ ...period, budgetItemsCreated });
  }));

  // Get budget period items: every item's row with its figures, or one item's
  // (?budget_item_uuid=, which computes only its row).
  router.get('/periods/:uuid/items', validateQuery(budgetPeriodItemsQuery), tenantHandler(async (req: AuthenticatedRequest, res) => {
    const { budget_item_uuid } = parsedQuery(req, budgetPeriodItemsQuery);
    res.json({ success: true, data: await budgetPeriodItems(String(req.params.uuid), budget_item_uuid) });
  }));

  // Get envelope account transfers for a budget period
  router.get('/periods/:uuid/envelope-transfers', tenantHandler(async (req: AuthenticatedRequest, res) => {
    res.json({ success: true, data: await envelopeTransfers(String(req.params.uuid)) });
  }));

  // Each envelope account's money through a budget period, as its envelopes count it
  router.get('/periods/:uuid/envelope-balance', tenantHandler(async (req: AuthenticatedRequest, res) => {
    res.json({ success: true, data: await envelopeBalanceThroughPeriod(String(req.params.uuid)) });
  }));

  // ====================================================================
  // BUDGET PERIOD ITEMS ENDPOINTS
  // ====================================================================

  // Update budget period item budget amount: recorded as an event of the difference.
  router.put('/period-items/:uuid/budget', validateBody(budgetAmountUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res) => {
    res.json(await budgetService.setPeriodItemBudget(String(req.params.uuid), req.body.amount, req.user.userId, req.body.description));
  }));

  // ====================================================================
  // BUDGET EVENTS ENDPOINT
  // ====================================================================

  // Get budget events history: GET /api/budgets/events?budget_item_uuid=&period_uuid=&limit=
  // Answers { success, data } with BudgetService's event rows (the
  // bill page sent uuids, which were ignored, and read `data` off a bare array).
  router.get('/events', validateQuery(budgetEventsQuery), tenantHandler(async (req: AuthenticatedRequest, res) => {
    const { budget_item_uuid, period_uuid, limit } = parsedQuery(req, budgetEventsQuery);
    res.json({ success: true, data: await budgetEvents({ budgetItemUuid: budget_item_uuid, periodUuid: period_uuid, limit }) });
  }));

  // ============================================================================
  // BUDGET ITEM MATCHING RULES ENDPOINTS
  // ============================================================================

  // Get budget item matching rules: the active ones, or one item's.
  router.get('/item-matching-rules', validateQuery(budgetItemMatchingRulesQuery), tenantHandler(async (req: AuthenticatedRequest, res) => {
    const { budget_item_uuid, budget_item_id } = parsedQuery(req, budgetItemMatchingRulesQuery);
    res.json(await rules.list({ budgetItemUuid: budget_item_uuid, budgetItemId: budget_item_id }));
  }));

  // Create budget item matching rule
  router.post('/item-matching-rules', validateBody(budgetItemMatchingRuleSchema), tenantHandler(async (req: AuthenticatedRequest, res) => {
    res.status(201).json(await rules.create(req.body));
  }));

  // Update budget item matching rule: the body replaces it, checked as a new rule is.
  router.put('/item-matching-rules/:uuid', validateBody(budgetItemMatchingRuleSchema), tenantHandler(async (req: AuthenticatedRequest, res) => {
    res.json(await rules.update(String(req.params.uuid), req.body));
  }));

  // Delete budget item matching rule
  router.delete('/item-matching-rules/:uuid', tenantHandler(async (req: AuthenticatedRequest, res) => {
    await rules.delete(String(req.params.uuid));
    res.status(204).send();
  }));

  return router;
}
