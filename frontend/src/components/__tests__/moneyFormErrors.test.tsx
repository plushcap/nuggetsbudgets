import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import TransferForm from '../transfer/TransferForm';
import BudgetTransferModal from '../BudgetTransferModal';
import AdjustBalanceModal from '../AdjustBalanceModal';
import MoveBalanceToNextPeriodModal from '../closeout/MoveBalanceToNextPeriodModal';
import type { Account, BudgetPeriodItem } from '../../services/api';

const createTransfer = vi.hoisted(() => vi.fn());
const adjust = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  useCreateTransferMutation: () => ({ mutateAsync: createTransfer, isPending: false }),
  useAdjustBalanceMutation: () => ({ mutateAsync: adjust, isPending: false }),
}));
vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});

/**
 * The money-entry forms are react-hook-form forms. A refused submit shows each
 * field's message under it, marks the field aria-invalid and names the message in its
 * aria-describedby (so a screen reader reads it there), and focuses the first such field.
 */
describe('money-entry forms tie their errors to their fields', () => {
  it('TransferForm', async () => {
    const accounts = [{ id: 1, name: 'Checking' }, { id: 2, name: 'Savings' }] as unknown as Account[];
    renderWithProviders(<Theme><TransferForm accounts={accounts} budgetPeriods={[]} /></Theme>);
    await userEvent.click(screen.getByRole('button', { name: 'Create Transfer' }));

    const from = screen.getByRole('combobox', { name: 'From Account *' });
    await waitFor(() => expect(from).toHaveAttribute('aria-invalid', 'true'));
    expect(from).toHaveAccessibleDescription('Source account is required');
    expect(from).toHaveFocus();
    expect(screen.getByRole('combobox', { name: 'To Account *' })).toHaveAccessibleDescription('Destination account is required');
    const amount = screen.getByRole('textbox', { name: 'Amount *' });
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(amount).toHaveAccessibleDescription('Amount must be greater than zero');
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('BudgetTransferModal: the amount is a currency field, and more than the source has is an error on it', async () => {
    const items = [
      { id: 1, uuid: 'b1', budget_item_name: 'Groceries', name: 'Groceries', expense_type: 'Expense', type: 'Monthly', calculated_remaining: 120 },
      { id: 2, uuid: 'b2', budget_item_name: 'Dining', name: 'Dining', expense_type: 'Expense', type: 'Monthly', calculated_remaining: 10 },
    ] as unknown as BudgetPeriodItem[];
    renderWithProviders(
      <Theme>
        <BudgetTransferModal isOpen onClose={vi.fn()} budgetPeriodItems={items} selectedItemId={2} periodUuid="period-9" onSuccess={vi.fn()} />
      </Theme>,
    );
    const amount = screen.getByRole('textbox', { name: 'Amount' });
    await userEvent.type(amount, '25');
    await userEvent.click(screen.getByRole('button', { name: 'Move Money' }));
    await waitFor(() => expect(amount).toHaveAttribute('aria-invalid', 'true'));
    expect(amount).toHaveAccessibleDescription('Insufficient funds. Available: $10.00');
    expect(screen.getByRole('button', { name: /^To Budget Item/ })).toHaveAccessibleDescription(
      'Choose the budget item the money goes to.'
    );
  });

  it('AdjustBalanceModal and MoveBalanceToNextPeriodModal', async () => {
    const { unmount } = renderWithProviders(
      <Theme>
        <AdjustBalanceModal open onOpenChange={vi.fn()} accountUuid="a1" accountName="Checking" currentBalance={100} />
      </Theme>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Adjust balance' }));
    const target = screen.getByRole('textbox', { name: 'New balance' });
    await waitFor(() => expect(target).toHaveAttribute('aria-invalid', 'true'));
    expect(target).toHaveAccessibleDescription('Enter the balance the account should have.');
    expect(target).toHaveFocus();
    expect(adjust).not.toHaveBeenCalled();
    unmount();

    renderWithProviders(
      <Theme>
        <MoveBalanceToNextPeriodModal
          open
          onClose={vi.fn()}
          accountUuid="a1"
          accountName="Card"
          periodBalance={0}
          sourcePeriodUuid="p1"
          sourcePeriodName="March"
          nextPeriodName="April"
          onSuccess={vi.fn()}
        />
      </Theme>,
    );
    const amount = screen.getByRole('textbox', { name: 'Amount to move' });
    expect(amount).toHaveAccessibleDescription(/Defaulted to this account's March balance/);
    await userEvent.click(screen.getByRole('button', { name: 'Move balance' }));
    await waitFor(() => expect(amount).toHaveAttribute('aria-invalid', 'true'));
    expect(amount).toHaveAccessibleDescription(/^Enter the amount to move \(at least a cent\)\. Defaulted/);
  });
});
