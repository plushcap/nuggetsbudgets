import { z } from 'zod';
import { queryBoolean, queryCalendarDay, queryEnum, queryUuid } from './primitives.js';
import { nullableDayText, responseAmount } from './responses.js';
import { TAG_REPORT_FLOW_MEASURES } from './vocabulary.js';

/** Which way the Sankey chart lays its flows: left to right (the default) or right to left. */
export const SANKEY_DIRECTIONS = ['lr', 'rl'] as const;
export type SankeyDirection = (typeof SANKEY_DIRECTIONS)[number];

/**
 * GET /api/reports/sankey/:rootTagUuid: every field of the report, so a parse
 * checks each and one the schema doesn't name fails the route test (`answerProblem`).
 * Amounts are numbers the server added up in cents.
 */
export const sankeyNodeSchema = z.object({
  /** 'tag:<uuid>', or 'untagged'. */
  id: z.string(),
  label: z.string(),
  level: z.number().int(),
  color: z.string(),
});
export const sankeyLinkSchema = z.object({
  source: z.string(),
  target: z.string(),
  value: responseAmount,
});
export const sankeyDrilldownItemSchema = z.object({
  budget_item_uuid: z.uuid(),
  budget_item_name: z.string(),
  contribution: responseAmount,
  rule_applied: z.enum([
    'income_transactions',
    'rollover_allocation',
    'expense_transactions',
    'actual_override',
    'allocated_override',
  ]),
});
export const sankeyResponseSchema = z.object({
  namespace: z.object({
    uuid: z.uuid(),
    name: z.string(),
    flow_measure: z.enum(TAG_REPORT_FLOW_MEASURES),
    max_depth: z.number().int(),
  }),
  period: z.object({
    start_date: nullableDayText,
    end_date: nullableDayText,
    budget_period_uuid: z.uuid().nullable(),
  }),
  direction: z.enum(SANKEY_DIRECTIONS),
  nodes: z.array(sankeyNodeSchema),
  links: z.array(sankeyLinkSchema),
  totals: z.object({
    by_root_child: z.array(z.object({ tag_uuid: z.uuid(), label: z.string(), total: responseAmount })),
    untagged_total: responseAmount,
    balance_check: z.object({
      income_total: responseAmount,
      outflow_total: responseAmount,
      unallocated_residual: responseAmount,
    }),
  }),
  /** Each node's budget items and what each added, keyed by tag uuid (or 'untagged'). */
  _drilldown: z.record(z.string(), z.array(sankeyDrilldownItemSchema)),
});
export type SankeyResponse = z.infer<typeof sankeyResponseSchema>;

/**
 * GET /api/reports/sankey/:rootTagUuid's query: the window, as a range of days
 * (either end open) or a budget period (its days and its allocations), which way to lay the
 * chart, whether to show the untagged node and count transfers, and a flow measure that
 * overrides the namespace's own. A malformed day or period uuid reached SQL (a 500); a
 * direction was echoed back as sent.
 */
export const sankeyReportQuery = z
  .object({
    start_date: queryCalendarDay(),
    end_date: queryCalendarDay(),
    budget_period_uuid: queryUuid(),
    direction: queryEnum(SANKEY_DIRECTIONS, { default: 'lr' }),
    include_untagged: queryBoolean({ default: true }),
    include_transfers: queryBoolean({ default: false }),
    flow_measure_override: queryEnum(TAG_REPORT_FLOW_MEASURES, { message: "flow_measure_override must be 'actual', 'allocated', or 'effective'" }),
  })
  .refine((q) => q.start_date !== undefined || q.end_date !== undefined || q.budget_period_uuid !== undefined, {
    message: 'Provide start_date+end_date or budget_period_uuid',
  });
export type SankeyReportQuery = z.infer<typeof sankeyReportQuery>;
