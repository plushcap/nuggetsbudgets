import { toast } from 'react-hot-toast';
import type { BudgetItem, BudgetPeriod, Tag, Transaction, User } from '../services/api';
import { isSessionExpiredError } from '../services/api/base';
import {
  useApplyTagToTransactionMutation,
  useRemoveTagFromTransactionMutation,
  useUpdateTransactionMutation,
} from './queries';
import { logger } from '../utils/logger';
import { transactionReviewStatus } from '@nuggets/shared';

/** The names the success messages show; ids that aren't found read as "None". */
export interface QuickActionContext {
  budgetPeriods: BudgetPeriod[];
  budgetItems: BudgetItem[];
  users: User[];
  tags: Tag[];
}

/** Each action resolves to whether it succeeded; a failure has already been shown to the user. */
export interface TransactionQuickActions {
  toggleReviewed: (transaction: Transaction) => Promise<boolean>;
  changeBudgetPeriod: (transaction: Transaction, budgetPeriodId: number | null) => Promise<boolean>;
  changeBudgetItem: (transaction: Transaction, budgetItemId: number | null) => Promise<boolean>;
  assignUser: (transaction: Transaction, userId: number | null) => Promise<boolean>;
  applyTag: (transaction: Transaction, tagUuid: string) => Promise<boolean>;
  removeTag: (transaction: Transaction, tagUuid: string) => Promise<boolean>;
}

/**
 * The transaction table's quick actions (context menu and mobile sheet), the same on every
 * page. Each one saves, then says what happened: a toast on success, and the server's reason
 * on failure (e.g. a split transaction refusing a budget item). The mutations refresh every
 * screen derived from transactions, so callers needn't refetch.
 */
export function useTransactionQuickActions(context: QuickActionContext, onUpdated?: () => void): TransactionQuickActions {
  const updateTransaction = useUpdateTransactionMutation();
  const applyTagMutation = useApplyTagToTransactionMutation();
  const removeTagMutation = useRemoveTagFromTransactionMutation();

  const run = async (
    work: () => Promise<unknown>,
    success: () => string,
    failure: string,
    logContext: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      await work();
    } catch (error) {
      // An expired session has its own message (AuthContext); don't add a second.
      if (isSessionExpiredError(error)) return false;
      logger.error({ err: error, ...logContext }, failure);
      toast.error(error instanceof Error && error.message ? error.message : failure);
      return false;
    }
    toast.success(success());
    onUpdated?.();
    return true;
  };

  return {
    toggleReviewed: (transaction) => {
      const status = transaction.review_status === transactionReviewStatus.enum.reviewed ? 'needs review' : 'reviewed';
      return run(
        () => updateTransaction.mutateAsync({ uuid: transaction.uuid, data: { review_status: status } }),
        () => `Transaction marked as ${status}`,
        'Failed to update review status',
        { transactionUuid: transaction.uuid },
      );
    },
    changeBudgetPeriod: (transaction, budgetPeriodId) =>
      run(
        () => updateTransaction.mutateAsync({ uuid: transaction.uuid, data: { budget_period_id: budgetPeriodId } }),
        () => `Budget period updated to ${context.budgetPeriods.find((p) => p.id === budgetPeriodId)?.name ?? 'None'}`,
        'Failed to update budget period',
        { transactionUuid: transaction.uuid, budgetPeriodId },
      ),
    changeBudgetItem: (transaction, budgetItemId) =>
      run(
        () => updateTransaction.mutateAsync({ uuid: transaction.uuid, data: { budget_item_id: budgetItemId } }),
        () => `Budget item updated to ${context.budgetItems.find((i) => i.id === budgetItemId)?.name ?? 'None'}`,
        'Failed to update budget item',
        { transactionUuid: transaction.uuid, budgetItemId },
      ),
    // `assigned_to` is the field the API reads; null unassigns.
    assignUser: (transaction, userId) =>
      run(
        () => updateTransaction.mutateAsync({ uuid: transaction.uuid, data: { assigned_to: userId } }),
        () => {
          const user = userId === null ? undefined : context.users.find((u) => u.id === userId);
          return userId === null ? 'Transaction unassigned' : `Transaction assigned to ${user?.first_name ?? 'user'}`;
        },
        'Failed to assign user',
        { transactionUuid: transaction.uuid, userId },
      ),
    applyTag: (transaction, tagUuid) =>
      run(
        () => applyTagMutation.mutateAsync([transaction.uuid, tagUuid]),
        () => {
          const tag = context.tags.find((t) => t.uuid === tagUuid);
          return tag ? `Tag "${tag.name}" applied` : 'Tag applied';
        },
        'Failed to apply tag',
        { transactionUuid: transaction.uuid, tagUuid },
      ),
    removeTag: (transaction, tagUuid) =>
      run(
        () => removeTagMutation.mutateAsync([transaction.uuid, tagUuid]),
        () => 'Tag removed',
        'Failed to remove tag',
        { transactionUuid: transaction.uuid, tagUuid },
      ),
  };
}
