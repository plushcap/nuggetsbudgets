import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import BudgetItemActivityModal from '../BudgetItemActivityModal';
import type { BudgetPeriodItem } from '../../services/api';

vi.mock('../../hooks/queries', () => ({
  useBudgetItemActivityQuery: () => ({ data: [], isLoading: false }),
  // `date` is the transaction's calendar date (transaction_date), sent both as
  // 'YYYY-MM-DD' and as an ISO instant at UTC midnight.
  useBudgetItemTransactionsQuery: () => ({
    data: [
      { id: 1, uuid: 't1', description: 'Groceries', amount: -20, date: '2026-10-01', account_name: 'Checking', type: 'expense' },
      { id: 2, uuid: 't2', description: 'Pharmacy', amount: -8, date: '2026-10-15T00:00:00.000Z', account_name: 'Checking', type: 'expense' },
    ],
    isLoading: false,
  }),
}));

// Read as UTC instants, these showed a day early anywhere west of UTC.
describe('BudgetItemActivityModal transaction dates in Los Angeles', () => {
  pinTimeZone('America/Los_Angeles');

  it("shows each transaction's own date", async () => {
    renderWithProviders(
      <Theme>
        <BudgetItemActivityModal isOpen onClose={() => {}} budgetPeriodItem={{ id: 5, uuid: 'bpi-5', budget_item_name: 'Food' } as unknown as BudgetPeriodItem} />
      </Theme>,
    );
    await userEvent.click(await screen.findByRole('tab', { name: /transactions/i }));
    expect(await screen.findByText('Checking • 10/1/2026')).toBeInTheDocument();
    expect(screen.getByText('Checking • 10/15/2026')).toBeInTheDocument();
  });
});
