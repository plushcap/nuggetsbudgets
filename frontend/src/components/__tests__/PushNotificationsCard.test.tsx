import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { PushNotificationsCard } from '../PushNotificationsCard';
import type { PushState } from '../../utils/pushNotifications';

const push = vi.hoisted(() => ({
  state: 'disabled' as PushState,
  getPushState: vi.fn(),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
}));
vi.mock('../../utils/pushNotifications', () => ({
  getPushState: () => push.getPushState(),
  enablePush: () => push.enablePush(),
  disablePush: () => push.disablePush(),
}));

const api = vi.hoisted(() => ({ count: 0, sendTestPush: vi.fn() }));
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    getPushDeviceCount: () => Promise.resolve({ count: api.count }),
    sendTestPush: () => api.sendTestPush(),
  };
});

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ toast, default: toast }));

const renderCard = () => renderWithProviders(<Theme><PushNotificationsCard /></Theme>);

describe('PushNotificationsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.count = 0;
    push.getPushState.mockImplementation(() => Promise.resolve(push.state));
  });

  it('explains the Home Screen step on an iPhone browser tab instead of offering a switch', async () => {
    push.state = 'install-first';
    renderCard();
    expect(await screen.findByText(/add Nuggets to your Home Screen first/i)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('tells the person how to unblock notifications they denied', async () => {
    push.state = 'denied';
    renderCard();
    expect(await screen.findByText(/blocked for Nuggets/i)).toBeInTheDocument();
  });

  it('turns notifications on for this device', async () => {
    push.state = 'disabled';
    push.enablePush.mockResolvedValue('enabled');
    renderCard();

    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);

    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked());
    expect(push.enablePush).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Notifications are on for this device');
  });

  it('turns notifications off for this device', async () => {
    push.state = 'enabled';
    renderCard();

    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).toBeChecked());
    await userEvent.click(toggle);

    await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked());
    expect(push.disablePush).toHaveBeenCalledTimes(1);
  });

  it('sends a test to the devices that have notifications on', async () => {
    push.state = 'enabled';
    api.count = 2;
    api.sendTestPush.mockResolvedValue({ sent: 2, failed: 0, removed: 0 });
    renderCard();

    expect(await screen.findByText('On for 2 devices.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /send a test/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Test sent to 2 devices'));
  });
});
