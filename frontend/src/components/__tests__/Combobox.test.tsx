import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Text, Theme } from '@radix-ui/themes';
import Combobox, { type ComboboxOption } from '../Combobox';

/**
 * The shared picker, by keyboard, the way the WAI-ARIA combobox pattern has it:
 * focus stays in the search box, aria-activedescendant names the highlighted option,
 * and closing puts the focus back on the trigger.
 */

const FRUIT = ['Apple', 'Banana', 'Cherry'];

function Harness({
  onPick = vi.fn(),
  multi = false,
  error,
  disabled = false,
  hiddenCount,
}: {
  onPick?: (name: string) => void;
  multi?: boolean;
  error?: string;
  disabled?: boolean;
  hiddenCount?: number;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const options: ComboboxOption[] = FRUIT.filter((f) => f.toLowerCase().includes(search.toLowerCase())).map((f) => ({
    key: f,
    content: <Text>{f}</Text>,
    selected: chosen.includes(f),
    keepOpen: multi,
    onSelect: () => {
      onPick(f);
      setChosen((c) => (multi ? (c.includes(f) ? c.filter((x) => x !== f) : [...c, f]) : [f]));
    },
  }));
  return (
    <Theme>
      <span id="fruit-label">Fruit</span>
      <Combobox
        aria-labelledby="fruit-label"
        aria-describedby="fruit-hint"
        valueLabel={chosen.length ? chosen.join(', ') : 'Pick a fruit'}
        triggerContent={<Text>{chosen.join(', ') || 'Pick a fruit'}</Text>}
        search={search}
        onSearchChange={setSearch}
        searchLabel="Search fruit"
        listLabel="Fruit"
        options={options}
        hiddenCount={hiddenCount}
        emptyMessage="No fruit"
        multiselectable={multi}
        error={error}
        disabled={disabled}
      />
      <span id="fruit-hint">Seasonal</span>
      <button type="button">After</button>
    </Theme>
  );
}

const trigger = (name = 'Fruit Pick a fruit') => screen.getByRole('button', { name });
const searchBox = () => screen.getByRole('combobox', { name: 'Search fruit' });
const active = () => {
  const id = searchBox().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.textContent : null;
};

describe('Combobox', () => {
  it('names its popup by the field, apart from the list', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    expect(screen.getByRole('dialog', { name: 'Fruit' })).toContainElement(screen.getByRole('listbox', { name: 'Fruit' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-labelledby', 'fruit-label');
  });

  it('is a button named by its label then its value, read with its hint', () => {
    render(<Harness />);
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveAccessibleDescription('Seasonal');
  });

  it.each([['{Enter}'], [' '], ['{ArrowDown}']])('opens from the trigger with %s, focus in the search box', async (key) => {
    render(<Harness />);
    trigger().focus();
    await userEvent.keyboard(key);
    expect(searchBox()).toHaveFocus();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox', { name: 'Fruit' });
    expect(searchBox()).toHaveAttribute('aria-controls', listbox.id);
    expect(searchBox()).toHaveAttribute('aria-expanded', 'true');
    expect(searchBox()).toHaveAttribute('aria-autocomplete', 'list');
    expect(searchBox()).not.toHaveAttribute('aria-activedescendant');
  });

  it('moves the highlight with the arrows through aria-activedescendant, and stops at the ends', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    await userEvent.keyboard('{ArrowDown}');
    expect(active()).toBe('Apple');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(active()).toBe('Cherry');
    await userEvent.keyboard('{ArrowUp}');
    expect(active()).toBe('Banana');
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(active()).toBe('Apple');
    expect(searchBox()).toHaveFocus();
  });

  it('goes to the last option on ArrowUp from nothing', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    await userEvent.keyboard('{ArrowUp}');
    expect(active()).toBe('Cherry');
  });

  it('chooses the highlighted option on Enter, closes, and returns the focus to the trigger', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await userEvent.click(trigger());
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledWith('Banana');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger('Fruit Banana')).toHaveFocus();
  });

  it('chooses nothing on Enter with nothing highlighted', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await userEvent.click(trigger());
    await userEvent.keyboard('{Enter}');
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('clears the highlight when the search changes, and filters', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.type(searchBox(), 'an');
    expect(active()).toBeNull();
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Banana']);
    expect(screen.getByRole('status')).toHaveTextContent('1 result');
  });

  it('closes on Escape without choosing, focus back on the trigger, and starts over next time', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await userEvent.click(trigger());
    await userEvent.type(searchBox(), 'ch');
    await userEvent.keyboard('{ArrowDown}{Escape}');
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(searchBox()).toHaveValue('');
  });

  it('closes on Tab and Alt+ArrowUp, back on the trigger', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    await userEvent.tab();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();

    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('marks the chosen options with aria-selected, and stays open while a multi-select toggles', async () => {
    render(<Harness multi />);
    await userEvent.click(trigger());
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
    await userEvent.keyboard('{ArrowDown}{Enter}{ArrowDown}{ArrowDown}{Enter}');
    expect(screen.getByRole('option', { name: 'Apple' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Banana' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('option', { name: 'Cherry' })).toHaveAttribute('aria-selected', 'true');
    expect(searchBox()).toHaveFocus();
    // Enter again on Cherry un-chooses it.
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('option', { name: 'Cherry' })).toHaveAttribute('aria-selected', 'false');
  });

  it('chooses with the mouse, without taking the focus from the search box first', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole('option', { name: 'Cherry' }));
    expect(onPick).toHaveBeenCalledWith('Cherry');
  });

  it('says how many matches it left out', async () => {
    render(<Harness hiddenCount={7} />);
    await userEvent.click(trigger());
    expect(screen.getByText('7 more — type to narrow the list.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('10 results');
  });

  it('shows the empty message when nothing matches', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    await userEvent.type(searchBox(), 'zz');
    expect(screen.getByText('No fruit')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('No results');
  });

  it('reads an error after the name, before the hint', () => {
    render(<Harness error="Pick one" />);
    expect(trigger()).toHaveAccessibleDescription('Pick one Seasonal');
  });

  it("can't be opened while disabled", async () => {
    render(<Harness disabled />);
    expect(trigger()).toBeDisabled();
    await userEvent.click(trigger());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
