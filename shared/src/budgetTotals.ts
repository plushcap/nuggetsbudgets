import type { BudgetPeriodItemResponse } from './budgetResponses.js';
import { budgetExpenseType, budgetItemStatus } from './vocabulary.js';

/**
 * The budget's totals: the period's "Actual" remaining, the section subtotals and
 * Close-Out's envelope reconciliation, worked out from the period items' event-sourced figures
 * (GET /api/budgets/periods/:uuid/items, never stored). They were the browser's alone; here,
 * the Budget page, Close-Out, the Dashboard card and the MCP server work out the same figures
 * with the same code.
 *
 * Money is added in whole cents: an amount as the API sends it (pg's NUMERIC text,
 * or the number a parse made of it) is read as whole cents, added and compared as integers,
 * and given back as an amount with at most two decimals, so 0 is 0, never -0 or -1.1e-13.
 */

/** An amount as the API sends it (decimal text, or a number), in whole cents; 0 when it isn't one. */
export function amountCents(value: unknown): number {
  const amount = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

/** Whole cents as an amount with at most two decimals (the double nearest it); -0 is 0. */
export const centsAmount = (cents: number): number => cents / 100 || 0;

type Figures = Pick<BudgetPeriodItemResponse, 'calculated_budget' | 'calculated_actual' | 'calculated_remaining' | 'calculated_transfers'>;
type Kind = Pick<BudgetPeriodItemResponse, 'expense_type' | 'type' | 'subtype'>;

/** The fields {@link calculateActualRemaining} reads of each item. */
export type RemainingItem = Kind & Omit<Figures, 'calculated_transfers'>;

export interface ActualRemaining {
  /** What income actually came in (positive). */
  actualIncome: number;
  /** What monthly expense items actually spent (pre-signed, so negative). */
  monthlyActual: number;
  /** What envelope expense items have planned this period (positive). */
  envelopeBudgetAmount: number;
  /** What savings goals have budgeted this period (positive). */
  savingsBudgetAmount: number;
  /** Income left after monthly spending, envelope plans and goal savings. */
  remaining: number;
  /** What fixed monthly bills still have to pay (each one's remaining above 0; positive). */
  fixedRemaining: number;
  /** `remaining` less the bills still to pay. */
  estimatedRemaining: number;
}

/**
 * The period's "Actual" remaining: actual income, less what monthly expenses spent, less what
 * envelopes plan and goals save. The Budget page, Close-Out and the Dashboard card all show
 * this number. Close-Out also shows the bills still to pay and what is left after them.
 *
 * An envelope plan is an Expense item's: Close-Out had kept its own copy that took every
 * Envelope item's budget, so an Envelope Savings item came off twice (as a goal and as a
 * plan), and a Transfer one that the Budget page doesn't list came off too.
 */
export function calculateActualRemaining(items: readonly RemainingItem[]): ActualRemaining {
  let actualIncome = 0;
  let monthlyActual = 0;
  let envelopeBudgetAmount = 0;
  let savingsBudgetAmount = 0;
  let fixedRemaining = 0;

  for (const item of items) {
    if (item.expense_type === budgetExpenseType.enum.Income) {
      actualIncome += amountCents(item.calculated_actual);
    } else if (item.expense_type === budgetExpenseType.enum.Savings) {
      savingsBudgetAmount += amountCents(item.calculated_budget);
    } else if (item.expense_type === budgetExpenseType.enum.Expense) {
      if (item.type === 'Monthly') {
        monthlyActual += amountCents(item.calculated_actual);
        // A bill not paid yet; one paid over (remaining below 0) owes nothing more.
        if (item.subtype === 'Fixed') fixedRemaining += Math.max(0, amountCents(item.calculated_remaining));
      } else if (item.type === 'Envelope') {
        envelopeBudgetAmount += amountCents(item.calculated_budget);
      }
    }
  }

  // monthlyActual is already negative (amounts are pre-signed), so it is added.
  const remaining = actualIncome + monthlyActual - envelopeBudgetAmount - savingsBudgetAmount;
  return {
    actualIncome: centsAmount(actualIncome),
    monthlyActual: centsAmount(monthlyActual),
    envelopeBudgetAmount: centsAmount(envelopeBudgetAmount),
    savingsBudgetAmount: centsAmount(savingsBudgetAmount),
    remaining: centsAmount(remaining),
    fixedRemaining: centsAmount(fixedRemaining),
    estimatedRemaining: centsAmount(remaining - fixedRemaining),
  };
}

// ---- The Budget page's sections and subtotals -----------------------------------------------

/** The fields the sections and subtotals read of each item. */
export type SubtotalItem = Kind &
  Figures &
  Pick<BudgetPeriodItemResponse, 'uuid' | 'budget_item_name' | 'goal_target_date' | 'status'>;

export interface Subtotal {
  budget: number;
  actual: number;
  transfers: number;
  remaining: number;
}

/** A budget being edited and not saved yet, by its period item's uuid, which the totals count instead. */
export type PendingBudgets = Readonly<Record<string, number>>;

/** Expense items grouped by type, then subtype, each subtype's items sorted by name. */
export type ExpenseGrouped<T> = Record<string, Record<string, T[]>>;

export interface BudgetSections<T> {
  /** expense_type 'Income', by name. */
  income: T[];
  /** expense_type 'Savings' the period shows (periodGoal), by goal_target_date, earliest first (none last). */
  savings: T[];
  /** expense_type 'Expense', as listed. */
  expenseItems: T[];
  expenseGrouped: ExpenseGrouped<T>;
}

export interface BudgetSubtotals {
  income: Subtotal;
  savings: Subtotal;
  expense: Subtotal;
  /** By type. */
  byType: Record<string, Subtotal>;
  /** By `${type}::${subtype}`. */
  bySubtype: Record<string, Subtotal>;
}

/** An item's budget: the pending edit, else what the server worked out. */
export const currentBudgetValue = (item: Pick<SubtotalItem, 'uuid' | 'calculated_budget'>, pending: PendingBudgets): number =>
  centsAmount(item.uuid in pending ? amountCents(pending[item.uuid]) : amountCents(item.calculated_budget));

const byName = <T extends Pick<SubtotalItem, 'budget_item_name'>>(a: T, b: T) => a.budget_item_name.localeCompare(b.budget_item_name);

/** By goal_target_date, earliest first; one without a date goes last. Dates are 'YYYY-MM-DD', which sort as text. */
const bySavingsDate = <T extends Pick<SubtotalItem, 'goal_target_date'>>(a: T, b: T) => {
  if (!a.goal_target_date) return b.goal_target_date ? 1 : 0;
  if (!b.goal_target_date) return -1;
  return a.goal_target_date < b.goal_target_date ? -1 : a.goal_target_date > b.goal_target_date ? 1 : 0;
};

/**
 * Whether a goal is one of the period's: an active goal (or one with no status), or
 * any other with money in the period: a budget, spending, a transfer or a balance it holds. The
 * desktop Budget page listed and totalled the active goals only, as the goals migration chose
 * (15504e42, to keep finished and paused goals off the page), while the mobile list, the Plan
 * card, the Actual remaining and the MCP counted every goal. So a paused goal with this month's
 * budget was money the desktop's goal total left out. Every view now lists, and totals, these:
 * a goal left out has no money in the period, so the totals are every goal's.
 */
export function periodGoal(item: Pick<SubtotalItem, 'status' | 'calculated_budget' | 'calculated_actual' | 'calculated_transfers' | 'calculated_remaining'>): boolean {
  if (item.status == null || item.status === budgetItemStatus.enum.active) return true;
  return [item.calculated_budget, item.calculated_actual, item.calculated_transfers, item.calculated_remaining].some((figure) => amountCents(figure) !== 0);
}

/**
 * The period's items as the Budget page lists them: Income, Savings and Expense, each sorted,
 * the expenses grouped by type and subtype. From the items' own fields only, so a pending
 * edit doesn't move one.
 */
export function deriveBudgetSections<T extends SubtotalItem>(items: readonly T[]): BudgetSections<T> {
  const income = items.filter((item) => item.expense_type === budgetExpenseType.enum.Income).sort(byName);
  const savings = items.filter((item) => item.expense_type === budgetExpenseType.enum.Savings && periodGoal(item)).sort(bySavingsDate);
  const expenseItems = items.filter((item) => item.expense_type === budgetExpenseType.enum.Expense);
  const expenseGrouped: ExpenseGrouped<T> = {};
  for (const item of expenseItems) {
    const subtypes = (expenseGrouped[item.type ?? ''] ??= {});
    (subtypes[item.subtype ?? ''] ??= []).push(item);
  }
  for (const subtypes of Object.values(expenseGrouped)) {
    for (const subtypeItems of Object.values(subtypes)) subtypeItems.sort(byName);
  }
  return { income, savings, expenseItems, expenseGrouped };
}

/** The items' budget (pending edits counted), actual, transfers and remaining, added in whole cents. */
export function calculateSubtotals(items: readonly SubtotalItem[], pending: PendingBudgets = {}): Subtotal {
  let budget = 0;
  let actual = 0;
  let transfers = 0;
  let remaining = 0;
  for (const item of items) {
    budget += amountCents(currentBudgetValue(item, pending));
    actual += amountCents(item.calculated_actual);
    transfers += amountCents(item.calculated_transfers);
    remaining += amountCents(item.calculated_remaining);
  }
  return { budget: centsAmount(budget), actual: centsAmount(actual), transfers: centsAmount(transfers), remaining: centsAmount(remaining) };
}

/**
 * Every subtotal the Budget page shows, in one pass: the sections', each expense type's (all its
 * subtypes) and each subtype's. A pending budget counts, so a caller that memoizes this lists
 * the pending edits among its dependencies.
 */
export function computeAllSubtotals(sections: BudgetSections<SubtotalItem>, pending: PendingBudgets = {}): BudgetSubtotals {
  const byType: Record<string, Subtotal> = {};
  const bySubtype: Record<string, Subtotal> = {};
  for (const [type, subtypes] of Object.entries(sections.expenseGrouped)) {
    byType[type] = calculateSubtotals(Object.values(subtypes).flat(), pending);
    for (const [subtype, subtypeItems] of Object.entries(subtypes)) {
      bySubtype[`${type}::${subtype}`] = calculateSubtotals(subtypeItems, pending);
    }
  }
  return {
    income: calculateSubtotals(sections.income, pending),
    savings: calculateSubtotals(sections.savings, pending),
    expense: calculateSubtotals(sections.expenseItems, pending),
    byType,
    bySubtype,
  };
}

// ---- Close-Out's envelope reconciliation -----------------------------------------------------

export interface EnvelopeAccount {
  uuid: string;
  name: string;
  icon: string | null;
  actual_balance: number;
}
export interface EnvelopeBudgetSummary {
  expected_balance: number;
  envelope_items_count: number;
  total_budgeted: number;
  total_spent: number;
}
export interface EnvelopeVariance {
  amount: number;
  status: 'balanced' | 'overfunded' | 'underfunded';
  percentage: number;
}
export interface EnvelopeReconciliation {
  envelope_account: EnvelopeAccount | null;
  budget_summary: EnvelopeBudgetSummary | null;
  variance: EnvelopeVariance | null;
}

/** The fields the reconciliation reads of an account (GET /api/accounts). */
export interface ReconciledAccount {
  uuid: string;
  name: string;
  icon: string | null;
  is_envelope_account: boolean;
  /** null when it couldn't be computed. */
  calculated_balance: number | string | null;
}

/**
 * The envelope accounts' money against what the envelopes should hold: the expected balance
 * is the envelope items' remaining (rollover and all), the actual one the envelope accounts'
 * balances, as the Budget page's Envelope Comparison adds them (future-period activity
 * is not backed out). Balanced is exactly 0 cents of variance (float sums made $1,030.31
 * 1030.3100000000002). null without an envelope account or items, or when an envelope account's
 * balance is unavailable (never compared against $0).
 */
export function envelopeReconciliation(
  items: readonly Pick<SubtotalItem, 'type' | 'calculated_budget' | 'calculated_actual' | 'calculated_remaining'>[],
  accounts: readonly ReconciledAccount[],
): EnvelopeReconciliation | null {
  const envelopeAccounts = accounts.filter((account) => account.is_envelope_account);
  const first = envelopeAccounts[0];
  if (!first || items.length === 0 || envelopeAccounts.some((account) => account.calculated_balance == null)) return null;
  const envelopeItems = items.filter((item) => item.type === 'Envelope');
  const expected = envelopeItems.reduce((sum, item) => sum + amountCents(item.calculated_remaining), 0);
  const actual = envelopeAccounts.reduce((sum, account) => sum + amountCents(account.calculated_balance), 0);
  const variance = actual - expected;
  return {
    envelope_account: { uuid: first.uuid, name: first.name, icon: first.icon, actual_balance: centsAmount(actual) },
    budget_summary: {
      expected_balance: centsAmount(expected),
      envelope_items_count: envelopeItems.length,
      total_budgeted: centsAmount(envelopeItems.reduce((sum, item) => sum + amountCents(item.calculated_budget), 0)),
      total_spent: centsAmount(envelopeItems.reduce((sum, item) => sum + amountCents(item.calculated_actual), 0)),
    },
    variance: {
      amount: centsAmount(variance),
      status: variance > 0 ? 'overfunded' : variance < 0 ? 'underfunded' : 'balanced',
      // `|| 0`: a ratio just below 0 (a variance under half a percent, the other way from the expected balance) rounds to -0.
      percentage: expected !== 0 ? Math.round((variance / expected) * 100) || 0 : 0,
    },
  };
}
