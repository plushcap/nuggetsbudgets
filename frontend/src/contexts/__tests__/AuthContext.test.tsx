import { StrictMode, useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from '../AuthContext';
import ProtectedRoute from '../../components/ProtectedRoute';
import { authenticateWithPasskey, getCurrentUser, getMyTenants, loginRequest, logoutRequest, setActiveTenant } from '../../services/api';
import { accountKeys, tenantKeys } from '../../hooks/queries/keys';
import { authKeys } from '../../hooks/queries/auth';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    loginRequest: vi.fn(),
    logoutRequest: vi.fn(),
    getMyTenants: vi.fn(),
    setActiveTenant: vi.fn(),
    authenticateWithPasskey: vi.fn(),
  };
});
vi.mock('../../utils/pushNotifications', () => ({
  disablePushOnSignOut: vi.fn(async () => {}),
  syncPushSubscription: vi.fn(async () => {}),
}));
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from 'react-hot-toast';

const alice = { id: 1, uuid: 'u-alice', email: 'alice@example.com', name: 'Alice' };
const bob = { id: 2, uuid: 'u-bob', email: 'bob@example.com', name: 'Bob' };
const membership = { tenants: [], organizations: [], activeTenant: null, isDeploymentAdmin: false, tenantRole: null, orgRole: null };
const ledgerAccounts = [{ uuid: 'acct-1', name: "Alice's checking" }];
const accountsKey = accountKeys.list(false);

let auth: ReturnType<typeof useAuth>;
/** Hands the test the latest context value (after commit, as a render must not write outside itself). */
const Capture = () => {
  const value = useAuth();
  useEffect(() => {
    auth = value;
  });
  return null;
};

const LoginProbe = () => {
  const from = (useLocation().state as { from?: { pathname: string } } | null)?.from?.pathname;
  return <div>login page, return to: {from ?? 'none'}</div>;
};

function renderApp(client: QueryClient, route = '/accounts') {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <Capture />
          <Routes>
            <Route path="/login" element={<LoginProbe />} />
            <Route path="/accounts" element={<ProtectedRoute><div>accounts page</div></ProtectedRoute>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('AuthProvider keeps one session or ledger from showing another its data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMyTenants).mockResolvedValue(membership as never);
    vi.mocked(logoutRequest).mockResolvedValue(undefined);
    vi.mocked(setActiveTenant).mockResolvedValue(undefined as never);
  });

  it('drops the ledger data when someone signs out, and sends the next sign-in home', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(alice as never);
    const client = newClient();
    client.setQueryData(accountsKey, ledgerAccounts);
    renderApp(client);
    expect(await screen.findByText('accounts page')).toBeInTheDocument();

    await act(() => auth.logout());

    expect(client.getQueryData(accountsKey)).toBeUndefined();
    expect(client.getQueryData(tenantKeys.mine())).toBeUndefined();
    // Not the page Alice was on.
    expect(await screen.findByText('login page, return to: none')).toBeInTheDocument();
  });

  it('returns to the page after an expired session, without the data it showed', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(alice as never);
    const client = newClient();
    client.setQueryData(accountsKey, ledgerAccounts);
    renderApp(client);
    expect(await screen.findByText('accounts page')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event('session-expired'));
    });

    expect(await screen.findByText('login page, return to: /accounts')).toBeInTheDocument();
    expect(client.getQueryData(accountsKey)).toBeUndefined();
  });

  it('drops what an earlier session left in the cache when someone signs in', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    vi.mocked(loginRequest).mockResolvedValue({ ok: true, user: bob } as never);
    const client = newClient();
    // Left behind by a session in this tab (e.g. one whose sign-out request failed).
    client.setQueryData(accountsKey, ledgerAccounts);
    renderApp(client, '/login');
    await waitFor(() => expect(client.getQueryData(authKeys.me())).toBeNull());

    await act(async () => {
      await auth.login('bob@example.com', 'secret');
    });

    expect(client.getQueryData(accountsKey)).toBeUndefined();
    expect(client.getQueryData(authKeys.me())).toEqual(bob);
  });

  it("empties the old ledger's queries on a switch, and refetches the membership", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(alice as never);
    const client = newClient();
    // Not on screen: a plain invalidation would keep it and show it on the next visit.
    client.setQueryData(accountsKey, ledgerAccounts);
    renderApp(client);
    expect(await screen.findByText('accounts page')).toBeInTheDocument();
    await waitFor(() => expect(getMyTenants).toHaveBeenCalledTimes(1));

    await act(() => auth.switchTenant('ledger-2'));

    expect(setActiveTenant).toHaveBeenCalledWith('ledger-2');
    expect(client.getQueryData(accountsKey)).toBeUndefined();
    expect(client.getQueryData(authKeys.me())).toEqual(alice);
    expect(getMyTenants).toHaveBeenCalledTimes(2);
  });

  // A request answered 401 while signing out turned the sign-out into an
  // expired session: a "session expired" toast, and the next sign-in returned here.
  it('treats a 401 that lands during sign-out as part of signing out', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(alice as never);
    let finishLogout: () => void = () => {};
    vi.mocked(logoutRequest).mockImplementation(() => new Promise<void>((resolve) => { finishLogout = resolve; }));
    const client = newClient();
    renderApp(client);
    expect(await screen.findByText('accounts page')).toBeInTheDocument();

    let signingOut: Promise<void> = Promise.resolve();
    act(() => { signingOut = auth.logout(); });
    await waitFor(() => expect(logoutRequest).toHaveBeenCalled());
    act(() => { window.dispatchEvent(new Event('session-expired')); });
    await act(async () => { finishLogout(); await signingOut; });

    expect(await screen.findByText('login page, return to: none')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("another tab's sign-out or ledger switch", () => {
  beforeEach(() => {
    vi.mocked(getMyTenants).mockResolvedValue(membership as never);
    vi.mocked(logoutRequest).mockResolvedValue(undefined);
    vi.mocked(setActiveTenant).mockResolvedValue(undefined as never);
    vi.mocked(getCurrentUser).mockResolvedValue(alice as never);
  });

  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  // Two AuthProviders stand in for two tabs: each has its own cache, as tabs do.
  function renderTabs({ strict = false } = {}) {
    const tabs = [newClient(), newClient()];
    const auths: Array<ReturnType<typeof useAuth>> = [];
    const Tab = ({ index }: { index: number }) => {
      const value = useAuth();
      useEffect(() => {
        auths[index] = value;
      });
      return null;
    };
    for (const [index, client] of tabs.entries()) {
      const tab = (
        <QueryClientProvider client={client}>
          <MemoryRouter><AuthProvider><Tab index={index} /></AuthProvider></MemoryRouter>
        </QueryClientProvider>
      );
      render(strict ? <StrictMode>{tab}</StrictMode> : tab);
    }
    return { tabs, auths };
  }

  it("empties the other tab's ledger data when one tab switches ledgers", async () => {
    const { tabs, auths } = renderTabs();
    await waitFor(() => expect(auths[1]?.user).toEqual(alice));
    tabs[1].setQueryData(accountsKey, ledgerAccounts);

    await act(() => auths[0].switchTenant('ledger-2'));

    await waitFor(() => expect(tabs[1].getQueryData(accountsKey)).toBeUndefined());
  });

  it('signs the other tab out, without its data, when one tab signs out', async () => {
    const { tabs, auths } = renderTabs();
    await waitFor(() => expect(auths[1]?.user).toEqual(alice));
    tabs[1].setQueryData(accountsKey, ledgerAccounts);

    await act(() => auths[0].logout());

    await waitFor(() => expect(auths[1].user).toBeNull());
    expect(tabs[1].getQueryData(accountsKey)).toBeUndefined();
    expect(auths[1].mayReturnAfterSignIn()).toBe(false);
  });

  // Changing the password ends every session; the tab that did it, and the others,
  // drop it as signing out does, without asking the server to end it again.
  it('forgets the session in every tab after a password change, without calling the server', async () => {
    const { tabs, auths } = renderTabs();
    await waitFor(() => expect(auths[1]?.user).toEqual(alice));
    tabs[0].setQueryData(accountsKey, ledgerAccounts);
    tabs[1].setQueryData(accountsKey, ledgerAccounts);

    act(() => auths[0].forgetSession());

    await waitFor(() => expect(auths[0].user).toBeNull());
    await waitFor(() => expect(auths[1].user).toBeNull());
    expect(tabs[0].getQueryData(accountsKey)).toBeUndefined();
    expect(tabs[1].getQueryData(accountsKey)).toBeUndefined();
    expect(logoutRequest).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  // A passkey sign-in reloads its own tab; the others held the earlier session's data.
  it("drops the other tab's data when one tab signs in with a passkey", async () => {
    vi.mocked(authenticateWithPasskey).mockResolvedValue({ success: true } as never);
    const { tabs, auths } = renderTabs();
    await waitFor(() => expect(auths[1]?.user).toEqual(alice));
    tabs[1].setQueryData(accountsKey, ledgerAccounts);

    await act(() => auths[0].loginWithPasskey());

    expect(authenticateWithPasskey).toHaveBeenCalledWith(undefined);
    await waitFor(() => expect(tabs[1].getQueryData(accountsKey)).toBeUndefined());
  });

  // StrictMode (the dev build) runs an effect's cleanup once on mount,
  // which closed the channel for good: every switch then failed with "Could not switch
  // ledger", and the tabs stopped following each other.
  it('keeps the tabs in step under StrictMode, without a failure toast', async () => {
    const { tabs, auths } = renderTabs({ strict: true });
    await waitFor(() => expect(auths[1]?.user).toEqual(alice));
    tabs[1].setQueryData(accountsKey, ledgerAccounts);

    await act(() => auths[0].switchTenant('ledger-2'));

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Ledger switched');
    await waitFor(() => expect(tabs[1].getQueryData(accountsKey)).toBeUndefined());
  });

  // The other tab is told once the server has the new ledger, not after this tab's
  // queries refetch: until then its writes would land in a ledger it doesn't show.
  it('tells the other tab about a switch before its own data has reloaded', async () => {
    const { tabs, auths } = renderTabs();
    await waitFor(() => expect(auths[1]?.user).toEqual(alice));
    const pending: Array<() => void> = [];
    vi.mocked(getMyTenants).mockImplementation(() => new Promise((resolve) => { pending.push(() => resolve(membership as never)); }));
    tabs[1].setQueryData(accountsKey, ledgerAccounts);

    let switching: Promise<void> = Promise.resolve();
    act(() => { switching = auths[0].switchTenant('ledger-2'); });

    await waitFor(() => expect(tabs[1].getQueryData(accountsKey)).toBeUndefined());
    await act(async () => { pending.forEach((finish) => finish()); await switching; });
  });
});

// A server that is restarting isn't "signed out": the probe is retried, then
// the page offers a retry, and sign-in is never shown for it.
describe('AuthProvider when the session probe fails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMyTenants).mockResolvedValue(membership as never);
  });

  it('retries, then shows a retry screen; a successful retry opens the page', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(Object.assign(new Error('Bad gateway'), { status: 502 }));
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    renderApp(client);

    expect(await screen.findByRole('heading', { name: "Can't reach Nuggets" })).toBeInTheDocument();
    expect(getCurrentUser).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/login page/)).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();

    vi.mocked(getCurrentUser).mockResolvedValue(alice as never);
    act(() => screen.getByRole('button', { name: 'Try again' }).click());
    expect(await screen.findByText('accounts page')).toBeInTheDocument();
  });

  it('still sends a signed-out visitor (401, null) to sign-in', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    renderApp(newClient());
    expect(await screen.findByText('login page, return to: /accounts')).toBeInTheDocument();
  });
});

// The ledger list rides out a restart too: the session probe passed, and the next
// request, the ledger list, failed at once with "Your ledgers didn't load".
describe('AuthProvider when the ledger list fails', () => {
  const restarting = () => Object.assign(new Error('Bad gateway'), { status: 502 });
  const ledgers = { ...membership, tenants: [{ uuid: 't-1', name: 'Home' }] };
  // The test client's own default is no retries: the ledger list's are its own.
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentUser).mockResolvedValue(alice as never);
  });

  it('asks again twice, so a restart passes without the error', async () => {
    vi.mocked(getMyTenants).mockRejectedValueOnce(restarting()).mockRejectedValueOnce(restarting()).mockResolvedValue(ledgers as never);
    renderApp(client());

    await waitFor(() => expect(auth.tenants).toHaveLength(1));
    expect(getMyTenants).toHaveBeenCalledTimes(3);
    expect(auth.membershipFailed).toBe(false);
  });

  it('says the ledgers failed after the third try, and Try again asks again', async () => {
    vi.mocked(getMyTenants).mockRejectedValue(restarting());
    renderApp(client());

    await waitFor(() => expect(auth.membershipFailed).toBe(true));
    expect(getMyTenants).toHaveBeenCalledTimes(3);
    expect(toast.error).not.toHaveBeenCalled();

    vi.mocked(getMyTenants).mockResolvedValue(ledgers as never);
    await act(() => auth.retryMembership());
    await waitFor(() => expect(auth.tenants).toHaveLength(1));
    expect(auth.membershipFailed).toBe(false);
  });

  it('does not ask again after a 401: the session has ended', async () => {
    vi.mocked(getMyTenants).mockRejectedValue(Object.assign(new Error('Your session has expired'), { status: 401 }));
    renderApp(client());

    await waitFor(() => expect(auth.membershipFailed).toBe(true));
    expect(getMyTenants).toHaveBeenCalledTimes(1);
  });
});
