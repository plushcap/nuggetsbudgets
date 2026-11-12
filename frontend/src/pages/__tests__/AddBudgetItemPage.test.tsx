import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import AddBudgetItemPage, { IncomeAddForm, ExpenseAddForm, BillAddForm } from '../AddBudgetItemPage';

// The three create forms now live inside AddBudgetItemPage (the per-kind
// /settings/{...}/add pages were folded in). The page swaps between them
// with a segmented control; each shares the create → apply-tags → toast →
// navigate flow and defaults returnTo to /budgets (the management home).

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

describe('AddBudgetItemPage (segmented create)', () => {
  const renderAt = (route: string) => renderWithProviders(<Theme><AddBudgetItemPage /></Theme>, { route });

  it('defaults to the expense form', () => {
    renderAt('/budget-items/add');
    expect(screen.getByRole('button', { name: /create expense/i })).toBeInTheDocument();
  });

  it('honours the ?kind= query param for the initial segment', () => {
    renderAt('/budget-items/add?kind=income');
    expect(screen.getByRole('button', { name: /create income/i })).toBeInTheDocument();
  });

  it('passes a custom returnTo through to the form Cancel link', () => {
    renderAt('/budget-items/add?kind=bill&returnTo=%2Fbudgets%3Fmonth%3D2026-06');
    expect(screen.getByRole('link', { name: /cancel/i })).toHaveAttribute('href', '/budgets?month=2026-06');
  });

  // returnTo is followed only to a path on this app; anything else is /budgets.
  it.each(['//evil.example', '/\\evil.example', '/.//evil.example', '/%2e//evil.example', 'javascript:alert(1)', 'https://evil.example/x'])(
    'leads Cancel back to /budgets, not to returnTo %j',
    (returnTo) => {
      renderAt(`/budget-items/add?kind=bill&returnTo=${encodeURIComponent(returnTo)}`);
      expect(screen.getByRole('link', { name: /cancel/i })).toHaveAttribute('href', '/budgets');
    },
  );

  it('switches the rendered form when another segment is chosen', async () => {
    renderAt('/budget-items/add');
    expect(screen.getByRole('button', { name: /create expense/i })).toBeInTheDocument();
    // SegmentedControl renders each label twice (visible + a width spacer).
    await userEvent.click(screen.getAllByText('Income')[0]);
    expect(screen.getByRole('button', { name: /create income/i })).toBeInTheDocument();
    await userEvent.click(screen.getAllByText('Bill')[0]);
    expect(screen.getByRole('button', { name: /create bill/i })).toBeInTheDocument();
  });
});

describe('IncomeAddForm', () => {
  const render = () => renderWithProviders(<Theme><IncomeAddForm /></Theme>);

  it('blocks submit and shows the name validation when empty', async () => {
    render();
    await userEvent.click(screen.getByRole('button', { name: /create income/i }));
    expect(await screen.findByText(/budget item name is required/i)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('submits the income as a budget item and returns to the budget page', async () => {
    render();
    await userEvent.type(screen.getByPlaceholderText(/Salary, Freelance/i), 'Salary');
    await userEvent.click(screen.getByRole('button', { name: /create income/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const arg = mutateAsync.mock.calls[0][0];
    expect(arg.name).toBe('Salary');
    expect(arg.expense_type).toBe('Income');
    expect(navigate).toHaveBeenCalledWith('/budgets');
  });

  it('applies selected tags after the income is created', async () => {
    render();
    await userEvent.type(screen.getByPlaceholderText(/Salary, Freelance/i), 'Salary');
    await userEvent.click(screen.getByRole('button', { name: /add-test-tag/i }));
    await userEvent.click(screen.getByRole('button', { name: /create income/i }));
    await waitFor(() => expect(addTag).toHaveBeenCalledWith({ budgetItemUuid: 'bi-new', tagId: 5 }));
    expect(navigate).toHaveBeenCalledWith('/budgets');
  });
});

describe('ExpenseAddForm', () => {
  const render = () => renderWithProviders(<Theme><ExpenseAddForm /></Theme>);

  it('blocks submit and shows the name validation when empty', async () => {
    render();
    await userEvent.click(screen.getByRole('button', { name: /create expense/i }));
    expect(await screen.findByText(/budget item name is required/i)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('submits the expense as a non-bill budget item', async () => {
    render();
    await userEvent.type(screen.getByPlaceholderText(/Groceries, Entertainment/i), 'Groceries');
    await userEvent.click(screen.getByRole('button', { name: /create expense/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const arg = mutateAsync.mock.calls[0][0];
    expect(arg.name).toBe('Groceries');
    expect(arg.isbill).toBe(false);
    expect(arg.recurring_payment).toBe(false);
    expect(navigate).toHaveBeenCalledWith('/budgets');
  });

  it('applies selected tags after the expense is created', async () => {
    render();
    await userEvent.type(screen.getByPlaceholderText(/Groceries, Entertainment/i), 'Groceries');
    await userEvent.click(screen.getByRole('button', { name: /add-test-tag/i }));
    await userEvent.click(screen.getByRole('button', { name: /create expense/i }));
    await waitFor(() => expect(addTag).toHaveBeenCalledWith({ budgetItemUuid: 'bi-new', tagId: 5 }));
    expect(navigate).toHaveBeenCalledWith('/budgets');
  });
});

// jsdom lacks the pointer-capture API Radix Select calls.
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
});

describe('BillAddForm', () => {
  const render = () => renderWithProviders(<Theme><BillAddForm /></Theme>);

  it('blocks submit and shows the name validation when empty', async () => {
    render();
    await userEvent.click(screen.getByRole('button', { name: /create bill/i }));
    expect(await screen.findByText(/budget item name is required/i)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('submits the bill as a recurring budget item', async () => {
    render();
    await userEvent.type(screen.getByPlaceholderText(/Electric Bill/i), 'Electric');
    await userEvent.click(screen.getByRole('button', { name: /create bill/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const arg = mutateAsync.mock.calls[0][0];
    expect(arg.name).toBe('Electric');
    expect(arg.isbill).toBe(true);
    expect(arg.recurring_payment).toBe(true);
    expect(arg.expense_type).toBe('Expense');
    expect(navigate).toHaveBeenCalledWith('/budgets');
  });

  // As Edit Bills does, a Monthly frequency hides the envelope section with
  // text it can't read in the starting balance; the bill is created without that amount (NaN
  // would go as null), and its default budget is worked out from none.
  it('creates the bill once Monthly hides an envelope amount it can\'t read, leaving that amount out', async () => {
    const pickFrequency = async (name: string) => {
      await userEvent.click(screen.getByRole('combobox', { name: /payment frequency/i }));
      await userEvent.click(await screen.findByRole('option', { name }));
    };
    render();
    await userEvent.type(screen.getByPlaceholderText(/Electric Bill/i), 'Electric');
    await userEvent.type(screen.getByRole('textbox', { name: /bill amount/i }), '120');
    await pickFrequency('Quarterly (3 Months)');
    const starting = screen.getByLabelText(/envelope starting balance/i);
    await userEvent.clear(starting);
    await userEvent.type(starting, '1,00o');
    await pickFrequency('Monthly');
    expect(screen.queryByLabelText(/envelope starting balance/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /create bill/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const arg = mutateAsync.mock.calls[0][0];
    expect(arg.recurring_payment_frequency).toBe(1);
    expect(arg.rollover_starting_balance).toBeUndefined();
    expect(JSON.parse(JSON.stringify(arg))).not.toHaveProperty('rollover_starting_balance');
    expect(arg.default_budget_amount).toBe(120);
  });

  it('applies selected tags after the bill is created', async () => {
    render();
    await userEvent.type(screen.getByPlaceholderText(/Electric Bill/i), 'Electric');
    await userEvent.click(screen.getByRole('button', { name: /add-test-tag/i }));
    await userEvent.click(screen.getByRole('button', { name: /create bill/i }));
    await waitFor(() => expect(addTag).toHaveBeenCalledWith({ budgetItemUuid: 'bi-new', tagId: 5 }));
    expect(navigate).toHaveBeenCalledWith('/budgets');
  });
});
