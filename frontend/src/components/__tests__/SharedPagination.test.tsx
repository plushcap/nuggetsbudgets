import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import SharedPagination from '../SharedPagination';

/**
 * The pagination footer's "Rows per page" picker: offered only with its sizes and a
 * handler, and a new size moves to the page that holds the first row shown before.
 */

// jsdom lacks the pointer-capture APIs Radix Select calls.
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

const SIZES = [25, 50, 100, 200] as const;

const renderFooter = (props: { currentPage: number; itemsPerPage: number; totalItems: number; withPicker?: boolean }) => {
  const onPageChange = vi.fn();
  const onItemsPerPageChange = vi.fn();
  render(
    <Theme>
      <SharedPagination
        currentPage={props.currentPage}
        totalPages={Math.ceil(props.totalItems / props.itemsPerPage)}
        totalItems={props.totalItems}
        itemsPerPage={props.itemsPerPage}
        onPageChange={onPageChange}
        itemLabel="transactions"
        {...(props.withPicker === false ? {} : { pageSizeOptions: SIZES, onItemsPerPageChange })}
      />
    </Theme>,
  );
  return { onPageChange, onItemsPerPageChange };
};

const choose = async (size: string) => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: 'Rows per page' }));
  await user.click(await screen.findByRole('option', { name: size }));
};

describe('SharedPagination rows per page', () => {
  it('has no picker without sizes to offer', () => {
    renderFooter({ currentPage: 1, itemsPerPage: 20, totalItems: 90, withPicker: false });
    expect(screen.queryByRole('combobox', { name: 'Rows per page' })).not.toBeInTheDocument();
  });

  it('shows the size in use, and offers each size', async () => {
    renderFooter({ currentPage: 1, itemsPerPage: 50, totalItems: 300 });
    const picker = screen.getByRole('combobox', { name: 'Rows per page' });
    expect(picker).toHaveTextContent('50');
    await userEvent.setup().click(picker);
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['25', '50', '100', '200']);
  });

  it.each([
    // [page, size, new size, page holding the first row shown]
    [5, 25, '200', 1], // row 101 of 25s is on page 1 of 200s
    [2, 100, '25', 5], // row 101 of 100s is on page 5 of 25s
    [4, 50, '100', 2], // row 151 is on page 2 of 100s
    [3, 200, '50', 9], // row 401 is on page 9 of 50s
    [1, 25, '100', 1],
  ])('on page %i of %i, choosing %s moves to page %i', async (page, size, chosen, expected) => {
    const { onPageChange, onItemsPerPageChange } = renderFooter({ currentPage: page, itemsPerPage: size, totalItems: 1000 });
    await choose(chosen);
    expect(onPageChange).toHaveBeenCalledWith(expected);
    expect(onItemsPerPageChange).toHaveBeenCalledWith(Number(chosen));
  });

  it('changes nothing when the size in use is chosen again', async () => {
    const { onPageChange, onItemsPerPageChange } = renderFooter({ currentPage: 3, itemsPerPage: 50, totalItems: 1000 });
    await choose('50');
    expect(onPageChange).not.toHaveBeenCalled();
    expect(onItemsPerPageChange).not.toHaveBeenCalled();
  });
});
