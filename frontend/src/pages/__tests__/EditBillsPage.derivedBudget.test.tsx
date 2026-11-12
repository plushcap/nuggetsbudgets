import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import EditBillsPage from '../EditBillsPage';

const updateBudgetItem = vi.fn().mockResolvedValue({});
const billItem = {
  id: 3,
  uuid: 'bill-1',
  name: 'Electric',
  isbill: true,
  merchant_id: null,
  recurring_payment_amount: 150.3,
  recurring_payment_frequency: 1,
  category_id: null,
  recurring_next_payment_date: null,
  icon: 'Receipt',
  color: '#F59E0B',
  default_budget_amount: null,
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
const historyData: unknown = undefined;
// The history sidebar's page of transactions (useBudgetItemTransactionsPage). Loading by
// default: the form tests don't need it.
const loadingHistory = { page: 1, setPage: vi.fn(), transactions: [] as unknown[], total: 0, loading: true, error: null };
const historyPage = loadingHistory;
const emptyArr: never[] = [];
// A query that hasn't returned yet has no data (undefined), the same on every render.
const tagsData: never[] | undefined = emptyArr;
const itemTagsData: never[] | undefined = emptyArr;

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


describe('a bill saved with no budget amount', () => {
  it('derives the monthly budget of a $150.30 monthly bill', async () => {
    renderPage();
    await screen.findByDisplayValue('Electric');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateBudgetItem).toHaveBeenCalledTimes(1));
    const arg = updateBudgetItem.mock.calls[0][0];
    expect(arg.data.default_budget_amount).toBe(150.3);
  });
});
