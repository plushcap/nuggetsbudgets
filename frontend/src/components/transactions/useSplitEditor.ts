import { useState } from 'react';
import toast from 'react-hot-toast';
import type { TransactionSplitChild, TransactionWithSplits } from '@nuggets/shared';
import { useSplitTransactionMutation, useUnsplitTransactionMutation } from '../../hooks/queries';
import type { UseConfirmationReturn } from '../../hooks/useConfirmation';
import type { SplitItem } from '../../services/api/transactions';
import { toCents } from '../../utils/currency';
import { logger } from '../../utils/logger';
import type { Tag } from '../TagSelector';

interface SplitEditorOptions {
  transaction: TransactionWithSplits;
  confirmAsync: UseConfirmationReturn['confirmAsync'];
  /** Runs a write with the page's buttons waiting (useTransactionEditor). */
  whileSaving: (write: () => Promise<void>) => Promise<void>;
}

/**
 * The detail page's inline split editor: a transaction's splits are re-made one at a time,
 * each a positive amount, a budget item and tags, until they add up to the transaction; and
 * Unsplit.
 *
 * A re-split replaces the splits, so each one's tags go back with it. Splits whose
 * tags the page doesn't have aren't re-split: a production build keeps an answer that
 * didn't match its schema, and one without them would have dropped them.
 */
export function useSplitEditor({ transaction, confirmAsync, whileSaving }: SplitEditorOptions) {
  const splitMutation = useSplitTransactionMutation();
  const unsplitMutation = useUnsplitTransactionMutation();

  const [isEditing, setIsEditing] = useState(false);
  const [pendingSplits, setPendingSplits] = useState<SplitItem[]>([]);
  const [newAmount, setNewAmount] = useState('');
  const [newBudgetItem, setNewBudgetItem] = useState<number | null>(null);
  const [newTags, setNewTags] = useState<Tag[]>([]);

  const resetNewSplit = () => {
    setNewAmount('');
    setNewBudgetItem(null);
    setNewTags([]);
  };

  /** Start editing: the splits there are (none for a transaction not split yet). */
  const start = () => {
    // The split answer's type: a split there may come without its tags.
    const children: TransactionSplitChild[] = transaction.split_children ?? [];
    if (children.some((child) => child.tags === undefined)) {
      toast.error("This transaction's splits came without their tags, so editing them now would drop the tags. Reload the page and try again.");
      return;
    }
    setPendingSplits(
      children.map((child) => ({
        amount: Math.abs(child.amount),
        budget_item_id: child.budget_item_id || null,
        budget_period_id: child.budget_period_id || null,
        tag_ids: (child.tags ?? []).map((t) => t.id),
      })),
    );
    setIsEditing(true);
  };

  /** Add the split being typed to the list. */
  const addSplit = () => {
    // Above zero, which NaN (text the box can't read) isn't.
    if (!(parseFloat(newAmount) > 0)) {
      toast.error('Please enter a valid amount');
      return;
    }
    setPendingSplits([
      ...pendingSplits,
      {
        amount: parseFloat(newAmount),
        budget_item_id: newBudgetItem,
        budget_period_id: transaction.budget_period_id || null,
        tag_ids: newTags.map((t) => t.id),
      },
    ]);
    resetNewSplit();
  };

  const removeSplit = (index: number) => {
    setPendingSplits(pendingSplits.filter((_, i) => i !== index));
  };

  // Added in whole cents: the splits must match the amount to the cent.
  const totalCents = pendingSplits.reduce((sum, split) => sum + toCents(split.amount), 0);
  const remainingCents = Math.abs(toCents(transaction.amount || 0)) - totalCents;
  const canSave = remainingCents === 0 && pendingSplits.length >= 2;

  /** Re-split the transaction into the listed splits, each signed as the transaction is. */
  const save = async () => {
    if (!canSave) return;
    // The splits are entered positive; the server takes them signed.
    const signedSplits = pendingSplits.map((split) => ({
      ...split,
      amount: transaction.amount < 0 ? -Math.abs(split.amount) : Math.abs(split.amount),
    }));
    try {
      await splitMutation.mutateAsync([transaction.uuid, signedSplits]);
      setPendingSplits([]);
      setIsEditing(false);
      toast.success('Transaction split successfully');
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      toast.error(message || 'Failed to split transaction');
    }
  };

  const cancel = () => {
    setIsEditing(false);
    setPendingSplits([]);
    resetNewSplit();
  };

  /** Put the transaction back together, once confirmed. */
  const unsplit = async () => {
    const confirmed = await confirmAsync({
      title: 'Unsplit Transaction',
      message:
        'This will remove all splits and restore the original transaction. The original budget assignment will need to be reassigned. Continue?',
      variant: 'warning',
      confirmText: 'Unsplit',
      cancelText: 'Cancel',
    });
    if (!confirmed) return;

    await whileSaving(async () => {
      try {
        await unsplitMutation.mutateAsync(transaction.uuid);
        toast.success('Transaction unsplit successfully');
      } catch (error) {
        logger.error({ err: error, uuid: transaction.uuid }, 'Failed to unsplit transaction');
        toast.error('Failed to unsplit transaction');
      }
    });
  };

  return {
    isEditing,
    pendingSplits,
    newSplit: { amount: newAmount, budgetItem: newBudgetItem, tags: newTags },
    setNewAmount,
    setNewBudgetItem,
    setNewTags,
    start,
    addSplit,
    removeSplit,
    totalCents,
    remainingCents,
    canSave,
    save,
    cancel,
    unsplit,
  };
}

export type SplitEditor = ReturnType<typeof useSplitEditor>;
