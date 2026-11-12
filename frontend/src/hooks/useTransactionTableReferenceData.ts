import { useMemo } from 'react';
import type { BudgetItem, BudgetPeriod, Tag, User } from '../services/api';
import { useBudgetItemsQuery, useBudgetPeriodsQuery, useTagsQuery, useUsersQuery } from './queries';

export interface TransactionTableReferenceData {
  budgetPeriods: BudgetPeriod[];
  users: User[];
  budgetItems: BudgetItem[];
  /** Every tag (the quick actions name a tag from it). */
  allTags: Tag[];
  /** The tags that may be applied: the active ones. */
  activeTags: Tag[];
}

/**
 * The lists the transaction table names things from: the page's own when it passes them (a
 * non-empty list), else fetched, each only when the page didn't pass it.
 */
export function useTransactionTableReferenceData(passed: {
  budgetPeriods: BudgetPeriod[];
  users: User[];
  budgetItems: BudgetItem[];
}): TransactionTableReferenceData {
  const { data: fetchedPeriods = [] } = useBudgetPeriodsQuery({ enabled: passed.budgetPeriods.length === 0 });
  const { data: fetchedUsers = [] } = useUsersQuery({ enabled: passed.users.length === 0 });
  const { data: fetchedItems = [] } = useBudgetItemsQuery({ enabled: passed.budgetItems.length === 0 });
  const { data: allTags = [] } = useTagsQuery();
  const activeTags = useMemo(() => allTags.filter((tag: Tag) => tag.is_active !== false), [allTags]);
  return {
    budgetPeriods: passed.budgetPeriods.length > 0 ? passed.budgetPeriods : fetchedPeriods,
    users: passed.users.length > 0 ? passed.users : fetchedUsers,
    budgetItems: passed.budgetItems.length > 0 ? passed.budgetItems : fetchedItems,
    allTags,
    activeTags,
  };
}
