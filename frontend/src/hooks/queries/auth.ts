import { useQuery, useMutation } from '@tanstack/react-query';
import { DEFAULT_PASSWORD_POLICY, type PasswordPolicy } from '@nuggets/shared';
import { getPasswordPolicy, getSetupStatus, setupAdmin } from '../../services/api';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

export const authKeys = {
  setupStatus: () => ['auth', 'setupStatus'] as const,
  me: () => ['auth', 'me'] as const,
  passwordPolicy: () => ['auth', 'passwordPolicy'] as const,
};

/**
 * The password policy the server enforces (GET /api/auth/password-policy), for the pages
 * that set a password: they check it before sending and show it as a hint. The default
 * policy stands in until it arrives (or if it can't be fetched; the server still checks).
 */
export function usePasswordPolicy(): PasswordPolicy {
  const { data } = useQuery({
    queryKey: authKeys.passwordPolicy(),
    queryFn: getPasswordPolicy,
    staleTime: Infinity,
    retry: false,
    meta: { suppressErrorToast: true },
  });
  return data ?? DEFAULT_PASSWORD_POLICY;
}

/**
 * Whether initial admin setup is complete. Used by the login and admin-setup
 * pages (pre-authentication), so errors are surfaced inline rather than as a
 * global toast.
 */
export function useSetupStatusQuery(options?: QueryOverrides) {
  return useQuery({
    queryKey: authKeys.setupStatus(),
    queryFn: getSetupStatus,
    meta: { suppressErrorToast: true },
    ...options,
  });
}

export function useSetupAdminMutation() {
  return useMutation({
    mutationFn: (payload: Parameters<typeof setupAdmin>[0]) => setupAdmin(payload),
  });
}
