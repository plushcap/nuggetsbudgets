import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBudgetItemHistory, getMerchantSpending } from '../../services/api';
import { budgetKeys, merchantKeys } from './keys';
import { usePaginatedTransactionsQuery } from './transactions';
import { EMPTY_LIST } from '../../utils/emptyList';
import { usePageInRange } from '../usePageInRange';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

/**
 * A budget item's figures over its recent periods and in the current one, in one request.
 * Keyed under the item, so a budget edit or a transaction write (both
 * invalidate budgetKeys.all) refreshes it.
 */
export function useBudgetItemHistoryQuery(uuid: string | undefined, periods?: number, options?: QueryOverrides) {
  return useQuery({
    queryKey: [...budgetKeys.item(uuid ?? ''), 'history', { periods: periods ?? null }],
    queryFn: () => getBudgetItemHistory(uuid as string, periods),
    ...options,
    // The pages show the failure where the figures go; no global toast as well.
    meta: { suppressErrorToast: true, ...options?.meta },
    enabled: !!uuid && (options?.enabled ?? true),
  });
}

/**
 * A merchant's spending charts and transaction count, in one request. Keyed
 * under the merchant, so merchant and transaction writes (merchantKeys.all) refresh it.
 */
export function useMerchantSpendingQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({
    queryKey: [...merchantKeys.detail(uuid ?? ''), 'spending'],
    queryFn: () => getMerchantSpending(uuid as string),
    ...options,
    meta: { suppressErrorToast: true, ...options?.meta },
    enabled: !!uuid && (options?.enabled ?? true),
  });
}

/**
 * One page of a budget item's transactions (no split children), newest first, from the
 * server: the edit pages' history sidebars used to fetch them all and page in
 * the browser. `page` resets to 1 when the item changes, and comes back to the last page
 * when the list shrinks under it.
 */
export function useBudgetItemTransactionsPage(uuid: string | undefined, perPage: number) {
  const [state, setState] = useState<{ uuid: string | undefined; page: number }>({ uuid, page: 1 });
  const page = state.uuid === uuid ? state.page : 1;
  const setPage = useCallback((next: number) => setState({ uuid, page: next }), [uuid]);
  const query = usePaginatedTransactionsQuery(page, perPage, { budget_item_uuid: uuid ?? '' }, {
    enabled: !!uuid,
    meta: { suppressErrorToast: true },
  });
  const total = query.data?.pagination.total ?? 0;
  usePageInRange(page, query.data && !query.isPlaceholderData ? Math.ceil(total / perPage) : undefined, setPage);
  return {
    page,
    setPage,
    transactions: query.data?.transactions ?? EMPTY_LIST,
    total,
    loading: query.isLoading,
    error: query.isError ? query.error : null,
  };
}
