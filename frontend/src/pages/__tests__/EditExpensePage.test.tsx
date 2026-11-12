import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { UNREADABLE_AMOUNT_MESSAGE } from '../../components/forms/optionalAmount';
import EditExpensePage from '../EditExpensePage';

const updateBudgetItem = vi.fn().mockResolvedValue({});
const expenseItem = {
  id: 7,
  uuid: 'expense-1',
  name: 'Groceries',
  description: 'food',
  expense_type: 'Expense',
  priority: 'Optional',
  type: 'Monthly',
  subtype: 'Flexible',
  rollover: false,
  default_budget_amount: 600,
  rollover_target_amount: null,
  rollover_starting_balance: null,
  rollover_starting_balance_date: null,
  notes: 'weekly shop',
  instructions: '',
  color: '#3B82F6',
  icon: 'CreditCard',
  category_id: null,
  transaction_auto_tag_id: null,
};

// Stable references so the form's `reset` effect (which depends on the tags
// array) doesn't re-fire every render and loop.
const budgetItems: Record<string, unknown>[] = [expenseItem];
// The current period's figures (GET /budget-items/:uuid/history), none unless a test sets them.
let historyData: unknown;
const emptyArr: never[] = [];
// A query that hasn't returned yet has no data (undefined), the same on every render.
let tagsData: never[] | undefined = emptyArr;
let itemTagsData: never[] | undefined = emptyArr;
// What GET /budgets/items/:uuid/usage says of its history.
let historyBeforeCurrentPeriod = false;

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  const noop = () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  return {
    ...actual,
    useBudgetItemsQuery: () => ({ data: budgetItems, isLoading: false }),
    useBudgetItemHistoryQuery: () => ({ data: historyData, isLoading: false, isError: false }),
    useCategoriesQuery: () => ({ data: emptyArr, isLoading: false }),
    useTagsQuery: () => ({ data: tagsData, isLoading: tagsData === undefined }),
    useBudgetItemTagsQuery: () => ({ data: itemTagsData }),
    // isLoading keeps the history sidebar on its spinner branch, avoiding the
    // Radix ScrollArea jsdom render loop. The form under test is unaffected.
    useBudgetItemTransactionsPage: () => ({ page: 1, setPage: vi.fn(), transactions: emptyArr, total: 0, loading: true, error: null }),
    useUpdateBudgetItemMutation: () => ({ mutateAsync: updateBudgetItem, isPending: false }),
    useBudgetItemUsageQuery: (uuid: string | null) => ({ data: uuid ? { history_before_current_period: historyBeforeCurrentPeriod } : undefined, isLoading: false }),
    useDeleteBudgetItemMutation: noop,
    useAddTagToBudgetItemMutation: noop,
    useRemoveTagFromBudgetItemMutation: noop,
  };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate, useParams: () => ({ uuid: 'expense-1' }) };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const renderPage = () => renderWithProviders(<Theme><EditExpensePage /></Theme>);

describe('EditExpensePage (react-hook-form)', () => {
  beforeEach(() => { updateBudgetItem.mockClear(); navigate.mockClear(); historyBeforeCurrentPeriod = false; });

  it('seeds the form from the loaded expense and saves edits', async () => {
    renderPage();
    const nameInput = await screen.findByDisplayValue('Groceries');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Food');
    await userEvent.click(screen.getByRole('button', { name: /update expense/i }));
    await waitFor(() => expect(updateBudgetItem).toHaveBeenCalledTimes(1));
    const arg = updateBudgetItem.mock.calls[0][0];
    expect(arg.uuid).toBe('expense-1');
    expect(arg.data.name).toBe('Food');
    expect(arg.data.isbill).toBe(false);
    expect(arg.data.recurring_payment).toBe(false);
    expect(navigate).toHaveBeenCalledWith('/settings/expenses');
  });

  // An `= []` default on a query's data is a new array each render while the query is
  // loading; an effect that depends on it and sets state looped (React error #185).
  it.each([
    // The form shows while only the item's tags are loading...
    ['the item\'s tags', () => { itemTagsData = undefined; }, () => screen.findByDisplayValue('Groceries')],
    // ...and the page's loader while the tag list is (the form's reset effect still runs).
    ['the tag list', () => { tagsData = undefined; }, () => screen.findByText('Loading expense...')],
  ])('renders without an update loop while %s are loading', async (_what, setLoading, find) => {
    setLoading();
    try {
      renderPage();
      expect(await find()).toBeInTheDocument();
      // Long enough for a looping effect to hit React's update limit and throw.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await find()).toBeInTheDocument();
    } finally {
      tagsData = emptyArr;
      itemTagsData = emptyArr;
    }
  });

  // Once it has money in an earlier period, Monthly ↔ Envelope is fixed. The page
  // says so as soon as the other type is chosen, and sends nothing the server would refuse.
  it('says, before saving, that its history keeps it monthly, and sends nothing', async () => {
    Object.assign(window.HTMLElement.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => {}, scrollIntoView: () => {} });
    historyBeforeCurrentPeriod = true;
    renderPage();
    await screen.findByDisplayValue('Groceries');
    expect(screen.queryByText(/has money recorded in an earlier period/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'Type' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Envelope' }));
    expect(await screen.findByText(/Groceries has money recorded in an earlier period/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /update expense/i }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(updateBudgetItem).not.toHaveBeenCalled();
  });

  it('blocks save when the name is cleared', async () => {
    renderPage();
    const nameInput = await screen.findByDisplayValue('Groceries');
    await userEvent.clear(nameInput);
    await userEvent.click(screen.getByRole('button', { name: /update expense/i }));
    expect(await screen.findByText(/budget item name is required/i)).toBeInTheDocument();
    expect(updateBudgetItem).not.toHaveBeenCalled();
  });

  // "15o" for 150 was read as 0 (unreadable is null, and the field mapped null to 0),
  // and Update saved a budget of 0 with a success toast.
  it('refuses a default budget it can\'t read, beside the field, and sends nothing', async () => {
    renderPage();
    await screen.findByDisplayValue('Groceries');
    const box = screen.getByLabelText(/monthly budget amount/i);
    await userEvent.clear(box);
    await userEvent.type(box, '15o');
    const update = screen.getByRole('button', { name: /update expense/i });
    await userEvent.click(update);
    expect(await screen.findByText(UNREADABLE_AMOUNT_MESSAGE)).toBeInTheDocument();
    expect(box).toHaveAttribute('aria-invalid', 'true');
    // One message for the field: CurrencyInput's own hint is left out.
    expect(box).toHaveAccessibleDescription(UNREADABLE_AMOUNT_MESSAGE);
    expect(screen.queryByText(/with at most two decimals/)).not.toBeInTheDocument();
    await waitFor(() => expect(box).toHaveFocus());
    expect(update).toBeEnabled();
    expect(updateBudgetItem).not.toHaveBeenCalled();

    // Read, it saves; the message goes.
    await userEvent.clear(box);
    await userEvent.type(box, '150');
    await userEvent.click(update);
    await waitFor(() => expect(updateBudgetItem).toHaveBeenCalledTimes(1));
    expect(updateBudgetItem.mock.calls[0][0].data.default_budget_amount).toBe(150);
    expect(screen.queryByText(UNREADABLE_AMOUNT_MESSAGE)).not.toBeInTheDocument();
  });

  // The starting balance is an amount as the others are. One past what can be
  // stored was sent, and the server's refusal came back as a toast.
  it('refuses a starting balance past what can be stored beside the field, and sends nothing', async () => {
    budgetItems[0] = { ...expenseItem, type: 'Envelope', rollover: true, rollover_target_amount: 900, rollover_starting_balance: 50 };
    try {
      renderPage();
      await screen.findByDisplayValue('Groceries');
      const box = screen.getByLabelText(/^starting balance$/i);
      await userEvent.clear(box);
      await userEvent.type(box, '-100000000000');
      await userEvent.click(screen.getByRole('button', { name: /update expense/i }));
      await waitFor(() => expect(box).toHaveAccessibleDescription('Enter an amount between -9,999,999,999.99 and 9,999,999,999.99.'));
      expect(box).toHaveAttribute('aria-invalid', 'true');
      expect(updateBudgetItem).not.toHaveBeenCalled();
    } finally {
      budgetItems[0] = expenseItem;
    }
  });
});

// An expense's actual is pre-signed (negative when it spent), and the goal card
// showed "Previously Spent" only for a positive one, so never for an expense that had spent.
describe('EditExpensePage goal progress', () => {
  it('shows what the envelope spent this period as Previously Spent', async () => {
    budgetItems[0] = { ...expenseItem, type: 'Envelope', rollover: true, rollover_target_amount: 900 };
    historyData = {
      budget_item_uuid: 'expense-1',
      periods: [],
      current: { period_uuid: 'p-1', budget: '100.00', actual: '-45.50', transfers: '0.00', remaining: '250.00' },
    };
    try {
      renderPage();
      expect(await screen.findByText('Progress Toward Goal')).toBeInTheDocument();
      expect(screen.getByText('Previously Spent:').parentElement).toHaveTextContent('Previously Spent:-$45.50');
    } finally {
      budgetItems[0] = expenseItem;
      historyData = undefined;
    }
  });
});

// returnTo is followed only to a path on this app; anything else is the list.
describe('EditExpensePage returnTo', () => {
  const FALLBACK = '/settings/expenses';
  it.each([
    ['//evil.example', FALLBACK],
    ['/\\evil.example', FALLBACK],
    ['/.//evil.example', FALLBACK],
    ['/%2e//evil.example', FALLBACK],
    ['javascript:alert(1)', FALLBACK],
    ['https://evil.example/x', FALLBACK],
    ['/budgets?month=2026-06', '/budgets?month=2026-06'],
  ])('takes returnTo %j to %j', async (returnTo, expected) => {
    renderWithProviders(<Theme><EditExpensePage /></Theme>, { route: `/?returnTo=${encodeURIComponent(returnTo)}` });
    await screen.findByDisplayValue('Groceries');
    expect(screen.getByRole('link', { name: /cancel/i })).toHaveAttribute('href', expected);
  });
});
