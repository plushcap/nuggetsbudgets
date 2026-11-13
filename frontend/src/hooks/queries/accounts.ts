import { useQuery, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  getAccounts,
  getAccount,
  getAccountBalance,
  getAccountTransactions,
  createAccountWithImage,
  updateAccountWithImage,
  updateAccountImportSettings,
  adjustAccountBalance,
} from '../../services/api';
import { accountKeys, budgetKeys, netWorthKeys } from './keys';
import { invalidateTransactionData, useKeepPreviousLedgerData } from './invalidation';

type QueryOverrides = {
  meta?: Record<string, unknown>;
  staleTime?: number;
  enabled?: boolean;
};

/** List of accounts (optionally including hidden). */
export function useAccountsQuery(showHidden = false, options?: QueryOverrides) {
  return useQuery({
    queryKey: accountKeys.list(showHidden),
    queryFn: () => getAccounts(showHidden),
    ...options,
  });
}

/** A single account by uuid. `undefined` uuid disables the query. */
export function useAccountQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({
    queryKey: accountKeys.detail(uuid ?? ''),
    queryFn: () => getAccount(uuid as string),
    enabled: !!uuid,
    ...options,
  });
}

/** Event-based calculated balance for a single account. */
export function useAccountBalanceQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({
    queryKey: [...accountKeys.detail(uuid ?? ''), 'balance'],
    queryFn: () => getAccountBalance(uuid as string),
    enabled: !!uuid,
    ...options,
  });
}

/**
 * Whose list an account-transactions key holds: the account (`['accounts', 'detail', uuid, …]`).
 * Its filters refine that one list, so its rows stay up while they change.
 */
const accountOf = (queryKey: QueryKey): string => String(queryKey[2] ?? '');

/**
 * Paginated, filtered transactions for an account. Keeps the previous page up while paging,
 * within one ledger and one account: an account page whose route moves to another account
 * without remounting shows its loader, never the last account's rows.
 */
export function useAccountTransactionsQuery(
  uuid: string | undefined,
  params: Parameters<typeof getAccountTransactions>[1],
  options?: QueryOverrides & { refetchOnWindowFocus?: boolean },
) {
  const queryKey = [...accountKeys.detail(uuid ?? ''), 'transactions', params];
  const keepPreviousPage = useKeepPreviousLedgerData<Awaited<ReturnType<typeof getAccountTransactions>>>(queryKey, accountOf);
  return useQuery({
    queryKey,
    queryFn: () => getAccountTransactions(uuid as string, params),
    enabled: !!uuid,
    placeholderData: keepPreviousPage,
    ...options,
  });
}

/**
 * Create an account (multipart, with optional image). An opening balance is a
 * transaction, so everything derived from transactions refreshes too.
 */
export function useCreateAccountWithImageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (formData: FormData) => createAccountWithImage(formData),
    onSuccess: () => invalidateTransactionData(queryClient),
  });
}

/**
 * Update an account (multipart, with optional image). Invalidates account caches, and
 * net worth: its type and hide/close/exclude flags decide how it counts there.
 */
export function useUpdateAccountWithImageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, formData }: { uuid: string; formData: FormData }) =>
      updateAccountWithImage(uuid, formData),
    onSuccess: (_data, { uuid }) => {
      void queryClient.invalidateQueries({ queryKey: accountKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: accountKeys.detail(uuid) });
      void queryClient.invalidateQueries({ queryKey: netWorthKeys.all });
      // Which account is the envelope account, and whether it is hidden or closed, decide the
      // envelope accounts' money through a period (Close-Out, the Budget page).
      void queryClient.invalidateQueries({ queryKey: [...budgetKeys.all, 'envelopeBalance'] });
    },
  });
}

/**
 * Manually adjust an account's balance (inserts one balance-adjustment
 * transaction), which reaches every total derived from transactions, net worth
 * included.
 */
export function useAdjustBalanceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, targetBalance }: { uuid: string; targetBalance: number }) =>
      adjustAccountBalance(uuid, targetBalance),
    onSuccess: () => invalidateTransactionData(queryClient),
  });
}

type ImportSettings = Parameters<typeof updateAccountImportSettings>[1];

/** Update an account's import settings. Invalidates account caches. */
export function useUpdateAccountImportSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, settings }: { uuid: string; settings: ImportSettings }) =>
      updateAccountImportSettings(uuid, settings),
    onSuccess: (_data, { uuid }) => {
      void queryClient.invalidateQueries({ queryKey: accountKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: accountKeys.detail(uuid) });
    },
  });
}
