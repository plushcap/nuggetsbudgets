import { useQuery } from '@tanstack/react-query';
import { getSankeyReport } from '../../services/api';
import { reportKeys } from './keys';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

export function useSankeyReportQuery(
  rootTagUuid: string | undefined,
  params: Parameters<typeof getSankeyReport>[1],
  options?: QueryOverrides,
) {
  return useQuery({
    queryKey: reportKeys.sankey(rootTagUuid, (params ?? {}) as Record<string, unknown>),
    queryFn: () => getSankeyReport(rootTagUuid as string, params),
    enabled: !!rootTagUuid,
    ...options,
  });
}
