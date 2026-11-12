import { formatMoney, budgetExpenseType } from '@nuggets/shared';
import type { BudgetPeriodItem } from '../../services/api';
import { centsOf } from '../../utils/currency';

/**
 * The Budget page's per-item figures, worked out in whole cents: a
 * float comparison could put an item exactly 5% from its limit (1.12 of 22.40 left,
 * 5.000000000000001%) on the wrong side of a threshold, and a sub-cent remainder showed red.
 * Each threshold is compared as integers (remaining × 20 ≤ budget is 5%).
 */

/** The order of the expense types (Monthly first, then Envelope) and of their subtypes. */
export const BUDGET_TYPE_ORDER = ['Monthly', 'Envelope'] as const;
export const BUDGET_SUBTYPE_ORDER = ['Flexible', 'Fixed', 'Paycheck'] as const;

/** An expense's statuses (a goal's too, until it is funded). */
export type ExpenseStatus = 'over-budget' | 'spent' | 'critical' | 'warning' | 'near-limit' | 'on-track';
/** An income item's: what has come in against its plan. */
export type IncomeStatus = 'expected' | 'partly-received' | 'received' | 'above-plan';
export type BudgetStatus = ExpenseStatus | IncomeStatus | 'funded';

export const BUDGET_STATUS_LABELS: Record<BudgetStatus, string> = {
  'over-budget': 'Over Budget',
  spent: 'Spent',
  critical: 'Critical',
  warning: 'Warning',
  'near-limit': 'Near Limit',
  'on-track': 'On Track',
  expected: 'Expected',
  'partly-received': 'Partly received',
  received: 'Received',
  'above-plan': 'Above plan',
  funded: 'Funded',
};

/** What the server worked out the item has left (an envelope's balance, rollover and all). */
export const remainingOf = (item: Pick<BudgetPeriodItem, 'calculated_remaining'>): number =>
  parseFloat(String(item.calculated_remaining)) || 0;

/**
 * Where an item stands, from its actual, budget and remaining (each as the API sends it, or an
 * amount): over budget below zero; spent at exactly zero, once something has been spent; then
 * critical, warning or near the limit at 5%, 25% or 50% of the budget left, else on track.
 *
 * An actual is pre-signed: an expense's spending is negative, so for an expense "something
 * spent" is an actual that isn't zero (`> 0` never held for one, which showed Critical
 * instead).
 *
 * An income item (`kind` 'income') has its own words: what came in (its actual) against its
 * budget, in cents. Expected until anything is received (an actual of 0, or below it after a
 * reversal), Partly received below the budget, Received at it, Above plan past it (an income
 * item budgeted 0 that received money is above its plan). Its remaining doesn't matter: income
 * isn't spent.
 */
export function budgetStatus(actual: unknown, budget: unknown, remaining: unknown, kind: 'expense' | 'income' = 'expense'): BudgetStatus {
  const actualCents = centsOf(actual);
  const budgetCents = centsOf(budget);
  const remainingCents = centsOf(remaining);
  if (kind === 'income') {
    if (actualCents <= 0) return 'expected';
    if (actualCents < budgetCents) return 'partly-received';
    return actualCents === budgetCents ? 'received' : 'above-plan';
  }
  const spentSomething = actualCents !== 0;
  if (remainingCents < 0) return 'over-budget';
  if (remainingCents === 0 && budgetCents > 0 && spentSomething) return 'spent';
  if (budgetCents > 0) {
    if (remainingCents * 20 <= budgetCents) return 'critical';
    if (remainingCents * 4 <= budgetCents) return 'warning';
    if (remainingCents * 2 <= budgetCents) return 'near-limit';
  }
  return 'on-track';
}

const clampPercent = (percent: number): number => Math.max(0, Math.min(percent, 100));

/**
 * How full an item's bar is, 0–100. An envelope's shows what it holds against its target, or
 * against its budget without one (full when it holds money and has no budget); any other item's
 * shows how much of its budget is left.
 */
export function progressPercentage(
  item: Pick<BudgetPeriodItem, 'type' | 'rollover_target_amount' | 'calculated_remaining'>,
  budget: unknown,
): number {
  const budgetCents = centsOf(budget);
  const remainingCents = centsOf(item.calculated_remaining);
  if (item.type === 'Envelope') {
    // An envelope's remaining is what it has saved.
    const savedCents = Math.max(0, remainingCents);
    const targetCents = centsOf(item.rollover_target_amount);
    if (targetCents > 0) return clampPercent((savedCents / targetCents) * 100);
    if (budgetCents === 0) return remainingCents > 0 ? 100 : 0;
    return clampPercent((savedCents / budgetCents) * 100);
  }
  if (budgetCents === 0) return 0;
  // The server's remaining handles a negative actual (a refund) as it should.
  return clampPercent((remainingCents / budgetCents) * 100);
}

/** An envelope's saved amount against its target ("$40.00 of $100.00: 40%"), when it has one. */
export function envelopeTarget(
  item: Pick<BudgetPeriodItem, 'type' | 'rollover_target_amount' | 'calculated_remaining'>,
): { saved: string; target: string; percent: number } | null {
  const targetCents = centsOf(item.rollover_target_amount);
  if (item.type !== 'Envelope' || targetCents <= 0) return null;
  const savedCents = Math.max(0, centsOf(item.calculated_remaining));
  return {
    saved: formatMoney(savedCents / 100),
    target: formatMoney(targetCents / 100),
    percent: Math.round((savedCents / targetCents) * 100),
  };
}

export interface StyledAmount {
  text: string;
  className: string;
}

const TONE = {
  negative: 'text-[var(--red-11)]',
  zero: 'text-[var(--gray-11)]',
  amount: 'text-[var(--gray-12)]',
  remaining: 'text-[var(--green-12)]',
} as const;

/**
 * An amount in accounting style, red in parentheses below zero, coloured by its cents: -0.004
 * is $0.00 in gray, not red. A positive remaining is green.
 */
export function styledAmount(amount: unknown, kind: 'amount' | 'remaining' = 'amount'): StyledAmount {
  const cents = centsOf(amount);
  return {
    text: formatMoney(cents / 100, { negative: 'parentheses' }),
    className: cents < 0 ? TONE.negative : cents === 0 ? TONE.zero : TONE[kind],
  };
}

/** A section total's remaining: green from zero up, red below, by its cents. */
export const remainingTone = (amount: unknown): string =>
  centsOf(amount) < 0 ? TONE.negative : TONE.remaining;

/** The status badge's colours. */
export const STATUS_BADGE_CLASS: Record<BudgetStatus, string> = {
  'over-budget': 'text-[var(--red-11)] bg-[var(--red-3)]',
  spent: 'text-[var(--red-11)] bg-[var(--red-3)]',
  critical: 'text-[var(--red-11)] bg-[var(--red-3)]',
  warning: 'text-[var(--orange-12)] bg-[var(--orange-3)]',
  'near-limit': 'text-[var(--yellow-12)] bg-[var(--yellow-3)]',
  'on-track': 'text-[var(--green-12)] bg-[var(--green-3)]',
  expected: 'text-[var(--gray-11)] bg-[var(--gray-3)]',
  'partly-received': 'text-[var(--amber-12)] bg-[var(--amber-3)]',
  received: 'text-[var(--green-12)] bg-[var(--green-3)]',
  'above-plan': 'text-[var(--green-12)] bg-[var(--green-3)]',
  funded: 'text-[var(--green-12)] bg-[var(--green-3)]',
};

/** A flexible monthly item's bar, coloured by how much of its budget is left. */
export const STATUS_BAR_CLASS: Record<BudgetStatus, string> = {
  'over-budget': 'bg-[var(--red-9)]',
  spent: 'bg-[var(--red-9)]',
  critical: 'bg-[var(--red-9)]',
  warning: 'bg-[var(--orange-9)]',
  'near-limit': 'bg-[var(--yellow-9)]',
  'on-track': 'bg-[var(--green-9)]',
  expected: 'bg-[var(--gray-9)]',
  'partly-received': 'bg-[var(--amber-9)]',
  received: 'bg-[var(--green-9)]',
  'above-plan': 'bg-[var(--green-9)]',
  funded: 'bg-[var(--green-9)]',
};

/** The kind of figures an item has, for budgetStatus: an income item's, or an expense's (a goal's too). */
export const statusKind = (item: Pick<BudgetPeriodItem, 'expense_type'>): 'expense' | 'income' =>
  item.expense_type === budgetExpenseType.enum.Income ? 'income' : 'expense';

/**
 * A goal's status: Funded once it has set aside its budget for the period, or more (it
 * showed Spent, or Over Budget, in red); else an expense's, from what it has set aside and
 * what is left.
 */
export function goalStatus(item: Pick<BudgetPeriodItem, 'calculated_actual' | 'calculated_remaining'>, budget: unknown): BudgetStatus {
  // Pre-signed: money set aside is negative.
  const savedCents = -centsOf(item.calculated_actual);
  if (savedCents > 0 && savedCents >= centsOf(budget)) return 'funded';
  return budgetStatus(Math.abs(savedCents) / 100, budget, item.calculated_remaining);
}

/** What a goal card shows: what it has saved (as a positive amount), what is left, its status and bar. */
export function goalFigures(item: BudgetPeriodItem, budget: number) {
  // A goal's actual is pre-signed (money set aside is negative); the card shows its size.
  const actual = Math.abs(centsOf(item.calculated_actual)) / 100;
  const status = goalStatus(item, budget);
  return {
    actual: styledAmount(actual),
    remaining: styledAmount(remainingOf(item), 'remaining'),
    status,
    percent: progressPercentage(item, budget),
  };
}

/** Every other bar: red over budget, yellow near the limit; an income item's in its status's colour; else green. */
export const plainBarClass = (status: BudgetStatus): string =>
  status === 'over-budget' ? 'bg-[var(--red-9)]'
    : status === 'near-limit' ? 'bg-[var(--yellow-9)]'
      : status === 'expected' || status === 'partly-received' ? STATUS_BAR_CLASS[status]
        : 'bg-[var(--green-9)]';
