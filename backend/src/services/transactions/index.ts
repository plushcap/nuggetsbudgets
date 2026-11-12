/**
 * The transactions domain: what the /api/transactions and /api/transfer
 * routes do, without HTTP. Each function runs on the request's tenant transaction
 * (getDb(), under RLS), takes no pool, and refuses a request by throwing a
 * {@link TransactionRefusal} that carries the answer for it.
 *
 * - list.ts: the filtered lists, one transaction, its attachments
 * - create.ts: create one, bulk create
 * - update.ts: edit one, bulk edit, delete
 * - splits.ts: split, re-split, unsplit
 * - tags.ts: tag and untag one
 * - transfers.ts: account-to-account transfers and period-balance moves
 * - rules.ts / lookup.ts: the money rules and lookups they share
 * - locks.ts: the order a write of several transactions locks them in (id order), and
 *   the lock a tag or a note on one takes first
 * - rangeDeletion.ts: Delete Transactions (data management): a date range, previewed first
 */
export { TransactionRefusal } from './refusal.js';
export {
  listFilters,
  listPage,
  listTransactions,
  listTransactionsPage,
  getTransactionDetail,
  listTransactionAttachments,
  type ListQuery,
} from './list.js';
export { createTransaction, bulkCreateTransactions } from './create.js';
export { updateTransaction, bulkUpdateTransactions, deleteTransaction } from './update.js';
export { splitTransaction, unsplitTransaction, type SplitInput } from './splits.js';
export { addTransactionTag, removeTransactionTag } from './tags.js';
export { createTransfer, movePeriodBalance, type TransferInput, type PeriodMoveInput } from './transfers.js';
export { lockTransactions, lockTransactionsForReference } from './locks.js';
