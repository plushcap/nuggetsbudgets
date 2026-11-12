import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getImportSettings, updateImportSettings, getImportUsers,
  getImportStatus, getImportSyncLog,
  runManualSync, syncAccount, testImportConnection,
} from '../../services/api';
import { importKeys } from './keys';
import { invalidateTransactionData } from './invalidation';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

export function useImportSettingsQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: [...importKeys.all, 'settings'], queryFn: getImportSettings, ...options });
}
export function useImportUsersQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: [...importKeys.all, 'users'], queryFn: getImportUsers, ...options });
}
export function useImportSyncLogQuery(...args: Parameters<typeof getImportSyncLog>) {
  return useQuery({ queryKey: [...importKeys.all, 'syncLog', args], queryFn: () => getImportSyncLog(...args) });
}
export function useImportStatusQuery(...args: Parameters<typeof getImportStatus>) {
  return useQuery({ queryKey: [...importKeys.all, 'status', args], queryFn: () => getImportStatus(...args) });
}

// An import run adds and changes transactions, so everything derived from them too.
function useInvalidateImports() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: importKeys.all });
    invalidateTransactionData(qc);
  };
}

export function useUpdateImportSettingsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof updateImportSettings>[0]) => updateImportSettings(data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: importKeys.all }),
  });
}
export function useRunManualSyncMutation() {
  const invalidate = useInvalidateImports();
  return useMutation({ mutationFn: (args: Parameters<typeof runManualSync>) => runManualSync(...args), onSuccess: invalidate });
}
export function useSyncAccountMutation() {
  const invalidate = useInvalidateImports();
  return useMutation({ mutationFn: (args: Parameters<typeof syncAccount>) => syncAccount(...args), onSuccess: invalidate });
}
export function useTestImportConnectionMutation() {
  return useMutation({ mutationFn: () => testImportConnection() });
}
