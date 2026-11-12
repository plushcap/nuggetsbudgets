import { z } from 'zod';
import {
  dayText,
  instant,
  nullableDayText,
  nullableInstant,
  nullableResponseAmount,
  nullableResponseDecimal,
  responseAmount,
  storedValue,
} from './responses.js';
import { accountGroup, accountType } from './primitives.js';
import {
  BUDGET_EVENT_TRANSACTION_TYPES,
  BUDGET_EVENT_TYPES,
  BUDGET_EXPENSE_TYPES,
  BUDGET_PRIORITIES,
  TRANSACTION_TYPES,
  budgetItemStatus,
} from './vocabulary.js';
import { budgetItemMatchingRuleMethod } from './budgets.js';

/**
 * The budget, budget-period and goal answers. Each names every field
 * its route answers, so a parse checks each and one the schema doesn't name fails the
 * route tests (`answerProblem`); NUMERIC columns are read as numbers. The request schemas
 * are in budgets.ts and goals.ts.
 */

/** A count pg sends as text (COUNT(*) is a bigint), read as a number. */
const countText = z
  .union([z.number().int(), z.string().regex(/^\d+$/)])
  .transform(Number);

/** budget_items.expense_type and .priority: today's values, or one an item kept from before them. */
const expenseType = storedValue(BUDGET_EXPENSE_TYPES).nullable();
const priority = storedValue(BUDGET_PRIORITIES).nullable();

/**
 * A budget item (the template) as `GET /api/budgets/items` lists it (with its category's
 * name) and the create and update answers carry it.
 */
export const budgetItemResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  tenant_id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  expense_type: expenseType,
  priority,
  /** Free text: the MCP tools take any label here. */
  type: z.string().nullable(),
  subtype: z.string().nullable(),
  status: budgetItemStatus.nullable(),
  rollover: z.boolean(),
  isbill: z.boolean(),
  recurring_payment: z.boolean(),
  recurring_amount_varies: z.boolean(),
  default_budget_amount: nullableResponseAmount,
  rollover_starting_balance: nullableResponseAmount,
  rollover_starting_balance_date: nullableDayText,
  rollover_target_amount: nullableResponseAmount,
  rollover_target_date: nullableDayText,
  recurring_payment_frequency: z.number().int().nullable(),
  recurring_payment_amount: nullableResponseAmount,
  recurring_last_payment_date: nullableDayText,
  recurring_next_payment_date: nullableDayText,
  goal_target_amount: nullableResponseAmount,
  goal_target_date: nullableDayText,
  notes: z.string().nullable(),
  instructions: z.string().nullable(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  image_path: z.string().nullable(),
  merchant_id: z.number().int().nullable(),
  category_id: z.number().int().nullable(),
  transaction_auto_tag_id: z.number().int().nullable(),
  created_at: instant,
  updated_at: nullableInstant,
  /** The list only. */
  category_name: z.string().nullable().optional(),
});
export type BudgetItemResponse = z.infer<typeof budgetItemResponseSchema>;

/** A budget period: `GET /api/budgets/periods` lists them, oldest first. */
export const budgetPeriodResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  tenant_id: z.number().int(),
  name: z.string(),
  month: z.string(),
  year: z.number().int(),
  month_number: z.number().int(),
  start_date: dayText,
  end_date: dayText,
  status: storedValue(['active', 'closed', 'upcoming'] as const).nullable(),
  created_at: instant,
  updated_at: nullableInstant,
});
export type BudgetPeriodResponse = z.infer<typeof budgetPeriodResponseSchema>;
export const budgetPeriodListResponseSchema = z.array(budgetPeriodResponseSchema);

/**
 * A budget period item, with its item's fields and the event-sourced figures computed from
 * the budget event log (never stored): `GET /api/budgets/periods/:uuid/items` (`data`).
 */
export const budgetPeriodItemResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  tenant_id: z.number().int(),
  budget_period_id: z.number().int(),
  budget_item_id: z.number().int(),
  budget_item_uuid: z.uuid(),
  budget_item_name: z.string(),
  starting: nullableResponseAmount,
  calculated_budget: responseAmount,
  calculated_actual: responseAmount,
  calculated_transfers: responseAmount,
  calculated_remaining: responseAmount,
  expense_type: expenseType,
  priority,
  type: z.string().nullable(),
  subtype: z.string().nullable(),
  status: budgetItemStatus.nullable(),
  rollover: z.boolean(),
  rollover_target_amount: nullableResponseAmount,
  isbill: z.boolean(),
  goal_target_amount: nullableResponseAmount,
  goal_target_date: nullableDayText,
  image_path: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  category_name: z.string().nullable(),
  created_at: instant,
  updated_at: nullableInstant,
});
export type BudgetPeriodItemResponse = z.infer<typeof budgetPeriodItemResponseSchema>;
export const budgetPeriodItemsResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(budgetPeriodItemResponseSchema),
});

/** One item of `GET /api/budgets/periods/:uuid/summary` (camelCase computed amounts). */
export const budgetPeriodSummaryResponseSchema = z.object({
  budgetItemId: z.number().int(),
  budgetItemName: z.string(),
  rolloverEnabled: z.boolean(),
  startingAmount: responseAmount,
  budgetAmount: responseAmount,
  actualAmount: responseAmount,
  transfersAmount: responseAmount,
  remainingAmount: responseAmount,
});
export type BudgetPeriodSummaryResponse = z.infer<typeof budgetPeriodSummaryResponseSchema>;
export const budgetPeriodSummaryListResponseSchema = z.object({ summary: z.array(budgetPeriodSummaryResponseSchema) });

/** An account linked to a goal, as one goal (`GET /api/goals/:uuid`) lists them. */
export const goalAccountResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  account_type: storedValue(accountType.options),
  account_group: storedValue(accountGroup.options),
  subtype: z.string().nullable(),
  icon: z.string().nullable(),
  /** null when the balance couldn't be computed (`balance_unavailable`): "Unavailable", never $0. */
  calculated_balance: nullableResponseAmount,
  balance_unavailable: z.boolean(),
  associated_at: instant,
  /** The day the link counts from (goal links have valid_from/valid_to). */
  linked_since: dayText,
});

/** An envelope linked to a goal, as one goal lists them. */
export const goalBudgetItemResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  rollover_starting_balance: nullableResponseAmount,
  associated_at: instant,
  linked_since: dayText,
});

/** A goal's progress at the end of one day, computed when it is read: decimal text. */
export const goalProgressSnapshotResponseSchema = z.object({
  snapshot_date: dayText,
  total_from_accounts: z.string(),
  total_from_budget_items: z.string(),
  total_progress: z.string(),
});

/** When a goal's target is reached at its past pace and at its planned contribution. */
export const goalProjectionResponseSchema = z.object({
  currentProgress: responseAmount,
  /** null for a goal with no target (one made through the budget item routes), and then so are the rest. */
  targetAmount: nullableResponseAmount,
  remainingAmount: nullableResponseAmount,
  pastPerformanceMonths: z.number().int().nullable(),
  plannedContributionMonths: z.number().int().nullable(),
  pastPerformanceDate: nullableDayText,
  plannedContributionDate: nullableDayText,
});

/**
 * A goal as the list (`GET /api/goals`: with its progress, link counts and projected date),
 * one goal (`GET /api/goals/:uuid`: with its progress, links, history and projection) and
 * the create and update answers (the row alone) carry it.
 */
export const goalResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  /**
   * null for a goal made through the budget item routes (`POST /api/budgets/items` with
   * Savings/Goal, or an item changed to one), which set no target or date. The
   * goal routes require both. With no target, progress_percentage, remaining_amount and the
   * projection's figures are null too.
   */
  target_amount: nullableResponseAmount,
  target_date: nullableDayText,
  estimated_monthly_contribution: nullableResponseAmount,
  image_path: z.string().nullable(),
  status: budgetItemStatus,
  created_at: instant,
  updated_at: nullableInstant,
  // Computed when a goal is read (the list and one goal; the create and update answers are the bare row).
  current_progress: responseAmount.optional(),
  total_from_accounts: responseAmount.optional(),
  total_from_budget_items: responseAmount.optional(),
  /** Of the target, 0 to 100 (or more), not rounded to cents; null without a target. */
  progress_percentage: nullableResponseDecimal.optional(),
  remaining_amount: nullableResponseAmount.optional(),
  // The list.
  account_count: countText.optional(),
  budget_item_count: countText.optional(),
  projected_completion_date: nullableDayText.optional(),
  // One goal.
  associated_accounts: z.array(goalAccountResponseSchema).optional(),
  associated_budget_items: z.array(goalBudgetItemResponseSchema).optional(),
  progress_history: z.array(goalProgressSnapshotResponseSchema).optional(),
  projection: goalProjectionResponseSchema.optional(),
});
export type GoalResponse = z.infer<typeof goalResponseSchema>;
export const goalListResponseSchema = z.object({ goals: z.array(goalResponseSchema) });
export const goalOneResponseSchema = z.object({ goal: goalResponseSchema });

// ---- The other budget, budget-period, goal and Close-Out answers -------------------------

/** A `{ message }` answer: an item archived, restored or deleted, an account or envelope linked to a goal or unlinked. */
export const messageResponseSchema = z.object({ message: z.string() });

/** A goal that links a budget item, now or before; `deleted` once DELETE /api/goals/:uuid archived it. */
export const linkedGoalResponseSchema = z.object({
  uuid: z.uuid(),
  name: z.string(),
  deleted: z.boolean(),
});
export type LinkedGoal = z.infer<typeof linkedGoalResponseSchema>;

/** GET /api/budgets/items/:uuid/usage: what archiving, deleting or merging an item touches. */
export const budgetItemUsageResponseSchema = z.object({
  transactions: z.number().int(),
  first_transaction_date: nullableDayText,
  last_transaction_date: nullableDayText,
  rules: z.number().int(),
  budget_periods: z.number().int(),
  /** Receipts and documents attached to it: they keep it from being deleted. */
  attachments: z.number().int(),
  /** An envelope's balance now; 0 for an item that doesn't roll over. Archiving needs 0. */
  balance: responseAmount,
  archived: z.boolean(),
  /** Nothing references it, so it can be deleted outright. */
  can_delete: z.boolean(),
  /**
   * It has money recorded in a period before the current one (a budget event or a transaction
   * the figures count), so whether it rolls over can't change: 409
   * ROLLOVER_LOCKED.
   */
  history_before_current_period: z.boolean(),
  /**
   * The goals that link it, now or before (any range), each once, by name: while there are any,
   * a merge into an item that doesn't roll over is refused, 409 MERGE_UNLINKS_GOALS.
   */
  linked_goals: z.array(linkedGoalResponseSchema),
});
export type BudgetItemUsage = z.infer<typeof budgetItemUsageResponseSchema>;

/**
 * The words of a MERGE_UNLINKS_GOALS refusal, which the merge dialog shows before the person
 * confirms, from the goals that count the item. A goal counts only envelopes, so
 * the item merges only into one; that is always the way through. A deleted goal (DELETE
 * /api/goals/:uuid archives it and keeps its links) keeps its history too, so it counts as well,
 * and unlinking a goal doesn't help: its past readings keep the link.
 */
export function mergeUnlinksGoalsMessage(itemName: string, intoName: string, goals: readonly LinkedGoal[]): string {
  const one = goals.length === 1;
  const names = goals.map((goal) => (goal.deleted ? `${goal.name} (deleted)` : goal.name)).join(', ');
  const deleted = goals.some((goal) => goal.deleted);
  return (
    `${itemName} counts toward ${one ? 'the goal' : 'the goals'} ${names}, and ${intoName} isn’t an envelope, which a goal can’t count. ` +
    `Merging would take its money out of ${one ? 'that goal’s' : 'those goals’'} history, so merge it into an envelope instead.` +
    (deleted
      ? ` A deleted goal keeps its history, so it counts as well; unlinking a goal doesn’t help either, since its past readings keep the link.`
      : ` Unlinking ${one ? 'the goal' : 'the goals'} doesn’t help: ${one ? 'its' : 'their'} past readings keep the link.`)
  );
}

/** POST /api/budgets/items/:uuid/merge: how many transactions and rules moved. */
export const budgetItemMergeResponseSchema = z.object({
  transactions: z.number().int(),
  rules: z.number().int(),
});

/** A budget item's figures in one period, from the event-sourced calculate_* functions (decimal text). */
export const budgetItemPeriodFiguresResponseSchema = z.object({
  period_uuid: z.uuid(),
  period_name: z.string(),
  month: z.string(),
  month_number: z.number().int(),
  year: z.number().int(),
  start_date: dayText,
  end_date: dayText,
  status: storedValue(['active', 'closed', 'upcoming'] as const).nullable(),
  budget: responseAmount,
  actual: responseAmount,
  transfers: responseAmount,
  remaining: responseAmount,
});
export type BudgetItemPeriodFigures = z.infer<typeof budgetItemPeriodFiguresResponseSchema>;

/** GET /api/budget-items/:uuid/history: the item's figures over its recent periods, and in the current one. */
export const budgetItemHistoryResponseSchema = z.object({
  budget_item_uuid: z.uuid(),
  /** The item's figures in the ledger's last N periods, oldest first (by start_date). */
  periods: z.array(budgetItemPeriodFiguresResponseSchema),
  /** Its figures in the period holding the household's today; null when it has no row there. */
  current: budgetItemPeriodFiguresResponseSchema.nullable(),
});
export type BudgetItemHistory = z.infer<typeof budgetItemHistoryResponseSchema>;
/** The history as the backend sends it (its figures as decimal text). */
export type BudgetItemHistoryAnswer = z.input<typeof budgetItemHistoryResponseSchema>;

/** POST /api/budgets/periods: the new period's row, and how many of its items were created. */
export const budgetPeriodCreatedResponseSchema = budgetPeriodResponseSchema.extend({
  budgetItemsCreated: z.number().int(),
});

/** One period of `GET /api/budget-periods/management`, with its counts (COUNT(*), sent as text). */
export const budgetPeriodManagementRowResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  year: z.number().int(),
  month_number: z.number().int(),
  start_date: dayText,
  end_date: dayText,
  transaction_count: countText,
  budget_item_count: countText,
  budget_transaction_count: countText,
});
export type BudgetPeriodManagement = z.infer<typeof budgetPeriodManagementRowResponseSchema>;

/** GET /api/budget-periods/management: every period with its counts, and their span (null years without periods). */
export const budgetPeriodManagementResponseSchema = z.object({
  periods: z.array(budgetPeriodManagementRowResponseSchema),
  stats: z.object({
    total_periods: countText,
    earliest_year: z.number().int().nullable(),
    latest_year: z.number().int().nullable(),
  }),
});
export type BudgetPeriodsManagementResponse = z.infer<typeof budgetPeriodManagementResponseSchema>;

/** POST /api/budget-periods: the period made, its items, and the transactions it took in. */
export const budgetPeriodManagedCreatedResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  period_id: z.number().int(),
  budget_items_created: z.number().int(),
  transactions_associated: z.number().int(),
});
export type CreateManagedBudgetPeriodResult = z.infer<typeof budgetPeriodManagedCreatedResponseSchema>;

/** DELETE /api/budget-periods/:uuid: what went with the period. */
export const budgetPeriodDeletedResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  budget_items_deleted: z.number().int(),
  budget_transactions_deleted: z.number().int(),
  transactions_unassociated: z.number().int(),
});

/** GET /api/budgets/periods/:uuid/envelope-transfers (`data`): the envelope account's transfers in the period. */
export const envelopeTransfersResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    envelope_account: z.object({ id: z.number().int(), uuid: z.uuid(), name: z.string() }),
    /** Pre-signed: positive into the envelopes, negative out. */
    net_transfer_amount: responseAmount,
    transfer_count: z.number().int(),
    transfers: z.array(z.object({
      uuid: z.uuid(),
      date: dayText,
      amount: responseAmount,
      description: z.string().nullable(),
      /** The envelope account's name, and the account the money came from. */
      account_name: z.string().nullable(),
      source_account_name: z.string().nullable(),
    })),
  }),
});
export type EnvelopeTransferData = z.infer<typeof envelopeTransfersResponseSchema>['data'];

/** PUT /api/budgets/period-items/:uuid/budget: the budget event recorded (the difference from the budget before). */
export const budgetAmountUpdatedResponseSchema = z.object({
  success: z.literal(true),
  eventUuid: z.uuid(),
});

/** POST /api/budget-periods/:periodUuid/transfer: the transfer event, and the two items' names. */
export const budgetItemTransferResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  transferUuid: z.uuid(),
  fromItem: z.string(),
  toItem: z.string(),
  /** The amount as sent (a number or decimal text), read as a number. */
  amount: responseAmount,
});

const budgetEventTypeValue = storedValue(BUDGET_EVENT_TYPES);
const budgetEventTransactionTypeValue = storedValue(BUDGET_EVENT_TRANSACTION_TYPES);

/** One budget event of a period item: GET /api/budget-periods/items/:uuid/budget-activity lists them, newest first. */
export const budgetItemActivityEntryResponseSchema = z.object({
  id: z.number().int(),
  type: budgetEventTypeValue,
  transaction_type: budgetEventTransactionTypeValue,
  /** Its size: never negative; transaction_type says which way it went. */
  amount: responseAmount,
  description: z.string().nullable(),
  created_at: instant,
  budget_item_name: z.string(),
});
export type BudgetItemActivityEntry = z.infer<typeof budgetItemActivityEntryResponseSchema>;
export const budgetItemActivityResponseSchema = z.array(budgetItemActivityEntryResponseSchema);

/** One transaction of a period item: GET /api/budget-periods/items/:uuid/transactions lists them, newest first. */
export const budgetItemAssignedTransactionResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  description: z.string().nullable(),
  /** Pre-signed. */
  amount: responseAmount,
  date: dayText,
  account_name: z.string(),
  type: storedValue(TRANSACTION_TYPES),
});
export type BudgetItemAssignedTransaction = z.infer<typeof budgetItemAssignedTransactionResponseSchema>;
export const budgetItemAssignedTransactionsResponseSchema = z.array(budgetItemAssignedTransactionResponseSchema);

/** One event of the budget event log (GET /api/budgets/events `data`), camelCase as BudgetService answers it. */
export const budgetEventHistoryEntryResponseSchema = z.object({
  eventId: z.number().int(),
  timestamp: instant,
  budgetItemName: z.string(),
  /** 'Unknown' for an event outside every period. */
  periodName: z.string(),
  eventType: budgetEventTypeValue,
  transactionType: budgetEventTransactionTypeValue,
  amount: responseAmount,
  description: z.string().nullable(),
  /** Who recorded it: their name, else their email, else 'System'. */
  userName: z.string(),
});
export type BudgetEventHistory = z.infer<typeof budgetEventHistoryEntryResponseSchema>;
export const budgetEventHistoryResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(budgetEventHistoryEntryResponseSchema),
});

/** A budget item matching rule, as the create and update answers carry it. */
export const budgetItemMatchingRuleResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  budget_item_id: z.number().int().nullable(),
  merchant_id: z.number().int().nullable(),
  method: budgetItemMatchingRuleMethod,
  matching_text: z.string().nullable(),
  amount_min: nullableResponseAmount,
  amount_max: nullableResponseAmount,
  priority: z.number().int().nullable(),
  is_active: z.boolean(),
  notes: z.string().nullable(),
  created_at: instant,
  updated_at: nullableInstant,
});

/** A rule as GET /api/budgets/item-matching-rules lists it, with its item's and merchant's names. */
export const budgetItemMatchingRuleListEntryResponseSchema = budgetItemMatchingRuleResponseSchema.extend({
  budget_item_name: z.string().nullable(),
  budget_item_uuid: z.uuid().nullable(),
  budget_item_icon: z.string().nullable(),
  budget_item_color: z.string().nullable(),
  merchant_name: z.string().nullable(),
});
export type BudgetItemMatchingRule = z.infer<typeof budgetItemMatchingRuleListEntryResponseSchema>;
export const budgetItemMatchingRuleListResponseSchema = z.array(budgetItemMatchingRuleListEntryResponseSchema);

/** GET /api/goals/:uuid/progress-history: the goal's progress at each month end of the range, and today. */
export const goalProgressHistoryResponseSchema = z.object({ history: z.array(goalProgressSnapshotResponseSchema) });

/** One step of a goal's balance history. */
const goalBalancePoint = z.object({ date: dayText, balance: responseAmount });

/** GET /api/goals/:uuid/balance-history: its linked accounts' total at each step. */
export const goalBalanceHistoryResponseSchema = z.object({ history: z.array(goalBalancePoint) });

/** GET /api/goals/:uuid/account-balance-history: each linked account's balance at each step. */
export const goalAccountBalanceHistoryResponseSchema = z.object({
  accounts: z.array(z.object({
    account_id: z.number().int(),
    account_uuid: z.uuid(),
    account_name: z.string(),
    history: z.array(goalBalancePoint),
  })),
});

/** POST /api/goals/:uuid/image: where the picture is stored. */
export const goalImageResponseSchema = z.object({ message: z.string(), image_path: z.string() });

// POST /api/transfer/period (Close-Out's "Budget Period Transfer") answers transfers.ts's
// budgetPeriodTransferResponseSchema.
