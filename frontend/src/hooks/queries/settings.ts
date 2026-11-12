import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getGeneralSettings, updateGeneralSettings, getAvailableTimezones,
  getUsers, getAdminUsers, createUser, updateUser, deleteUser,
} from '../../services/api';
import { settingsKeys, userKeys } from './keys';
import { clearTimezoneCache } from '../../utils/timezone';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };
const STATIC_STALE_TIME = 60 * 60_000; // timezones basically never change

// ---- settings ---------------------------------------------------------------

export function useGeneralSettingsQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: [...settingsKeys.all, 'general'], queryFn: getGeneralSettings, ...options });
}
export function useAvailableTimezonesQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: [...settingsKeys.all, 'timezones'], queryFn: getAvailableTimezones, staleTime: STATIC_STALE_TIME, ...options });
}
export function useUpdateGeneralSettingsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof updateGeneralSettings>[0]) => updateGeneralSettings(data),
    onSuccess: () => {
      // A saved application_timezone applies now, not when utils/timezone.ts's cache expires.
      clearTimezoneCache();
      void qc.invalidateQueries({ queryKey: settingsKeys.all });
    },
  });
}

// ---- users / profile --------------------------------------------------------

export function useUsersQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: userKeys.list(), queryFn: getUsers, ...options });
}
export function useAdminUsersQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: [...userKeys.all, 'admin'], queryFn: getAdminUsers, ...options });
}
function useInvalidateUsers() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: userKeys.all });
}
export function useCreateUserMutation() {
  const invalidate = useInvalidateUsers();
  return useMutation({ mutationFn: (data: Parameters<typeof createUser>[0]) => createUser(data), onSuccess: invalidate });
}
export function useUpdateUserMutation() {
  const invalidate = useInvalidateUsers();
  return useMutation({ mutationFn: (args: Parameters<typeof updateUser>) => updateUser(...args), onSuccess: invalidate });
}
export function useDeleteUserMutation() {
  const invalidate = useInvalidateUsers();
  return useMutation({ mutationFn: (uuid: Parameters<typeof deleteUser>[0]) => deleteUser(uuid), onSuccess: invalidate });
}
