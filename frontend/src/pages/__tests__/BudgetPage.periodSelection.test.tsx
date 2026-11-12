import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '../../test/renderWithProviders';
import BudgetPage from '../BudgetPage';

/**
 * Which period the Budget page shows. The URL's `period` names it (a uuid or
 * YYYY-MM), else this session's saved choice, else today's month; the page writes
 * the shown period's YYYY-MM back into the URL, and a choice goes into both.
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
// The periods query's data, which a refetch after creating a period replaces.
const query = vi.hoisted(() => ({ periods: [] as unknown[], created: null as unknown }));
const createPeriod = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useBudgetPeriodsQuery: () => ({
      data: query.periods,
      isLoading: false,
      refetch: async () => {
        if (query.created) query.periods = [...query.periods, query.created];
        return { data: query.periods };
      },
    }),
    useBudgetPeriodItemsQuery: () => ({ data: { success: true, data: empty }, isLoading: false, isError: false }),
    useAccountsQuery: () => ({ data: empty }),
    useBudgetItemsQuery: () => ({ data: empty }),
    useCreateBudgetPeriodMutation: () => ({ mutateAsync: createPeriod, isPending: false }),
    useUpdateBudgetAmountMutation: mutation,
  };
});

// The URL as the page last set it. It's copied in an effect, which runs after the render that
// shows the period, so a test reads it in waitFor rather than right after the period shows.
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
          <BudgetPage />
          <LocationProbe />
        </MemoryRouter>
      </Theme>
    </QueryClientProvider>,
  );

const shownPeriod = () => screen.getByRole('combobox', { name: 'Budget period' });

beforeEach(() => {
  sessionStorage.clear();
  location = '';
  query.periods = periods;
  query.created = null;
  createPeriod.mockReset();
});

describe('BudgetPage period selection', () => {
  it("shows the URL's period by uuid and rewrites the URL to its YYYY-MM", async () => {
    renderAt('/budgets?period=uuid-2026-3');
    await waitFor(() => expect(shownPeriod()).toHaveTextContent('March 2026'));
    await waitFor(() => expect(location).toBe('?period=2026-03'));
  });

  it("shows this session's saved period when the URL names none, and puts it in the URL", async () => {
    sessionStorage.setItem('budget-selected-period', '2026-01');
    renderAt('/budgets');
    await waitFor(() => expect(shownPeriod()).toHaveTextContent('January 2026'));
    await waitFor(() => expect(location).toBe('?period=2026-01'));
  });

  it('shows the first period for a URL period that names none', async () => {
    renderAt('/budgets?period=2031-05');
    await waitFor(() => expect(shownPeriod()).toHaveTextContent('January 2026'));
    await waitFor(() => expect(location).toBe('?period=2026-01'));
  });

  it('a chosen period goes into the URL and the session', async () => {
    renderAt('/budgets?period=2026-01');
    await waitFor(() => expect(shownPeriod()).toHaveTextContent('January 2026'));
    await userEvent.click(shownPeriod());
    await userEvent.click(await screen.findByRole('option', { name: 'February 2026' }));
    await waitFor(() => expect(shownPeriod()).toHaveTextContent('February 2026'));
    await waitFor(() => expect(location).toBe('?period=2026-02'));
    expect(sessionStorage.getItem('budget-selected-period')).toBe('2026-02');
  });

  // POST /budgets/periods answers with the period row itself; the page looked for a
  // `data.periodId` it doesn't have, so the new period was never selected.
  it('shows a period it has just created', async () => {
    const year = new Date().getFullYear();
    query.created = {
      id: 99, uuid: 'uuid-new', name: `${year}-6`, month: 'June', year, month_number: 6,
      start_date: `${year}-06-01`, end_date: `${year}-06-30`, status: 'upcoming',
    };
    createPeriod.mockResolvedValue({ ...(query.created as object), budgetItemsCreated: 0 });
    renderAt('/budgets?period=2026-01');
    await waitFor(() => expect(shownPeriod()).toHaveTextContent('January 2026'));

    await userEvent.click(screen.getByRole('button', { name: 'Create Period' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('option', { name: 'June' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Period' }));

    expect(createPeriod).toHaveBeenCalledWith([year, 6]);
    await waitFor(() => expect(shownPeriod()).toHaveTextContent(`June ${year}`));
    await waitFor(() => expect(location).toBe(`?period=${year}-06`));
  });

  // Another member created the month after this page loaded its list: the POST answers 409,
  // and the page used to keep the dialog open with a generic error until it was reloaded.
  it('shows the existing period when someone else created the month first', async () => {
    const year = new Date().getFullYear();
    query.created = {
      id: 98, uuid: 'uuid-theirs', name: `${year}-7`, month: 'July', year, month_number: 7,
      start_date: `${year}-07-01`, end_date: `${year}-07-31`, status: 'upcoming',
    };
    createPeriod.mockRejectedValue(Object.assign(new Error('Budget period for 7/2026 already exists'), {
      status: 409,
      response: { data: { error: 'Budget period for 7/2026 already exists', code: 'BUDGET_PERIOD_EXISTS' } },
    }));
    renderAt('/budgets?period=2026-01');
    await waitFor(() => expect(shownPeriod()).toHaveTextContent('January 2026'));

    await userEvent.click(screen.getByRole('button', { name: 'Create Period' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('option', { name: 'July' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Period' }));

    await waitFor(() => expect(shownPeriod()).toHaveTextContent(`July ${year}`));
    await waitFor(() => expect(location).toBe(`?period=${year}-07`));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
