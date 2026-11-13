import { z } from 'zod';
import {
  CALENDAR_DAY_YEARS,
  INT4_MAX,
  calendarDay,
  decimalProblemMessage,
  isPositiveDecimal,
  moneyInput,
  queryInt,
  queryUuid,
  readDecimal,
  rowIdInput,
  wholeNumberInput,
} from './primitives.js';
import { regexRuleProblem } from './rulePattern.js';
import { budgetExpenseType, budgetPriority } from './vocabulary.js';
import type { BudgetItemResponse } from './budgetResponses.js';

/**
 * Budgets entity: the requests the budget, budget-period and budget-item routes take
 * (each body and query string checked before the handler runs, a 400 naming the
 * field), and response coercion for budget amounts (numeric fields lenient,
 * coerce-if-present, allow null/absent).
 */

const MAX_ROW_ID = INT4_MAX;

/**
 * A budget item's optional calendar date: a real day (calendarDay), so 2026-02-30 is
 * a 400 rather than the database's error (a 500); null, or '' (what a cleared date input
 * sends), for none.
 */
const optionalBudgetItemDay = z.preprocess((value) => (value === '' ? null : value), calendarDay.nullable()).optional();

/** The calendar dates a budget item holds, checked on create and update. */
const budgetItemDays = {
  rollover_target_date: optionalBudgetItemDay,
  rollover_starting_balance_date: optionalBudgetItemDay,
  recurring_next_payment_date: optionalBudgetItemDay,
};

/**
 * A budget item's optional amount: money (moneyInput) its DECIMAL(12,2) column holds as
 * written, so 12.345 is a 400 rather than rounded by the database, and text that isn't a
 * number a 400 rather than the database's error; null, or '' (a cleared field), for none. A
 * form's unreadable amount (NaN, which JSON can't send) is left out, as withUnreadableAmounts
 * (frontend) expects of a field it hides.
 */
const optionalBudgetItemAmount = (field: string) => {
  const message = `${field} must be a number`;
  const amount = moneyInput(message).superRefine((value, context) => {
    const read = readDecimal(value, 2, 12);
    if ('problem' in read) context.addIssue({ code: 'custom', message: decimalProblemMessage(message, read.problem, 2, 12) });
  });
  return z
    .preprocess((value) => (value === '' ? null : Number.isNaN(value) ? undefined : value), amount.nullable().optional())
    .optional();
};

/** The amounts a budget item holds, checked on create and update. */
const budgetItemAmounts = {
  default_budget_amount: optionalBudgetItemAmount('default_budget_amount'),
  recurring_payment_amount: optionalBudgetItemAmount('recurring_payment_amount'),
  rollover_target_amount: optionalBudgetItemAmount('rollover_target_amount'),
  goal_target_amount: optionalBudgetItemAmount('goal_target_amount'),
  // An envelope's starting balance, as the other amounts: one past the column
  // (1e11) or with more than 2 decimals is a 400 VALIDATION_ERROR naming the range or the decimals.
  rollover_starting_balance: optionalBudgetItemAmount('rollover_starting_balance'),
};

/** An optional text field, at most `max` characters (its column's), or null for none. */
const optionalText = (field: string, max?: number) => {
  const text = z.string({ error: `${field} must be text` });
  return (max === undefined ? text : text.max(max, `${field} may be at most ${max} characters`)).nullable().optional();
};

/**
 * An optional flag: true or false, never null (its column is NOT NULL) and never text or a
 * number. Postgres reads "true", "t", "yes", "on" and 1 as true, so a looser check let them
 * flip `rollover` past the type change's checks (the history lock, the empty
 * envelope, the carry-over).
 */
const optionalFlag = (field: string) => z.boolean({ error: `${field} must be true or false` }).optional();

/** A category, merchant or auto-tag id: a number, or text the editor reads (and refuses as INVALID_REFERENCE when it names nothing); null for none. */
const referenceId = (field: string) =>
  z.union([z.number(), z.string()], { error: `${field} must be an id` }).nullable().optional();

/**
 * The other fields a budget item holds, typed on create and update: what the
 * database would cast (text, a number, 1 for a flag) or refuse (null in a NOT NULL column, text
 * past its column's length: a 500) is a 400 VALIDATION_ERROR naming the field. The editor still
 * checks the references and, on update, the vocabulary against the item's own (an older item
 * may send back a legacy value).
 */
const budgetItemFields = {
  description: optionalText('description'),
  type: optionalText('type', 50),
  subtype: optionalText('subtype', 50),
  rollover: optionalFlag('rollover'),
  isbill: optionalFlag('isbill'),
  recurring_payment: optionalFlag('recurring_payment'),
  recurring_amount_varies: optionalFlag('recurring_amount_varies'),
  // Months between payments: at least 1. 0 or less is no schedule (the Bills page
  // leaves such a bill out), so it isn't written; an item holding one from before still reads, and
  // saves while the update leaves the frequency out.
  recurring_payment_frequency: wholeNumberInput(1, MAX_ROW_ID, 'recurring_payment_frequency must be a whole number of months, at least 1')
    .nullable()
    .optional(),
  category_id: referenceId('category_id'),
  merchant_id: referenceId('merchant_id'),
  transaction_auto_tag_id: referenceId('transaction_auto_tag_id'),
  color: optionalText('color', 7),
  icon: optionalText('icon', 100),
  instructions: optionalText('instructions'),
  notes: optionalText('notes'),
};

/** POST /api/budgets/items body. name required; its vocabulary, dates, amounts and other fields checked; others pass through. */
export const budgetItemCreateSchema = z.looseObject({
  name: z.string({ error: 'Budget item name is required' }).trim().min(1, 'Budget item name is required').max(100, 'Budget item name may be at most 100 characters'),
  // The values the database accepts: vocabulary.ts's lists.
  expense_type: budgetExpenseType.optional(),
  priority: budgetPriority.nullable().optional(),
  ...budgetItemFields,
  ...budgetItemDays,
  ...budgetItemAmounts,
});
export type BudgetItemCreateInput = z.infer<typeof budgetItemCreateSchema>;

/**
 * PUT /api/budgets/items/:uuid body: the fields to change. A name, when sent, isn't blank,
 * the dates are real days and the amounts whole cents; the other fields pass through to BudgetItemEditor, which
 * checks the expense type and priority against the item's own (an older item may hold a
 * legacy value, which it may send back unchanged).
 */
export const budgetItemUpdateSchema = z.looseObject({
  name: z.string({ error: 'Budget item name must be text' }).trim().min(1, 'Budget item name is required').max(100, 'Budget item name may be at most 100 characters').optional(),
  expense_type: optionalText('expense_type', 50),
  priority: optionalText('priority', 50),
  ...budgetItemFields,
  ...budgetItemDays,
  ...budgetItemAmounts,
});
export type BudgetItemUpdateInput = z.infer<typeof budgetItemUpdateSchema>;

/**
 * The fields a budget item create or update writes (BudgetItemEditor reads these and ignores
 * the rest of a body). A goal's own fields are the goal routes'.
 */
export const BUDGET_ITEM_WRITABLE_FIELDS = [
  'name', 'description', 'expense_type', 'priority', 'type', 'subtype',
  'rollover', 'isbill', 'recurring_payment', 'recurring_payment_frequency',
  'recurring_payment_amount', 'recurring_next_payment_date', 'recurring_amount_varies',
  'default_budget_amount', 'rollover_target_amount', 'rollover_target_date', 'rollover_starting_balance',
  'rollover_starting_balance_date', 'category_id', 'merchant_id', 'color', 'icon',
  'transaction_auto_tag_id', 'instructions', 'notes',
] as const;
type BudgetItemWritableField = (typeof BUDGET_ITEM_WRITABLE_FIELDS)[number];
export type BudgetItemAmountField = 'default_budget_amount' | 'recurring_payment_amount' | 'rollover_target_amount' | 'rollover_starting_balance';
type BudgetItemDayField = 'rollover_target_date' | 'rollover_starting_balance_date' | 'recurring_next_payment_date';

/**
 * A budget item request's fields, each as the API takes it: left out
 * (`undefined`) to keep what the item holds; `null` for none where the item may have none; an
 * amount as a number or decimal text (a form's unreadable amount is NaN, which is left out);
 * a day as 'YYYY-MM-DD', or '' for none. The other fields as the item answers them.
 */
export type BudgetItemRequest = {
  [K in BudgetItemWritableField]?:
    | (K extends BudgetItemAmountField
        ? number | string | null
        : K extends BudgetItemDayField
          ? string | null
          : BudgetItemResponse[K])
    | undefined;
};
/** POST /api/budgets/items: a name, and the fields to set. */
export type BudgetItemCreateRequest = BudgetItemRequest & { name: string };

/** PUT /api/budgets/period-items/:uuid/budget body: the period item's new budget. */
export const budgetAmountUpdateSchema = z.object({
  // A number or decimal text, as sent (moneyInput): BudgetService reads it in cents.
  amount: moneyInput('Amount must be a number'),
  description: z.string({ error: 'description must be text' }).nullable().optional(),
});
export type BudgetAmountUpdateInput = z.input<typeof budgetAmountUpdateSchema>;

/** POST /api/budget-periods/:periodUuid/transfer body: money moved between two items of the period. */
export const budgetItemTransferSchema = z
  .object({
    fromBudgetPeriodItemId: rowIdInput('From and To budget period item IDs are required'),
    toBudgetPeriodItemId: rowIdInput('From and To budget period item IDs are required'),
    amount: moneyInput('Amount must be greater than zero').refine(isPositiveDecimal, 'Amount must be greater than zero'),
    description: z.string({ error: 'description must be text' }).nullable().optional(),
  })
  .refine((transfer) => transfer.fromBudgetPeriodItemId !== transfer.toBudgetPeriodItemId, {
    path: ['toBudgetPeriodItemId'],
    message: 'Cannot transfer to the same budget item',
  });
export type BudgetItemTransferInput = z.input<typeof budgetItemTransferSchema>;

/** GET /api/budgets/periods/:uuid/items: one item's row only, by its uuid. */
export const budgetPeriodItemsQuery = z.object({
  budget_item_uuid: queryUuid({ message: 'budget_item_uuid must be a uuid' }),
});

/** GET /api/budgets/events: one item's, or one period's, budget events, the latest `limit`. */
export const budgetEventsQuery = z.object({
  budget_item_uuid: queryUuid({ message: 'budget_item_uuid must be a uuid' }),
  period_uuid: queryUuid({ message: 'period_uuid must be a uuid' }),
  limit: queryInt({ min: 1, max: 500, default: 100 }),
});

/** GET /api/budget-items/:uuid/history: the item's last `periods` periods (24 by default, at most 120). */
export const budgetItemHistoryQuery = z.object({
  periods: queryInt({ min: 1, max: 120, default: 24 }),
});

/** Matching methods a budget-item rule can use. */
export const budgetItemMatchingRuleMethod = z.enum([
  'exact',
  'contains',
  'starts_with',
  'ends_with',
  'regex',
  'merchant_exact',
]);
export type BudgetItemMatchingRuleMethod = z.infer<typeof budgetItemMatchingRuleMethod>;

/** The methods that match a transaction's description, and so need matching_text. */
export const BUDGET_ITEM_TEXT_MATCHING_METHODS: readonly BudgetItemMatchingRuleMethod[] = ['exact', 'contains', 'starts_with', 'ends_with', 'regex'];

/** A rule's amount bound: a number or decimal text, as sent; null, '' or absent for none. */
const ruleAmountBound = (field: string) =>
  z.preprocess((value) => (value === '' ? null : value), moneyInput(`${field} must be a number`).nullable()).optional();

/**
 * POST /api/budgets/item-matching-rules and PUT /api/budgets/item-matching-rules/:uuid
 * body: one check for both, since a PUT replaces the rule. A budget item (its id,
 * or its uuid) and a method are required; a text method needs matching_text (trimmed, at
 * most 255 characters, the column's), and merchant_exact a merchant (its id or uuid). The
 * amount bounds are money (moneyInput; the service reads them in cents). Ids and uuids that
 * name nothing in the ledger are the service's 400 INVALID_REFERENCE, and a regex that
 * could stall the server its 400 INVALID_PATTERN.
 */
export const budgetItemMatchingRuleSchema = z
  .object({
    budget_item_id: rowIdInput('Budget item is required').nullable().optional(),
    budget_item_uuid: z.uuid({ error: 'budget_item_uuid must be a uuid' }).nullable().optional(),
    merchant_id: rowIdInput('merchant_id must be a positive whole number').nullable().optional(),
    merchant_uuid: z.uuid({ error: 'merchant_uuid must be a uuid' }).nullable().optional(),
    method: z.enum(budgetItemMatchingRuleMethod.options, {
      error: `Method must be one of: ${budgetItemMatchingRuleMethod.options.join(', ')}`,
    }),
    matching_text: z
      .string({ error: 'Matching text must be text' })
      .trim()
      .max(255, 'Matching text may be at most 255 characters')
      .nullable()
      .optional(),
    amount_min: ruleAmountBound('amount_min'),
    amount_max: ruleAmountBound('amount_max'),
    priority: wholeNumberInput(-MAX_ROW_ID - 1, MAX_ROW_ID, 'priority must be a whole number').nullable().optional(),
    is_active: z.boolean({ error: 'is_active must be true or false' }).nullable().optional(),
    notes: z.string({ error: 'notes must be text' }).nullable().optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.budget_item_id == null && rule.budget_item_uuid == null) {
      ctx.addIssue({ code: 'custom', path: ['budget_item_id'], message: 'Budget item is required' });
    }
    if (BUDGET_ITEM_TEXT_MATCHING_METHODS.includes(rule.method) && !rule.matching_text) {
      ctx.addIssue({ code: 'custom', path: ['matching_text'], message: 'Matching text is required for this method' });
    }
    if (rule.method === 'merchant_exact' && rule.merchant_id == null && rule.merchant_uuid == null) {
      ctx.addIssue({ code: 'custom', path: ['merchant_id'], message: 'Merchant is required for merchant_exact method' });
    }
  });
export type BudgetItemMatchingRuleInput = z.input<typeof budgetItemMatchingRuleSchema>;
export type BudgetItemMatchingRuleFields = z.output<typeof budgetItemMatchingRuleSchema>;

/**
 * The rules form's schema (create + edit): the routes' {@link budgetItemMatchingRuleSchema},
 * and a regex pattern that can't stall the server, shown on its field. The routes
 * check the pattern in the service, which answers 400 INVALID_PATTERN.
 */
export const budgetItemMatchingRuleCreateSchema = budgetItemMatchingRuleSchema.superRefine((rule, ctx) => {
  const problem = rule.method === 'regex' && rule.matching_text ? regexRuleProblem(rule.matching_text) : null;
  if (problem) ctx.addIssue({ code: 'custom', path: ['matching_text'], message: problem });
});
export type BudgetItemMatchingRuleCreateInput = z.infer<typeof budgetItemMatchingRuleCreateSchema>;

/** GET /api/budgets/item-matching-rules: the active rules, or one item's (by uuid, or by its id). */
export const budgetItemMatchingRulesQuery = z.object({
  budget_item_uuid: queryUuid({ message: 'budget_item_uuid must be a uuid' }),
  budget_item_id: queryInt({ min: 1, max: MAX_ROW_ID, message: 'budget_item_id must be a positive whole number' }),
});

// The budget answers' schemas are in budgetResponses.ts.

/**
 * POST /api/budgets/periods body (year + month): a month in the years a calendar date may
 * fall in (CALENDAR_DAY_YEARS), so its first and last days are dates the database holds.
 */
export const budgetPeriodCreateSchema = z.object({
  year: wholeNumberInput(
    CALENDAR_DAY_YEARS.min,
    CALENDAR_DAY_YEARS.max,
    `Give the year, from ${CALENDAR_DAY_YEARS.min} to ${CALENDAR_DAY_YEARS.max}`,
  ),
  month: wholeNumberInput(1, 12, 'Month must be between 1 and 12'),
});
export type BudgetPeriodCreateInput = z.infer<typeof budgetPeriodCreateSchema>;

/**
 * POST /api/budget-periods body: a period as {@link budgetPeriodCreateSchema}, which by
 * default also takes in the month's transactions that have no period yet (not one a member
 * took out of a period).
 */
export const budgetPeriodManagedCreateSchema = budgetPeriodCreateSchema.extend({
  auto_rollover: z.boolean({ error: 'auto_rollover must be true or false' }).default(true),
  associate_transactions: z.boolean({ error: 'associate_transactions must be true or false' }).default(true),
});
export type BudgetPeriodManagedCreateInput = z.input<typeof budgetPeriodManagedCreateSchema>;

/**
 * POST /api/budgets/items/:uuid/merge — move this item's transactions (and,
 * with move_rules, its matching rules) to `into_uuid`, then archive it.
 */
export const mergeBudgetItemSchema = z.object({
  into_uuid: z.uuid('Choose the budget item to merge into.'),
  move_rules: z.boolean().default(true),
});
export type MergeBudgetItemInput = z.input<typeof mergeBudgetItemSchema>;
