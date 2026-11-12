import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import { budgetPeriod, budgetPeriodItem } from '../../../test/fixtures';
import type { BudgetPeriodItem } from '../../../services/api';
import BudgetGoalCard from '../BudgetGoalCard';
import type { BudgetRowActions } from '../budgetRowActions';
import type { InlineBudgetEdit } from '../useInlineBudgetEdit';

const goal = budgetPeriodItem(budgetPeriod(2026, 10), {
  id: 7, budget_item_name: 'Emergency Fund', expense_type: 'Savings', type: 'Goal', subtype: 'Goal',
  calculated_budget: '22.40', calculated_actual: '-21.28', calculated_remaining: '1.12',
  icon: 'piggy-bank', color: '#FEF08A', goal_target_date: '2026-12-31',
}) as unknown as BudgetPeriodItem;

const edit: InlineBudgetEdit = {
  budgetOf: (item) => parseFloat(String(item.calculated_budget)),
  isEditing: () => false,
  editingValue: () => '',
  startEdit: vi.fn(),
  change: vi.fn(),
  keyDown: vi.fn(),
  blur: vi.fn(),
};
const actions = (view = vi.fn()): BudgetRowActions => ({
  edit, searchParamsString: '', view, editItem: vi.fn(), retire: vi.fn(), transfer: vi.fn(), activity: vi.fn(),
});

const renderCard = (card: boolean, view = vi.fn()) =>
  renderWithProviders(<Theme><BudgetGoalCard item={goal} actions={actions(view)} card={card} /></Theme>);

/** The goal's icon circle: the element whose style holds the goal's colour. */
const iconCircle = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[style]')].find((el) => el.style.backgroundColor !== '');

describe('BudgetGoalCard (one source for the mobile card and the desktop row)', () => {
  it.each([true, false])('shows the goal and its figures as a card: %s', (card) => {
    renderCard(card);
    expect(screen.getByRole('link', { name: 'Emergency Fund' })).toHaveAttribute('href', `/goals/${goal.budget_item_uuid}/view`);
    expect(screen.getByText(/Target:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit budget for Emergency Fund, $22.40' })).toBeInTheDocument();
    // What it saved shows as its size; 1.12 of 22.40 left is exactly 5%.
    expect(screen.getByText('$21.28')).toBeInTheDocument();
    expect(screen.getByText('$1.12')).toBeInTheDocument();
    if (card) expect(screen.getByText('Critical')).toBeInTheDocument();
  });

  // The goal blocks drew their own `item.color + '20'` tint, with the icon in the item's
  // colour itself, which a pale colour left all but invisible on its tint.
  it.each([true, false])("draws its icon on the goal colour's tint, in a shade that reads on it (card: %s)", (card) => {
    const { container } = renderCard(card);
    const circle = iconCircle(container);
    // jsdom writes the tint's colour out as rgb().
    expect(circle?.style.backgroundColor).toMatch(/^color-mix\(in srgb, rgb\(254, 240, 138\) 12\.5%, transparent/);
    expect(circle?.style.color).toBe('color-mix(in srgb, #FEF08A 40%, var(--gray-12))');
  });

  it('opens the goal from its name', async () => {
    const view = vi.fn();
    renderCard(false, view);
    await userEvent.click(screen.getByRole('link', { name: 'Emergency Fund' }));
    expect(view).toHaveBeenCalledWith(goal);
  });
});
