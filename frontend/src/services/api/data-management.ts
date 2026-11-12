import {
  transactionRangeDeleteResponseSchema,
  transactionRangePreviewResponseSchema,
  type TransactionRangeDeleteResult,
  type TransactionRangePreview,
} from '@nuggets/shared';
import { apiPost } from './base';
import { parseAnswer } from './parseAnswer';

/** Which transactions to delete: a date range, and whether to keep those in a budget period. */
export interface DeleteTransactionsCriteria {
  dateFrom: string;
  dateTo: string;
  excludeBudgetPeriod: boolean;
}

export interface DeleteTransactionsRequest extends DeleteTransactionsCriteria {
  createBackup: boolean;
  /**
   * The preview's selectionKey: the server deletes the transactions that preview found, or,
   * when the range's are no longer those, none (409 PREVIEW_OUTDATED).
   */
  selectionKey: string;
}

/** What a preview found; `selectionKey` names the set, for the deletion to send back. */
export type DeleteTransactionsPreview = TransactionRangePreview;
/** What the deletion removed, and the backup it made first, if asked (`backupFileName`). */
export type DeleteTransactionsResponse = TransactionRangeDeleteResult;

/**
 * Preview transaction deletion without making changes
 */
export const previewDeleteTransactions = async (request: DeleteTransactionsCriteria): Promise<DeleteTransactionsPreview> =>
  parseAnswer(
    transactionRangePreviewResponseSchema,
    await apiPost<unknown>('/data-management/preview-delete-transactions', request),
    'deletion preview'
  );

/**
 * Delete the transactions a preview found, with an optional backup first
 */
export const deleteTransactions = async (request: DeleteTransactionsRequest): Promise<DeleteTransactionsResponse> =>
  parseAnswer(transactionRangeDeleteResponseSchema, await apiPost<unknown>('/data-management/delete-transactions', request), 'deletion');
