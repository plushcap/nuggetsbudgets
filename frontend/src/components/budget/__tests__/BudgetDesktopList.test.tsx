import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import { budgetPeriod, budgetPeriodItem } from '../../../test/fixtures';
import type { BudgetPeriodItem } from '../../../services/api';
import { calculateSubtotals, computeAllSubtotals, deriveBudgetSections } from '../../../pages/budgetPageCalcs';
import BudgetDesktopList, { BudgetColumnHeaders } from '../BudgetDesktopList';
import type { BudgetCollapse } from '../useBudgetCollapse';
import type { BudgetRowActions } from '../budgetRowActions';

/**
 * The desktop Budget grid's columns. Measured in a browser at 1440px,
 * nothing lined up with the column headings: the section and type totals sat 20px right of
 * them, the income rows' figures 8px, the goal rows' 32px (no actions column), the expense rows'
 * 4px left (their box's right padding), and the Planned figures were centred in their button.
 *
 * jsdom lays nothing out, so this checks what the browser showed the columns hang on: every line
 * of the grid (the headings, every header's totals and every row) ends in its three 6rem figure
 * cells, then the 24px actions column, with the same right-hand spacing (a row card's margin and
 * padding) between them and the grid's edge. The browser measured them equal with it.
 */

const october = budgetPeriod(2026, 10);
const items = [
  budgetPeriodItem(october, {
    id: 1, budget_item_name: 'Paycheck', expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck',
    calculated_budget: '5000.00', calculated_actual: '5000.00', calculated_remaining: '0.00',
  }),
  budgetPeriodItem(october, {
    id: 2, budget_item_name: 'Rent', expense_type: 'Expense', type: 'Monthly', subtype: 'Fixed',
    calculated_budget: '1500.10', calculated_actual: '-1500.10', calculated_remaining: '0.00',
  }),
  budgetPeriodItem(october, {
    id: 4, budget_item_name: 'Emergency fund', expense_type: 'Savings', type: 'Goal', subtype: 'Goal',
    calculated_budget: '400.00', calculated_actual: '-300.00', calculated_remaining: '100.00',
  }),
] as unknown as BudgetPeriodItem[];

const edit = {
  budgetOf: (item: BudgetPeriodItem) => parseFloat(String(item.calculated_budget)),
  isEditing: () => false,
  editingValue: () => '',
  startEdit: vi.fn(),
  change: vi.fn(),
  keyDown: vi.fn(),
  blur: vi.fn(),
};
const actions: BudgetRowActions = {
  edit, searchParamsString: '', view: vi.fn(), editItem: vi.fn(), retire: vi.fn(), transfer: vi.fn(), activity: vi.fn(),
};
const expanded: BudgetCollapse = {
  section: () => false, type: () => false, subtype: () => false,
  toggleSection: vi.fn(), toggleType: vi.fn(), toggleSubtype: vi.fn(),
};

const renderGrid = () => {
  const sections = deriveBudgetSections(items);
  const goals = sections.savings;
  return renderWithProviders(
    <Theme>
      <div data-testid="grid">
        <BudgetColumnHeaders />
        <BudgetDesktopList
          sections={sections}
          subtotals={computeAllSubtotals(sections, {})}
          goals={goals}
          goalTotals={calculateSubtotals(goals, {})}
          actions={actions}
          goalActions={actions}
          collapse={expanded}
        />
      </div>
    </Theme>,
  );
};

const widthOf = (el: Element | null) => (el instanceof HTMLElement ? el.style.getPropertyValue('--width') : '');

/** Radix's space scale (`rt-r-pr-3` is 12px) and Tailwind's (`pr-3` is 12px). */
const RADIX_SPACE = [0, 4, 8, 12, 16, 24, 32, 40, 48, 64];
/** What an element puts between its content and its right edge: margin and padding on the right. */
const rightSpacing = (el: HTMLElement): number => {
  let px = 0;
  let padded = false;
  for (const name of el.classList) {
    const radix = /^rt-r-(m|p)(r|x)?-(\d)$/.exec(name);
    if (radix) {
      px += RADIX_SPACE[Number(radix[3])];
      if (radix[1] === 'p') padded = true;
    }
    const tailwind = /^(m|p)(r|x)?-(\d+)$/.exec(name);
    if (tailwind) {
      px += Number(tailwind[3]) * 4;
      if (tailwind[1] === 'p') padded = true;
    }
  }
  // A Radix card's own padding (size 1), unless a class sets it.
  if (el.classList.contains('rt-Card') && !padded) px += 12;
  return px;
};

/** Each line of figures: the three cells' row, its name, and its spacing out to the grid's edge. */
const figureLines = (grid: HTMLElement) => {
  const cells = [...grid.querySelectorAll<HTMLElement>('.rt-Box')].filter((el) => widthOf(el) === '6rem');
  const lines = [...new Set(cells.map((cell) => cell.parentElement as HTMLElement))];
  return lines.map((line) => {
    let spacing = 0;
    for (let el: HTMLElement | null = line; el && el !== grid; el = el.parentElement) spacing += rightSpacing(el);
    const figures = [...line.children].filter((child) => widthOf(child) === '6rem');
    return {
      name: (line.textContent ?? '').replace(/\s+/g, ' ').trim(),
      figures: figures.length,
      // What follows the last figure: the actions column, 24px, after the line's gap.
      after: widthOf(figures[figures.length - 1]?.nextElementSibling ?? null),
      gap: line.classList.contains('rt-r-gap-2'),
      spacing,
    };
  });
};

describe('BudgetDesktopList columns', () => {
  it('ends every line in its three figures and the actions column, the same distance from the edge', () => {
    renderGrid();
    const lines = figureLines(screen.getByTestId('grid'));
    // The headings, the Income, Goals and Expenses totals, Monthly and Fixed, and the three rows.
    expect(lines).toHaveLength(9);
    const headings = lines[0];
    expect(headings.name).toBe('PlannedActualRemaining');
    for (const line of lines) {
      expect({ name: line.name, figures: line.figures, after: line.after, gap: line.gap, spacing: line.spacing })
        .toEqual({ name: line.name, figures: 3, after: '24px', gap: true, spacing: headings.spacing });
    }
    // A row card's margin and padding, 12px each.
    expect(headings.spacing).toBe(24);
  });

  it("keeps the goal row's figures in the columns though it has no menu, and the rows' menus in the actions column", () => {
    renderGrid();
    const goalLine = figureLines(screen.getByTestId('grid')).find((line) => line.name.startsWith('$400.00'));
    expect(goalLine?.after).toBe('24px');
    for (const menu of screen.getAllByRole('button', { name: 'Budget item actions' })) {
      expect(widthOf(menu.parentElement)).toBe('24px');
    }
  });

  it('puts a row\'s Planned figure at its column\'s right edge, as its heading is, not in the middle', () => {
    renderGrid();
    for (const button of screen.getAllByRole('button', { name: /^Edit budget for / })) {
      expect(button).toHaveClass('justify-end');
    }
    // No cell keeps its text off the right edge any more: the button's padding is outside it.
    const grid = screen.getByTestId('grid');
    const cells = [...grid.querySelectorAll<HTMLElement>('.rt-Box')].filter((el) => widthOf(el) === '6rem');
    expect(cells.filter((cell) => [...cell.classList].some((name) => /^rt-r-pr-/.test(name)))).toEqual([]);
  });
});
