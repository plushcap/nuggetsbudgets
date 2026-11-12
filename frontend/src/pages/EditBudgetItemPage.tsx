import React from 'react';
import { useParams, useSearchParams, Navigate } from 'react-router-dom';
import { useBudgetItemsQuery } from '../hooks/queries';
import type { BudgetItem } from '../services/api';
import { Flex } from '@radix-ui/themes';
import NuggetSpinner from '../components/NuggetSpinner';
import PageContainer from '../components/PageContainer';
import { sameOriginPath } from '../utils/safeUrls';
import EditIncomePage from './EditIncomePage';
import EditExpensePage from './EditExpensePage';
import EditBillsPage from './EditBillsPage';
import { budgetExpenseType } from '@nuggets/shared';

/**
 * Unified budget-item edit route (`/budget-items/:uuid/edit`).
 *
 * Income, Expense, and Bill are all the same `budget_item` entity — they differ
 * only by a couple of flags. This loads the item, infers its kind, and renders
 * the matching edit page, so every caller (the Budget page today, the per-row
 * kebab next) can link to ONE route instead of computing one of three
 * `/settings/{income|expenses|bills}/edit/:uuid` paths.
 *
 * This is additive: the three original edit routes still work. The rendered
 * sub-page reads the same `:uuid` param and `returnTo` query, so behavior
 * (data load, tags, delete, sidebars) is unchanged.
 */
export type BudgetItemKind = 'income' | 'bill' | 'expense';

/** Mirror of the Budget page's existing edit-link kind mapping. */
export const budgetItemKind = (item: Pick<BudgetItem, 'expense_type' | 'isbill'>): BudgetItemKind => {
  if (item.expense_type === budgetExpenseType.enum.Income) return 'income';
  if (item.isbill || item.expense_type === budgetExpenseType.enum.Transfer || item.expense_type === budgetExpenseType.enum['Transfer: Payment']) return 'bill';
  return 'expense';
};

const EditBudgetItemPage: React.FC = () => {
  const { uuid } = useParams<{ uuid: string }>();
  const [searchParams] = useSearchParams();
  const { data: budgetItems = [], isLoading } = useBudgetItemsQuery();

  const item = budgetItems.find((i) => i.uuid === uuid) ?? null;

  // Wait for the catalog before we can know which kind of editor to show.
  if (isLoading && !item) {
    return (
      <PageContainer width="editor">
        <Flex align="center" justify="center" minHeight="100vh">
          <NuggetSpinner size={48} />
        </Flex>
      </PageContainer>
    );
  }

  // Unknown uuid (e.g. hand-typed) — return to where the user came from.
  if (!item) {
    return <Navigate to={sameOriginPath(searchParams.get('returnTo')) ?? '/budgets'} replace />;
  }

  switch (budgetItemKind(item)) {
    case 'income':
      return <EditIncomePage />;
    case 'bill':
      return <EditBillsPage />;
    default:
      return <EditExpensePage />;
  }
};

export default EditBudgetItemPage;
