import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { handleResponse } from '../../services/api/base';
import ImportSettingsPage from '../ImportSettingsPage';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ toast, default: toast }));

const auth = vi.hoisted(() => ({
  current: { orgRole: 'admin', isDeploymentAdmin: false, activeOrganization: null } as Record<string, unknown>,
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.current }));
vi.mock('../../components/OrgSimpleFinConnectionCard', () => ({ default: () => 'SimpleFin connection card' }));

const api = vi.hoisted(() => ({ runManualSync: vi.fn() }));
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    getImportSettings: async () => ({ success: true, settings: { import_manual_sync_enabled: { value: 'true' } } }),
    getImportStatus: async () => ({ configured: true, connected: true, provider: 'simplefin', settings: {}, scheduler: { enabled: false, running: false, nextSyncTime: null, lastAutomaticSync: null } }),
    getImportUsers: async () => ({ success: true, users: [] }),
    runManualSync: () => api.runManualSync(),
  };
});

/** What the server answers, through the real response handling (status, Ledger wording). */
const answer = (status: number, body: unknown) =>
  handleResponse(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

async function clickSyncNow() {
  renderWithProviders(<Theme><ImportSettingsPage /></Theme>, { route: '/settings/import' });
  const button = await screen.findByRole('button', { name: /Sync Now/ });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
}

describe('ImportSettingsPage manual sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.current = { orgRole: 'admin', isDeploymentAdmin: false, activeOrganization: null };
  });

  it("shows the server's reason when a sync of the Ledger is already running", async () => {
    const reason = 'A bank sync of this tenant is already running. Try again when it has finished.';
    api.runManualSync.mockImplementation(() => answer(409, { error: reason, code: 'SYNC_IN_PROGRESS', message: reason }));
    await clickSyncNow();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('A bank sync of this ledger is already running. Try again when it has finished.')
    );
  });

  it('keeps the general message for a server error', async () => {
    api.runManualSync.mockImplementation(() => answer(500, { error: 'Internal server error' }));
    await clickSyncNow();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Manual sync failed'));
  });

  it("says a partial sync was partial, not that it completed successfully", async () => {
    const message = 'Sync completed with problems: 2 transactions could not be imported; see the server log';
    api.runManualSync.mockImplementation(() => answer(200, { success: true, status: 'partial', message }));
    await clickSyncNow();

    await waitFor(() => expect(toast).toHaveBeenCalledWith(message, expect.anything()));
    expect(toast.success).not.toHaveBeenCalled();
  });
});

/**
 * Any member of the ledger may open the page: its status and Sync Now are member
 * routes, and the account pages' Reconnect pill sends members here. The organization's
 * connection (its card, Test Connection, the SimpleFin accounts) is its admins' to see.
 */
describe('ImportSettingsPage by role', () => {
  const org = { uuid: 'org-1', name: 'Family' };
  const renderAs = (current: Record<string, unknown>) => {
    auth.current = current;
    renderWithProviders(<Theme><ImportSettingsPage /></Theme>, { route: '/settings/import-settings' });
  };

  beforeEach(() => vi.clearAllMocks());

  it('shows a member the status and Sync Now, and says who reconnects the bank', async () => {
    renderAs({ orgRole: 'member', isDeploymentAdmin: false, activeOrganization: org });

    expect(await screen.findByRole('button', { name: /Sync Now/ })).toBeInTheDocument();
    expect(screen.getByText('Connection Status')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View Sync History/ })).toHaveAttribute('href', '/import/sync-history');
    expect(screen.getByText(/an organization admin connects it/i)).toBeInTheDocument();

    expect(screen.queryByText(/admins only/i)).not.toBeInTheDocument();
    expect(screen.queryByText('SimpleFin connection card')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Test Connection/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View SimpleFin Accounts/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Import Configuration')).not.toBeInTheDocument();
  });

  it('shows an organization admin the connection as well', async () => {
    renderAs({ orgRole: 'admin', isDeploymentAdmin: false, activeOrganization: org });

    expect(await screen.findByText('SimpleFin connection card')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Test Connection/ })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /View SimpleFin Accounts/ })).toHaveAttribute('href', '/import/simplefin-accounts');
    expect(screen.getByRole('button', { name: /Sync Now/ })).toBeInTheDocument();
    expect(screen.queryByText(/an organization admin connects it/i)).not.toBeInTheDocument();
    // The ledger's own schedule is theirs to set.
    expect(await screen.findByText('Import Configuration')).toBeInTheDocument();
  });

  it("shows a deployment admin the ledger's schedule form", async () => {
    renderAs({ orgRole: 'member', isDeploymentAdmin: true, activeOrganization: org });
    expect(await screen.findByText('Import Configuration')).toBeInTheDocument();
  });
});
