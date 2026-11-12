import { z } from 'zod';
import { queryBoolean, queryEnum, queryInt } from './primitives.js';
import { dayText, instant, responseAmount } from './responses.js';

/**
 * Today's net worth, computed when it is read (`GET /api/net-worth/current`): over the
 * net_worth_accounts view, a liability counting minus its pre-signed balance.
 */
export const currentNetWorthResponseSchema = z.object({
  snapshot_date: dayText,
  total_assets: responseAmount,
  total_liabilities: responseAmount,
  net_worth: responseAmount,
  account_count: z.number().int(),
  active_account_count: z.number().int(),
});
export type CurrentNetWorthResponse = z.infer<typeof currentNetWorthResponseSchema>;
export const currentNetWorthAnswerSchema = z.object({ current_net_worth: currentNetWorthResponseSchema });

/**
 * One point of `GET /api/net-worth/history`. A point is computed from the
 * stored daily snapshots, not a stored row: its id is 0 and its uuid ''.
 */
export const netWorthSnapshotResponseSchema = currentNetWorthResponseSchema.extend({
  /** null for a stored snapshot without one (the column is nullable). */
  account_count: z.number().int().nullable(),
  id: z.number().int(),
  uuid: z.string(),
  snapshot_trigger: z.enum(['transaction', 'manual', 'scheduled', 'aggregation']),
  aggregation_level: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  source_snapshot_count: z.number().int(),
  calculation_method: z.enum(['event_driven', 'scheduled', 'aggregated']),
  /** A period with no snapshot of its own, shown with the one before (fill_gaps). */
  is_interpolated: z.boolean(),
  created_at: instant,
  updated_at: instant,
});
export type NetWorthSnapshotResponse = z.infer<typeof netWorthSnapshotResponseSchema>;
export const netWorthHistoryAnswerSchema = z.object({
  history: z.array(netWorthSnapshotResponseSchema),
  meta: z.object({
    count: z.number().int(),
    fill_gaps: z.boolean(),
    limit: z.number().int(),
    period: z.enum(['day', 'week', 'month', 'year']),
  }),
});
export type NetWorthHistoryAnswer = z.infer<typeof netWorthHistoryAnswerSchema>;

/** The periods a net-worth history is in. */
export const NET_WORTH_PERIODS = ['day', 'week', 'month', 'year'] as const;
export type NetWorthPeriod = (typeof NET_WORTH_PERIODS)[number];

/**
 * GET /api/net-worth/history query: `period` (a month when not given), `fill_gaps` (true when
 * not given: a period with no snapshot of its own shows the one before), and `limit`, how
 * many periods (30 when not given; at most 3660, ten years of days and the All Time chart's
 * 1000 months; read as pagination reads one, never refused).
 */
export const netWorthHistoryQuery = z.object({
  period: queryEnum(NET_WORTH_PERIODS, { default: 'month' }),
  fill_gaps: queryBoolean({ default: true }),
  limit: queryInt({ min: 1, max: 3660, default: 30 }),
});
export type NetWorthHistoryQuery = z.infer<typeof netWorthHistoryQuery>;
