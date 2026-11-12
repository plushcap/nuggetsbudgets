import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '../../test/renderWithProviders';
import { apiError, mockApi } from '../../test/apiServer';
import { account, accountsResponse, security } from '../../test/fixtures';
import CostBasisSettingsPage from '../CostBasisSettingsPage';

/**
 * Saving a cost-basis method: a refusal keeps the member on the page and says why, the
 * server's reason rather than a fixed "Failed to save settings", as the other
 * investment forms do.
 */

Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
});

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});

const brokerage = account({ id: 1, name: 'Brokerage', account_type: 'investment', account_group: 'investments' });

describe('CostBasisSettingsPage', () => {
  it("toasts the server's reason when the settings are refused", async () => {
    mockApi({
      'GET /accounts': accountsResponse([brokerage]),
      'GET /investments/securities': [security({ id: 1, ticker: 'STKIDX', name: 'Total Stock Market' })],
      'POST /investments/cost-basis-method': apiError(409, 'This account has sales recorded with another method', 'METHOD_LOCKED'),
    });
    const user = userEvent.setup();
    renderWithProviders(
      <Theme>
        <Routes>
          <Route path="/investments/cost-basis" element={<CostBasisSettingsPage />} />
          <Route path="/investments" element={<p>Investments overview</p>} />
        </Routes>
      </Theme>,
      { route: '/investments/cost-basis' },
    );

    await user.click(await screen.findByRole('combobox', { name: /Account/ }));
    await user.click(await screen.findByRole('option', { name: 'Brokerage' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const { default: toast } = await import('react-hot-toast');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This account has sales recorded with another method'));
    expect(screen.queryByText('Investments overview')).not.toBeInTheDocument();
  });
});
