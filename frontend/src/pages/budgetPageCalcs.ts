import {
  calculateSubtotals,
  computeAllSubtotals,
  currentBudgetValue,
  deriveBudgetSections,
  type BudgetSections as SharedBudgetSections,
  type ExpenseGrouped as SharedExpenseGrouped,
  type PendingBudgets,
} from '@nuggets/shared';
import type { BudgetPeriodItem } from '../services/api';

/**
 * The Budget page's sections and subtotals: `@nuggets/shared`'s, so the MCP server
 * and the backend work out the same figures, in whole cents. The page's types are its items'.
 */
export { calculateSubtotals, computeAllSubtotals, deriveBudgetSections };
export type { BudgetSubtotals, Subtotal } from '@nuggets/shared';

/** Expense items grouped by type -> subtype, each subtype's items sorted by name. */
export type ExpenseGrouped = SharedExpenseGrouped<BudgetPeriodItem>;
export type BudgetSections = SharedBudgetSections<BudgetPeriodItem>;

/** An item's budget including an optional pending (optimistic) edit. */
export const getCurrentBudgetValue = (item: BudgetPeriodItem, pending: PendingBudgets): number => currentBudgetValue(item, pending);
