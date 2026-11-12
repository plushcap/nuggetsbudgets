import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import type { BudgetPeriodItem } from '../../services/api';
import BudgetTransferModal from '../BudgetTransferModal';

vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const item = (id: number, name: string, remaining: number) =>
  ({
    id,
    uuid: `bpi-${id}`,
    budget_item_name: name,
    name,
    expense_type: 'Expense',
    type: 'Monthly',
    subtype: 'Flexible',
    priority: 'Optional',
    rollover: false,
    icon: 'Tag',
    color: 'gray',
    calculated_remaining: remaining,
    created_at: '2026-01-01T00:00:00Z',
  }) as unknown as BudgetPeriodItem;

const items = [item(1, 'Groceries', 120), item(2, 'Dining', -35.5)];

const renderModal = (isOpen: boolean, selectedItemId?: number) => (
  <Theme>
    <BudgetTransferModal
      isOpen={isOpen}
      onClose={vi.fn()}
      budgetPeriodItems={items}
      selectedItemId={selectedItemId}
      periodUuid="period-9"
      onSuccess={vi.fn()}
    />
  </Theme>
);

const amountBox = () => screen.getByRole('textbox', { name: 'Amount' });

describe('BudgetTransferModal prefill', () => {
  it('opened on an overspent item, covers its overage: it is the destination and the amount is filled', () => {
    render(renderModal(true, 2));
    expect(screen.getByText('Cover Budget Overage')).toBeInTheDocument();
    expect(amountBox()).toHaveValue('35.50');
  });

  it('opened on an item with money left, moves money from it', () => {
    render(renderModal(true, 1));
    expect(screen.getByText('Transfer Between Categories')).toBeInTheDocument();
    expect(screen.getByText('Available: $120.00')).toBeInTheDocument();
    expect(amountBox()).toHaveValue('');
  });

  it('clears what was entered when it closes, and prefills again when it reopens', async () => {
    const { rerender } = render(renderModal(true, 1));
    await userEvent.type(amountBox(), '12');
    await userEvent.type(screen.getByPlaceholderText(/adjusted for unexpected/i), 'note');
    rerender(renderModal(false, 1));
    rerender(renderModal(true, 1));
    expect(amountBox()).toHaveValue('');
    expect(screen.getByPlaceholderText(/adjusted for unexpected/i)).toHaveValue('');
    expect(screen.getByText('Available: $120.00')).toBeInTheDocument();

    rerender(renderModal(false, 1));
    rerender(renderModal(true, 2));
    expect(screen.getByText('Cover Budget Overage')).toBeInTheDocument();
    expect(amountBox()).toHaveValue('35.50');
  });
});

describe('BudgetTransferModal fields', () => {
  it('names each field by its label, and swaps From and To from a labelled button', async () => {
    render(renderModal(true, 1));
    expect(screen.getByRole('button', { name: 'From Budget Item Selected: Monthly: Groceries' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^To Budget Item Select destination/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Amount' })).toBe(amountBox());

    await userEvent.click(screen.getByRole('button', { name: 'Swap From and To' }));
    expect(screen.getByRole('button', { name: /^From Budget Item Select source/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'To Budget Item Selected: Monthly: Groceries' })).toBeInTheDocument();
  });

  // A refused transfer focused a picker by an aria-labelledby prefix; each picker's
  // trigger takes the field's id, which its message is named for, and the focus by it.
  it.each([
    ['From', undefined, /^From Budget Item/, 'Choose the budget item the money comes from.'],
    ['To', 1, /^To Budget Item/, 'Choose the budget item the money goes to.'],
  ] as const)('focuses the %s picker, by its own id, when it is the first field missing', async (_, selectedItemId, name, message) => {
    render(renderModal(true, selectedItemId));
    await userEvent.click(screen.getByRole('button', { name: 'Move Money' }));
    const picker = screen.getByRole('button', { name });
    expect(picker).toHaveFocus();
    expect(document.getElementById(`${picker.id}-error`)).toHaveTextContent(message);
    expect(picker).toHaveAccessibleDescription(expect.stringContaining(message));
  });
});

// The form held null for text the box couldn't read, so a reset to null (its
// useFormReset fires when a refetch changes what the item has left) was no change to the box,
// which kept the old text over an empty form.
describe('BudgetTransferModal with an amount it cannot read', () => {
  const withLeft = (left: number) => (
    <Theme>
      <BudgetTransferModal isOpen onClose={vi.fn()} budgetPeriodItems={[item(1, 'Groceries', left), item(2, 'Dining', 50)]} selectedItemId={1} periodUuid="period-9" onSuccess={vi.fn()} />
    </Theme>
  );

  it('empties the box when a refetch resets the form', async () => {
    const { rerender } = render(withLeft(120));
    await userEvent.type(amountBox(), '12o');
    await userEvent.tab();
    expect(amountBox()).not.toHaveFocus();
    expect(amountBox()).toHaveValue('12o');
    rerender(withLeft(100));
    expect(screen.getByText('Available: $100.00')).toBeInTheDocument();
    expect(amountBox()).toHaveValue('');
  });

  it('refuses it as no amount, in its own words', async () => {
    render(withLeft(120));
    await userEvent.type(amountBox(), '12o');
    await userEvent.click(screen.getByRole('button', { name: 'Move Money' }));
    expect(await screen.findByText('Enter an amount greater than zero.')).toBeInTheDocument();
    expect(amountBox()).toHaveAttribute('aria-invalid', 'true');
  });
});
