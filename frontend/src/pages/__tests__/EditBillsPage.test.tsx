import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { UNREADABLE_AMOUNT_MESSAGE } from '../../components/forms/optionalAmount';
import EditBillsPage from '../EditBillsPage';

const updateBudgetItem = vi.fn().mockResolvedValue({});
const billItem = {
  id: 3,
  uuid: 'bill-1',
  name: 'Electric',
  isbill: true,
  merchant_id: null,
  recurring_payment_amount: 120,
  recurring_payment_frequency: 1,
  category_id: null,
  recurring_next_payment_date: null,
  icon: 'Receipt',
  color: '#F59E0B',
  default_budget_amount: 120,
  rollover_target_amount: null,
  rollover_starting_balance: null,
  rollover_starting_balance_date: null,
  notes: 'monthly utility',
  instructions: '',
  transaction_auto_tag_id: null,
};

// Stable references so the form's `reset` effect (which depends on the tags
// array) doesn't re-fire every render and loop.
const budgetItems: Record<string, unknown>[] = [billItem];
// The current period's figures (GET /budget-items/:uuid/history), none unless a test sets them.
let historyData: unknown;
// The history sidebar's page of transactions (useBudgetItemTransactionsPage). Loading by
// default: the form tests don't need it.
const loadingHistory = { page: 1, setPage: vi.fn(), transactions: [] as unknown[], total: 0, loading: true, error: null };
let historyPage = loadingHistory;
const emptyArr: never[] = [];
// A query that hasn't returned yet has no data (undefined), the same on every render.
let tagsData: never[] | undefined = emptyArr;
let itemTagsData: never[] | undefined = emptyArr;
const resetLoading = () => { tagsData = emptyArr; itemTagsData = emptyArr; };
// What the usage answer says of its history.
let historyLocked = false;

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  const noop = () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  return {
    ...actual,
    useBudgetItemsQuery: () => ({ data: budgetItems, isLoading: false }),
    useBudgetItemHistoryQuery: () => ({ data: historyData, isLoading: false, isError: false }),
    useCategoriesQuery: () => ({ data: emptyArr }),
    useMerchantsQuery: () => ({ data: emptyArr }),
    useTagsQuery: () => ({ data: tagsData, isLoading: tagsData === undefined }),
    useBudgetItemTagsQuery: () => ({ data: itemTagsData }),
    // isLoading keeps the history sidebar on its spinner branch, avoiding the
    // Radix ScrollArea jsdom render loop. The form under test is unaffected.
    useBudgetItemTransactionsPage: () => historyPage,
    useBudgetEventHistoryQuery: () => ({ data: { data: emptyArr }, isLoading: true }),
    useCreateMerchantMutation: noop,
    useUpdateBudgetItemMutation: () => ({ mutateAsync: updateBudgetItem, isPending: false }),
    useBudgetItemUsageQuery: (uuid: string | null) => ({ data: uuid ? { history_before_current_period: historyLocked } : undefined, isLoading: false }),
    useDeleteBudgetItemMutation: noop,
    useAddTagToBudgetItemMutation: noop,
    useRemoveTagFromBudgetItemMutation: noop,
  };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate, useParams: () => ({ uuid: 'bill-1' }) };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// jsdom lacks the pointer-capture API Radix Select calls.
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
});

const renderPage = () => renderWithProviders(<Theme><EditBillsPage /></Theme>);

describe('EditBillsPage (react-hook-form)', () => {
  beforeEach(() => { updateBudgetItem.mockClear(); navigate.mockClear(); });

  it('seeds the form from the loaded bill and saves edits', async () => {
    renderPage();
    const nameInput = await screen.findByDisplayValue('Electric');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Power Bill');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateBudgetItem).toHaveBeenCalledTimes(1));
    const arg = updateBudgetItem.mock.calls[0][0];
    expect(arg.uuid).toBe('bill-1');
    expect(arg.data.name).toBe('Power Bill');
    expect(arg.data.isbill).toBe(true);
    expect(arg.data.recurring_payment).toBe(true);
    expect(arg.data.expense_type).toBe('Expense');
    expect(navigate).toHaveBeenCalledWith('/settings/bills');
  });

  // Every save sent `rollover: frequency > 1`, so a monthly bill that rolls over (made
  // through the API or MCP), once it had history, showed the locked note and refused every save.
  it("keeps a bill's kind unless its frequency moves across monthly, so a bill with history saves", async () => {
    const saved = budgetItems[0];
    budgetItems[0] = { ...billItem, rollover: true, type: 'Envelope' };
    historyLocked = true;
    try {
      renderPage();
      const nameInput = await screen.findByDisplayValue('Electric');
      expect(screen.queryByText(/has money recorded in an earlier period/)).not.toBeInTheDocument();
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'Power Bill');
      await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(updateBudgetItem).toHaveBeenCalledTimes(1));
      expect(updateBudgetItem.mock.calls[0][0].data).toMatchObject({ name: 'Power Bill', rollover: true, type: 'Envelope', recurring_payment_frequency: 1 });
    } finally {
      budgetItems[0] = saved!;
      historyLocked = false;
    }
  });

  it('blocks save when the name is cleared', async () => {
    renderPage();
    const nameInput = await screen.findByDisplayValue('Electric');
    await userEvent.clear(nameInput);
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/budget item name is required/i)).toBeInTheDocument();
    expect(updateBudgetItem).not.toHaveBeenCalled();
  });

  // Monthly hid the envelope section with "1,00o" still in its starting
  // balance, and Save did nothing: no request, no message, the focus left on the button.
  const quarterly = { ...billItem, recurring_payment_frequency: 3, rollover_target_amount: 360, rollover_starting_balance: 50 };
  const pickFrequency = async (name: string) => {
    await userEvent.click(screen.getByRole('combobox', { name: /payment frequency/i }));
    await userEvent.click(await screen.findByRole('option', { name }));
  };

  it('saves once Monthly hides an envelope amount it can\'t read, leaving that amount out', async () => {
    budgetItems[0] = quarterly;
    try {
      renderPage();
      await screen.findByDisplayValue('Electric');
      const starting = screen.getByLabelText(/envelope starting balance/i);
      await userEvent.clear(starting);
      await userEvent.type(starting, '1,00o');
      await pickFrequency('Monthly');
      expect(screen.queryByLabelText(/envelope starting balance/i)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(updateBudgetItem).toHaveBeenCalledTimes(1));
      const data = updateBudgetItem.mock.calls[0][0].data;
      expect(data.recurring_payment_frequency).toBe(1);
      // Not sent (NaN would go as null and empty the stored balance); the target as held.
      expect('rollover_starting_balance' in data && data.rollover_starting_balance !== undefined).toBe(false);
      expect(data.rollover_target_amount).toBe(360);
    } finally {
      budgetItems[0] = billItem;
    }
  });

  // Clearing the section when it hid blanked both amounts on Monthly and back,
  // and a default budget worked out on save then took a starting balance of 0.
  it('keeps the envelope amounts through Monthly and back, and a monthly bill sends them as held', async () => {
    budgetItems[0] = quarterly;
    try {
      renderPage();
      await screen.findByDisplayValue('Electric');
      await pickFrequency('Monthly');
      await pickFrequency('Quarterly (3 Months)');
      expect(screen.getByLabelText(/envelope target amount/i)).toHaveValue('360.00');
      expect(screen.getByLabelText(/envelope starting balance/i)).toHaveValue('50.00');

      await pickFrequency('Monthly');
      await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(updateBudgetItem).toHaveBeenCalledTimes(1));
      expect(updateBudgetItem.mock.calls[0][0].data).toMatchObject({
        recurring_payment_frequency: 1,
        rollover_target_amount: 360,
        rollover_starting_balance: 50,
      });
    } finally {
      budgetItems[0] = billItem;
    }
  });

  // The starting balance is an amount as the others are. One past what can be
  // stored was sent, and the server's refusal came back as a toast.
  it('refuses a starting balance past what can be stored beside the field, and sends nothing', async () => {
    budgetItems[0] = quarterly;
    try {
      renderPage();
      await screen.findByDisplayValue('Electric');
      const starting = screen.getByLabelText(/envelope starting balance/i);
      await userEvent.clear(starting);
      await userEvent.type(starting, '100000000000');
      await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(starting).toHaveAccessibleDescription('Enter an amount up to 9,999,999,999.99.'));
      expect(starting).toHaveAttribute('aria-invalid', 'true');
      expect(updateBudgetItem).not.toHaveBeenCalled();
    } finally {
      budgetItems[0] = billItem;
    }
  });

  // The API refuses a frequency below 1, which a bill may hold from before. The
  // select showed Monthly for 0 and nothing for -5, which the form then sent back.
  it.each([0, -5])('opens a bill whose frequency is %i as Monthly, and saves Monthly', async (months) => {
    budgetItems[0] = { ...billItem, recurring_payment_frequency: months };
    try {
      renderPage();
      await screen.findByDisplayValue('Electric');
      expect(screen.getByRole('combobox', { name: /payment frequency/i })).toHaveTextContent('Monthly');
      await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(updateBudgetItem).toHaveBeenCalledTimes(1));
      expect(updateBudgetItem.mock.calls[0][0].data).toMatchObject({ recurring_payment_frequency: 1 });
    } finally {
      budgetItems[0] = billItem;
    }
  });

  it('refuses a bill amount it can\'t read, beside the field, and sends nothing', async () => {
    renderPage();
    await screen.findByDisplayValue('Electric');
    const box = screen.getByLabelText(/^bill amount/i);
    await userEvent.clear(box);
    await userEvent.type(box, '12o');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(UNREADABLE_AMOUNT_MESSAGE)).toBeInTheDocument();
    await waitFor(() => expect(box).toHaveFocus());
    expect(updateBudgetItem).not.toHaveBeenCalled();
  });
  // An `= []` default on a query's data is a new array each render while the query is
  // loading; an effect that depends on it and sets state looped (React error #185).
  it.each([
    ['the item\'s tags', () => { itemTagsData = undefined; }, () => screen.findByDisplayValue('Electric')],
    ['the tag list', () => { tagsData = undefined; }, () => screen.findByText('Loading bill...')],
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

// A bill's actual is pre-signed (negative when it was paid), and the goal card
// showed "Previously Spent" only for a positive one, so never once the bill had been paid.
describe('EditBillsPage goal progress', () => {
  it('shows what the bill spent this period as Previously Spent', async () => {
    budgetItems[0] = { ...billItem, recurring_payment_frequency: 6, rollover_target_amount: 600 };
    historyData = {
      budget_item_uuid: 'bill-1',
      periods: [],
      current: { period_uuid: 'p-1', budget: '100.00', actual: '-120.00', transfers: '0.00', remaining: '300.00' },
    };
    try {
      renderPage();
      expect(await screen.findByText('Progress Toward Target')).toBeInTheDocument();
      // The card wants the amount spent, positive, and shows it as "-$120.00".
      expect(screen.getByText('Previously Spent:').parentElement).toHaveTextContent('Previously Spent:-$120.00');
    } finally {
      budgetItems[0] = billItem;
      historyData = undefined;
    }
  });
});

// The bill page had its own history widget (the ten newest, no paging); it
// uses the edit pages' shared panel, paged on the server.
describe('EditBillsPage history', () => {
  it("lists the bill's transactions a page at a time", async () => {
    const setPage = vi.fn();
    historyPage = {
      page: 1,
      setPage,
      total: 14,
      loading: false,
      error: null,
      transactions: Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        uuid: `tx-${i + 1}`,
        description: `Electric payment ${i + 1}`,
        amount: -120,
        transaction_date: '2026-10-05',
        account_name: 'Checking',
      })),
    };
    try {
      renderPage();
      expect(await screen.findByText('Transactions (14)')).toBeInTheDocument();
      expect(screen.getByText('Electric payment 1')).toBeInTheDocument();
      expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
      expect(setPage).toHaveBeenCalledWith(2);
    } finally {
      historyPage = loadingHistory;
    }
  });
});

// returnTo is followed only to a path on this app; anything else is the list.
describe('EditBillsPage returnTo', () => {
  const FALLBACK = '/settings/bills';
  it.each([
    ['//evil.example', FALLBACK],
    ['/\\evil.example', FALLBACK],
    ['/.//evil.example', FALLBACK],
    ['/%2e//evil.example', FALLBACK],
    ['javascript:alert(1)', FALLBACK],
    ['https://evil.example/x', FALLBACK],
    ['/budgets?month=2026-06', '/budgets?month=2026-06'],
  ])('takes returnTo %j to %j', async (returnTo, expected) => {
    renderWithProviders(<Theme><EditBillsPage /></Theme>, { route: `/?returnTo=${encodeURIComponent(returnTo)}` });
    await screen.findByDisplayValue('Electric');
    expect(screen.getByRole('link', { name: /cancel/i })).toHaveAttribute('href', expected);
  });
});
