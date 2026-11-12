/**
 * API Budgets Module - Budget Operations
 *
 * Handles all budget-related API operations:
 * - Budget Items (CRUD operations)
 * - Budget Periods (CRUD and status management)
 * - Event-sourced budget operations (updates, transfers)
 * - Budget period items and summaries
 * - Budget item matching rules
 *
 * Every answer is read with its `@nuggets/shared` response schema (parseAnswer),
 * and every query string is built from the route's own query schema (queryString).
 */

import { z } from 'zod';
import {
  budgetAmountUpdatedResponseSchema,
  budgetEventHistoryResponseSchema,
  budgetEventsQuery,
  budgetItemActivityResponseSchema,
  budgetItemAssignedTransactionsResponseSchema,
  budgetItemMatchingRuleListResponseSchema,
  budgetItemMatchingRuleResponseSchema,
  budgetItemMatchingRulesQuery,
  budgetItemMergeResponseSchema,
  budgetItemResponseSchema,
  budgetItemTransferResponseSchema,
  budgetItemUsageResponseSchema,
  budgetPeriodCreatedResponseSchema,
  budgetPeriodDeletedResponseSchema,
  budgetPeriodItemsQuery,
  budgetPeriodItemsResponseSchema,
  budgetPeriodListResponseSchema,
  budgetPeriodManagedCreatedResponseSchema,
  budgetPeriodManagementResponseSchema,
  envelopeTransfersResponseSchema,
  messageResponseSchema,
  queryString,
  type BudgetItemCreateRequest,
  type BudgetItemMatchingRuleInput,
  type BudgetItemRequest,
  type BudgetItemUsage,
  type BudgetPeriodsManagementResponse,
  type CreateManagedBudgetPeriodResult,
  type EnvelopeTransferData,
  type MergeBudgetItemInput,
} from '@nuggets/shared';
import { apiDelete, apiGet, apiPost, apiPut } from './base';
import { parseAnswer } from './parseAnswer';
import type {
  BudgetItem,
  BudgetPeriod,
  BudgetItemActivityEntry,
  BudgetItemAssignedTransaction,
  BudgetItemMatchingRule,
} from './types';

export type {
  BudgetPeriodManagement,
  BudgetPeriodsManagementResponse,
  CreateManagedBudgetPeriodResult,
  EnvelopeTransferData,
} from '@nuggets/shared';

// ====================================================================
// BUDGET ITEMS
// ====================================================================

/** Every budget item, with its category's name. */
export const getBudgetItems = async (): Promise<BudgetItem[]> =>
  parseAnswer(z.array(budgetItemResponseSchema), await apiGet<unknown>('/budgets/items'), 'budget items');

/** Create a budget item: its name, and the fields to set (null or left out where the API takes either). */
export const createBudgetItem = async (data: BudgetItemCreateRequest): Promise<BudgetItem> =>
  parseAnswer(budgetItemResponseSchema, await apiPost<unknown>('/budgets/items', data), 'budget item');

/** Change a budget item's fields: those left out keep what the item holds. */
export const updateBudgetItem = async (uuid: string, data: BudgetItemRequest): Promise<BudgetItem> =>
  parseAnswer(budgetItemResponseSchema, await apiPut<unknown>(`/budgets/items/${uuid}`, data), 'budget item');

/** Delete a budget item nothing references (else 409: archive or merge it). */
export const deleteBudgetItem = async (uuid: string): Promise<{ message: string }> =>
  parseAnswer(messageResponseSchema, await apiDelete<unknown>(`/budgets/items/${uuid}`), 'budget item deleted');

/** What archiving, deleting or merging a budget item touches. */
export const getBudgetItemUsage = async (uuid: string): Promise<BudgetItemUsage> =>
  parseAnswer(budgetItemUsageResponseSchema, await apiGet<unknown>(`/budgets/items/${uuid}/usage`), 'budget item usage');

/** Hide a budget item from new work, keeping its history. Refused while an envelope holds money. */
export const archiveBudgetItem = async (uuid: string): Promise<{ message: string }> =>
  parseAnswer(messageResponseSchema, await apiPost<unknown>(`/budgets/items/${uuid}/archive`), 'budget item archived');

export const restoreBudgetItem = async (uuid: string): Promise<{ message: string }> =>
  parseAnswer(messageResponseSchema, await apiPost<unknown>(`/budgets/items/${uuid}/restore`), 'budget item restored');

/** Move a budget item's transactions (and rules) to another, then archive it. */
export const mergeBudgetItem = async (uuid: string, body: MergeBudgetItemInput): Promise<{ transactions: number; rules: number }> =>
  parseAnswer(budgetItemMergeResponseSchema, await apiPost<unknown>(`/budgets/items/${uuid}/merge`, body), 'budget item merge');

// ====================================================================
// BUDGET PERIODS
// ====================================================================

/** Every budget period, oldest first. */
export const getBudgetPeriods = async (): Promise<BudgetPeriod[]> =>
  parseAnswer(budgetPeriodListResponseSchema, await apiGet<unknown>('/budgets/periods'), 'budget periods');

/**
 * Create a budget period. Answers with the new period's row and how many of its items were
 * created; 409 BUDGET_PERIOD_EXISTS when the ledger already has the month.
 */
export const createBudgetPeriod = async (year: number, month: number): Promise<BudgetPeriod & { budgetItemsCreated: number }> =>
  parseAnswer(budgetPeriodCreatedResponseSchema, await apiPost<unknown>('/budgets/periods', { year, month }), 'budget period');

/** Delete a budget period: its items and events go, its transactions stay, with no period. */
export const deleteBudgetPeriod = async (periodUuid: string): Promise<z.infer<typeof budgetPeriodDeletedResponseSchema>> =>
  parseAnswer(budgetPeriodDeletedResponseSchema, await apiDelete<unknown>(`/budget-periods/${periodUuid}`), 'budget period deleted');

/**
 * Get budget periods with management metadata (counts + stats).
 *
 * Distinct from {@link getBudgetPeriods}: this hits the `/budget-periods/management`
 * endpoint used by the admin Budget Periods page, which returns per-period
 * transaction/item/event counts plus aggregate stats.
 */
export const getBudgetPeriodsManagement = async (): Promise<BudgetPeriodsManagementResponse> =>
  parseAnswer(budgetPeriodManagementResponseSchema, await apiGet<unknown>('/budget-periods/management'), 'budget periods management');

/**
 * Create a budget period with automatic rollover and transaction association.
 *
 * Distinct from {@link createBudgetPeriod}: this hits the `/budget-periods`
 * management endpoint (always enabling rollover + associating existing
 * transactions) and reports how many items/transactions were affected.
 */
export const createManagedBudgetPeriod = async (year: number, month: number): Promise<CreateManagedBudgetPeriodResult> =>
  parseAnswer(
    budgetPeriodManagedCreatedResponseSchema,
    await apiPost<unknown>('/budget-periods', { year, month, auto_rollover: true, associate_transactions: true }),
    'budget period created',
  );

/**
 * Get the envelope savings transfer summary for a budget period.
 *
 * Returns `{ data: EnvelopeTransferData }`. A 404 with code `NO_ENVELOPE_ACCOUNT`
 * (no envelope account configured) is an expected state callers inspect via the
 * thrown ApiError's `code`.
 */
export const getEnvelopeTransfers = async (periodUuid: string): Promise<{ success: true; data: EnvelopeTransferData }> =>
  parseAnswer(
    envelopeTransfersResponseSchema,
    await apiGet<unknown>(`/budgets/periods/${periodUuid}/envelope-transfers`),
    'envelope transfers',
  );

// ====================================================================
// BUDGET PERIOD ITEMS
// ====================================================================

/**
 * The period's items with their event-sourced figures. With a budgetItemUuid the backend
 * computes the (expensive) calculated_* values for only that item.
 */
export const getBudgetPeriodItems = async (periodUuid: string, budgetItemUuid?: string): Promise<z.infer<typeof budgetPeriodItemsResponseSchema>> =>
  parseAnswer(
    budgetPeriodItemsResponseSchema,
    await apiGet<unknown>(`/budgets/periods/${periodUuid}/items${queryString(budgetPeriodItemsQuery, { budget_item_uuid: budgetItemUuid })}`),
    'budget period items',
  );

// ====================================================================
// EVENT-SOURCED BUDGET OPERATIONS
// ====================================================================

/** Set a period item's budget: recorded as an event of the difference. */
export const updateBudgetAmount = async (
  budgetPeriodItemUuid: string,
  amount: number,
  description?: string,
): Promise<z.infer<typeof budgetAmountUpdatedResponseSchema>> =>
  parseAnswer(
    budgetAmountUpdatedResponseSchema,
    await apiPut<unknown>(`/budgets/period-items/${budgetPeriodItemUuid}/budget`, { amount, description }),
    'budget amount',
  );

/** Transfer money between budget items within a budget period (named by its uuid). */
export const transferBetweenBudgetItems = async (
  periodUuid: string,
  fromBudgetPeriodItemId: number,
  toBudgetPeriodItemId: number,
  amount: number,
  description?: string,
): Promise<z.infer<typeof budgetItemTransferResponseSchema>> =>
  parseAnswer(
    budgetItemTransferResponseSchema,
    await apiPost<unknown>(`/budget-periods/${encodeURIComponent(periodUuid)}/transfer`, {
      fromBudgetPeriodItemId,
      toBudgetPeriodItemId,
      amount,
      description,
    }),
    'budget transfer',
  );

/** The budget event log: one item's, one period's, or both, the latest `limit` events. */
export const getBudgetEventHistory = async (
  budgetItemUuid?: string,
  periodUuid?: string,
  limit: number = 100,
): Promise<z.infer<typeof budgetEventHistoryResponseSchema>> =>
  parseAnswer(
    budgetEventHistoryResponseSchema,
    await apiGet<unknown>(`/budgets/events${queryString(budgetEventsQuery, { budget_item_uuid: budgetItemUuid, period_uuid: periodUuid, limit })}`),
    'budget events',
  );

// ====================================================================
// BUDGET ITEM MATCHING RULES
// ====================================================================

/** Every budget item matching rule, with its item's and merchant's names. */
export const getBudgetItemMatchingRules = async (): Promise<BudgetItemMatchingRule[]> =>
  parseAnswer(budgetItemMatchingRuleListResponseSchema, await apiGet<unknown>('/budgets/item-matching-rules'), 'budget item matching rules');

/** One budget item's matching rules. */
export const getBudgetItemMatchingRulesByBudgetItem = async (budgetItemUuid: string): Promise<BudgetItemMatchingRule[]> =>
  parseAnswer(
    budgetItemMatchingRuleListResponseSchema,
    await apiGet<unknown>(`/budgets/item-matching-rules${queryString(budgetItemMatchingRulesQuery, { budget_item_uuid: budgetItemUuid })}`),
    'budget item matching rules',
  );

/** Create a budget item matching rule (the create and update answers carry the rule alone, without the names). */
export const createBudgetItemMatchingRule = async (data: BudgetItemMatchingRuleInput): Promise<z.infer<typeof budgetItemMatchingRuleResponseSchema>> =>
  parseAnswer(budgetItemMatchingRuleResponseSchema, await apiPost<unknown>('/budgets/item-matching-rules', data), 'budget item matching rule');

/** Replace a budget item matching rule: the body is checked as a new rule's is. */
export const updateBudgetItemMatchingRule = async (
  uuid: string,
  data: BudgetItemMatchingRuleInput,
): Promise<z.infer<typeof budgetItemMatchingRuleResponseSchema>> =>
  parseAnswer(budgetItemMatchingRuleResponseSchema, await apiPut<unknown>(`/budgets/item-matching-rules/${uuid}`, data), 'budget item matching rule');

/** Delete a budget item matching rule (204, no answer). */
export const deleteBudgetItemMatchingRule = async (uuid: string): Promise<void> => {
  await apiDelete<void>(`/budgets/item-matching-rules/${uuid}`);
};

// ====================================================================
// BUDGET ITEM ACTIVITY
// ====================================================================

/** Budget activity (transfers, budget updates) of a budget period item (by its uuid), newest first. */
export const getBudgetItemActivity = async (budgetPeriodItemUuid: string): Promise<BudgetItemActivityEntry[]> =>
  parseAnswer(
    budgetItemActivityResponseSchema,
    await apiGet<unknown>(`/budget-periods/items/${encodeURIComponent(budgetPeriodItemUuid)}/budget-activity`),
    'budget item activity',
  );

/** The transactions of a budget period item (by its uuid), newest first. */
export const getBudgetItemTransactions = async (budgetPeriodItemUuid: string): Promise<BudgetItemAssignedTransaction[]> =>
  parseAnswer(
    budgetItemAssignedTransactionsResponseSchema,
    await apiGet<unknown>(`/budget-periods/items/${encodeURIComponent(budgetPeriodItemUuid)}/transactions`),
    'budget item transactions',
  );
