import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import { budgetPeriod, budgetPeriodItem } from '../../../test/fixtures';
import type { BudgetPeriodItem } from '../../../services/api';
import BudgetItemMobileCard from '../BudgetItemMobileCard';
import type { BudgetRowActions } from '../budgetRowActions';
import type { InlineBudgetEdit } from '../useInlineBudgetEdit';
import { ABOVE_STRETCHED_LINK } from '../../StretchedLink';

/** Whether an element sits in a box raised above the card's stretched link. */
const aboveLink = (el: HTMLElement) => Boolean(el.closest(ABOVE_STRETCHED_LINK.split(' ').map((c) => `[class~="${c}"]`).join('')));

const item = budgetPeriodItem(budgetPeriod(2026, 10), {
  id: 9, budget_item_name: 'Groceries', expense_type: 'Expense', type: 'Monthly', subtype: 'Flexible',
  calculated_budget: '400.00', calculated_actual: '-120.00', calculated_remaining: '280.00',
}) as unknown as BudgetPeriodItem;

const edit: InlineBudgetEdit = {
  budgetOf: (row) => parseFloat(String(row.calculated_budget)),
  isEditing: () => false,
  editingValue: () => '',
  startEdit: vi.fn(),
  change: vi.fn(),
  keyDown: vi.fn(),
  blur: vi.fn(),
};

const renderCard = () => {
  const actions: BudgetRowActions = {
    edit, searchParamsString: 'period=2026-10', view: vi.fn(), editItem: vi.fn(), retire: vi.fn(), transfer: vi.fn(), activity: vi.fn(),
  };
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path="/budgets" element={<BudgetItemMobileCard item={item} actions={actions} groupType="Monthly" groupSubtype="Flexible" />} />
        <Route path="/budget-items/:uuid/view" element={<p>Item page</p>} />
      </Routes>
    </Theme>,
    { route: '/budgets?period=2026-10' },
  );
  return actions;
};

// The card opened the item from an onClick on the Card, which no keyboard reaches. Its
// name is a link stretched over the card (an ::after jsdom doesn't lay out), and the card's
// own controls sit above it.
describe('BudgetItemMobileCard', () => {
  it('opens the item by its name link, stretched over the card, and not from a click handler on the card', async () => {
    const actions = renderCard();
    const link = screen.getByRole('link', { name: 'Groceries' });
    expect(link).toHaveAttribute('href', `/budget-items/${item.budget_item_uuid}/view`);
    expect(link).toHaveClass('after:absolute', 'after:inset-0');

    await userEvent.click(link.closest('.rt-Card') as HTMLElement);
    expect(actions.view).not.toHaveBeenCalled();
    expect(screen.queryByText('Item page')).not.toBeInTheDocument();

    link.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Item page')).toBeInTheDocument();
  });

  it('keeps Transfer and the menu above the link, each doing its own thing', async () => {
    const actions = renderCard();
    const transfer = screen.getByRole('button', { name: 'Transfer money' });
    expect(aboveLink(transfer)).toBe(true);
    await userEvent.click(transfer);
    expect(actions.transfer).toHaveBeenCalledWith(item);
    expect(screen.queryByText('Item page')).not.toBeInTheDocument();

    expect(aboveLink(screen.getByRole('button', { name: 'Budget item actions' }))).toBe(true);
  });
});
