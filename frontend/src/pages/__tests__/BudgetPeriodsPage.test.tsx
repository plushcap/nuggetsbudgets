import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import BudgetPeriodsPage from '../BudgetPeriodsPage';

// The API has sent DATE columns both as 'YYYY-MM-DD' and as an ISO instant at
// UTC midnight; either must show that calendar day.
const periods = [
  { id: 1, uuid: 'p1', name: 'October 2026', year: 2026, month_number: 10, start_date: '2026-10-01', end_date: '2026-10-31', transaction_count: 3, budget_item_count: 2, budget_transaction_count: 2 },
  { id: 2, uuid: 'p2', name: 'November 2026', year: 2026, month_number: 11, start_date: '2026-11-01T00:00:00.000Z', end_date: '2026-11-30T00:00:00.000Z', transaction_count: 0, budget_item_count: 0, budget_transaction_count: 0 },
];

vi.mock('../../hooks/queries', () => ({
  useBudgetPeriodsManagementQuery: () => ({ data: { periods, stats: null }, isLoading: false }),
  useDeleteBudgetPeriodMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// A period's start/end are calendar days; read as UTC instants they show
// a day early anywhere west of UTC.
describe('BudgetPeriodsPage date ranges in Los Angeles', () => {
  pinTimeZone('America/Los_Angeles');

  it('shows each period from its first to its last day', () => {
    renderWithProviders(<Theme><BudgetPeriodsPage /></Theme>);
    // Mobile cards and the desktop table both render the range.
    expect(screen.getAllByText('10/1/2026 - 10/31/2026').length).toBeGreaterThan(0);
    expect(screen.getAllByText('11/1/2026 - 11/30/2026').length).toBeGreaterThan(0);
  });
});

// An envelope's balance runs through every period up to each one, so
// deleting a period with budgets or spending changes the later periods' balances.
describe('Deleting a budget period', () => {
  const ENVELOPES = "Envelope balances in later periods include this period's budgets and spending, so they will change";

  it('warns that later envelope balances change when a later period exists', async () => {
    renderWithProviders(<Theme><BudgetPeriodsPage /></Theme>);
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete October 2026' })[0]);
    expect(await screen.findByText(ENVELOPES)).toBeInTheDocument();
  });

  it("doesn't for the latest period", async () => {
    renderWithProviders(<Theme><BudgetPeriodsPage /></Theme>);
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete November 2026' })[0]);
    expect(await screen.findByText('This action cannot be undone')).toBeInTheDocument();
    expect(screen.queryByText(ENVELOPES)).not.toBeInTheDocument();
  });
});
