import { z } from 'zod';
import { QUERY_MAX_PAGE, queryCalendarDay, queryEnum, queryInt } from './primitives.js';
import { TAG_REPORT_FLOW_MEASURES } from './vocabulary.js';
import { dayText, instant, nullableInstant, responseAmount, responseCount } from './responses.js';
import { transactionResponseSchema } from './transactions.js';

/**
 * POST /api/tags and PUT /api/tags/:uuid body: name (trimmed, up to 100 characters)
 * required; color, icon and description text when given (a description that wasn't was a
 * TypeError, a 500); sort_order a whole number and is_active a boolean. parent_id passes
 * through to the tag service, which reads a parent that isn't a tag id as no such tag (400).
 */
export const tagWriteSchema = z.looseObject({
  name: z
    .string({ error: 'Name is required' })
    .trim()
    .min(1, 'Name is required')
    .max(100, 'Tag name must be 100 characters or less'),
  color: z.string({ error: 'color must be text' }).nullish(),
  icon: z.string({ error: 'icon must be text' }).nullish(),
  description: z.string({ error: 'description must be text' }).nullish(),
  sort_order: z.number({ error: 'sort_order must be a whole number' }).int('sort_order must be a whole number').nullish(),
  is_active: z.boolean({ error: 'is_active must be true or false' }).optional(),
});
export type TagWriteInput = z.infer<typeof tagWriteSchema>;

/** POST /api/tags body ({@link tagWriteSchema}). */
export const tagCreateSchema = tagWriteSchema;
export type TagCreateInput = TagWriteInput;

/** PUT /api/tags/:uuid body ({@link tagWriteSchema}): the whole tag; a parent not sent keeps the current one. */
export const tagUpdateSchema = tagWriteSchema;
export type TagUpdateInput = TagWriteInput;

/** PUT /api/tags/:uuid/report-root body: mark or unmark a top-level tag as a report namespace root. */
export const tagReportRootSchema = z.looseObject({
  is_report_root: z.boolean({ error: 'is_report_root (boolean) is required' }),
  report_flow_measure: z.enum(TAG_REPORT_FLOW_MEASURES, { error: "report_flow_measure must be one of 'actual', 'allocated', 'effective'" }).optional(),
});
export type TagReportRootInput = z.infer<typeof tagReportRootSchema>;

/** A tag id a tagging body names: given (its validity, a tag of this ledger, is the tag service's 400 INVALID_REFERENCE). */
const taggingTagId = z
  .union([z.number(), z.string()], { error: 'tag_id is required' })
  .refine((id) => id !== 0 && id !== '', 'tag_id is required');

/** POST /api/tags/transaction/:transactionUuid and /api/tags/budget-items/:budgetItemUuid/tags body. */
export const taggingCreateSchema = z.looseObject({ tag_id: taggingTagId });
export type TaggingCreateInput = z.infer<typeof taggingCreateSchema>;

/** PUT /api/tags/budget-items/:budgetItemUuid/namespace/:rootTagUuid body: the tag to apply, or null to clear the namespace. */
export const tagNamespaceSetSchema = z.looseObject({
  tag_uuid: z.string({ error: 'tag_uuid must be a string (the tag to apply) or null (to clear)' }).nullable(),
});
export type TagNamespaceSetInput = z.infer<typeof tagNamespaceSetSchema>;

const TAG_RANGE = 'start_date and end_date must be dates in YYYY-MM-DD form';
/** The tag reports' optional range: inclusive calendar days. */
const tagReportRange = {
  start_date: queryCalendarDay({ message: TAG_RANGE }),
  end_date: queryCalendarDay({ message: TAG_RANGE }),
};

/** GET /api/tags/:uuid/summary and /breakdown query: the range. */
export const tagReportQuery = z.object(tagReportRange);
export type TagReportQuery = z.infer<typeof tagReportQuery>;

/** GET /api/tags/:uuid/transactions query: the range, and the page by offset (100 rows by default, at most 500). */
export const tagTransactionsQuery = z.object({
  ...tagReportRange,
  limit: queryInt({ min: 1, max: 500, default: 100 }),
  offset: queryInt({ min: 0, max: QUERY_MAX_PAGE * 500, default: 0 }),
});
export type TagTransactionsQuery = z.infer<typeof tagTransactionsQuery>;

/** GET /api/tags/:uuid/timeseries query: the range, and the bucket (a month when not given). */
export const tagTimeSeriesQuery = z.object({
  ...tagReportRange,
  bucket: queryEnum(['day', 'week', 'month'], { default: 'month' }),
});
export type TagTimeSeriesQuery = z.infer<typeof tagTimeSeriesQuery>;

/**
 * How many levels deep tags go. A top-level tag is level 0, so the deepest is
 * TAG_DEEPEST_LEVEL (3), and a tag there takes no child: the database's
 * calculate_tag_level trigger refuses one, the tag service refuses it first with a 400,
 * and the tags page doesn't offer such a tag as a parent.
 */
export const TAG_MAX_LEVELS = 4;
/** The deepest level a tag can be at; a tag at this level can't be a parent. */
export const TAG_DEEPEST_LEVEL = TAG_MAX_LEVELS - 1;

// ---------------------------------------------------------------------------
// Answers.

/**
 * A tag as the API answers it. Every tag answer has its own id, name, colour, icon, parent
 * and level; the rest depends on the answer, so it's optional here:
 * - the list and one tag (GET /api/tags, /:uuid, `tags_with_hierarchy`): all of its columns,
 *   its path, its parent's name and uuid and its counts ({@link tagWithHierarchyResponseSchema});
 * - a create or an update: its own columns ({@link tagRowResponseSchema});
 * - a transaction's or a budget item's tags: its path, and for a budget item the report
 *   namespace the tagging is in ({@link transactionTagsResponseSchema}, {@link budgetItemTagsResponseSchema}).
 */
export const tagResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  parent_id: z.number().int().nullable(),
  /** Its depth: 0 for a top-level tag, at most TAG_DEEPEST_LEVEL. The database sets it (calculate_tag_level). */
  level: z.number().int(),
  // Its other columns: the list, one tag, a create and an update.
  description: z.string().nullable().optional(),
  sort_order: z.number().int().nullable().optional(),
  is_active: z.boolean().optional(),
  created_at: instant.optional(),
  updated_at: nullableInstant.optional(),
  // The list and one tag.
  is_report_root: z.boolean().optional(),
  report_flow_measure: z.enum(TAG_REPORT_FLOW_MEASURES).nullable().optional(),
  parent_name: z.string().nullable().optional(),
  parent_uuid: z.uuid().nullable().optional(),
  child_count: responseCount.optional(),
  transaction_count: responseCount.optional(),
  budget_item_count: responseCount.optional(),
  /** When it was last put on a transaction: the picker lists the latest first. */
  last_used_at: nullableInstant.optional(),
  // The list, one tag, and a transaction's or a budget item's tags.
  /** Its names from the top down ('Home > Utilities'). */
  hierarchy_path: z.string().optional(),
  // A budget item's tags: the report namespace each tagging is in.
  report_root_id: z.number().int().nullable().optional(),
  report_root_uuid: z.uuid().nullable().optional(),
  report_root_name: z.string().nullable().optional(),
});
export type TagResponse = z.infer<typeof tagResponseSchema>;

/** A tag as the list and one tag answer it (`tags_with_hierarchy`). */
export const tagWithHierarchyResponseSchema = tagResponseSchema
  .omit({ report_root_id: true, report_root_uuid: true, report_root_name: true })
  .required({
    description: true,
    sort_order: true,
    is_active: true,
    created_at: true,
    updated_at: true,
    is_report_root: true,
    report_flow_measure: true,
    parent_name: true,
    parent_uuid: true,
    child_count: true,
    transaction_count: true,
    budget_item_count: true,
    last_used_at: true,
    hierarchy_path: true,
  });

/** GET /api/tags: by level, sort order and name. */
export const tagListResponseSchema = z.array(tagWithHierarchyResponseSchema);

/** A tag as a create (POST /api/tags) and an update (PUT /api/tags/:uuid) answer it: its own columns. */
export const tagRowResponseSchema = tagResponseSchema
  .pick({ id: true, uuid: true, name: true, color: true, icon: true, parent_id: true, level: true })
  .extend({
    description: z.string().nullable(),
    sort_order: z.number().int().nullable(),
    is_active: z.boolean(),
    created_at: instant,
    updated_at: nullableInstant,
  });

/** GET /api/tags/transaction/:transactionUuid: the transaction's tags by name, with their paths. */
export const transactionTagsResponseSchema = z.array(
  tagResponseSchema.pick({ id: true, uuid: true, name: true, color: true, icon: true, parent_id: true, level: true, hierarchy_path: true })
);

/** GET /api/tags/budget-items/:budgetItemUuid/tags: the item's tags by namespace, then name. */
export const budgetItemTagsResponseSchema = z.array(
  tagResponseSchema.pick({
    id: true, uuid: true, name: true, color: true, icon: true, parent_id: true, level: true, hierarchy_path: true,
    report_root_id: true, report_root_uuid: true, report_root_name: true,
  }).required({ hierarchy_path: true, report_root_id: true, report_root_uuid: true, report_root_name: true })
);

/** PUT /api/tags/:uuid/report-root: the tag marked or unmarked. */
export const tagReportRootSetResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  is_report_root: z.boolean(),
  report_flow_measure: z.enum(TAG_REPORT_FLOW_MEASURES).nullable(),
});
export type TagReportRootSet = z.infer<typeof tagReportRootSetResponseSchema>;

/** One report namespace: GET /api/tags/report-roots lists them, by name. */
export const reportRootResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  description: z.string().nullable(),
  report_flow_measure: z.enum(TAG_REPORT_FLOW_MEASURES).nullable(),
  created_at: instant,
  updated_at: nullableInstant,
  /** The tags below it. */
  descendant_count: responseCount,
  /** The budget items tagged in its namespace. */
  budget_item_tagging_count: responseCount,
});
export type ReportRoot = z.infer<typeof reportRootResponseSchema>;
export const reportRootListResponseSchema = z.array(reportRootResponseSchema);

/** The answer of a write that says only that it was done: a delete, an untag. */
export const tagDoneResponseSchema = z.object({ success: z.literal(true), message: z.string() });

/** POST /api/tags/transaction/:transactionUuid (201): the tagging written. */
export const transactionTaggingResponseSchema = z.object({ id: z.number().int(), uuid: z.uuid() });

/** POST /api/tags/budget-items/:budgetItemUuid/tags (201). */
export const budgetItemTaggingResponseSchema = tagDoneResponseSchema.extend({
  tagging: z.object({ id: z.number().int(), uuid: z.uuid() }),
});

/** PUT /api/tags/budget-items/:budgetItemUuid/namespace/:rootTagUuid: the tagging written, or null once cleared. */
export const tagNamespaceSetResponseSchema = tagDoneResponseSchema.extend({
  tagging: z
    .object({ id: z.number().int(), uuid: z.uuid(), tag_id: z.number().int(), report_root_id: z.number().int().nullable() })
    .nullable(),
});
export type TagNamespaceSetResponse = z.infer<typeof tagNamespaceSetResponseSchema>;

/** POST /api/tags/auto-tag/budget-item/:uuid and /auto-tag/merchant/:uuid: how many transactions were tagged again. */
export const autoTagResponseSchema = tagDoneResponseSchema.extend({ updatedCount: z.number().int() });

/** GET /api/tags/:uuid/summary: the count and totals of the tag's transactions and its descendants', each once. */
export const tagSummaryResponseSchema = z.object({
  tag_id: z.number().int(),
  tag_name: z.string(),
  tag_uuid: z.uuid(),
  hierarchy_path: z.string().nullable(),
  transaction_count: responseCount,
  /** Pre-signed sum: received minus spent. */
  total_amount: responseAmount,
  income_amount: responseAmount,
  /** Spent, as a positive amount. */
  expense_amount: responseAmount,
});
export type TagSummary = z.infer<typeof tagSummaryResponseSchema>;

/** One bucket of GET /api/tags/:uuid/timeseries: received and spent (both positive) from its first day. */
export const tagTimeSeriesBucketResponseSchema = z.object({
  bucket_date: dayText,
  income: responseAmount,
  expenses: responseAmount,
});
export type TagTimeSeriesBucket = z.infer<typeof tagTimeSeriesBucketResponseSchema>;

/** GET /api/tags/:uuid/timeseries. */
export const tagTimeSeriesResponseSchema = z.object({
  bucket: z.enum(['day', 'week', 'month']),
  series: z.array(tagTimeSeriesBucketResponseSchema),
});

/** One slice of GET /api/tags/:uuid/breakdown: a direct sub-tag's branch, or the tag itself (is_parent). */
export const tagBreakdownSliceResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  is_parent: z.boolean(),
  /** The sum of the transactions' sizes. */
  value: responseAmount,
  /** Received minus spent. */
  net: responseAmount,
  count: z.number().int(),
});
export type TagBreakdownSlice = z.infer<typeof tagBreakdownSliceResponseSchema>;

/** GET /api/tags/:uuid/breakdown. */
export const tagBreakdownResponseSchema = z.object({ breakdown: z.array(tagBreakdownSliceResponseSchema) });

/**
 * GET /api/tags/:uuid/transactions: a page of the tag's transactions and its descendants',
 * newest first, each once, with every tag it carries; how many there are in all, and the page.
 */
export const tagTransactionsResponseSchema = z.object({
  transactions: z.array(transactionResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type TagTransactionsResponse = z.infer<typeof tagTransactionsResponseSchema>;
