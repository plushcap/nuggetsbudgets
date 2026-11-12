import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import OneDriveSync from '../OneDriveSync';

/**
 * The OneDrive card's sign-in result: a `?message=` in a link is never shown (anyone
 * can craft one), only its own parameters leave the URL, and the popup's listener and
 * poll end with the page.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: toast }));
const startOneDriveAuth = vi.hoisted(() => vi.fn());
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  startOneDriveAuth,
}));
const refetch = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  useOneDriveStatusQuery: () => ({ data: { configured: true, connected: false }, isLoading: false, refetch }),
}));

let where = '';
const Where = () => {
  const location = useLocation();
  useEffect(() => {
    where = `${location.pathname}${location.search}`;
  });
  return null;
};

const renderAt = (route: string) =>
  renderWithProviders(
    <Theme>
      <OneDriveSync />
      <Where />
    </Theme>,
    { route },
  );

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  refetch.mockClear();
});

describe('OneDriveSync', () => {
  it("doesn't show a link's message, and drops only its own parameters from the URL", () => {
    renderAt('/settings/backup?tab=sync&onedrive=error&message=Call%20555-0100%20to%20restore%20your%20account');
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0][0]).not.toMatch(/555|restore/);
    expect(where).toBe('/settings/backup?tab=sync');
  });

  it('says so on success and reloads the status', () => {
    renderAt('/settings/backup?onedrive=success');
    expect(toast.success).toHaveBeenCalledWith('OneDrive connected successfully!');
    expect(refetch).toHaveBeenCalled();
    expect(where).toBe('/settings/backup');
  });

  it("stops listening for the popup when the page goes", async () => {
    startOneDriveAuth.mockResolvedValue({ authUrl: 'https://login.example/authorize' });
    const popup = { closed: false, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const { unmount } = renderAt('/settings/backup');
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(window.open).toHaveBeenCalled();
    unmount();
    expect(removeListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(clearInterval).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
