import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { UNREADABLE_AMOUNT_MESSAGE } from '../../components/forms/optionalAmount';
import EditIncomePage from '../EditIncomePage';

const updateBudgetItem = vi.fn().mockResolvedValue({});
const incomeItem = {
  id: 1,
  uuid: 'income-1',
  name: 'Salary',
  description: 'monthly pay',
  expense_type: 'Income',
  type: 'Monthly',
  default_budget_amount: 4200,
  notes: 'direct deposit',
  instructions: '',
  color: '#10B981',
  icon: 'DollarSign',
  transaction_auto_tag_id: null,
};

// Stable references so the form's `reset` effect (which depends on the tags
// array) doesn't re-fire every render and loop.
const budgetItems = [incomeItem];
const emptyArr: never[] = [];
// A query that hasn't returned yet has no data (undefined), the same on every render.
let tagsData: never[] | undefined = emptyArr;
let itemTagsData: never[] | undefined = emptyArr;
const resetLoading = () => { tagsData = emptyArr; itemTagsData = emptyArr; };

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  const noop = () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  return {
    ...actual,
    useBudgetItemsQuery: () => ({ data: budgetItems, isLoading: false }),
    useTagsQuery: () => ({ data: tagsData, isLoading: tagsData === undefined }),
    useBudgetItemTagsQuery: () => ({ data: itemTagsData }),
    // isLoading keeps the history sidebar on its spinner branch, avoiding the
    // Radix ScrollArea jsdom render loop. The form under test is unaffected.
    useBudgetItemTransactionsPage: () => ({ page: 1, setPage: vi.fn(), transactions: emptyArr, total: 0, loading: true, error: null }),
    useUpdateBudgetItemMutation: () => ({ mutateAsync: updateBudgetItem, isPending: false }),
    useDeleteBudgetItemMutation: noop,
    useAddTagToBudgetItemMutation: noop,
    useRemoveTagFromBudgetItemMutation: noop,
  };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate, useParams: () => ({ uuid: 'income-1' }) };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const renderPage = () => renderWithProviders(<Theme><EditIncomePage /></Theme>);

describe('EditIncomePage (react-hook-form)', () => {
  beforeEach(() => { updateBudgetItem.mockClear(); navigate.mockClear(); });

  it('seeds the form from the loaded income item and saves edits', async () => {
    renderPage();
    const nameInput = await screen.findByDisplayValue('Salary');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'New Salary');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateBudgetItem).toHaveBeenCalledTimes(1));
    const arg = updateBudgetItem.mock.calls[0][0];
    expect(arg.uuid).toBe('income-1');
    expect(arg.data.name).toBe('New Salary');
    expect(arg.data.expense_type).toBe('Income');
    expect(arg.data.isbill).toBe(false);
    expect(navigate).toHaveBeenCalledWith('/settings/income');
  });

  it('blocks save when the name is cleared', async () => {
    renderPage();
    const nameInput = await screen.findByDisplayValue('Salary');
    await userEvent.clear(nameInput);
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/budget item name is required/i)).toBeInTheDocument();
    expect(updateBudgetItem).not.toHaveBeenCalled();
  });

  it('refuses an income amount it can\'t read, beside the field, and sends nothing', async () => {
    renderPage();
    await screen.findByDisplayValue('Salary');
    const box = screen.getByLabelText(/monthly income amount/i);
    await userEvent.clear(box);
    await userEvent.type(box, '42oo');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(UNREADABLE_AMOUNT_MESSAGE)).toBeInTheDocument();
    await waitFor(() => expect(box).toHaveFocus());
    expect(updateBudgetItem).not.toHaveBeenCalled();
  });
  // An `= []` default on a query's data is a new array each render while the query is
  // loading; an effect that depends on it and sets state looped (React error #185).
  it.each([
    ['the item\'s tags', () => { itemTagsData = undefined; }, () => screen.findByDisplayValue('Salary')],
    ['the tag list', () => { tagsData = undefined; }, () => screen.findByText('Loading income...')],
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

// returnTo is followed only to a path on this app; anything else is the list.
describe('EditIncomePage returnTo', () => {
  const FALLBACK = '/settings/income';
  it.each([
    ['//evil.example', FALLBACK],
    ['/\\evil.example', FALLBACK],
    ['/.//evil.example', FALLBACK],
    ['/%2e//evil.example', FALLBACK],
    ['javascript:alert(1)', FALLBACK],
    ['https://evil.example/x', FALLBACK],
    ['/budgets?month=2026-06', '/budgets?month=2026-06'],
  ])('takes returnTo %j to %j', async (returnTo, expected) => {
    renderWithProviders(<Theme><EditIncomePage /></Theme>, { route: `/?returnTo=${encodeURIComponent(returnTo)}` });
    await screen.findByDisplayValue('Salary');
    expect(screen.getByRole('link', { name: /cancel/i })).toHaveAttribute('href', expected);
  });
});
