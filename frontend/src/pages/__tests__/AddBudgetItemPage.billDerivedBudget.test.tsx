import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { BillAddForm } from '../AddBudgetItemPage';

// A bill created with no Default Budget Amount gets one derived from its amount, in whole
// cents: Math.ceil(x * 100) / 100 saved 150.31 for a $150.30 monthly bill.

const mutateAsync = vi.fn().mockResolvedValue({ uuid: 'bi-new' });
const addTag = vi.fn().mockResolvedValue({});
const emptyArr: never[] = [];
vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  return {
    ...actual,
    useCategoriesQuery: () => ({ data: emptyArr, isLoading: false }),
    useMerchantsQuery: () => ({ data: emptyArr }),
    useCreateBudgetItemMutation: () => ({ mutateAsync, isPending: false }),
    useCreateMerchantMutation: () => ({ mutateAsync: vi.fn().mockResolvedValue({ id: 1, name: 'M' }), isPending: false }),
    useTagsQuery: () => ({ data: [{ id: 5, name: 'Tag', color: '#000000' }] }),
    useBudgetItemTagsQuery: () => ({ data: emptyArr }),
    useAddTagToBudgetItemMutation: () => ({ mutateAsync: addTag, isPending: false }),
  };
});

// Drive tag selection deterministically — the real TagSelector is a dropdown.
vi.mock('../../components/TagSelector', () => ({
  default: ({ onChange }: { onChange: (tags: { id: number; name: string }[]) => void }) => (
    <button type="button" onClick={() => onChange([{ id: 5, name: 'Tag' }])}>add-test-tag</button>
  ),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => { mutateAsync.mockClear(); addTag.mockClear(); navigate.mockClear(); });


describe('a bill saved with no budget amount', () => {
  it('derives the monthly budget of a $150.30 monthly bill', async () => {
    renderWithProviders(<Theme><BillAddForm /></Theme>);
    await userEvent.type(screen.getByPlaceholderText(/Electric Bill/i), 'Electric');
    await userEvent.type(screen.getByRole('textbox', { name: 'Bill Amount' }), '150.30');
    await userEvent.click(screen.getByRole('button', { name: /create bill/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const arg = mutateAsync.mock.calls[0][0];
    expect(arg.default_budget_amount).toBe(150.3);
  });
});
