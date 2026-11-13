import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getBackupSettings, getBackupSchedulerStatus, getBackupKeys,
  getDeploymentSettings, updateDeploymentSettings,
  getOneDriveStatus,
  getUserPasskeys, getAdminUserPasskeys, getSimpleFinAccounts, getSimpleFinAccountTransactions,
  getNotificationStatus, getNotificationSettings, getNotificationHistory,
  updateNotificationSettings, notificationSchedulerAction,
  clearNotificationHistory, sendTestNotification,
  getNotificationRules, saveNotificationRules, getNotificationPreferences, setNotificationPreferences,
} from '../../services/api';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

// ------------------------------------------------------------ notifications
const notificationKeys = {
  all: ['notifications'] as const,
  status: () => ['notifications', 'status'] as const,
  settings: () => ['notifications', 'settings'] as const,
  history: (page: number) => ['notifications', 'history', page] as const,
  rules: () => ['notifications', 'rules'] as const,
  preferences: () => ['notifications', 'preferences'] as const,
};

export function useNotificationRulesQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: notificationKeys.rules(), queryFn: getNotificationRules, ...options });
}
export function useSaveNotificationRulesMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rules: Parameters<typeof saveNotificationRules>[0]) => saveNotificationRules(rules),
    onSuccess: (saved) => {
      qc.setQueryData(notificationKeys.rules(), saved);
      // Which rules a person can choose about follows the rules.
      void qc.invalidateQueries({ queryKey: notificationKeys.preferences() });
    },
  });
}
export function useNotificationPreferencesQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: notificationKeys.preferences(), queryFn: getNotificationPreferences, ...options });
}
export function useSetNotificationPreferencesMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (request: Parameters<typeof setNotificationPreferences>[0]) => setNotificationPreferences(request),
    // One at a time, in click order: each response is the whole picture, so a
    // response overtaking a later click's would put that click's box back.
    scope: { id: 'notification-preferences' },
    onSuccess: (preferences) => qc.setQueryData(notificationKeys.preferences(), preferences),
  });
}

export function useNotificationStatusQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: notificationKeys.status(), queryFn: getNotificationStatus, ...options });
}
export function useNotificationSettingsQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: notificationKeys.settings(), queryFn: getNotificationSettings, ...options });
}
export function useNotificationHistoryQuery(page = 1, options?: QueryOverrides) {
  return useQuery({ queryKey: notificationKeys.history(page), queryFn: () => getNotificationHistory(page, 20), ...options });
}

export function useUpdateNotificationSettingsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: Parameters<typeof updateNotificationSettings>[0]) => updateNotificationSettings(settings),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}
export function useNotificationSchedulerMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: Parameters<typeof notificationSchedulerAction>[0]) => notificationSchedulerAction(action),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notificationKeys.status() }),
  });
}
export function useClearNotificationHistoryMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => clearNotificationHistory(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}
export function useSendTestNotificationMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof sendTestNotification>[0]) => sendTestNotification(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

// ----------------------------------------------------------------- backups
export function useBackupSettingsQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: ['backups', 'settings'], queryFn: getBackupSettings, ...options });
}
export function useBackupSchedulerStatusQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: ['backups', 'scheduler'], queryFn: getBackupSchedulerStatus, ...options });
}
/** The backup keys (the owner's age public keys), the server's signer, and the old key. */
export const backupKeysQueryKey = ['backups', 'keys'] as const;
export function useBackupKeysQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: backupKeysQueryKey, queryFn: getBackupKeys, ...options });
}

// ------------------------------------------------------ deployment settings
const deploymentSettingsKey = ['deployment', 'settings'] as const;
export function useDeploymentSettingsQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: deploymentSettingsKey, queryFn: getDeploymentSettings, ...options });
}
export function useUpdateDeploymentSettingsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: Parameters<typeof updateDeploymentSettings>[0]) => updateDeploymentSettings(settings),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: deploymentSettingsKey });
      // The next scheduled backup moves to the backup time in the new zone.
      void qc.invalidateQueries({ queryKey: ['backups', 'scheduler'] });
    },
  });
}

// ---------------------------------------------------------------- onedrive
export function useOneDriveStatusQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: ['onedrive', 'status'], queryFn: getOneDriveStatus, ...options });
}

// ---------------------------------------------------------------- passkeys
export function useUserPasskeysQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: ['passkeys', 'me'], queryFn: getUserPasskeys, ...options });
}
export function useAdminUserPasskeysQuery(userUuid: string | undefined, options?: QueryOverrides) {
  return useQuery({
    queryKey: ['passkeys', 'admin', userUuid ?? ''],
    queryFn: () => getAdminUserPasskeys(userUuid as string),
    enabled: !!userUuid,
    ...options,
  });
}

// --------------------------------------------------------------- simplefin
export function useSimpleFinAccountsQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: ['simplefin', 'accounts'], queryFn: getSimpleFinAccounts, ...options });
}

// Live, read-only account drill-down (research). Disabled until an account id is
// supplied (i.e. the detail modal opens). Not cached long — it's a live pull.
export function useSimpleFinAccountTransactionsQuery(accountId: string | null, days = 60, options?: QueryOverrides) {
  return useQuery({
    queryKey: ['simplefin', 'account-transactions', accountId, days],
    queryFn: () => getSimpleFinAccountTransactions(accountId as string, days),
    enabled: !!accountId,
    staleTime: 0,
    ...options,
  });
}
