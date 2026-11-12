import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import EditBudgetItemPage, { budgetItemKind } from '../EditBudgetItemPage';

// The dispatcher renders one of the three real edit pages — mock them so the
// test asserts only which one was chosen for a given item kind.
vi.mock('../EditIncomePage', () => ({ default: () => <div>income-editor</div> }));
vi.mock('../EditExpensePage', () => ({ default: () => <div>expense-editor</div> }));
vi.mock('../EditBillsPage', () => ({ default: () => <div>bills-editor</div> }));

// Mutable holder so each test can set the loaded catalog.
const state: { items: Array<Record<string, unknown>>; isLoading: boolean } = { items: [], isLoading: false };
vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  return { ...actual, useBudgetItemsQuery: () => ({ data: state.items, isLoading: state.isLoading }) };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigate,
    useParams: () => ({ uuid: 'bi-1' }),
    Navigate: ({ to }: { to: string }) => <div>redirect:{to}</div>,
  };
});

const renderPage = (route = '/') => renderWithProviders(<Theme><EditBudgetItemPage /></Theme>, { route });

describe('EditBudgetItemPage (unified edit dispatcher)', () => {
  beforeEach(() => { state.items = []; state.isLoading = false; navigate.mockClear(); });

  it('maps item flags to the right kind', () => {
    expect(budgetItemKind({ expense_type: 'Income', isbill: false })).toBe('income');
    expect(budgetItemKind({ expense_type: 'Expense', isbill: true })).toBe('bill');
    expect(budgetItemKind({ expense_type: 'Transfer', isbill: false })).toBe('bill');
    expect(budgetItemKind({ expense_type: 'Expense', isbill: false })).toBe('expense');
  });

  it('renders the income editor for an income item', () => {
    state.items = [{ uuid: 'bi-1', expense_type: 'Income', isbill: false }];
    renderPage();
    expect(screen.getByText('income-editor')).toBeInTheDocument();
  });

  it('renders the bills editor for a bill item', () => {
    state.items = [{ uuid: 'bi-1', expense_type: 'Expense', isbill: true }];
    renderPage();
    expect(screen.getByText('bills-editor')).toBeInTheDocument();
  });

  it('renders the expense editor for an expense item', () => {
    state.items = [{ uuid: 'bi-1', expense_type: 'Expense', isbill: false }];
    renderPage();
    expect(screen.getByText('expense-editor')).toBeInTheDocument();
  });

  it('redirects to returnTo (default /budgets) when the uuid is unknown', () => {
    state.items = [{ uuid: 'other', expense_type: 'Expense', isbill: false }];
    renderPage();
    expect(screen.getByText('redirect:/budgets')).toBeInTheDocument();
  });

  // returnTo is followed only to a path on this app; anything else is /budgets.
  it.each([
    ['//evil.example', '/budgets'],
    ['/\\evil.example', '/budgets'],
    ['/.//evil.example', '/budgets'],
    ['/%2e//evil.example', '/budgets'],
    ['javascript:alert(1)', '/budgets'],
    ['https://evil.example/x', '/budgets'],
    ['/budgets?month=2026-06', '/budgets?month=2026-06'],
  ])('redirects an unknown uuid with returnTo %j to %j', (returnTo, expected) => {
    state.items = [{ uuid: 'other', expense_type: 'Expense', isbill: false }];
    renderPage(`/?returnTo=${encodeURIComponent(returnTo)}`);
    expect(screen.getByText(`redirect:${expected}`)).toBeInTheDocument();
  });
});
