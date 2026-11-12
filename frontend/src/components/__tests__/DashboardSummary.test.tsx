import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { budgetPeriod, budgetPeriodItem } from '../../test/fixtures';
import DashboardSummary from '../DashboardSummary';

const october = vi.hoisted(() => ({ items: [] as unknown[] }));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 1 } }) }));
vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  const page = { data: { pagination: { total: 0 } }, isLoading: false };
  return {
    ...actual,
    useBudgetPeriodsQuery: () => ({ data: [budgetPeriod(2026, 10)], isLoading: false }),
    usePaginatedTransactionsQuery: () => page,
    useBudgetPeriodItemsQuery: () => ({ data: { success: true, data: october.items }, isLoading: false }),
  };
});
vi.mock('../../hooks/queries/accounts', () => ({ useAccountsQuery: () => ({ data: [], isLoading: false }) }));

const period = budgetPeriod(2026, 10);

/** The Remaining Budget card's figure. */
const remaining = () => screen.getByRole('link', { name: 'Remaining Budget' }).closest('.rt-Card')?.querySelector('[id$="-value"]');

describe('DashboardSummary', () => {
  // Rounded to whole dollars, -$0.01 showed as "($0)" in red.
  it('shows the remaining budget to the cent, red only below zero', () => {
    october.items = [
      budgetPeriodItem(period, { id: 1, budget_item_name: 'Interest', expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck', calculated_actual: '0.30' }),
      budgetPeriodItem(period, { id: 2, budget_item_name: 'Stamps', type: 'Envelope', subtype: 'Flexible', calculated_budget: '0.31' }),
    ];
    renderWithProviders(<Theme><DashboardSummary /></Theme>);
    expect(remaining()).toHaveTextContent('($0.01)');
    expect(remaining()).toHaveClass('text-[var(--red-11)]');
  });

  it('shows nothing left as $0.00, not in red', () => {
    october.items = [
      budgetPeriodItem(period, { id: 1, budget_item_name: 'Interest', expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck', calculated_actual: '0.30' }),
      budgetPeriodItem(period, { id: 2, budget_item_name: 'Coffee', type: 'Envelope', subtype: 'Flexible', calculated_budget: '0.10' }),
      budgetPeriodItem(period, { id: 3, budget_item_name: 'Tea', type: 'Envelope', subtype: 'Flexible', calculated_budget: '0.20' }),
    ];
    renderWithProviders(<Theme><DashboardSummary /></Theme>);
    expect(remaining()).toHaveTextContent('$0.00');
    expect(remaining()).toHaveClass('text-[var(--gray-12)]');
  });
});
