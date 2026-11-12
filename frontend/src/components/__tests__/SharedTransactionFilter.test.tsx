import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import SharedTransactionFilter, { type TransactionFilters } from '../SharedTransactionFilter';

/**
 * The filter bar shows what is typed at once and tells the page 300ms after the
 * last change; filters the page sets (a reset, a link) replace what is shown.
 */
const bar = (filters: TransactionFilters, onFiltersChange = vi.fn()) => (
  <Theme>
    <SharedTransactionFilter filters={filters} onFiltersChange={onFiltersChange} budgetPeriods={[]} budgetItems={[]} />
  </Theme>
);
const search = () => screen.getByPlaceholderText('Search transactions...');

describe('SharedTransactionFilter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows a change at once and reports it after 300ms of quiet', () => {
    const onFiltersChange = vi.fn();
    render(bar({ search: '' }, onFiltersChange));
    fireEvent.change(search(), { target: { value: 'gro' } });
    fireEvent.change(search(), { target: { value: 'groceries' } });
    expect(search()).toHaveValue('groceries');
    act(() => vi.advanceTimersByTime(299));
    expect(onFiltersChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onFiltersChange).toHaveBeenCalledTimes(1);
    expect(onFiltersChange).toHaveBeenCalledWith({ search: 'groceries' });
  });

  // Unreadable text is null to onChange, which the bar read as no bound and dropped the
  // minimum, showing every amount.
  it("keeps the amount bound it applied when the box's text isn't an amount, and says so", () => {
    const onFiltersChange = vi.fn();
    render(bar({ amountMin: 12 }, onFiltersChange));
    fireEvent.click(screen.getByRole('button', { name: /^filters/i }));
    const min = screen.getByRole('textbox', { name: 'Minimum amount' });
    act(() => min.focus());
    fireEvent.change(min, { target: { value: '1o' } });
    act(() => vi.advanceTimersByTime(1000));
    expect(onFiltersChange).not.toHaveBeenCalled();
    const kept = 'Not an amount: enter it like 1,234.56. The filter still uses $12.00.';
    expect(screen.getByText(kept)).toBeInTheDocument();
    // One message: the box's own hint is left out.
    expect(min).toHaveAccessibleDescription(kept);
    expect(screen.queryByText(/with at most two decimals/)).not.toBeInTheDocument();
    // It stays in sight, flagged, once the box loses focus.
    act(() => min.blur());
    expect(min).toHaveValue('1o');
    expect(min).toHaveAttribute('aria-invalid', 'true');

    // Read, it changes the filter; the note goes.
    act(() => min.focus());
    fireEvent.change(min, { target: { value: '10' } });
    act(() => vi.advanceTimersByTime(300));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ amountMin: 10 });
    expect(screen.queryByText(/the filter still uses/i)).not.toBeInTheDocument();
  });

  it('applies no bound for an unreadable box that had none, and clearing the filters empties it', () => {
    const onFiltersChange = vi.fn();
    render(bar({ search: 'rent' }, onFiltersChange));
    fireEvent.click(screen.getByRole('button', { name: /^filters/i }));
    const max = screen.getByRole('textbox', { name: 'Maximum amount' });
    act(() => max.focus());
    fireEvent.change(max, { target: { value: '5k' } });
    act(() => max.blur());
    act(() => vi.advanceTimersByTime(1000));
    expect(onFiltersChange).not.toHaveBeenCalled();
    expect(screen.getByText("Not an amount: enter it like 1,234.56. The filter doesn't use it until it is one.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(screen.getByRole('textbox', { name: 'Maximum amount' })).toHaveValue('');
    expect(screen.queryByText(/the filter doesn't use it/i)).not.toBeInTheDocument();
  });

  // The bar's own message ("Not an amount… the filter still uses …") showed from the `(1`
  // of an accounting negative until its `)`, as the box's hint did.
  it('waits to say an accounting negative being typed is not an amount, and says so if left unclosed', () => {
    const onFiltersChange = vi.fn();
    render(bar({ amountMin: -5 }, onFiltersChange));
    fireEvent.click(screen.getByRole('button', { name: /^filters/i }));
    const min = screen.getByRole('textbox', { name: 'Minimum amount' });
    act(() => min.focus());
    fireEvent.change(min, { target: { value: '(12' } });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText(/the filter still uses/i)).not.toBeInTheDocument();
    expect(min).not.toHaveAttribute('aria-invalid');
    // The bound it had is kept meanwhile.
    expect(onFiltersChange).not.toHaveBeenCalled();
    // Left without its `)`, it says so.
    act(() => min.blur());
    expect(screen.getByText('Not an amount: enter it like 1,234.56. The filter still uses -$5.00.')).toBeInTheDocument();
    // Closed, it is read.
    act(() => min.focus());
    fireEvent.change(min, { target: { value: '(12)' } });
    act(() => vi.advanceTimersByTime(300));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ amountMin: -12 });
  });

  // So did a grouped number, from the `1 2` of 1 234,56 until its group of three.
  it('waits to say a grouped number being typed is not an amount, and says so if left unfinished', () => {
    const onFiltersChange = vi.fn();
    render(bar({ amountMax: 50 }, onFiltersChange));
    fireEvent.click(screen.getByRole('button', { name: /^filters/i }));
    const max = screen.getByRole('textbox', { name: 'Maximum amount' });
    act(() => max.focus());
    for (const typed of ['1', '1 ', '1 2', '1 23']) {
      fireEvent.change(max, { target: { value: typed } });
      expect(screen.queryByText(/the filter still uses/i), typed).not.toBeInTheDocument();
      expect(max, typed).not.toHaveAttribute('aria-invalid');
    }
    act(() => vi.advanceTimersByTime(1000));
    // The 1 typed first was read, and applied; the bound is kept while the rest is typed.
    expect(onFiltersChange).toHaveBeenCalledTimes(1);
    expect(onFiltersChange).toHaveBeenLastCalledWith({ amountMax: 1 });
    act(() => max.blur());
    expect(screen.getByText('Not an amount: enter it like 1,234.56. The filter still uses $1.00.')).toBeInTheDocument();
    act(() => max.focus());
    fireEvent.change(max, { target: { value: '1 234,56' } });
    act(() => vi.advanceTimersByTime(300));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ amountMax: 1234.56 });
    expect(screen.queryByText(/the filter still uses/i)).not.toBeInTheDocument();
  });

  it('shows filters the page sets in place of what was typed', () => {
    const { rerender } = render(bar({ search: '' }));
    fireEvent.change(search(), { target: { value: 'typed' } });
    rerender(bar({ search: 'from the page' }));
    expect(search()).toHaveValue('from the page');
  });
});
