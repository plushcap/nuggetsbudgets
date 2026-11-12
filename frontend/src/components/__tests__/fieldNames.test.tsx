import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import RadixBudgetItemSelector from '../RadixBudgetItemSelector';
import RadixMerchantSelector from '../RadixMerchantSelector';
import TagSelector from '../TagSelector';
import SingleTagSelector from '../SingleTagSelector';
import RadixIconPicker from '../RadixIconPicker';
import RadixColorPicker from '../RadixColorPicker';
import RadixDatePicker from '../RadixDatePicker';
import CurrencyInput from '../CurrencyInput';

/**
 * The custom pickers show their value on a button, which a <label for> would hide
 * (a label replaces a button's name). They take `aria-labelledby` instead, and are
 * named by their label and then by what they show.
 */
const caption = (text: string) => <span id="caption">{text}</span>;

describe('custom field names', () => {
  it('a budget item selector is named by its label, then its value', () => {
    render(
      <>
        {caption('Budget Item')}
        <RadixBudgetItemSelector aria-labelledby="caption" value={null} onChange={vi.fn()} budgetItems={[]} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Budget Item Select a budget item...' })).toBeInTheDocument();
  });

  it('a merchant selector is named by its label, then its value', () => {
    render(
      <>
        {caption('Merchant')}
        <RadixMerchantSelector
          aria-labelledby="caption"
          value=""
          onChange={vi.fn()}
          onSelectMerchant={vi.fn()}
          merchants={[]}
        />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Merchant Select a merchant...' })).toBeInTheDocument();
  });

  it('a tag selector is named by its label, then its value', () => {
    render(
      <>
        {caption('Tags')}
        <TagSelector aria-labelledby="caption" selectedTags={[]} onChange={vi.fn()} tags={[]} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Tags Select tags...' })).toBeInTheDocument();
  });

  it('a single tag selector is named by its own label', () => {
    render(<SingleTagSelector label="Auto-Tag" selectedTag={null} onChange={vi.fn()} tags={[]} />);
    expect(screen.getByRole('button', { name: 'Auto-Tag Select a tag...' })).toBeInTheDocument();
  });

  it('the icon and color pickers are named by their own labels, then their values', () => {
    render(
      <Theme>
        <RadixIconPicker value="Tag" onChange={vi.fn()} />
        <RadixColorPicker value="#2563eb" onChange={vi.fn()} label="Color" />
      </Theme>,
    );
    expect(screen.getByRole('button', { name: 'Icon Tag' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Color #2563eb' })).toBeInTheDocument();
    expect(screen.getAllByText('Icon')).toHaveLength(1);
  });

  it('a picker named from elsewhere drops its own label', () => {
    render(
      <Theme>
        {caption('Category icon')}
        <RadixIconPicker aria-labelledby="caption" value="Tag" onChange={vi.fn()} />
      </Theme>,
    );
    expect(screen.getByRole('button', { name: 'Category icon Tag' })).toBeInTheDocument();
    expect(screen.queryByText('Icon')).not.toBeInTheDocument();
  });

  it('a date picker is named by its label or its aria-label, then its date', () => {
    render(
      <Theme>
        {caption('Start date')}
        <RadixDatePicker aria-labelledby="caption" value="2026-10-01" onChange={vi.fn()} />
        <RadixDatePicker aria-label="From" placeholder="From" value="" onChange={vi.fn()} />
        <RadixDatePicker aria-label="To" placeholder="To" value="2026-10-31" onChange={vi.fn()} />
      </Theme>,
    );
    expect(screen.getByRole('button', { name: 'Start date October 1st, 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'From' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'To: October 31st, 2026' })).toBeInTheDocument();
  });

  it('a currency input takes an aria-label', () => {
    render(
      <Theme>
        <CurrencyInput aria-label="Minimum amount" value={null} onChange={vi.fn()} />
      </Theme>,
    );
    expect(screen.getByRole('textbox', { name: 'Minimum amount' })).toBeInTheDocument();
  });
});
