import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { toast } from 'react-hot-toast';
import type { BudgetItem, Tag } from '../../services/api';
import { useBudgetItemTags } from '../useBudgetItemTags';

const addTag = vi.fn();
const removeTag = vi.fn();
const tag = (id: number, name: string) => ({ id, uuid: `tag-${id}`, name }) as Tag;
const groceries = tag(1, 'Groceries');
const weekly = tag(2, 'Weekly');
const shared = tag(3, 'Shared');
const itemTags = [groceries, weekly];

vi.mock('../queries', () => ({
  useBudgetItemTagsQuery: (uuid: string | undefined) => ({ data: uuid ? itemTags : undefined }),
  useAddTagToBudgetItemMutation: () => ({ mutateAsync: addTag }),
  useRemoveTagFromBudgetItemMutation: () => ({ mutateAsync: removeTag }),
}));
vi.mock('react-hot-toast', () => ({ toast: { error: vi.fn() } }));

const item = { id: 7, uuid: 'item-7', name: 'Food', transaction_auto_tag_id: 3 } as BudgetItem;
const allTags = [groceries, weekly, shared];

// The income, expense and bill edit pages each held a copy of this.
describe('useBudgetItemTags', () => {
  beforeEach(() => {
    addTag.mockReset().mockResolvedValue({});
    removeTag.mockReset().mockResolvedValue({});
    vi.mocked(toast.error).mockClear();
  });

  it("starts from the item's tags and auto-tag", () => {
    const { result } = renderHook(() => useBudgetItemTags(item, allTags));
    expect(result.current.selectedTags).toEqual(itemTags);
    expect(result.current.autoTag).toEqual(shared);
  });

  it('saves the tags added and removed, then shows the new set', async () => {
    const { result } = renderHook(() => useBudgetItemTags(item, allTags));
    await act(() => result.current.changeTags([groceries, shared]));
    expect(addTag.mock.calls).toEqual([[{ budgetItemUuid: 'item-7', tagId: 3 }]]);
    expect(removeTag.mock.calls).toEqual([[{ budgetItemUuid: 'item-7', tagId: 2 }]]);
    expect(result.current.selectedTags).toEqual([groceries, shared]);
  });

  it("keeps the tags shown and says why when a change isn't saved", async () => {
    // An API failure: the helpers attach the status, and its message is the server's reason.
    addTag.mockRejectedValue(Object.assign(new Error('Tag not found'), { status: 404 }));
    const { result } = renderHook(() => useBudgetItemTags(item, allTags));
    await act(() => result.current.changeTags([...itemTags, shared]));
    expect(result.current.selectedTags).toEqual(itemTags);
    expect(toast.error).toHaveBeenCalledWith('Tag not found');
  });

  it('does nothing before the item has loaded', async () => {
    const { result } = renderHook(() => useBudgetItemTags(null, allTags));
    expect(result.current.selectedTags).toEqual([]);
    expect(result.current.autoTag).toBeNull();
    await act(() => result.current.changeTags([shared]));
    expect(addTag).not.toHaveBeenCalled();
  });
});
