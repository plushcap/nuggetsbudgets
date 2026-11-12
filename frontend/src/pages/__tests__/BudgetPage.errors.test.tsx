import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '../../test/renderWithProviders';
import BudgetPage from '../BudgetPage';

/**
 * The Budget page when something fails or there's nothing yet: a failed inline
 * save is a toast and that row goes back to the server's amount (the page stays); an
 * amount typed just before leaving is still saved; a ledger with no periods can create
 * one from the empty state; a failed load is a retry, not "no periods".
 */

Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

// The desktop row and the mobile card both mount an editor that focuses itself; jsdom has
// no CSS to hide one, so the second would take the focus and the first's blur would save.
vi.mock('../../utils/focusOnMount', () => ({ focusOnMount: () => {} }));

const toastError = vi.hoisted(() => vi.fn());
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { error: toastError, success: vi.fn() }),
  toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn() }),
}));

const period = vi.hoisted(() => ({
  id: 1,
  uuid: 'uuid-2026-2',
  name: '2026-2',
  month: 'February',
  year: 2026,
  month_number: 2,
  start_date: '2026-02-01',
  end_date: '2026-02-28',
  status: 'active',
}));
const item = vi.hoisted(() => ({
  id: 10,
  uuid: 'bpi-10',
  budget_period_id: 1,
  budget_item_id: 3,
  budget_item_uuid: 'bi-3',
  budget_item_name: 'Groceries',
  name: 'Groceries',
  expense_type: 'Expense',
  priority: 'Essential',
  type: 'Monthly',
  subtype: 'Flexible',
  rollover: false,
  icon: 'Tag',
  color: 'gray',
  starting: 0,
  calculated_budget: 400,
  calculated_actual: -120,
  calculated_transfers: 0,
  calculated_remaining: 280,
  created_at: '2026-02-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
}));
const empty = vi.hoisted(() => [] as never[]);
const state = vi.hoisted(() => ({
  periods: [] as unknown[],
  periodsError: null as Error | null,
  items: [] as unknown[],
  refetchPeriods: vi.fn(),
  updateAmount: vi.fn(),
}));

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  return {
    ...actual,
    useBudgetPeriodsQuery: () => ({
      data: state.periodsError ? undefined : state.periods,
      isLoading: false,
      isError: !!state.periodsError,
      error: state.periodsError,
      isFetching: false,
      refetch: state.refetchPeriods,
    }),
    useBudgetPeriodItemsQuery: () => ({ data: { success: true, data: state.items }, isLoading: false, isError: false }),
    useAccountsQuery: () => ({ data: empty }),
    useBudgetItemsQuery: () => ({ data: empty }),
    useCreateBudgetPeriodMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useUpdateBudgetAmountMutation: () => ({ mutateAsync: state.updateAmount, isPending: false }),
  };
});

const renderPage = () =>
  render(
    <QueryClientProvider client={makeTestQueryClient()}>
      <Theme>
        <MemoryRouter initialEntries={['/budgets?period=2026-02']}>
          <BudgetPage />
        </MemoryRouter>
      </Theme>
    </QueryClientProvider>,
  );

/** Opens the first Groceries budget amount for editing and types `amount`. */
const typeBudget = async (amount: string) => {
  await userEvent.click(screen.getAllByRole('button', { name: 'Edit budget for Groceries, $400.00' })[0]);
  const input = screen.getAllByRole('textbox', { name: 'Budget for Groceries' })[0];
  await userEvent.clear(input);
  await userEvent.type(input, amount);
  return input;
};

beforeEach(() => {
  state.periods = [period];
  state.periodsError = null;
  state.items = [item];
  state.refetchPeriods.mockReset();
  state.updateAmount.mockReset();
  toastError.mockReset();
});

describe('BudgetPage when things fail', () => {
  it('a failed inline save is a toast and that row goes back to the saved amount; the page stays', async () => {
    state.updateAmount.mockRejectedValue(Object.assign(new Error('Budget period is closed'), { status: 409 }));
    renderPage();
    await typeBudget('450');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Budget period is closed'));
    expect(screen.getByRole('heading', { name: 'Budget Plan' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Edit budget for Groceries, $400.00' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Edit budget for Groceries, $450.00' })).not.toBeInTheDocument();
  });

  it('saves an amount typed just before leaving the page', async () => {
    state.updateAmount.mockResolvedValue({});
    const { unmount } = renderPage();
    await typeBudget('450');
    await userEvent.keyboard('{Enter}');
    // Leave within the 500 ms the save waits for more typing.
    unmount();
    expect(state.updateAmount).toHaveBeenCalledTimes(1);
    expect(state.updateAmount.mock.calls[0][0].slice(0, 2)).toEqual(['bpi-10', 450]);
  });

  it('offers to create the first period when the ledger has none', async () => {
    state.periods = [];
    state.items = [];
    renderPage();
    expect(screen.getByRole('heading', { name: 'Budget Plan', level: 1 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create budget period' }));
    expect(within(screen.getByRole('dialog')).getByRole('heading', { name: 'Create Budget Period' })).toBeInTheDocument();
  });

  it('a failed load of the periods is a retry, not "no periods"', async () => {
    state.periodsError = Object.assign(new Error('Internal server error (reference req-9)'), {
      status: 500,
      requestId: 'req-9',
    });
    renderPage();
    expect(screen.getByRole('heading', { name: "Couldn't load the budget", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create budget period' })).not.toBeInTheDocument();
    expect(screen.getByText('Reference req-9')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(state.refetchPeriods).toHaveBeenCalled();
  });
});
