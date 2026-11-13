import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '../../test/renderWithProviders';
import { apiError, mockApi } from '../../test/apiServer';
import CloseOutPage from '../CloseOutPage';

/**
 * Which period Close-Out shows: the URL's `period` (uuid or YYYY-MM), else the one
 * chosen here last time, else today's month. The page writes the shown period's
 * YYYY-MM back into the URL; a choice goes into both.
 */

// jsdom lacks the pointer-capture and scroll APIs Radix Select calls.
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

const periods = vi.hoisted(() =>
  [1, 2, 3].map((month) => ({
    id: month,
    uuid: `uuid-2026-${month}`,
    name: `2026-${month}`,
    month: ['January', 'February', 'March'][month - 1],
    year: 2026,
    month_number: month,
    start_date: `2026-0${month}-01`,
    end_date: `2026-0${month}-28`,
    status: month === 2 ? 'active' : 'closed',
  })),
);
const empty = vi.hoisted(() => [] as never[]);

vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  useBudgetPeriodsQuery: () => ({ data: periods, isLoading: false }),
  useBudgetPeriodItemsQuery: () => ({ data: { success: true, data: empty }, isLoading: false }),
  useZeroBalanceAccountsQuery: () => ({ data: undefined, isLoading: false }),
  useAccountsQuery: () => ({ data: empty }),
  useEnvelopeBalanceQuery: () => ({ data: { success: true, data: { accounts: empty } }, isLoading: false, isSuccess: true }),
}));

let location = '';
const LocationProbe = () => {
  const { search } = useLocation();
  useEffect(() => {
    location = search;
  }, [search]);
  return null;
};

const renderAt = (route: string) =>
  render(
    <QueryClientProvider client={makeTestQueryClient()}>
      <Theme>
        <MemoryRouter initialEntries={[route]}>
          <CloseOutPage />
          <LocationProbe />
        </MemoryRouter>
      </Theme>
    </QueryClientProvider>,
  );

const shownPeriod = () => screen.getByRole('combobox', { name: 'Budget period' });

// The hooks above are stubbed; the envelope section and the time zone still fetch, so the API
// answers them (no envelope account; the default zone) instead of a raw `fetch` failing to
// parse a relative URL and logging it.
let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  location = '';
  api = mockApi({
    'GET /budgets/periods/:uuid/envelope-transfers': apiError(404, 'No envelope account configured', 'NO_ENVELOPE_ACCOUNT'),
    'GET /settings/general': [],
  });
});
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  vi.unstubAllGlobals();
});

describe('CloseOutPage period selection', () => {
  it("shows the URL's period by uuid and rewrites the URL to its YYYY-MM", async () => {
    renderAt('/closeout?period=uuid-2026-3');
    await waitFor(() => expect(shownPeriod()).toHaveTextContent('March 2026'));
    await waitFor(() => expect(location).toBe('?period=2026-03'));
  });

  it('shows the period chosen last in this tab when the URL names none', async () => {
    sessionStorage.setItem('closeout-selected-period', '2026-01');
    renderAt('/closeout');
    await waitFor(() => expect(shownPeriod()).toHaveTextContent('January 2026'));
    await waitFor(() => expect(location).toBe('?period=2026-01'));
  });

  it('a chosen period goes into the URL and is kept for the tab, not across sessions', async () => {
    renderAt('/closeout?period=2026-01');
    await waitFor(() => expect(shownPeriod()).toHaveTextContent('January 2026'));
    await userEvent.click(shownPeriod());
    await userEvent.click(await screen.findByRole('option', { name: 'February 2026' }));
    await waitFor(() => expect(shownPeriod()).toHaveTextContent('February 2026'));
    expect(location).toBe('?period=2026-02');
    expect(sessionStorage.getItem('closeout-selected-period')).toBe('2026-02');
    expect(localStorage.getItem('closeout-selected-period')).toBeNull();
  });
});
