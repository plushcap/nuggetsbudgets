import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { mockApi, type ApiRequest } from '../../test/apiServer';
import TransactionDetailPage from '../TransactionDetailPage';

const updateTransaction = vi.fn().mockResolvedValue({});
const uploadAttachments = vi.hoisted(() => vi.fn().mockResolvedValue({}));

// Stable reference so the seed effect (guarded by seededTxIdRef) doesn't loop.
const transaction = {
  id: 11,
  uuid: 'tx-1',
  amount: -42.5,
  transaction_date: '2026-05-01',
  type: 'expense',
  status: 'pending',
  review_status: 'needs review',
  account_id: 3,
  budget_item_id: null,
  merchant_id: null,
  budget_period_id: null,
  assigned_to: null,
  notes: 'orig note',
  merchant_name: 'Corner Store',
  parent_transaction_id: null,
  parent_transaction_uuid: null,
  is_split_parent: false,
  // The account's accounts.type, which GET /api/transactions/:uuid answers as account_class.
  account_class: 'Asset',
};
const emptyArr: never[] = [];
// A query that hasn't returned yet has no data (undefined), the same on every render.
let txTagsData: { id: number; name: string; color: string }[] | undefined = emptyArr;
const resetLoading = () => { txTagsData = emptyArr; };
// What the transaction query answers instead, for its failures.
let txQueryOverride: Record<string, unknown> | null = null;

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  const noop = () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  return {
    ...actual,
    useTransactionQuery: () => txQueryOverride ?? { data: transaction, isLoading: false },
    useBudgetItemsQuery: () => ({ data: emptyArr }),
    useBudgetPeriodsQuery: () => ({ data: emptyArr }),
    useMerchantsQuery: () => ({ data: emptyArr }),
    useUsersQuery: () => ({ data: emptyArr }),
    useTagsQuery: () => ({ data: emptyArr }),
    useTransactionTagsQuery: () => ({ data: txTagsData }),
    useTransactionAttachmentsQuery: () => ({ data: { attachments: emptyArr } }),
    useUploadAttachmentsMutation: () => ({ mutateAsync: uploadAttachments, isPending: false }),
    useDeleteAttachmentMutation: noop,
    useUpdateTransactionMutation: () => ({ mutateAsync: updateTransaction, isPending: false }),
    useDeleteTransactionMutation: noop,
    useSplitTransactionMutation: noop,
    useUnsplitTransactionMutation: noop,
    useCreateMerchantMutation: noop,
  };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate, useParams: () => ({ uuid: 'tx-1' }) };
});
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
import toast from 'react-hot-toast';

// jsdom lacks the pointer-capture API Radix Select calls.
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
});

// The hooks above are stubbed; what still fetches is answered by the API stand-in, and a
// request it doesn't answer fails the test (the activity's raw fetch logged
// "Failed to parse URL /api/annotations…").
let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    'GET /annotations': (req: ApiRequest) => ({ subject_type: req.query.get('subject_type'), subject_uuid: req.query.get('subject_uuid'), annotations: [] }),
  });
});
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  vi.unstubAllGlobals();
});

// Start in edit mode via ?edit=true (real useSearchParams from MemoryRouter).
const renderPage = (route = '/?edit=true') => renderWithProviders(<Theme><TransactionDetailPage /></Theme>, { route });

// The page is large: typing a value key by key re-renders it once per key, which on a
// loaded machine outran the test timeout. One change event exercises the same handler.
const setField = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });

/** The body of the last whole-form save (Save Changes sends every field, amount among them). */
const fullSaveData = (): Record<string, unknown> | undefined => {
  const saves = updateTransaction.mock.calls
    .map(([arg]) => arg as { uuid: string; data?: Record<string, unknown> })
    .filter((arg) => arg.uuid === 'tx-1' && arg.data && 'amount' in arg.data);
  return saves[saves.length - 1]?.data;
};

describe('TransactionDetailPage (react-hook-form autosave)', () => {
  beforeEach(() => { updateTransaction.mockClear(); navigate.mockClear(); });

  it('autosaves the notes field after the debounce', async () => {
    renderPage();
    setField(await screen.findByDisplayValue('orig note'), 'Updated note');
    await waitFor(
      () => expect(updateTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ uuid: 'tx-1', data: { notes: 'Updated note' } }),
      ),
    );
  });

  it('saves all fields and navigates back when Save Changes is clicked', async () => {
    renderPage();
    setField(await screen.findByDisplayValue('orig note'), 'Final');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      const fullSave = updateTransaction.mock.calls.find(
        ([arg]) => arg.uuid === 'tx-1' && arg.data && arg.data.notes === 'Final' && 'amount' in arg.data,
      );
      expect(fullSave).toBeTruthy();
      // The merchant box starts with the transaction's merchant, and the save carries it.
      expect(fullSave?.[0].data.merchant_name).toBe('Corner Store');
    });
    expect(navigate).toHaveBeenCalledWith('/transactions');
  });

  // The server refuses an income on a liability account with a reason for people.
  it("shows the server's reason when it refuses the save, and stays on the page", async () => {
    const reason = "Income can't be recorded on a liability account. Record money paid toward it as a payment, or a charge on it as an expense.";
    updateTransaction.mockRejectedValueOnce(Object.assign(new Error(reason), { status: 400, code: 'INCOME_ON_LIABILITY' }));
    vi.mocked(toast.error).mockClear();
    renderPage();
    await screen.findByDisplayValue('orig note');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(reason));
    expect(navigate).not.toHaveBeenCalled();
  });

  // The form held the status as its label ('Cleared'), which Save Changes sent as it
  // was, and the server, which checks the exact value, refused every whole-form save.
  describe('the status', () => {
    afterEach(() => {
      transaction.status = 'pending';
    });

    it("sends the transaction's status as the database has it when Save Changes is clicked", async () => {
      transaction.status = 'cleared';
      renderPage();
      setField(await screen.findByDisplayValue('orig note'), 'Edited');
      await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(fullSaveData()?.status).toBe('cleared'));
      expect(fullSaveData()?.review_status).toBe('needs review');
      expect(fullSaveData()?.type).toBe('expense');
    });

    it('shows the status by its label and sends one picked as its value, alone and with Save Changes', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByDisplayValue('orig note');
      const status = screen.getByRole('combobox', { name: /^Status/ });
      expect(status).toHaveTextContent('Pending');
      await user.click(status);
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Pending', 'Cleared', 'Reconciled']);
      await user.click(screen.getByRole('option', { name: 'Reconciled' }));
      await waitFor(() =>
        expect(updateTransaction).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'tx-1', data: { status: 'reconciled' } })),
      );
      expect(screen.getByRole('combobox', { name: /^Status/ })).toHaveTextContent('Reconciled');
      await user.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(fullSaveData()?.status).toBe('reconciled'));
    });

    // The same for a type from before today's list: the select showed a blank.
    it('shows a type from before the list, and sends it back as it is', async () => {
      const before = transaction.type;
      transaction.type = 'adjustment';
      try {
        renderPage();
        setField(await screen.findByDisplayValue('orig note'), 'Edited');
        expect(screen.getByRole('combobox', { name: /^Type/ })).toHaveTextContent('adjustment (legacy value)');
        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
        await waitFor(() => expect(fullSaveData()?.type).toBe('adjustment'));
      } finally {
        transaction.type = before;
      }
    });

    // A row may keep a status from before today's list; the select showed a blank.
    it('shows a status from before the list, and sends it back as it is', async () => {
      transaction.status = 'void';
      renderPage();
      setField(await screen.findByDisplayValue('orig note'), 'Edited');
      expect(screen.getByRole('combobox', { name: /^Status/ })).toHaveTextContent('void (legacy value)');
      await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(fullSaveData()?.status).toBe('void'));
    });
  });

  // A liability account takes no income, which the server refuses, as Add Transaction
  // offers none there.
  describe('the type picker', () => {
    const typesOffered = async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByDisplayValue('orig note');
      await user.click(screen.getByRole('combobox', { name: /^Type/ }));
      return screen.getAllByRole('option').map((option) => option.textContent);
    };
    afterEach(() => {
      transaction.account_class = 'Asset';
      transaction.type = 'expense';
    });

    it('offers Income on an asset account', async () => {
      expect(await typesOffered()).toContain('Income');
    });

    it('offers no Income on a liability account', async () => {
      transaction.account_class = 'Liability';
      expect(await typesOffered()).toEqual(['Expense', 'Payment', 'Transfer', 'Starting Balance', 'Balance Adjustment']);
    });

    it('keeps an income from before the rule shown as Income on a liability account, so it saves as it is', async () => {
      transaction.account_class = 'Liability';
      transaction.type = 'income';
      renderPage();
      await screen.findByDisplayValue('orig note');
      expect(screen.getByRole('combobox', { name: /^Type/ })).toHaveTextContent('Income');
      await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => {
        const fullSave = updateTransaction.mock.calls.find(([arg]) => arg.uuid === 'tx-1' && arg.data && 'amount' in arg.data);
        expect(fullSave?.[0].data.type).toBe('income');
      });
    });
  });

  it("doesn't offer a budget item on a split parent, whose splits carry them", async () => {
    transaction.is_split_parent = true;
    try {
      renderPage();
      expect(await screen.findByText(/Each split has its own budget item/)).toBeInTheDocument();
      expect(screen.getByText('On each split')).toBeInTheDocument();
      expect(screen.queryByText('Select a budget item...')).not.toBeInTheDocument();
    } finally {
      transaction.is_split_parent = false;
    }
  });
  // A side of a transfer isn't split; the server refuses one (409).
  it("doesn't offer Start Split on a side of a transfer, and says why", async () => {
    Object.assign(transaction, { type: 'transfer', transfer_transaction_id: 12 });
    try {
      renderPage('/');
      expect(await screen.findByText(/one side of a transfer/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Start Split/ })).not.toBeInTheDocument();
    } finally {
      Object.assign(transaction, { type: 'expense', transfer_transaction_id: undefined });
    }
  });

  it('offers Start Split on a transaction that is no side of a transfer', async () => {
    renderPage('/');
    expect(await screen.findByRole('button', { name: /Start Split/ })).toBeInTheDocument();
  });

  it("keeps a transfer side's splits from before the rule, with Unsplit but no Edit Splits", async () => {
    Object.assign(transaction, {
      type: 'transfer',
      transfer_transaction_id: 12,
      is_split_parent: true,
      split_children: [
        { id: 21, uuid: 'c-1', amount: -30, description: null, budget_item_id: null, budget_period_id: null, budget_period_item_id: null, tags: [] },
        { id: 22, uuid: 'c-2', amount: -12.5, description: null, budget_item_id: null, budget_period_id: null, budget_period_item_id: null, tags: [] },
      ],
    });
    try {
      renderPage('/');
      expect(await screen.findByText(/Split Allocations \(2\)/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Unsplit/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Edit Splits/ })).not.toBeInTheDocument();
    } finally {
      Object.assign(transaction, { type: 'expense', transfer_transaction_id: undefined, is_split_parent: false, split_children: undefined });
    }
  });

  it("shows the transaction's tags, and a newer answer from the server", async () => {
    txTagsData = [{ id: 1, name: 'Groceries', color: '#2563eb' }];
    try {
      const { rerender } = renderPage('/');
      expect(await screen.findByText('Groceries')).toBeInTheDocument();
      txTagsData = [{ id: 2, name: 'Household', color: '#2563eb' }];
      rerender(<Theme><TransactionDetailPage /></Theme>);
      expect(await screen.findByText('Household')).toBeInTheDocument();
      expect(screen.queryByText('Groceries')).not.toBeInTheDocument();
    } finally {
      resetLoading();
    }
  });

  describe('a saved field', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('says "Saved" for 10 seconds', async () => {
      renderPage();
      setField(await screen.findByDisplayValue('orig note'), 'Updated note');
      await act(async () => {
        vi.advanceTimersByTime(1000); // the autosave debounce
      });
      await waitFor(() => expect(updateTransaction).toHaveBeenCalled());
      expect(await screen.findByText('Saved')).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(9_000);
      });
      expect(screen.getByText('Saved')).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(1_500);
      });
      expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    });
  });

  // An `= []` default on a query's data is a new array each render while the query is
  // loading; an effect that depends on it and sets state looped (React error #185).
  it.each([
    ['the transaction\'s tags', () => { txTagsData = undefined; }, () => screen.findByDisplayValue('orig note')],
  ])('renders without an update loop while %s are loading', async (_what, setLoading, find) => {
    setLoading();
    try {
      renderPage();
      expect(await find()).toBeInTheDocument();
      // Long enough for a looping effect to hit React's update limit and throw.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await find()).toBeInTheDocument();
    } finally {
      resetLoading();
    }
  });
});

// A load that failed isn't "doesn't exist", and an edit made just before leaving is saved.
describe('TransactionDetailPage when things fail', () => {
  const refetch = vi.fn();
  afterEach(() => { txQueryOverride = null; refetch.mockClear(); });

  it('shows a retry, not "not found", when the server failed', async () => {
    txQueryOverride = {
      data: undefined, isLoading: false, isError: true, isFetching: false, refetch,
      error: Object.assign(new Error('Internal error (reference r-5)'), { status: 500, requestId: 'r-5' }),
    };
    renderPage();
    expect(screen.getByRole('heading', { name: "Couldn't load this transaction", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText(/Transaction not found/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('says "not found" for a 404', () => {
    txQueryOverride = {
      data: undefined, isLoading: false, isError: true, isFetching: false, refetch,
      error: Object.assign(new Error('Transaction not found'), { status: 404 }),
    };
    renderPage();
    expect(screen.getByRole('heading', { name: 'Transaction not found' })).toBeInTheDocument();
  });

  it("doesn't save a note typed and then cancelled", async () => {
    updateTransaction.mockClear();
    const { unmount } = renderPage();
    setField(await screen.findByDisplayValue('orig note'), 'Typed then cancelled');
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    unmount();
    expect(updateTransaction).not.toHaveBeenCalled();
  });

  // Save Changes dropped the field saves still waiting before it ran, so when it
  // failed, an edit made just before it was lost.
  it('keeps a field edit still waiting to save when Save Changes fails', async () => {
    updateTransaction.mockClear();
    navigate.mockClear();
    updateTransaction.mockRejectedValueOnce(Object.assign(new Error('Internal error (reference r-9)'), { status: 500 }));
    vi.mocked(toast.error).mockClear();
    const { unmount } = renderPage();
    setField(await screen.findByDisplayValue('orig note'), 'Typed before Save');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Internal error (reference r-9)'));
    expect(navigate).not.toHaveBeenCalledWith('/transactions');
    unmount();
    expect(updateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'tx-1', data: { notes: 'Typed before Save' } }),
    );
  });

  // A held field save went back after a failed Save Changes even when a newer edit of the
  // same field had already saved, and overwrote it.
  it('keeps the newest edit when one is typed while Save Changes runs and then fails', async () => {
    updateTransaction.mockClear();
    let rejectSave: (e: unknown) => void = () => {};
    renderPage();
    setField(await screen.findByDisplayValue('orig note'), 'a');
    updateTransaction.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateTransaction).toHaveBeenCalledTimes(1));
    setField(screen.getByDisplayValue('a'), 'ab');
    await waitFor(
      () => expect(updateTransaction).toHaveBeenCalledWith(expect.objectContaining({ data: { notes: 'ab' } })),
      { timeout: 3000 },
    );
    await act(async () => { rejectSave(Object.assign(new Error('Internal error (reference r-1)'), { status: 500 })); });
    await new Promise((r) => setTimeout(r, 1500));
    const noteSaves = updateTransaction.mock.calls
      .map(([arg]) => (arg as { data: Record<string, unknown> }).data)
      .filter((d) => Object.keys(d).length === 1 && 'notes' in d)
      .map((d) => d.notes);
    expect(noteSaves).toEqual(['ab']);
  }, 10000);

  it('saves nothing cancelled while Save Changes runs and then fails', async () => {
    updateTransaction.mockClear();
    navigate.mockClear();
    let rejectSave: (e: unknown) => void = () => {};
    const { unmount } = renderPage();
    setField(await screen.findByDisplayValue('orig note'), 'Typed then cancelled');
    updateTransaction.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateTransaction).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    unmount();
    await act(async () => { rejectSave(Object.assign(new Error('Internal error (reference r-2)'), { status: 500 })); });
    await new Promise((r) => setTimeout(r, 50));
    expect(updateTransaction).toHaveBeenCalledTimes(1);
  }, 10000);

  it('drops the field saves Save Changes covered once it has saved', async () => {
    updateTransaction.mockClear();
    navigate.mockClear();
    const { unmount } = renderPage();
    setField(await screen.findByDisplayValue('orig note'), 'Saved with the rest');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/transactions'));
    unmount();
    expect(updateTransaction).toHaveBeenCalledTimes(1);
    expect(fullSaveData()?.notes).toBe('Saved with the rest');
  });

  // "-15" scheduled a save of -15, and "-15o" (unreadable: null) left it waiting, so it
  // went a second later while the box was flagged; Save Changes sent the amount as 0.
  it("drops the amount's waiting save when its text stops being an amount, and refuses Save Changes beside it", async () => {
    updateTransaction.mockClear();
    navigate.mockClear();
    const { unmount } = renderPage();
    await screen.findByDisplayValue('orig note');
    const box = document.getElementById('transaction-amount') as HTMLInputElement;
    act(() => box.focus());
    setField(box, '-15');
    setField(box, '-15o');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText('Not an amount: enter it like 1,234.56.')).toBeInTheDocument();
    expect(box).toHaveFocus();
    expect(box).toHaveAttribute('aria-invalid', 'true');
    // One message for the field: CurrencyInput's own hint is left out.
    expect(box).toHaveAccessibleDescription('Not an amount: enter it like 1,234.56.');
    expect(screen.queryByText(/with at most two decimals/)).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    // Leaving the page sends the field saves still waiting: none for the amount.
    unmount();
    expect(updateTransaction).not.toHaveBeenCalled();
  });

  // Cancel (outside ?edit=true) didn't reset the form, so what was typed outlived
  // it: the amount's unreadable text, as 0 (which Save Changes sent after editing again), then
  // as NaN (refused, over an empty box). Cancel restores what is saved.
  it('restores the saved amount and note on Cancel, and saves them as they are after editing again', async () => {
    updateTransaction.mockClear();
    navigate.mockClear();
    renderPage('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    let box = document.getElementById('transaction-amount') as HTMLInputElement;
    expect(box).toHaveValue('-42.50');
    act(() => box.focus());
    setField(box, '-15o');
    setField(screen.getByDisplayValue('orig note'), 'Typed then cancelled');
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    box = document.getElementById('transaction-amount') as HTMLInputElement;
    expect(box).toHaveValue('-42.50');
    expect(box).not.toHaveAttribute('aria-invalid');
    expect(screen.getByDisplayValue('orig note')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/transactions'));
    expect(screen.queryByText('Not an amount: enter it like 1,234.56.')).not.toBeInTheDocument();
    expect(fullSaveData()).toMatchObject({ amount: -42.5, notes: 'orig note' });
  });

  it('saves the amount once its text reads again', async () => {
    updateTransaction.mockClear();
    navigate.mockClear();
    renderPage();
    await screen.findByDisplayValue('orig note');
    const box = document.getElementById('transaction-amount') as HTMLInputElement;
    act(() => box.focus());
    setField(box, '-15o');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText('Not an amount: enter it like 1,234.56.')).toBeInTheDocument();
    setField(box, '-150');
    expect(screen.queryByText('Not an amount: enter it like 1,234.56.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/transactions'));
    expect(fullSaveData()?.amount).toBe(-150);
  });

  it('saves a note typed just before leaving the page', async () => {
    updateTransaction.mockClear();
    const { unmount } = renderPage();
    setField(await screen.findByDisplayValue('orig note'), 'Left in a hurry');
    unmount();
    expect(updateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'tx-1', data: { notes: 'Left in a hurry' } }),
    );
  });
});

describe('TransactionDetailPage attachments', () => {
  it('sends and counts only the files that pass the checks', async () => {
    const { container } = renderPage();
    await screen.findByDisplayValue('orig note');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const ok = new File(['%PDF'], 'receipt.pdf', { type: 'application/pdf' });
    const bad = new File(['MZ'], 'virus.exe', { type: 'application/octet-stream' });
    fireEvent.change(input, { target: { files: [ok, bad] } });
    await waitFor(() => expect(uploadAttachments).toHaveBeenCalledTimes(1));
    const formData = uploadAttachments.mock.calls[0][0].formData as FormData;
    expect(formData.getAll('attachments').map((f) => (f as File).name)).toEqual(['receipt.pdf']);
    // The transaction comes before the files, which the server refuses otherwise.
    expect([...formData.keys()]).toEqual(['transaction_id', 'attachments']);
    expect(toast.error).toHaveBeenCalledWith('File type .exe not allowed');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('1 file uploaded'));
  });
});

// Save Changes sent the form's values as they were, a link the box had refused among
// them (the server refused the whole save), and a bare host as typed.
describe('TransactionDetailPage Save Changes and the link', () => {
  const linkBox = () => document.getElementById('external_link') as HTMLInputElement;
  beforeEach(() => { updateTransaction.mockClear(); navigate.mockClear(); });
  afterEach(() => { delete (transaction as { external_link?: string }).external_link; });

  it("doesn't send a link the box refuses, and refuses Save Changes beside it", async () => {
    const { unmount } = renderPage();
    await screen.findByDisplayValue('orig note');
    setField(linkBox(), 'javascript:alert(1)');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText('A website starts with http:// or https://.')).toBeInTheDocument();
    expect(linkBox()).toHaveFocus();
    expect(linkBox()).toHaveAttribute('aria-invalid', 'true');
    expect(navigate).not.toHaveBeenCalled();
    unmount();
    expect(updateTransaction.mock.calls.map(([arg]) => arg.data.external_link)).not.toContain('javascript:alert(1)');
  });

  it('saves a bare host as the web address the box would save', async () => {
    renderPage();
    await screen.findByDisplayValue('orig note');
    setField(linkBox(), 'example.com/r/1');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/transactions'));
    expect(fullSaveData()?.external_link).toBe('https://example.com/r/1');
  });

  it('saves the rest, and leaves out a stored link the box would refuse that nobody changed', async () => {
    (transaction as { external_link?: string }).external_link = 'https://someone@example.com/r/1';
    renderPage();
    await screen.findByDisplayValue('orig note');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/transactions'));
    expect(fullSaveData()).not.toHaveProperty('external_link');
  });
});

// The page decoded returnTo a second time (searchParams already had), and a split's
// redirect to its parent put it back unencoded, so a returnTo with a query lost its tail.
describe('TransactionDetailPage returnTo', () => {
  beforeEach(() => navigate.mockClear());
  afterEach(() => { txQueryOverride = null; });
  const withReturnTo = (returnTo: string, edit = true) =>
    `/?${edit ? 'edit=true&' : ''}returnTo=${encodeURIComponent(returnTo)}`;

  it('goes back to returnTo as it was given, a query in it included', async () => {
    renderPage(withReturnTo('/transactions?search=a%26b&page=2'));
    await screen.findByDisplayValue('orig note');
    await userEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(navigate).toHaveBeenCalledWith('/transactions?search=a%26b&page=2');
  });

  it.each(['https://evil.example/x', '//evil.example/x', '/\\evil.example/x', '/\t/evil.example', 'javascript:alert(1)', 'transactions'])(
    'never leads off the app: %j goes back to the list',
    async (returnTo) => {
      renderPage(withReturnTo(returnTo));
      await screen.findByDisplayValue('orig note');
      await userEvent.click(screen.getByRole('button', { name: 'Go back' }));
      expect(navigate).toHaveBeenCalledWith('/transactions');
    },
  );

  it.each([true, false])("takes a split to its parent's page with returnTo whole (edit: %s), in place of the split's", (edit) => {
    txQueryOverride = { data: { ...transaction, parent_transaction_id: 10, parent_transaction_uuid: 'parent-1' }, isLoading: false };
    renderPage(withReturnTo('/accounts/a-1?status=pending&page=2', edit));
    expect(navigate).toHaveBeenCalledTimes(1);
    const [to, options] = navigate.mock.calls[0] as [string, unknown];
    const url = new URL(to, 'https://app.example');
    expect(url.pathname).toBe('/transactions/parent-1');
    expect(url.searchParams.get('edit')).toBe(edit ? 'true' : null);
    expect(url.searchParams.get('returnTo')).toBe('/accounts/a-1?status=pending&page=2');
    expect([...url.searchParams.keys()]).toEqual(edit ? ['edit', 'returnTo'] : ['returnTo']);
    // Back from the parent goes where the split was opened from, not to the split (which redirects again).
    expect(options).toEqual({ replace: true });
  });
});
