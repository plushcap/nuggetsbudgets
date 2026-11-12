import { useQuery } from '@tanstack/react-query';
import { getZeroBalanceAccounts } from '../../services/api';
import { budgetKeys } from './keys';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

/** Zero-balance / adjustment audit for a budget period's close-out. */
export function useZeroBalanceAccountsQuery(periodUuid: string | undefined, options?: QueryOverrides) {
  return useQuery({
    queryKey: [...budgetKeys.all, 'zeroBalance', periodUuid ?? ''],
    queryFn: () => getZeroBalanceAccounts(periodUuid as string),
    enabled: !!periodUuid,
    ...options,
  });
}
