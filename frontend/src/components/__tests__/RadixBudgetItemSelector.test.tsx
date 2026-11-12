import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import type { BudgetItem } from '../../services/api';
import RadixBudgetItemSelector from '../RadixBudgetItemSelector';

const item = (id: number, name: string, type: string) =>
  ({ id, uuid: `bi-${id}`, name, type, icon: 'Tag', color: 'gray', status: 'active' }) as unknown as BudgetItem;

const items = [
  item(1, 'Rent', 'Fixed'),
  item(2, 'Groceries', 'Monthly'),
  item(3, 'Car repair', 'Envelope'),
  item(4, 'Dining', 'Monthly'),
];

function Harness({ start = null, onChange = vi.fn() }: { start?: number | null; onChange?: (v: number | null) => void }) {
  const [value, setValue] = useState<number | null>(start);
  return (
    <Theme>
      <RadixBudgetItemSelector
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        budgetItems={items}
      />
    </Theme>
  );
}

const optionNames = () =>
  within(screen.getByRole('listbox', { name: 'Budget items' }))
    .getAllByRole('option')
    .map((o) => o.textContent?.trim());

describe('RadixBudgetItemSelector', () => {
  it('lists every item by type then name, Monthly first, after a "No budget item" option', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Select a budget item...' }));
    const names = optionNames();
    expect(names[0]).toContain('No budget item');
    expect(names.slice(1).map((n) => n?.replace(/\s+/g, ' '))).toEqual([
      expect.stringContaining('Dining'),
      expect.stringContaining('Groceries'),
      expect.stringContaining('Rent'),
      expect.stringContaining('Car repair'),
    ]);
  });

  it('matches every word of the search against the name and type', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Select a budget item...' }));
    await userEvent.type(screen.getByRole('combobox', { name: 'Search budget items' }), 'monthly gro');
    expect(optionNames().slice(1)).toEqual([expect.stringContaining('Groceries')]);
  });

  it('arrows down to "No budget item" first, and choosing it clears the choice', async () => {
    const onChange = vi.fn();
    render(<Harness start={1} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Selected: Fixed: Rent' }));
    await userEvent.type(screen.getByRole('combobox', { name: 'Search budget items' }), 'dining');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(4);

    await userEvent.click(screen.getByRole('button', { name: 'Selected: Monthly: Dining' }));
    // Enter with nothing highlighted chooses nothing.
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('says there are none, not "no matches", with no items and no search', async () => {
    render(
      <Theme>
        <RadixBudgetItemSelector value={null} onChange={vi.fn()} budgetItems={[]} />
      </Theme>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Select a budget item...' }));
    expect(screen.getByText('No budget items yet')).toBeInTheDocument();
  });
});
