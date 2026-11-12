import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from '../../test/renderWithProviders';
import AddTransactionPage from '../AddTransactionPage';

const createTransaction = vi.hoisted(() => vi.fn());
const createMerchant = vi.hoisted(() => vi.fn());
const account = { id: 1, uuid: 'a1', name: 'Everyday checking', account_type: 'checking', type: 'Asset' };
const merchants = [{ id: 5, uuid: 'm5', name: 'Corner Store' }];
const none: never[] = [];

vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  useAccountQuery: () => ({ data: account, isLoading: false }),
  useBudgetItemsQuery: () => ({ data: none, isLoading: false }),
  useBudgetPeriodsQuery: () => ({ data: none, isLoading: false }),
  useMerchantsQuery: () => ({ data: merchants, isLoading: false }),
  useCreateMerchantMutation: () => ({ mutateAsync: createMerchant, isPending: false }),
  useCreateTransactionMutation: () => ({ mutateAsync: createTransaction, isPending: false }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
import toast from 'react-hot-toast';
// The form's starting date: today, unless a test starts it empty.
const startingDate = vi.hoisted(() => ({ empty: false }));
vi.mock('../../types/forms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../types/forms')>();
  return {
    ...actual,
    createDefaultTransactionForm: () => ({ ...actual.createDefaultTransactionForm(), ...(startingDate.empty ? { transaction_date: '' } : {}) }),
  };
});

// jsdom lacks the pointer-capture API Radix Select calls.
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
});

const renderPage = () =>
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path="/accounts/:accountUuid/add-transaction" element={<AddTransactionPage />} />
        <Route path="/accounts/:uuid" element={<p>Account page</p>} />
      </Routes>
    </Theme>,
    { route: '/accounts/a1/add-transaction' }
  );

/**
 * Add Transaction is a react-hook-form form. A refused submit names what's
 * missing at each field, ties the message to it, and focuses the first such field;
 * a valid one sends the database's own status values.
 */
describe('AddTransactionPage (react-hook-form)', () => {
  beforeEach(() => {
    createTransaction.mockReset().mockResolvedValue({});
    createMerchant.mockReset();
    account.type = 'Asset';
    vi.mocked(toast.error).mockClear();
  });

  it('names what is missing at each field, tied to it, and focuses the first', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /create transaction/i }));

    const amount = screen.getByRole('textbox', { name: 'Amount *' });
    await waitFor(() => expect(amount).toHaveAttribute('aria-invalid', 'true'));
    expect(amount).toHaveAccessibleDescription('Enter the amount.');
    expect(amount).toHaveFocus();
    expect(screen.getByRole('button', { name: /^Merchant Name \*/ })).toHaveAccessibleDescription('Enter or choose a merchant.');
    expect(createTransaction).not.toHaveBeenCalled();
  });

  // The date was focused by an aria-labelledby prefix; its trigger takes the field's id,
  // which its error message names, and the focus by it.
  // The merchant was focused by an aria-labelledby prefix; its trigger takes the field's
  // id, and the focus by it.
  it('focuses the merchant when it is the first field missing, by its own id', async () => {
    renderPage();
    await userEvent.type(screen.getByRole('textbox', { name: 'Amount *' }), '-12.50');
    await userEvent.click(screen.getByRole('button', { name: /create transaction/i }));

    const merchant = screen.getByRole('button', { name: /^Merchant Name \*/ });
    await waitFor(() => expect(merchant).toHaveFocus());
    expect(merchant).toHaveAttribute('id', 'add-tx-merchant-field');
    expect(merchant).toHaveAccessibleDescription('Enter or choose a merchant.');
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it('focuses the date when it is the first field missing, by its own id', async () => {
    startingDate.empty = true;
    try {
      renderPage();
      await userEvent.type(screen.getByRole('textbox', { name: 'Amount *' }), '-12.50');
      await userEvent.click(screen.getByRole('button', { name: /^Merchant Name \*/ }));
      await userEvent.click(within(screen.getByRole('listbox', { name: 'Merchants' })).getByRole('option', { name: /Corner Store/ }));
      await userEvent.click(screen.getByRole('button', { name: /create transaction/i }));

      const date = screen.getByRole('button', { name: /^Transaction Date \*/ });
      await waitFor(() => expect(date).toHaveFocus());
      expect(date).toHaveAttribute('id', 'add-tx-date-field');
      expect(date).toHaveAccessibleDescription('Pick the date.');
      expect(createTransaction).not.toHaveBeenCalled();
    } finally {
      startingDate.empty = false;
    }
  });

  // Text the box can't read is NaN in the form (nullableAmountInput), so a reset
  // empties the box; it shows no preview and is refused as no amount is.
  it('previews no amount it cannot read, and refuses it as no amount', async () => {
    renderPage();
    const amount = screen.getByRole('textbox', { name: 'Amount *' });
    await userEvent.type(amount, '-12o');
    expect(screen.queryByText(/Preview/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /create transaction/i }));
    await waitFor(() => expect(amount).toHaveAttribute('aria-invalid', 'true'));
    expect(amount).toHaveAccessibleDescription(/^Enter the amount\./);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it('saves with the status the database takes (pending), not "Pending"', async () => {
    renderPage();
    // The Status field shows its default.
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Pending');

    await userEvent.type(screen.getByRole('textbox', { name: 'Amount *' }), '-12.50');
    await userEvent.click(screen.getByRole('button', { name: /^Merchant Name \*/ }));
    await userEvent.click(within(screen.getByRole('listbox', { name: 'Merchants' })).getByRole('option', { name: /Corner Store/ }));
    await userEvent.click(screen.getByRole('button', { name: /create transaction/i }));

    await waitFor(() => expect(createTransaction).toHaveBeenCalledTimes(1));
    expect(createTransaction.mock.calls[0][0]).toMatchObject({
      account_uuid: 'a1',
      merchant_id: 5,
      amount: -12.5,
      type: 'expense',
      status: 'pending',
      review_status: 'needs review',
    });
    expect(await screen.findByText('Account page')).toBeInTheDocument();
  });

  // A liability account takes no income, which the server refuses.
  it('offers Income on an asset account', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('combobox', { name: 'Transaction Type' }));
    expect(screen.getByRole('option', { name: 'Income' })).toBeInTheDocument();
  });

  it('offers no Income on a liability account', async () => {
    account.type = 'Liability';
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('combobox', { name: 'Transaction Type' }));
    const offered = screen.getAllByRole('option').map((option) => option.textContent);
    expect(offered).toEqual(['Expense', 'Payment', 'Transfer', 'Balance Adjustment']);
  });

  it("shows the server's reason when it refuses the transaction", async () => {
    const reason = "Income can't be recorded on a liability account. Record money paid toward it as a payment, or a charge on it as an expense.";
    createTransaction.mockRejectedValue(Object.assign(new Error(reason), { status: 400, code: 'INCOME_ON_LIABILITY' }));
    renderPage();
    await userEvent.type(screen.getByRole('textbox', { name: 'Amount *' }), '12.50');
    await userEvent.click(screen.getByRole('button', { name: /^Merchant Name \*/ }));
    await userEvent.click(within(screen.getByRole('listbox', { name: 'Merchants' })).getByRole('option', { name: /Corner Store/ }));
    await userEvent.click(screen.getByRole('button', { name: /create transaction/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(reason));
    expect(screen.queryByText('Account page')).not.toBeInTheDocument();
  });
});
