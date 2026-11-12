import React, { createContext, useContext, useEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { logger } from '../utils/logger';
import { errorStatus } from '../utils/errors';
import { toast } from 'react-hot-toast';
import {
  authenticateWithPasskey,
  getCurrentUser,
  loginRequest,
  logoutRequest,
  getMyTenants,
  setActiveTenant,
  type AuthUser,
  type PasskeySignInOptions,
} from '../services/api';
import { authKeys } from '../hooks/queries/auth';
import { disablePushOnSignOut, syncPushSubscription } from '../utils/pushNotifications';
import { tenantKeys } from '../hooks/queries/keys';
import { removeSessionData, resetLedgerData } from '../hooks/queries/invalidation';
import type { MemberRole, OrganizationSummary, TenantSummary } from '@nuggets/shared';

type User = AuthUser;

interface AuthContextType {
  user: User | null;
  setUser: (user: User | null) => void;
  login: (email: string, password: string) => Promise<boolean>;
  /** Signs in with a passkey (throws on failure); the caller reloads the page. */
  /** No email: the passkey chosen says whose account it is. */
  loginWithPasskey: (options?: PasskeySignInOptions) => Promise<void>;
  logout: (sessionExpired?: boolean) => Promise<void>;
  /**
   * The server already ended this session (changing the password ends them all): drop it
   * here and in the browser's other tabs, as signing out does, without calling the server
   * or showing a toast of its own.
   */
  forgetSession: () => void;
  loading: boolean;
  /**
   * The session probe failed for a reason other than "signed out" (the server is down or
   * restarting), and there is no session user to go on: show a retry, not sign-in.
   */
  sessionError: unknown;
  /** Ask the server again who is signed in. */
  retrySession: () => void;
  /** A retry of the session probe is running. */
  retryingSession: boolean;

  // ---- Multi-tenancy -------------------------------------------------------
  /**
   * True until the membership summary (ledgers/orgs/active budget) has arrived, and so
   * also once asking for it failed (membershipFailed).
   */
  membershipLoading: boolean;
  /**
   * Asking for the membership summary failed, after two more tries for anything but a 401.
   * It isn't asked for again on its own after that (never stale): a gate waiting
   * on it offers `retryMembership` instead.
   */
  membershipFailed: boolean;
  /** Ask for the membership summary again. */
  retryMembership: () => Promise<void>;
  /** The budgets the user can switch between (grouped by org client-side). */
  tenants: TenantSummary[];
  /** Organizations the user belongs to (drives org-admin settings visibility). */
  organizations: OrganizationSummary[];
  /** The currently active budget, or null when none is selected. */
  activeTenant: { uuid: string; name: string; organizationUuid: string; organizationName: string } | null;
  /** The active budget's organization, for convenience. */
  activeOrganization: { uuid: string; name: string } | null;
  /** Deployment admin: full cross-org authority (Organizations console). */
  isDeploymentAdmin: boolean;
  /** Caller's role on the active budget / its org (null when no active budget). */
  tenantRole: MemberRole | null;
  orgRole: MemberRole | null;
  /** Switch the active budget, then refresh all tenant-scoped data. */
  switchTenant: (tenantUuid: string) => Promise<void>;
  /**
   * Whether the next sign-in may return to the page that sent the user to sign-in.
   * False after someone signs out: the next person starts at home, not on their page.
   */
  mayReturnAfterSignIn: () => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** BroadcastChannel name, and the messages, by which tabs keep each other current. */
const SESSION_CHANNEL = 'nuggets-session';
type SessionMessage = 'ledger-switched' | 'signed-in' | 'signed-out';

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();

  /**
   * Session state is owned by React Query. The startup probe hits /api/auth/me
   * (session cookie sent automatically); `staleTime: Infinity` keeps it from
   * refetching on its own — the session-expired event drives invalidation.
   */
  const meQuery = useQuery({
    queryKey: authKeys.me(),
    queryFn: getCurrentUser,
    staleTime: Infinity,
    gcTime: Infinity,
    // getCurrentUser answers "signed out" itself; what throws is the server being away
    // (a restart runs migrations first), which a couple of tries often rides out.
    retry: 2,
    refetchOnWindowFocus: false,
    // ProtectedRoute shows the failure as a page, not a toast.
    meta: { suppressErrorToast: true },
  });
  const { data, isLoading: loading, refetch: refetchMe } = meQuery;
  const user = data ?? null;
  const sessionError = !user && meQuery.isError ? meQuery.error : null;
  const retryingSession = meQuery.isFetching;
  const retrySession = useCallback(() => {
    void refetchMe();
  }, [refetchMe]);

  // Keep the server's record of this browser's push subscription current.
  const userId = user?.id;
  useEffect(() => {
    if (userId != null) void syncPushSubscription();
  }, [userId]);

  /**
   * Membership picture (budgets/orgs/roles). Only fetched once authenticated, so
   * a logged-out startup probe never trips the shared 401 handler. Switching a
   * ledger refetches this too (resetLedgerData).
   */
  const { data: membership, isError: membershipQueryFailed, refetch: refetchMembership } = useQuery({
    queryKey: tenantKeys.mine(),
    queryFn: getMyTenants,
    enabled: !!user,
    staleTime: Infinity,
    gcTime: Infinity,
    // As the session probe: a failure is often the server restarting (it runs the
    // migrations first), which a couple of tries rides out before RequireLedger says the
    // ledgers didn't load. A 401 is the session ending, which the shared handler
    // answers by signing out: asking again would only repeat it.
    retry: (failures, error) => errorStatus(error) !== 401 && failures < 2,
    refetchOnWindowFocus: false,
    // RequireLedger shows a failure as a page with its own Try again, not also a toast.
    meta: { suppressErrorToast: true },
  });

  const tenants = membership?.tenants ?? [];
  const organizations = membership?.organizations ?? [];
  const activeTenant = membership?.activeTenant ?? null;
  const activeOrganization = activeTenant
    ? { uuid: activeTenant.organizationUuid, name: activeTenant.organizationName }
    : null;
  const isDeploymentAdmin = membership?.isDeploymentAdmin ?? false;
  const tenantRole = membership?.tenantRole ?? null;
  const orgRole = membership?.orgRole ?? null;
  // Authenticated but the membership summary hasn't arrived yet — distinct from
  // "loaded, and there is genuinely no active ledger" (membership is then an
  // object). The ledger gate uses this to avoid flashing the picker on load.
  const membershipLoading = !!user && membership === undefined;
  const membershipFailed = membershipLoading && membershipQueryFailed;
  const retryMembership = useCallback(async () => {
    await refetchMembership();
  }, [refetchMembership]);

  // Update the cached session user (e.g. after a profile edit).
  const setUser = useCallback(
    (next: User | null) => {
      queryClient.setQueryData(authKeys.me(), next);
    },
    [queryClient],
  );

  // The browser's other tabs share this session's cookie and its active ledger: tell
  // them when either changes, or they keep showing the old ledger while their writes
  // land in the new one. The channel is opened by the effect below.
  const sessionChannelRef = useRef<BroadcastChannel | null>(null);
  const tellOtherTabs = useCallback((message: SessionMessage) => {
    // What this tab did has already happened; failing to tell the others mustn't undo it.
    try {
      sessionChannelRef.current?.postMessage(message);
    } catch (error) {
      logger.warn({ err: error, message }, 'Could not tell the other tabs');
    }
  }, []);

  const switchTenant = useCallback(
    async (tenantUuid: string) => {
      try {
        await setActiveTenant(tenantUuid);
        // Now, not after this tab's data reloads: the other tabs' writes already land in it.
        tellOtherTabs('ledger-switched');
        // Every query but the session holds the old ledger's data. Empty them, so no
        // screen shows it while the new ledger's loads.
        await resetLedgerData(queryClient);
        toast.success('Ledger switched');
      } catch (error) {
        logger.error({ err: error }, 'Failed to switch tenant');
        toast.error('Could not switch ledger');
      }
    },
    [queryClient, tellOtherTabs],
  );

  // Set by signing out (not by an expired session); read by ProtectedRoute.
  const signedOutRef = useRef(false);
  const mayReturnAfterSignIn = useCallback(() => !signedOutRef.current, []);

  const login = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      try {
        const result = await loginRequest(email, password);
        if (result.ok) {
          // Nothing an earlier session loaded in this tab may show to this one.
          removeSessionData(queryClient);
          signedOutRef.current = false;
          setUser(result.user ?? null);
          tellOtherTabs('signed-in');
          toast.success('Login successful!');
          return true;
        }
        toast.error(result.error || 'Login failed');
        return false;
      } catch (error) {
        logger.error({ err: error }, 'Login error');
        toast.error('Login failed. Please try again.');
        return false;
      }
    },
    [setUser, queryClient, tellOtherTabs],
  );

  const loginWithPasskey = useCallback(
    async (options?: PasskeySignInOptions) => {
      await authenticateWithPasskey(options);
      tellOtherTabs('signed-in');
    },
    [tellOtherTabs],
  );

  const logout = useCallback(
    async (sessionExpired = false) => {
      // Revoke the server session unless this logout was triggered by expiry.
      if (!sessionExpired) {
        // Marked first: a request answered 401 while signing out must not turn this
        // into an expired session that returns the next person to this page.
        signedOutRef.current = true;
        // Needs the session, so before it's revoked.
        await disablePushOnSignOut();
        await logoutRequest();
      }

      setUser(null);
      // Drop every query of this session, membership included: the cache would
      // otherwise show this ledger's data to whoever signs in next.
      removeSessionData(queryClient);
      if (!sessionExpired) tellOtherTabs('signed-out');

      if (sessionExpired) {
        toast.error('Your session has expired. Please log in again.');
      } else {
        toast.success('Logged out successfully');
      }
    },
    [setUser, queryClient, tellOtherTabs],
  );

  const forgetSession = useCallback(() => {
    signedOutRef.current = true;
    setUser(null);
    removeSessionData(queryClient);
    tellOtherTabs('signed-out');
  }, [setUser, queryClient, tellOtherTabs]);

  // What another tab did to the session or the active ledger. Opened here, not in a
  // memo: StrictMode runs this cleanup once on mount, which left a memoized channel closed.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const sessionChannel = new BroadcastChannel(SESSION_CHANNEL);
    sessionChannelRef.current = sessionChannel;
    sessionChannel.onmessage = (event: MessageEvent<SessionMessage>) => {
      if (event.data === 'ledger-switched') {
        void resetLedgerData(queryClient);
      } else if (event.data === 'signed-out') {
        signedOutRef.current = true;
        setUser(null);
        removeSessionData(queryClient);
      } else if (event.data === 'signed-in') {
        // Possibly someone else: drop this tab's data and read who it is now. Reset, not
        // invalidated: if that read fails, the old user mustn't stay on screen.
        removeSessionData(queryClient);
        signedOutRef.current = false;
        void queryClient.resetQueries({ queryKey: authKeys.me() });
      }
    };
    return () => {
      if (sessionChannelRef.current === sessionChannel) sessionChannelRef.current = null;
      sessionChannel.close();
    };
  }, [queryClient, setUser]);

  // Listen for session expiry events from API calls
  useEffect(() => {
    let isHandlingSessionExpiry = false;

    const handleSessionExpired = () => {
      // Debounce: only handle the first expiry event, ignore subsequent ones. After
      // signing out (or while doing so), a 401 is expected, not an expiry.
      if (isHandlingSessionExpiry || signedOutRef.current) {
        return;
      }

      isHandlingSessionExpiry = true;
      logger.info('Session expired, logging out user');
      logout(true); // Pass true to indicate session expiry

      // Reset flag after a short delay to allow future session expiries
      setTimeout(() => {
        isHandlingSessionExpiry = false;
      }, 1000);
    };

    window.addEventListener('session-expired', handleSessionExpired);

    return () => {
      window.removeEventListener('session-expired', handleSessionExpired);
    };
  }, [logout]);

  const value: AuthContextType = {
    user,
    setUser,
    login,
    loginWithPasskey,
    logout,
    forgetSession,
    loading,
    sessionError,
    retrySession,
    retryingSession,
    membershipLoading,
    membershipFailed,
    retryMembership,
    tenants,
    organizations,
    activeTenant,
    activeOrganization,
    isDeploymentAdmin,
    tenantRole,
    orgRole,
    switchTenant,
    mayReturnAfterSignIn,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
