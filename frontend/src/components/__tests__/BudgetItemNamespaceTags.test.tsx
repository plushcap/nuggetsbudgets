import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import BudgetItemNamespaceTags from '../BudgetItemNamespaceTags';

/**
 * Each report namespace's dropdown shows the item's tag in it: from the item's
 * taggings when they arrive, and again when a newer answer arrives.
 */
const state = vi.hoisted(() => ({
  itemTags: undefined as { uuid: string; report_root_uuid: string | null }[] | undefined,
}));

vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  useReportRootsQuery: () => ({ data: [{ id: 10, uuid: 'root-10', name: 'Spending' }], isLoading: false }),
  useTagsQuery: () => ({
    data: [
      { id: 10, uuid: 'root-10', name: 'Spending', parent_id: null, is_report_root: true, hierarchy_path: 'Spending' },
      { id: 11, uuid: 'tag-11', name: 'Food', parent_id: 10, hierarchy_path: 'Spending/Food' },
      { id: 12, uuid: 'tag-12', name: 'Fun', parent_id: 10, hierarchy_path: 'Spending/Fun' },
    ],
    isLoading: false,
  }),
  useBudgetItemTagsQuery: () => ({ data: state.itemTags, refetch: vi.fn() }),
}));

const tags = (uuid: string | null) => (uuid ? [{ uuid, report_root_uuid: 'root-10' }] : []);
const ui = (budgetItemUuid: string | null) => (
  <Theme>
    <BudgetItemNamespaceTags budgetItemUuid={budgetItemUuid} />
  </Theme>
);
const dropdown = () => screen.getByRole('combobox', { name: 'Spending' });

describe('BudgetItemNamespaceTags', () => {
  beforeEach(() => {
    state.itemTags = undefined;
  });

  it("shows the item's tag once its taggings arrive, and a newer answer's", () => {
    const { rerender } = render(ui('bi-1'));
    expect(dropdown()).toHaveValue('');
    state.itemTags = tags('tag-11');
    rerender(ui('bi-1'));
    expect(dropdown()).toHaveValue('tag-11');
    state.itemTags = tags('tag-12');
    rerender(ui('bi-1'));
    expect(dropdown()).toHaveValue('tag-12');
  });

  it('keeps what is shown while a refetch is still loading', () => {
    state.itemTags = tags('tag-11');
    const { rerender } = render(ui('bi-1'));
    state.itemTags = undefined;
    rerender(ui('bi-1'));
    expect(dropdown()).toHaveValue('tag-11');
  });

  it('asks to save a new item first', () => {
    render(ui(null));
    expect(screen.getByText(/Save this item first/)).toBeInTheDocument();
  });
});
