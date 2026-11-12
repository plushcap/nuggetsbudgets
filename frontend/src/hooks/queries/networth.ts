import { useQuery } from '@tanstack/react-query';
import {
  getCurrentNetWorth, getNetWorthHistory,
} from '../../services/api';
import { netWorthKeys } from './keys';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

export function useCurrentNetWorthQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: [...netWorthKeys.all, 'current'], queryFn: getCurrentNetWorth, ...options });
}
export function useNetWorthHistoryQuery(
  period?: string,
  limit?: number,
  fillGaps?: boolean,
  options?: QueryOverrides,
) {
  const args = [period, limit, fillGaps] as Parameters<typeof getNetWorthHistory>;
  return useQuery({ queryKey: [...netWorthKeys.all, 'history', args], queryFn: () => getNetWorthHistory(...args), ...options });
}
