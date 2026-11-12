import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import { budgetPeriod, budgetPeriodItem } from '../../../test/fixtures';
import type { BudgetPeriodItem } from '../../../services/api';
import BudgetItemDesktopRow from '../BudgetItemDesktopRow';
import BudgetItemMobileCard from '../BudgetItemMobileCard';
import type { BudgetRowActions } from '../budgetRowActions';

/**
 * Each budget row's status badge, desktop row and mobile card: an
 * expense at zero after spending shows Spent; an income envelope at zero after a reversal (a
 * negative actual this period) shows Expected: nothing received this period.
 */

const october = budgetPeriod(2026, 10);
const envelope = (id: number, name: string, expenseType: 'Expense' | 'Income') =>
  budgetPeriodItem(october, {
    id, budget_item_name: name, expense_type: expenseType, type: 'Envelope', subtype: 'Flexible', rollover: true,
    calculated_budget: '100.00', calculated_actual: '-50.00', calculated_remaining: '0.00',
  }) as unknown as BudgetPeriodItem;

const actions: BudgetRowActions = {
  edit: {
    budgetOf: (item) => parseFloat(String(item.calculated_budget)),
    isEditing: () => false,
    editingValue: () => '',
    startEdit: vi.fn(),
    change: vi.fn(),
    keyDown: vi.fn(),
    blur: vi.fn(),
  },
  searchParamsString: '', view: vi.fn(), editItem: vi.fn(), retire: vi.fn(), transfer: vi.fn(), activity: vi.fn(),
};

const STATUS = /^(On Track|Near Limit|Warning|Critical|Over Budget|Spent|Expected|Partly received|Received|Above plan|Funded)$/;

describe('a budget row’s status', () => {
  it.each([
    ['an expense envelope', 'Spent', envelope(1, 'Car repairs', 'Expense')],
    ['an income envelope', 'Expected', envelope(2, 'Side income', 'Income')],
  ])('shows %s at zero after a negative actual as %s, in the row and the card', (_kind, status, item) => {
    renderWithProviders(
      <Theme>
        <BudgetItemDesktopRow item={item} actions={actions} />
        <BudgetItemMobileCard item={item} actions={actions} income={item.expense_type === 'Income'} />
      </Theme>,
    );
    expect(screen.getAllByText(STATUS).map((badge) => badge.textContent)).toEqual([status, status]);
  });

  // The words and colours by design: income Expected (gray), Partly received (amber),
  // Received and Above plan (green); a goal funded in full Funded (green).
  it.each([
    ['Expected', 'gray', '0.00'],
    ['Partly received', 'amber', '40.00'],
    ['Received', 'green', '100.00'],
    ['Above plan', 'green', '120.00'],
  ])('shows an income item that received what it did as %s, in %s', (status, colour, received) => {
    const pay = budgetPeriodItem(october, {
      id: 3, budget_item_name: 'Pay', expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck',
      calculated_budget: '100.00', calculated_actual: received, calculated_remaining: '0.00',
    }) as unknown as BudgetPeriodItem;
    renderWithProviders(<Theme><BudgetItemDesktopRow item={pay} actions={actions} /></Theme>);
    const badge = screen.getByText(STATUS);
    expect(badge.textContent).toBe(status);
    expect(badge.closest('[data-accent-color]')?.getAttribute('data-accent-color')).toBe(colour);
  });
});

describe('a goal’s status', () => {
  it('shows a goal that set aside its budget as Funded, in green', async () => {
    const { default: BudgetGoalCard } = await import('../BudgetGoalCard');
    const goal = budgetPeriodItem(october, {
      id: 4, budget_item_name: 'House', expense_type: 'Savings', type: 'Goal', subtype: 'Goal',
      calculated_budget: '250.00', calculated_actual: '-250.00', calculated_remaining: '0.00',
    }) as unknown as BudgetPeriodItem;
    renderWithProviders(<Theme><BudgetGoalCard item={goal} actions={actions} card /></Theme>);
    const badge = screen.getByText(STATUS);
    expect(badge.textContent).toBe('Funded');
    expect(badge.closest('[data-accent-color]')?.getAttribute('data-accent-color')).toBe('green');
  });
});
