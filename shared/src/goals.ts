import { z } from 'zod';
import { calendarDay, isPositiveDecimal, moneyInput, queryCalendarDay, queryEnum, queryInt, rowIdInput } from './primitives.js';
import { budgetItemStatus } from './vocabulary.js';

/**
 * Goals entity (response coercion focus, for goal amounts).
 * All numeric fields are lenient (coerce-if-present, allow null/absent) so a
 * partial goal payload never fails to coerce.
 */

/**
 * POST /api/goals body. Mirrors the route's validation: name, target_amount
 * (> 0), and target_date are required; the rest optional with a status default.
 * The amounts are a number or decimal text, as sent (moneyInput): the route reads
 * them in cents, so 12.345 or "1e2" is refused rather than rounded or read as 100.
 */
export const goalCreateSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().nullable().optional(),
  target_amount: moneyInput('Target amount must be a number').refine(isPositiveDecimal, 'Target amount must be greater than 0'),
  // A real day (calendarDay): 2026-02-30 was the database's error, a 500.
  target_date: z.string({ error: 'target_date is required' }).min(1, 'target_date is required').pipe(calendarDay),
  estimated_monthly_contribution: moneyInput('estimated_monthly_contribution must be a number').nullable().optional(),
  // budget_items.status's CHECK: anything else was a database error (a 500).
  status: budgetItemStatus.default('active'),
});
export type GoalCreateInput = z.infer<typeof goalCreateSchema>;
/** What a client sends to create a goal: null, or left out, where the route takes either. */
export type GoalCreateRequest = z.input<typeof goalCreateSchema>;

/** PUT /api/goals/:uuid body: the fields to change, each read as POST reads it. */
export const goalUpdateSchema = goalCreateSchema.extend({ status: budgetItemStatus }).partial();
export type GoalUpdateInput = z.infer<typeof goalUpdateSchema>;
export type GoalUpdateRequest = z.input<typeof goalUpdateSchema>;

/** POST /api/goals/:uuid/accounts body: the account to link, by its id. */
export const goalAccountLinkSchema = z.object({
  account_id: rowIdInput('account_id is required'),
});

/** POST /api/goals/:uuid/budget-items body: the envelope to link, by its id. */
export const goalBudgetItemLinkSchema = z.object({
  budget_item_id: rowIdInput('budget_item_id is required'),
});

/** GET /api/goals/:uuid/progress-history: the range, each end a calendar date (calendarDay's years). */
export const goalProgressHistoryQuery = z.object({
  start_date: queryCalendarDay(),
  end_date: queryCalendarDay(),
});

/** The steps a goal's balance history is drawn at. */
export const GOAL_HISTORY_PERIODS = ['day', 'week', 'month', 'year'] as const;

/** GET /api/goals/:uuid/balance-history and /account-balance-history: `limit` steps of `period` back from today. */
export const goalBalanceHistoryQuery = z.object({
  // At most ten years of days.
  limit: queryInt({ min: 0, max: 3660, default: 36 }),
  period: queryEnum(GOAL_HISTORY_PERIODS, { default: 'month' }),
});

// The goal answers' schemas are in budgetResponses.ts.
