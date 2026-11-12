import {
  budgetItemHistoryQuery,
  budgetItemHistoryResponseSchema,
  merchantSpendingResponseSchema,
  queryString,
  type BudgetItemHistory,
  type MerchantSpending as SharedMerchantSpending,
} from '@nuggets/shared';
import { apiGet } from './base';
import { parseAnswer } from './parseAnswer';

/**
 * One-request summaries for the detail pages. Amounts are NUMERIC on the
 * server and arrive as strings: coerce them where they're drawn.
 */

/** A budget item's figures over its recent periods and in the current one: budgetItemHistoryResponseSchema. */
export type { BudgetItemHistory, BudgetItemPeriodFigures } from '@nuggets/shared';

/** GET /budget-items/:uuid/history (base.ts adds /api). The figures are read as numbers. */
export const getBudgetItemHistory = async (uuid: string, periods?: number): Promise<BudgetItemHistory> =>
  parseAnswer(
    budgetItemHistoryResponseSchema,
    await apiGet<unknown>(`/budget-items/${encodeURIComponent(uuid)}/history${queryString(budgetItemHistoryQuery, { periods })}`),
    'budget item history',
  );

/** GET /merchant-spending/:uuid: merchantSpendingResponseSchema, its totals read as numbers. */
export type MerchantSpending = SharedMerchantSpending;

/** GET /merchant-spending/:uuid (base.ts adds /api). */
export const getMerchantSpending = async (uuid: string): Promise<MerchantSpending> =>
  parseAnswer(merchantSpendingResponseSchema, await apiGet<unknown>(`/merchant-spending/${encodeURIComponent(uuid)}`), 'merchant spending');

/** A budget item's current-period figures as numbers, the shape its cards draw. */
export interface CurrentPeriodFigures {
  calculated_budget: number;
  calculated_actual: number;
  calculated_remaining: number;
  calculated_transfers: number;
}

const amountOf = (value: number | string | null | undefined): number => Number(value ?? 0) || 0;

/** The current period's figures from a history answer, or null without a row there. */
export function currentPeriodFigures(history: BudgetItemHistory | undefined): CurrentPeriodFigures | null {
  const current = history?.current;
  if (!current) return null;
  return {
    calculated_budget: amountOf(current.budget),
    calculated_actual: amountOf(current.actual),
    calculated_remaining: amountOf(current.remaining),
    calculated_transfers: amountOf(current.transfers),
  };
}
