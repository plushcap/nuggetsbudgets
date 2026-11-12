import { Router, Response } from 'express';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import {
  tagCreateSchema,
  tagNamespaceSetSchema,
  tagReportQuery,
  tagReportRootSchema,
  tagTimeSeriesQuery,
  tagTransactionsQuery,
  tagUpdateSchema,
  taggingCreateSchema,
  type TagNamespaceSetInput,
  type TagReportRootInput,
  type TagWriteInput,
  type TaggingCreateInput,
} from '@nuggets/shared';
import { createLogger } from '../utils/logger.js';
import { TagService } from '../services/tags/TagService.js';
import { TagReportService, type DateRange } from '../services/tags/TagReportService.js';
import { TaggingService } from '../services/tags/TaggingService.js';
import { tagNotFound } from '../services/tags/TagError.js';

const logger = createLogger({ service: 'TagsRoute' });

/** A report query's range, as the tag reports take it. */
const rangeOf = ({ start_date, end_date }: { start_date?: string | undefined; end_date?: string | undefined }): DateRange => ({
  ...(start_date !== undefined && { start: start_date }),
  ...(end_date !== undefined && { end: end_date }),
});

/** A tag body's fields, as the tag service takes them. */
const tagInput = ({ name, color, icon, description, parent_id, sort_order, is_active }: TagWriteInput) => ({
  name,
  color,
  icon,
  description,
  parent_id,
  sort_order,
  is_active,
});

/**
 * The tag routes: tags and their hierarchy, the tag reports, and tagging transactions
 * and budget items. The handlers check the request (the shared tag schemas), call the
 * services in services/tags/ and shape the answer; the services' refusals (TagError) are
 * answered by the route wrapper.
 */
export function createTagsRoutes(): Router {
  const router = Router();
  const tags = new TagService();
  const reports = new TagReportService();
  const taggings = new TaggingService();

  // ============================================================================
  // TAGS
  // ============================================================================

  router.get('/', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await tags.list());
  }));

  // Before GET /:uuid, so "report-roots" isn't taken for a uuid.
  router.get('/report-roots', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await tags.listReportRoots());
  }));

  router.get('/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const tag = await tags.find(String(req.params.uuid));
    if (!tag) throw tagNotFound();
    res.json(tag);
  }));

  router.get('/:uuid/summary', validateQuery(tagReportQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await reports.summary(String(req.params.uuid), rangeOf(parsedQuery(req, tagReportQuery))));
  }));

  // The tag's transactions and its descendants', a page at a time.
  router.get('/:uuid/transactions', validateQuery(tagTransactionsQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const query = parsedQuery(req, tagTransactionsQuery);
    const { limit, offset } = query;
    const { transactions, total } = await reports.transactions(String(req.params.uuid), rangeOf(query), { limit, offset });
    res.json({ transactions, total, limit, offset });
  }));

  // Received and spent per day, week or month, for the tag's chart.
  router.get('/:uuid/timeseries', validateQuery(tagTimeSeriesQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const query = parsedQuery(req, tagTimeSeriesQuery);
    const series = await reports.timeSeries(String(req.params.uuid), rangeOf(query), query.bucket);
    res.json({ bucket: query.bucket, series });
  }));

  // The tag's totals across its direct sub-tags, for the pie chart.
  router.get('/:uuid/breakdown', validateQuery(tagReportQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json({ breakdown: await reports.breakdown(String(req.params.uuid), rangeOf(parsedQuery(req, tagReportQuery))) });
  }));

  // tagCreateSchema checks and trims the name.
  router.post('/', validateBody(tagCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.status(201).json(await tags.create(tagInput(req.body as TagWriteInput)));
  }));

  // tagUpdateSchema checks and trims the name, as on create.
  router.put('/:uuid', validateBody(tagUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const uuid = String(req.params.uuid);
    logger.info({ uuid }, 'Updating tag');
    res.json(await tags.update(uuid, tagInput(req.body as TagWriteInput)));
  }));

  // Marks or unmarks a top-level tag as a report namespace root.
  router.put('/:uuid/report-root', validateBody(tagReportRootSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { is_report_root, report_flow_measure } = req.body as TagReportRootInput;
    res.json(await tags.setReportRoot(String(req.params.uuid), is_report_root, report_flow_measure));
  }));

  router.delete('/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const uuid = String(req.params.uuid);
    logger.info({ uuid }, 'Deleting tag');
    await tags.remove(uuid);
    res.json({ success: true, message: 'Tag deleted successfully' });
  }));

  // ============================================================================
  // TAGS ON A TRANSACTION
  // ============================================================================

  router.get('/transaction/:transactionUuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await taggings.transactionTags(String(req.params.transactionUuid)));
  }));

  router.post('/transaction/:transactionUuid', validateBody(taggingCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { tag_id } = req.body as TaggingCreateInput;
    res.status(201).json(await taggings.tagTransaction(String(req.params.transactionUuid), tag_id as number, req.user.userId));
  }));

  router.delete('/transaction/:transactionUuid/tag/:tagId', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    await taggings.untagTransaction(String(req.params.transactionUuid), Number(req.params.tagId));
    res.json({ success: true, message: 'Tag removed from transaction' });
  }));

  // ============================================================================
  // TAGS ON A BUDGET ITEM
  // ============================================================================

  // Grouped by namespace (report_root_id / report_root_name).
  router.get('/budget-items/:budgetItemUuid/tags', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await taggings.budgetItemTags(String(req.params.budgetItemUuid)));
  }));

  router.post('/budget-items/:budgetItemUuid/tags', validateBody(taggingCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { tag_id } = req.body as TaggingCreateInput;
    const tagging = await taggings.tagBudgetItem(String(req.params.budgetItemUuid), tag_id as number, req.user.userId);
    res.status(201).json({ success: true, message: 'Tag added to budget item', tagging });
  }));

  // Replaces or clears the budget item's tag in one report namespace, in one step: the
  // way to change a namespace tag.
  router.put('/budget-items/:budgetItemUuid/namespace/:rootTagUuid', validateBody(tagNamespaceSetSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { tag_uuid } = req.body as TagNamespaceSetInput;
    const set = await taggings.setBudgetItemNamespaceTag(String(req.params.budgetItemUuid), String(req.params.rootTagUuid), tag_uuid, req.user.userId);
    res.json({
      success: true,
      message: set.tagId === null ? 'Namespace tag cleared' : 'Namespace tag set',
      tagging: set.tagging,
    });
  }));

  router.delete('/budget-items/:budgetItemUuid/tags/:tagId', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    await taggings.untagBudgetItem(String(req.params.budgetItemUuid), Number(req.params.tagId));
    res.json({ success: true, message: 'Tag removed from budget item' });
  }));

  // ============================================================================
  // AUTO-TAGGING
  // ============================================================================

  // Applies the auto-tags again to every transaction of a budget item.
  router.post('/auto-tag/budget-item/:budgetItemUuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const updatedCount = await taggings.autoTagBudgetItem(String(req.params.budgetItemUuid));
    res.json({ success: true, message: `Auto-tags applied to ${updatedCount} transaction(s)`, updatedCount });
  }));

  // Applies the auto-tags again to every transaction of a merchant.
  router.post('/auto-tag/merchant/:merchantUuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const updatedCount = await taggings.autoTagMerchant(String(req.params.merchantUuid));
    res.json({ success: true, message: `Auto-tags applied to ${updatedCount} transaction(s)`, updatedCount });
  }));

  return router;
}
