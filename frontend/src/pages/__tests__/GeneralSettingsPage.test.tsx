import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import GeneralSettingsPage from '../GeneralSettingsPage';

// The same objects on every render, as React Query's data is.
const { save, settings, zones } = vi.hoisted(() => ({
  save: vi.fn(),
  settings: { data: [{ setting_key: 'application_timezone', setting_value: 'America/New_York', setting_type: 'string', description: 'Time zone', category: 'general' }], isLoading: false },
  zones: { data: [{ value: 'America/New_York', label: 'Eastern Time', offset: 'UTC-5/-4' }], isLoading: false },
}));
vi.mock('../../hooks/queries/settings', () => ({
  useGeneralSettingsQuery: () => settings,
  useAvailableTimezonesQuery: () => zones,
  useUpdateGeneralSettingsMutation: () => ({ mutateAsync: save, isPending: false }),
}));
vi.mock('../../components/ThemeSettings', () => ({ default: () => null }));
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from 'react-hot-toast';

describe('GeneralSettingsPage', () => {
  // A refused zone read only "Failed to save general settings".
  it("says why the server refused a save", async () => {
    save.mockRejectedValue(Object.assign(new Error('application_timezone must be an IANA time zone such as America/New_York'), { status: 400 }));
    renderWithProviders(<Theme><GeneralSettingsPage /></Theme>);
    fireEvent.click((await screen.findAllByRole('button', { name: /Save Settings/ }))[0]);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Not saved: application_timezone must be an IANA time zone such as America/New_York'),
    );
  });

  it('names the time zone field by its label', async () => {
    renderWithProviders(<Theme><GeneralSettingsPage /></Theme>);
    expect(await screen.findByRole('combobox', { name: 'Ledger Time Zone' })).toBeInTheDocument();
  });

  it("offers the ledger's currency and number format, shows how amounts will look, and saves them", async () => {
    const before = settings.data;
    settings.data = [
      ...before,
      { setting_key: 'application_currency', setting_value: 'EUR', setting_type: 'string', description: 'Currency', category: 'general' },
      { setting_key: 'application_locale', setting_value: 'de-DE', setting_type: 'string', description: 'Locale', category: 'general' },
    ];
    try {
      save.mockResolvedValue(undefined);
      renderWithProviders(<Theme><GeneralSettingsPage /></Theme>);
      expect(await screen.findByRole('combobox', { name: 'Ledger Currency' })).toHaveTextContent('EUR – Euro');
      expect(screen.getByRole('combobox', { name: 'Number Format' })).toHaveTextContent('German (Germany)');
      expect(screen.getByText(/Amounts show as/).textContent?.replace(/[\u00a0\u202f]/g, ' ')).toBe(
        'Amounts show as -1.234,56 € for everyone in this ledger.',
      );
      // Under Money, not as text boxes under Other Settings.
      expect(screen.queryByText('Other Settings')).not.toBeInTheDocument();
      fireEvent.click((await screen.findAllByRole('button', { name: /Save Settings/ }))[0]);
      await waitFor(() =>
        expect(save).toHaveBeenLastCalledWith({
          application_timezone: 'America/New_York',
          application_currency: 'EUR',
          application_locale: 'de-DE',
        }),
      );
    } finally {
      settings.data = before;
    }
  });

  it('keeps the general message for a server error', async () => {
    save.mockRejectedValue(Object.assign(new Error('Failed to update general settings'), { status: 500 }));
    renderWithProviders(<Theme><GeneralSettingsPage /></Theme>);
    fireEvent.click((await screen.findAllByRole('button', { name: /Save Settings/ }))[0]);
    await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith('Failed to save general settings'));
  });
});
