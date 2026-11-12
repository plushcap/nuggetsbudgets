import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import NotificationSettingsPage from '../NotificationSettingsPage';

const api = vi.hoisted(() => ({ status: vi.fn(), settings: vi.fn(), history: vi.fn() }));
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    getNotificationStatus: () => api.status(),
    getNotificationSettings: () => api.settings(),
    getNotificationHistory: () => api.history(),
  };
});

const HOME = { id: 1, uuid: 'tenant-1', name: 'Home' };
const auth = vi.hoisted(() => ({ isDeploymentAdmin: false, activeTenant: null as unknown }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const renderPage = () => renderWithProviders(<Theme><NotificationSettingsPage /></Theme>, { route: '/settings/notifications' });

describe('NotificationSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.isDeploymentAdmin = false;
    auth.activeTenant = HOME;
    api.status.mockResolvedValue({
      configured: true,
      enabled: true,
      scheduler: { running: true, shuttingDown: false, hasRunningOperations: false, settings: {} },
      queue: { pending: 0, processing: 0, sent: 3, failed: 0 },
    });
    api.settings.mockResolvedValue({ settings: {}, passwordConfigured: false });
    api.history.mockResolvedValue({ notifications: [], pagination: { page: 1, totalPages: 1 } });
  });

  it("doesn't show or ask for the deployment's email settings unless you're a deployment admin", () => {
    renderPage();
    expect(screen.getByText('Access Denied')).toBeInTheDocument();
    expect(screen.queryByText('SMTP Configuration')).not.toBeInTheDocument();
    expect(api.status).not.toHaveBeenCalled();
    expect(api.settings).not.toHaveBeenCalled();
    expect(api.history).not.toHaveBeenCalled();
  });

  it('shows a deployment admin the settings, scheduler and history', async () => {
    auth.isDeploymentAdmin = true;
    renderPage();
    expect(await screen.findByText('SMTP Configuration')).toBeInTheDocument();
    expect(screen.getByText('Notification System Status')).toBeInTheDocument();
    expect(screen.getByText('Recent Notifications')).toBeInTheDocument();
    expect(screen.queryByText('Access Denied')).not.toBeInTheDocument();
  });

  it("opens without a ledger, for a deployment admin who has none, and leaves the ledger's history out", async () => {
    auth.isDeploymentAdmin = true;
    auth.activeTenant = null;
    renderPage();
    expect(await screen.findByText('SMTP Configuration')).toBeInTheDocument();
    expect(screen.getByText('Notification System Status')).toBeInTheDocument();
    expect(screen.queryByText('Recent Notifications')).not.toBeInTheDocument();
    expect(api.history).not.toHaveBeenCalled();
  });

  it("says why a notification hasn't gone: waiting for email, or why it failed", async () => {
    auth.isDeploymentAdmin = true;
    const row = (id: number, status: string, error_message: string | null) => ({
      id, uuid: `n-${id}`, user_email: 'pat@example.com', user_name: 'Pat', notification_type: 'budget_item',
      status, sent_at: null, failed_at: null, error_message, retry_count: 0, created_at: '2026-11-04T12:00:00.000Z',
    });
    api.history.mockResolvedValue({
      notifications: [
        row(1, 'pending', 'Waiting for email to be set up'),
        row(2, 'failed', "Not sent: email wasn't set up in time"),
        // A sent one's old reason (cleared when it goes, but never shown).
        row(3, 'sent', 'An earlier attempt failed'),
      ],
      pagination: { page: 1, totalPages: 1 },
    });
    renderPage();
    expect(await screen.findByText('Waiting for email to be set up')).toBeInTheDocument();
    expect(screen.getByText("Not sent: email wasn't set up in time")).toBeInTheDocument();
    expect(screen.queryByText('An earlier attempt failed')).not.toBeInTheDocument();
  });
});
