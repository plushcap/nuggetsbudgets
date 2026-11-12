import { useQuery, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  getPaginatedTransactionsWithFilters, getTransactionsWithFilters, getTransaction,
  createTransaction, updateTransaction, deleteTransaction, bulkUpdateTransactions,
  applyTagToTransaction, removeTagFromTransaction, splitTransaction, unsplitTransaction, getTransactionTags,
  createTransfer,
} from '../../services/api';
import { transactionKeys } from './keys';
import { invalidateTransactionData, useKeepPreviousLedgerData } from './invalidation';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

export function useTransactionsWithFiltersQuery(filters: Record<string, string> = {}, options?: QueryOverrides) {
  return useQuery({ queryKey: transactionKeys.list(filters), queryFn: () => getTransactionsWithFilters(filters), ...options });
}
/**
 * Whose transactions a paged list holds: a merchant's or a budget item's (the detail pages'
 * filters). Another one's rows never stand in for them while they load. The other
 * filters (search, dates, status) refine one list, so its rows stay up while they change.
 */
const listOwner = (queryKey: QueryKey): string => {
  const filters = (queryKey[2] ?? {}) as Record<string, unknown>;
  return JSON.stringify([filters.merchant_uuid ?? null, filters.budget_item_uuid ?? null]);
};

/**
 * Paginated, filtered transactions. Keeps the previous page up while paging, within one
 * ledger and one merchant's or budget item's list.
 */
export function usePaginatedTransactionsQuery(
  page: number,
  limit: number,
  filters?: Parameters<typeof getPaginatedTransactionsWithFilters>[2],
  options?: QueryOverrides,
) {
  const queryKey = transactionKeys.list({ page, limit, ...(filters ?? {}) });
  const keepPreviousPage = useKeepPreviousLedgerData<Awaited<ReturnType<typeof getPaginatedTransactionsWithFilters>>>(
    queryKey,
    listOwner,
  );
  return useQuery({
    queryKey,
    queryFn: () => getPaginatedTransactionsWithFilters(page, limit, filters),
    placeholderData: keepPreviousPage,
    ...options,
  });
}
export function useTransactionQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({ queryKey: transactionKeys.detail(uuid ?? ''), queryFn: () => getTransaction(uuid as string), enabled: !!uuid, ...options });
}
export function useTransactionTagsQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({ queryKey: [...transactionKeys.detail(uuid ?? ''), 'tags'], queryFn: () => getTransactionTags(uuid as string), enabled: !!uuid, ...options });
}

// Transaction writes change balances, budget spend and every total derived from them.
function useInvalidateTransactions() {
  const qc = useQueryClient();
  return () => invalidateTransactionData(qc);
}

export function useCreateTransactionMutation() {
  const invalidate = useInvalidateTransactions();
  return useMutation({ mutationFn: (data: Parameters<typeof createTransaction>[0]) => createTransaction(data), onSuccess: invalidate });
}
export function useUpdateTransactionMutation() {
  const invalidate = useInvalidateTransactions();
  return useMutation({ mutationFn: ({ uuid, data }: { uuid: string; data: Parameters<typeof updateTransaction>[1] }) => updateTransaction(uuid, data), onSuccess: invalidate });
}
export function useDeleteTransactionMutation() {
  const invalidate = useInvalidateTransactions();
  return useMutation({ mutationFn: (uuid: string) => deleteTransaction(uuid), onSuccess: invalidate });
}
export function useBulkUpdateTransactionsMutation() {
  const invalidate = useInvalidateTransactions();
  return useMutation({ mutationFn: (args: Parameters<typeof bulkUpdateTransactions>) => bulkUpdateTransactions(...args), onSuccess: invalidate });
}
/** A transfer moves money between accounts → refresh balances, transactions, and budget spend. */
export function useCreateTransferMutation() {
  const invalidate = useInvalidateTransactions();
  return useMutation({ mutationFn: (data: Parameters<typeof createTransfer>[0]) => createTransfer(data), onSuccess: invalidate });
}
export function useApplyTagToTransactionMutation() {
  const invalidate = useInvalidateTransactions();
  return useMutation({ mutationFn: (args: Parameters<typeof applyTagToTransaction>) => applyTagToTransaction(...args), onSuccess: invalidate });
}
export function useRemoveTagFromTransactionMutation() {
  const invalidate = useInvalidateTransactions();
  return useMutation({ mutationFn: (args: Parameters<typeof removeTagFromTransaction>) => removeTagFromTransaction(...args), onSuccess: invalidate });
}
export function useSplitTransactionMutation() {
  const invalidate = useInvalidateTransactions();
  return useMutation({ mutationFn: (args: Parameters<typeof splitTransaction>) => splitTransaction(...args), onSuccess: invalidate });
}
export function useUnsplitTransactionMutation() {
  const invalidate = useInvalidateTransactions();
  return useMutation({ mutationFn: (uuid: string) => unsplitTransaction(uuid), onSuccess: invalidate });
}
