import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import BudgetItemTransactionHistory from '../BudgetItemTransactionHistory';
import type { Transaction } from '../../../services/api';

const tx = (over: Partial<Transaction>): Transaction =>
  ({
    id: 1,
    uuid: 'tx-1',
    transaction_date: '2026-06-01',
    amount: -10,
    description: 'Coffee',
    budget_item_id: 1,
    ...over,
  } as unknown as Transaction);

const render = (props: Partial<React.ComponentProps<typeof BudgetItemTransactionHistory>> = {}) =>
  renderWithProviders(
    <Theme>
      <BudgetItemTransactionHistory
        transactions={[]}
        total={props.transactions?.length ?? 0}
        page={1}
        onPageChange={() => {}}
        loading={false}
        emptyStateDescription="Nothing here yet"
        {...props}
      />
    </Theme>,
  );

describe('BudgetItemTransactionHistory', () => {
  it('shows the loading state', () => {
    render({ loading: true });
    expect(screen.getByText(/loading transactions/i)).toBeInTheDocument();
  });

  it('shows the empty state with the provided description', () => {
    render({ transactions: [], emptyStateDescription: 'Nothing here yet' });
    expect(screen.getByText(/no transactions yet/i)).toBeInTheDocument();
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
  });

  it('renders the transaction count and a merchant label', () => {
    render({ transactions: [tx({ id: 1, uuid: 'a', merchant_name: 'Cafe', amount: -5 })] });
    expect(screen.getByText('Transactions (1)')).toBeInTheDocument();
    expect(screen.getByText('Cafe')).toBeInTheDocument();
  });

  it('falls back to the provided label when a transaction has no name', () => {
    render({
      transactions: [tx({ id: 1, uuid: 'a', merchant_name: '', description: '', amount: 5 })],
      fallbackMerchantName: 'Income Source',
    });
    expect(screen.getByText('Income Source')).toBeInTheDocument();
  });

  it('shows the page the server sent and asks for the next one', async () => {
    const onPageChange = vi.fn();
    render({
      transactions: [tx({ id: 1, uuid: 'a', merchant_name: 'First', transaction_date: '2026-06-02' })],
      total: 2,
      page: 1,
      onPageChange,
      recordsPerPage: 1,
    });

    expect(screen.getByText('Transactions (2)')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('First')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('shows the error instead of an empty list', () => {
    render({ error: 'Could not load the transactions' });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the transactions');
    expect(screen.queryByText(/no transactions yet/i)).not.toBeInTheDocument();
  });
});
