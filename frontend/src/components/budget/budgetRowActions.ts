import type { BudgetPeriodItem } from '../../services/api';
import type { InlineBudgetEdit } from './useInlineBudgetEdit';

/** What a budget-item row or card can do, which the Budget page provides once for them all. */
export interface BudgetRowActions {
  edit: InlineBudgetEdit;
  /** The /budgets search string, encoded into an edit link's returnTo. */
  searchParamsString: string;
  /** Open the item's page (a goal's is its goal page). */
  view: (item: BudgetPeriodItem) => void;
  /** Open the item's edit page. */
  editItem: (item: BudgetPeriodItem) => void;
  /** Archive, merge or delete it. */
  retire: (item: BudgetPeriodItem) => void;
  /** Move budget to or from it. */
  transfer: (item: BudgetPeriodItem) => void;
  /** Show its budget changes. */
  activity: (item: BudgetPeriodItem) => void;
}

/** The link an item's name is: its edit page, back to this view of the budget. */
export const itemEditHref = (item: BudgetPeriodItem, searchParamsString: string): string =>
  `/budget-items/${item.budget_item_uuid}/edit?returnTo=${encodeURIComponent(`/budgets?${searchParamsString}`)}`;

/** A goal's page. */
export const goalHref = (item: BudgetPeriodItem): string => `/goals/${item.budget_item_uuid}/view`;
