import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import BudgetMatchingRulesPage from '../BudgetMatchingRulesPage';

const createRule = vi.fn().mockResolvedValue({});
const updateRule = vi.fn().mockResolvedValue({});
const toastError = vi.fn();

// Stable references so the edit seed effect / derived lookups don't loop.
const rule = {
  id: 9,
  uuid: 'rule-1',
  budget_item_id: 5,
  merchant_id: null,
  method: 'contains',
  matching_text: 'SMPLMART',
  amount_min: null,
  amount_max: null,
  priority: 100,
  is_active: true,
  notes: '',
};
const rules = [rule];
const emptyArr: never[] = [];

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  const noop = () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  return {
    ...actual,
    useBudgetItemsQuery: () => ({ data: emptyArr }),
    useMerchantsQuery: () => ({ data: emptyArr }),
    useBudgetItemMatchingRulesQuery: () => ({ data: rules, isLoading: false }),
    useCreateBudgetItemMatchingRuleMutation: () => ({ mutateAsync: createRule, isPending: false }),
    useUpdateBudgetItemMatchingRuleMutation: () => ({ mutateAsync: updateRule, isPending: false }),
    useDeleteBudgetItemMatchingRuleMutation: noop,
  };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) } }));

const renderAt = (route: string) =>
  renderWithProviders(<Theme><BudgetMatchingRulesPage /></Theme>, { route });

describe('BudgetMatchingRulesPage forms (react-hook-form)', () => {
  beforeEach(() => { createRule.mockClear(); updateRule.mockClear(); toastError.mockClear(); navigate.mockClear(); });

  it('creates a rule from the add form (budget item pre-selected via query param)', async () => {
    renderAt('/add?budget_item_id=5');
    await userEvent.type(screen.getByPlaceholderText(/text to match in transaction descriptions/i), 'SAMPLE STORE');
    await userEvent.click(screen.getAllByRole('button', { name: /create rule/i })[0]);
    await waitFor(() => expect(createRule).toHaveBeenCalledTimes(1));
    const payload = createRule.mock.calls[0][0][0];
    expect(payload.budget_item_id).toBe(5);
    expect(payload.method).toBe('contains');
    expect(payload.matching_text).toBe('SAMPLE STORE');
    expect(navigate).toHaveBeenCalledWith('/settings/budget-matching');
  });

  // The form's schema is the routes': it refuses on the field, as the server would.
  it('blocks the add form when a text method has no matching text, saying so on the field', async () => {
    renderAt('/add?budget_item_id=5');
    await userEvent.click(screen.getAllByRole('button', { name: /create rule/i })[0]);
    const textBox = screen.getByPlaceholderText(/text to match in transaction descriptions/i);
    await waitFor(() => expect(textBox).toHaveAccessibleDescription(/matching text is required for this method/i));
    expect(textBox).toHaveAttribute('aria-invalid', 'true');
    expect(createRule).not.toHaveBeenCalled();
  });

  it('seeds the edit form from the loaded rule and saves edits', async () => {
    renderAt('/rule-1/edit');
    const textInput = await screen.findByDisplayValue('SMPLMART');
    await userEvent.clear(textInput);
    await userEvent.type(textInput, 'SAMPLEMART');
    await userEvent.click(screen.getAllByRole('button', { name: /save changes/i })[0]);
    await waitFor(() => expect(updateRule).toHaveBeenCalledTimes(1));
    const [uuidArg, payload] = updateRule.mock.calls[0][0];
    expect(uuidArg).toBe('rule-1');
    expect(payload.budget_item_id).toBe(5);
    expect(payload.matching_text).toBe('SAMPLEMART');
    expect(navigate).toHaveBeenCalledWith('/settings/budget-matching');
  });
});
