import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { AuthProvider } from '../../contexts/AuthContext';
import RequireLedger from '../../components/RequireLedger';
import SettingsPage from '../SettingsPage';
import { getCurrentUser, getMyTenants } from '../../services/api';

/**
 * When the membership summary (GET /api/tenants/mine) fails, the pages don't wait for it
 * forever. AuthProvider asks for it three times at most, then not again on its
 * own (`staleTime: Infinity`), so a page that waited on it showed "Loading…" until a reload:
 * MCP Access among them, which needs no role and no ledger. A page that does need a role
 * says who may use it and offers to ask again.
 */
// The ledger's money gate waits for its settings (LedgerMoneyFormat.test.tsx); this test serves
// none, so its pages render as a USD ledger's would.
vi.mock('../../components/LedgerMoneyFormat', () => ({ default: ({ children }: { children: import('react').ReactNode }) => children }));
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, getCurrentUser: vi.fn(), getMyTenants: vi.fn() };
});
vi.mock('../../utils/pushNotifications', () => ({
  disablePushOnSignOut: vi.fn(async () => {}),
  syncPushSubscription: vi.fn(async () => {}),
}));
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../McpAccessPage', () => ({ default: () => 'MCP page' }));
vi.mock('../UserManagementPage', () => ({ default: () => 'Users page' }));
vi.mock('../DataDeletionSettingsPage', () => ({ default: () => 'Data management page' }));
vi.mock('../CategoriesPage', () => ({ default: () => 'Categories page' }));
vi.mock('../../components/LedgerSelectionScreen', () => ({ default: () => 'Choose a ledger screen' }));

const someone = { id: 1, uuid: 'u-1', email: 'someone@example.com', name: 'Someone' };
const tenant = { uuid: 'ledger-1', name: 'Home', organizationUuid: 'org-1', organizationName: 'Family' };
const noRoles = { tenants: [], organizations: [], activeTenant: null, isDeploymentAdmin: false, tenantRole: null, orgRole: null };
const tenantAdmin = {
  tenants: [{ ...tenant, status: 'active', role: 'admin', isActiveTenant: true }],
  organizations: [{ uuid: 'org-1', name: 'Family', status: 'active', role: 'member' }],
  activeTenant: tenant,
  isDeploymentAdmin: false,
  tenantRole: 'admin',
  orgRole: 'member',
};

function renderAt(route: string) {
  // No wait between AuthProvider's tries of the summary.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <Theme>
            <RequireLedger>
              <Routes>
                <Route path="/dashboard" element="Dashboard page" />
                <Route path="/settings/*" element={<SettingsPage />} />
              </Routes>
            </RequireLedger>
          </Theme>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const down = () => Promise.reject(new Error('Failed to fetch'));
/** The summary fails at each of AuthProvider's three tries, then answers `then`. */
const failsThenAnswers = (then: unknown) =>
  vi.mocked(getMyTenants).mockImplementationOnce(down).mockImplementationOnce(down).mockImplementationOnce(down).mockResolvedValue(then as never);

describe('Settings pages when the membership summary fails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentUser).mockResolvedValue(someone as never);
  });

  it('opens MCP Access, which needs no role and no ledger', async () => {
    vi.mocked(getMyTenants).mockImplementation(down);
    renderAt('/settings/mcp');
    expect(await screen.findByText('MCP page')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('opens MCP Access without waiting for the summary at all', async () => {
    vi.mocked(getMyTenants).mockReturnValue(new Promise(() => {}));
    renderAt('/settings/mcp');
    expect(await screen.findByText('MCP page')).toBeInTheDocument();
  });

  it("says who may use an admin page, and asks again on Try again", async () => {
    failsThenAnswers({ ...noRoles, isDeploymentAdmin: true });
    renderAt('/settings/users');

    const heading = await screen.findByRole('heading', { name: 'Deployment admins only' });
    expect(heading.closest('.rt-CalloutRoot')).not.toBeNull();
    expect(screen.getByText(/couldn.t load your roles/i)).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.queryByText('Users page')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Users page')).toBeInTheDocument();
    expect(getMyTenants).toHaveBeenCalledTimes(4);
  });

  it('says so for an admin page on the ledger too, rather than wait for a ledger', async () => {
    failsThenAnswers(tenantAdmin);
    renderAt('/settings/data-management');

    expect(await screen.findByRole('heading', { name: 'Ledger admins only' })).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Data management page')).toBeInTheDocument();
  });

  it.each(['/settings/categories', '/dashboard'])('offers to ask again on a page that needs a ledger (%s)', async (route) => {
    failsThenAnswers(tenantAdmin);
    renderAt(route);

    expect(await screen.findByText(/couldn.t load your ledgers/i)).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(route === '/dashboard' ? 'Dashboard page' : 'Categories page')).toBeInTheDocument();
  });
});
