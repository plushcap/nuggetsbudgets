/**
 * API Goals Module - Goal Tracking Operations
 *
 * Handles all goal-related API operations:
 * - Goal CRUD operations
 * - Goal associations (accounts, budget items)
 * - Progress tracking and history
 * - Goal images
 *
 * Every answer is read with its `@nuggets/shared` response schema (parseAnswer),
 * and every query string is built from the route's own query schema (queryString).
 */

import { z } from 'zod';
import {
  goalAccountBalanceHistoryResponseSchema,
  goalBalanceHistoryQuery,
  goalBalanceHistoryResponseSchema,
  goalImageResponseSchema,
  goalListResponseSchema,
  goalOneResponseSchema,
  messageResponseSchema,
  queryString,
  type GOAL_HISTORY_PERIODS,
} from '@nuggets/shared';
import { apiDelete, apiGet, apiPost, apiPostFormData, apiPut } from './base';
import { parseAnswer } from './parseAnswer';
import type { Goal, CreateGoalRequest, UpdateGoalRequest } from './types';

type GoalHistoryPeriod = (typeof GOAL_HISTORY_PERIODS)[number];

// ====================================================================
// GOAL CRUD OPERATIONS
// ====================================================================

/** Every goal with its current progress. */
export const getGoals = async (): Promise<{ goals: Goal[] }> =>
  parseAnswer(goalListResponseSchema, await apiGet<unknown>('/goals'), 'goals');

/** One goal by its uuid, with its links, history and projection. */
export const getGoal = async (uuid: string): Promise<{ goal: Goal }> =>
  parseAnswer(goalOneResponseSchema, await apiGet<unknown>(`/goals/${uuid}`), 'goal');

/** Create a goal (null or left out where the route takes either). */
export const createGoal = async (data: CreateGoalRequest): Promise<{ goal: Goal }> =>
  parseAnswer(goalOneResponseSchema, await apiPost<unknown>('/goals', data), 'goal');

/** Change a goal's fields. */
export const updateGoal = async (uuid: string, data: UpdateGoalRequest): Promise<{ goal: Goal }> =>
  parseAnswer(goalOneResponseSchema, await apiPut<unknown>(`/goals/${uuid}`, data), 'goal');

// ====================================================================
// GOAL ASSOCIATIONS
// ====================================================================

/** Link an account to a goal, from today. */
export const associateAccountWithGoal = async (goalUuid: string, accountId: number): Promise<{ message: string }> =>
  parseAnswer(messageResponseSchema, await apiPost<unknown>(`/goals/${goalUuid}/accounts`, { account_id: accountId }), 'goal account link');

/** Unlink an account (named by its uuid) from a goal, from today. */
export const removeAccountFromGoal = async (goalUuid: string, accountUuid: string): Promise<{ message: string }> =>
  parseAnswer(
    messageResponseSchema,
    await apiDelete<unknown>(`/goals/${goalUuid}/accounts/${encodeURIComponent(accountUuid)}`),
    'goal account unlink',
  );

/** Link a budget item (envelope) to a goal, from today. */
export const associateBudgetItemWithGoal = async (goalUuid: string, budgetItemId: number): Promise<{ message: string }> =>
  parseAnswer(
    messageResponseSchema,
    await apiPost<unknown>(`/goals/${goalUuid}/budget-items`, { budget_item_id: budgetItemId }),
    'goal envelope link',
  );

/** Unlink an envelope (named by its uuid) from a goal, from today. */
export const removeBudgetItemFromGoal = async (goalUuid: string, budgetItemUuid: string): Promise<{ message: string }> =>
  parseAnswer(
    messageResponseSchema,
    await apiDelete<unknown>(`/goals/${goalUuid}/budget-items/${encodeURIComponent(budgetItemUuid)}`),
    'goal envelope unlink',
  );

// ====================================================================
// GOAL IMAGES
// ====================================================================

/** Upload an image for a goal. */
export const uploadGoalImage = async (goalUuid: string, imageFile: File): Promise<{ message: string; image_path: string }> => {
  const formData = new FormData();
  formData.append('image', imageFile);
  // Shared FormData helper attaches the X-CSRF-Token header (and omits Content-Type).
  return parseAnswer(goalImageResponseSchema, await apiPostFormData<unknown>(`/goals/${goalUuid}/image`, formData), 'goal image');
};

/** Delete a goal's image. */
export const deleteGoalImage = async (goalUuid: string): Promise<{ message: string }> =>
  parseAnswer(messageResponseSchema, await apiDelete<unknown>(`/goals/${goalUuid}/image`), 'goal image deleted');

/** The goal's linked accounts' total, `limit` steps of `period` back from today. */
export const getGoalBalanceHistory = async (
  goalUuid: string,
  period: GoalHistoryPeriod = 'month',
  limit: number = 36,
): Promise<z.infer<typeof goalBalanceHistoryResponseSchema>> =>
  parseAnswer(
    goalBalanceHistoryResponseSchema,
    await apiGet<unknown>(`/goals/${goalUuid}/balance-history${queryString(goalBalanceHistoryQuery, { period, limit })}`),
    'goal balance history',
  );

/** Each linked account's balance, `limit` steps of `period` back from today. */
export const getGoalAccountBalanceHistory = async (
  goalUuid: string,
  period: GoalHistoryPeriod = 'month',
  limit: number = 36,
): Promise<z.infer<typeof goalAccountBalanceHistoryResponseSchema>> =>
  parseAnswer(
    goalAccountBalanceHistoryResponseSchema,
    await apiGet<unknown>(`/goals/${goalUuid}/account-balance-history${queryString(goalBalanceHistoryQuery, { period, limit })}`),
    'goal account balance history',
  );
