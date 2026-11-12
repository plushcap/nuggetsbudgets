import { toast } from 'react-hot-toast';
import type { BudgetItem, Tag } from '../services/api';
import { useAddTagToBudgetItemMutation, useBudgetItemTagsQuery, useRemoveTagFromBudgetItemMutation } from './queries';
import { useSeededState } from './useSeededState';
import { EMPTY_LIST } from '../utils/emptyList';
import { apiErrorMessage } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * A budget item's tags and auto-tag as its edit page edits them (the income,
 * expense and bill pages held identical copies). The tags start from the item's and follow
 * them when they reload; a change is saved at once, tag by tag. The auto-tag starts from the
 * item's and is saved with the form.
 *
 * `item` is the loaded item (null until it loads); `tags` is the ledger's tag list.
 */
export function useBudgetItemTags(item: BudgetItem | null, tags: Tag[]) {
  const uuid = item?.uuid;
  const { data: itemTags = EMPTY_LIST } = useBudgetItemTagsQuery(uuid);
  const addTag = useAddTagToBudgetItemMutation();
  const removeTag = useRemoveTagFromBudgetItemMutation();

  // The item's tags as the query has them, and its auto-tag once the item loads (both
  // again when the data changes).
  const [selectedTags, setSelectedTags] = useSeededState<Tag[]>(() => itemTags, [itemTags]);
  const [autoTag, setAutoTag] = useSeededState<Tag | null>(
    (current) => (item ? tags.find((tag) => tag.id === item.transaction_auto_tag_id) ?? null : (current ?? null)),
    [item, tags],
  );

  const changeTags = async (newTags: Tag[]) => {
    if (!uuid) return;
    const currentIds = new Set(selectedTags.map((t) => t.id));
    const newIds = new Set(newTags.map((t) => t.id));
    try {
      for (const tag of newTags.filter((t) => !currentIds.has(t.id))) {
        await addTag.mutateAsync({ budgetItemUuid: uuid, tagId: tag.id });
      }
      for (const tag of selectedTags.filter((t) => !newIds.has(t.id))) {
        await removeTag.mutateAsync({ budgetItemUuid: uuid, tagId: tag.id });
      }
      setSelectedTags(newTags);
    } catch (err) {
      // What was saved before the failure comes back with the item's tags (each change
      // refreshes them).
      logger.error({ err, uuid }, 'Failed to update tags');
      toast.error(apiErrorMessage(err, 'Failed to update tags'));
    }
  };

  return { selectedTags, changeTags, autoTag, setAutoTag };
}
