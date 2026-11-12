import type React from 'react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { formatMoney } from '@nuggets/shared';
import type { BudgetPeriodItem } from '../../services/api';
import { useUpdateBudgetAmountMutation } from '../../hooks/queries';
import { useKeyedDebounce } from '../../hooks/useKeyedDebounce';
import { apiErrorMessage } from '../../utils/errors';
import { logger } from '../../utils/logger';

/** One item's inline budget edit, as a row's amount field drives it. */
export interface InlineBudgetEdit {
  /** The item's budget: an edit not saved yet, else the server's. */
  budgetOf: (item: BudgetPeriodItem) => number;
  isEditing: (item: BudgetPeriodItem) => boolean;
  /** The text in the item's open field. */
  editingValue: (item: BudgetPeriodItem) => string;
  startEdit: (item: BudgetPeriodItem) => void;
  change: (item: BudgetPeriodItem, e: React.ChangeEvent<HTMLInputElement>) => void;
  keyDown: (item: BudgetPeriodItem, e: React.KeyboardEvent) => void;
  blur: (item: BudgetPeriodItem) => void;
}

const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...record };
  delete next[key];
  return next;
};

/**
 * The Budget page's inline budget edits: the open fields, and the amounts entered but not saved
 * yet (`pending`, which the totals include at once). A save goes 500 ms after the item's last
 * change, and one still waiting when the page closes goes then. A refused save is a toast with
 * the server's reason, and the item shows what the server still holds.
 */
export function useInlineBudgetEdit(): InlineBudgetEdit & { pending: Record<string, number> } {
  const updateBudgetAmount = useUpdateBudgetAmountMutation();
  const { schedule } = useKeyedDebounce(500);
  const [pending, setPending] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<Record<string, string>>({});

  const budgetOf = (item: BudgetPeriodItem): number =>
    (pending[item.uuid] ?? parseFloat(String(item.calculated_budget))) || 0;

  const save = (itemUuid: string, amount: number) => {
    setPending((prev) => ({ ...prev, [itemUuid]: amount }));
    schedule(itemUuid, async () => {
      try {
        await updateBudgetAmount.mutateAsync([itemUuid, amount, `Budget updated to ${formatMoney(amount)} via UI`]);
      } catch (err) {
        logger.error({ err }, 'Failed to update budget');
        toast.error(apiErrorMessage(err, `Couldn't save the budget amount`));
      } finally {
        // Saved, the refetched item has it; refused, the server's amount shows again.
        setPending((prev) => without(prev, itemUuid));
      }
    });
  };

  const close = (itemUuid: string) => setEditing((prev) => without(prev, itemUuid));

  const commit = (itemUuid: string) => {
    const value = editing[itemUuid];
    if (value !== undefined) save(itemUuid, parseFloat(value) || 0);
    close(itemUuid);
  };

  return {
    pending,
    budgetOf,
    isEditing: (item) => editing[item.uuid] !== undefined,
    editingValue: (item) => editing[item.uuid] ?? '',
    startEdit: (item) => setEditing((prev) => ({ ...prev, [item.uuid]: budgetOf(item).toString() })),
    change: (item, e) => {
      const value = e.target.value;
      const withoutCommas = value.replace(/,/g, '');
      // Empty and a lone minus are allowed while typing; otherwise a number with at most
      // two decimals, with or without thousands commas.
      if (withoutCommas !== '' && withoutCommas !== '-' && !/^-?(\d{1,3}(,\d{3})*|\d+)(\.\d{0,2})?$/.test(value)) return;
      setEditing((prev) => ({ ...prev, [item.uuid]: withoutCommas }));
    },
    keyDown: (item, e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit(item.uuid);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close(item.uuid);
      }
    },
    // An empty field or a lone minus saves as 0, and a trailing point goes.
    blur: (item) => commit(item.uuid),
  };
}
