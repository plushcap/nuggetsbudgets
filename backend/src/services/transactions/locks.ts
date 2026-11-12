import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { DB } from '../../db/schema.generated.js';
import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { errorCode } from '../../utils/errors.js';
import { ControlPlaneError } from '../controlPlaneErrors.js';

const logger = createLogger({ service: 'TransactionLocks' });

/**
 * The order writes take transactions' row locks in. Two transactions that lock the
 * same rows in different orders can each hold one the other waits for: Postgres then fails
 * one of them (40P01, "deadlock detected"), which answers a 500. Delete Transactions (data
 * management) locks a whole range at once, the two sides of its transfers and their splits
 * included, so every write of several transactions locks them first, in id order, and only
 * then writes:
 *
 *   - an edit of one transaction locks it and a transfer's other side, in id order, FOR
 *     UPDATE (updateTransaction: a split of it made meanwhile waits, and checks its splits
 *     against the amount the edit leaves); an edit of a transfer moves both sides, and
 *     deleting one deletes both, with their splits (deleteTransaction);
 *   - a split or an unsplit locks the parent, then the splits it deletes (a split's id is
 *     always above its parent's, which it's inserted after);
 *   - a bulk edit, a merchant merge or a rule applied, a budget item merged into another,
 *     and a budget period created or deleted lock the rows they change;
 *   - a bank sync locks every row of the account it can write, in one statement, before it
 *     writes them one by one in the bank's order (TransactionImporter): each import's row
 *     by SimpleFin id, the pending rows it replaces or flags, and every manual entry an
 *     import can be linked to (manualMatchCandidates, the matcher's own criteria). The rows
 *     it inserts no one else sees until it commits.
 *
 * A write that holds some of the rows then waits for another at the first row they share,
 * never for one below it, so the one it waits for never waits for it. A row that joins a
 * write's set after its lock (the write's own statement reads again) is locked when it's
 * written, as before.
 *
 * Every one of these locks goes through {@link lockTransactions}, or, for a lock that also
 * reads the rows (a single edit's, a split's parent), {@link lockingTransactions}: a lock
 * not granted within the pool's lock_timeout (Delete Transactions holding the range, a bulk
 * edit holding a split), or a deadlock with a write outside the app, is then a 409
 * TRANSACTION_BUSY to try again, never a 500.
 */

/** Which transactions a lock takes: a condition on `transactions` alone. */
export type TransactionsWhere = (eb: ExpressionBuilder<DB, 'transactions'>) => Expression<SqlBool>;

/** SQLSTATE lock_not_available: a lock wasn't granted within lock_timeout (DB_LOCK_TIMEOUT_MS). */
const LOCK_NOT_AVAILABLE = '55P03';
/** SQLSTATE deadlock_detected: Postgres broke a deadlock by failing this transaction. */
const DEADLOCK_DETECTED = '40P01';

/**
 * Whether `err` is a lock a statement couldn't get: a wait past the pool's lock_timeout
 * (55P03), or a deadlock Postgres broke by failing it (40P01). Either aborted the
 * transaction (or the savepoint) it ran in, so nothing it wrote is kept: a conflict to try
 * again, not a server error.
 */
export function isLockConflict(err: unknown): boolean {
  const code = errorCode(err);
  return code === LOCK_NOT_AVAILABLE || code === DEADLOCK_DETECTED;
}

/** The code of the 409 a write answers when the transactions it changes were busy. */
export const TRANSACTION_BUSY = 'TRANSACTION_BUSY';

/** Whether `err` is that 409 ({@link lockTransactions}, {@link lockTransactionsForReference}). */
export function isTransactionBusy(err: unknown): err is ControlPlaneError {
  return err instanceof ControlPlaneError && err.code === TRANSACTION_BUSY;
}

/**
 * Lock the transactions `where` picks, in id order, for a write that changes them (FOR NO
 * KEY UPDATE, what an UPDATE takes) or, with `forDelete`, deletes them (FOR UPDATE). Answers
 * their ids. A row deleted meanwhile is left out.
 *
 * A wait past the pool's lock_timeout (Delete Transactions, say, holding some of them), or
 * a deadlock with a write outside the app, failed here with 55P03 or 40P01 and answered a
 * 500. It is a 409 TRANSACTION_BUSY to try again, nothing saved (the error aborted
 * the request's transaction, which the error answer rolls back), as a tag or a note on one
 * answers ({@link lockTransactionsForReference}).
 */
export async function lockTransactions(where: TransactionsWhere, { forDelete = false }: { forDelete?: boolean } = {}): Promise<number[]> {
  const query = getDb().selectFrom('transactions').select('id').where(where).orderBy('id');
  const rows = await lockingTransactions(() => (forDelete ? query.forUpdate() : query.forNoKeyUpdate()).execute(), {
    nothing: forDelete ? 'deleted' : 'saved',
  });
  return rows.map((row) => row.id);
}

/**
 * Run `lock`, a statement that locks transactions for a write that changes them and reads
 * them as it does (a single edit locks its transaction and a transfer's other side with
 * their columns; a split, its parent's row), so it can't be {@link lockTransactions}'s
 * select of ids. A lock not granted within the pool's lock_timeout, or a deadlock, is the
 * 409 TRANSACTION_BUSY lockTransactions answers, saying nothing was `nothing` (saved, by
 * default, or deleted). The error aborted the request's transaction, which the error
 * answer rolls back (a single edit, a split and an unsplit answered a 500).
 */
export async function lockingTransactions<T>(lock: () => Promise<T>, { nothing = 'saved' }: { nothing?: 'saved' | 'deleted' } = {}): Promise<T> {
  try {
    return await lock();
  } catch (err) {
    if (!isLockConflict(err)) throw err;
    logger.warn({ err, nothing }, 'A write could not lock its transactions in time; nothing saved');
    throw new ControlPlaneError(
      409,
      TRANSACTION_BUSY,
      `Another change to these transactions was being saved at the same time, so nothing was ${nothing}. Try again.`
    );
  }
}

/**
 * Run `lock`, a statement that locks, in id order, the rows a delete of several is about to
 * delete (the budget-period delete, the unused-merchants and pass-through-securities
 * cleanups). A delete alone takes its rows in the order it scans them; a note written on two
 * of them (a manual resolve, which locks its subjects in id order) could hold one the delete
 * waited for while it waited for one the delete had taken: a deadlock, which Postgres broke by
 * failing one of them (the delete with a 500, or the resolve with a 409). Locked first, in id
 * order, the delete waits at the first row they share, holding none after it. A wait past
 * the pool's lock_timeout, or a deadlock with a write outside the app, is a 409 RECORD_BUSY
 * to try again, nothing deleted (the error aborted the request's transaction, which the
 * error answer rolls back). `what` names the rows in that answer ("these merchants").
 */
export async function lockRowsForDelete<T>(what: string, lock: () => Promise<T>): Promise<T> {
  try {
    return await lock();
  } catch (err) {
    if (!isLockConflict(err)) throw err;
    logger.warn({ err, what }, 'A delete could not lock its rows in time; nothing deleted');
    throw new ControlPlaneError(409, 'RECORD_BUSY', `Another change to ${what} was being saved at the same time, so nothing was deleted. Try again.`);
  }
}

/**
 * Lock the transactions `where` picks, in id order, for a write that points at them without
 * a foreign key: a tag or a note put on them, changed or taken off (taggings,
 * annotations). FOR KEY SHARE, what a foreign key check takes: no edit waits for it, only a delete
 * (FOR UPDATE), which then sees the tag or note before it deletes them with the transaction
 * (Delete Transactions checks they are what its preview showed). A delete under way makes it
 * wait, and its rows are then gone: left out of the answer, so the write answers a 404 rather
 * than leave a tag or note pointing at nothing. Answers their ids.
 *
 * The database takes the same lock as a tagging or an annotation is inserted (the
 * trg_*_lock_transactions triggers), and refuses one whose transaction isn't there. That
 * comes after the statement's own writes, so code that changes a transaction's tags or notes
 * takes it here first, in order with the rest of its locks.
 *
 * A wait past the pool's lock_timeout (DB_LOCK_TIMEOUT_MS: a long deletion of these
 * transactions, say) fails with 55P03, which answered a 500; it, and a deadlock, are a
 * 409 TRANSACTION_BUSY to try again, as Delete Transactions answers its own. The
 * error aborted the request's transaction, which the error answer rolls back.
 */
export async function lockTransactionsForReference(where: TransactionsWhere): Promise<number[]> {
  try {
    const rows = await getDb().selectFrom('transactions').select('id').where(where).orderBy('id').forKeyShare().execute();
    return rows.map((row) => row.id);
  } catch (err) {
    if (!isLockConflict(err)) throw err;
    logger.warn({ err }, 'A tag or note write could not lock its transaction in time; nothing saved');
    throw new ControlPlaneError(
      409,
      TRANSACTION_BUSY,
      'Another change to this transaction was being saved at the same time, so nothing was saved. Try again.'
    );
  }
}

/**
 * The table of each kind of row a tag or a note can be on (taggings.taggable_type,
 * annotations.subject_type: check_known_or_unchanged refuses any other type).
 */
export const REFERENCED_TABLES = {
  account: 'accounts',
  budget_item: 'budget_items',
  budget_period_item: 'budget_period_items',
  category: 'categories',
  merchant: 'merchants',
  security: 'securities',
  tag: 'tags',
  transaction: 'transactions',
} as const;
export type ReferencedType = keyof typeof REFERENCED_TABLES;

/** How a refusal names a subject that was busy. */
const REFERENCED_LABELS: Record<ReferencedType, string> = {
  account: 'account',
  budget_item: 'budget item',
  budget_period_item: 'budget period item',
  category: 'category',
  merchant: 'merchant',
  security: 'security',
  tag: 'tag',
  transaction: 'transaction',
};

/**
 * The order a write locks the subjects of its tags or notes in: the database's own order
 * as it inserts them, lock_referenced_subjects' table order, then the transactions
 * (lock_referenced_transactions, whose trigger fires after it: triggers fire in name
 * order). A table at a time, each in id order.
 */
const REFERENCE_LOCK_ORDER: readonly ReferencedType[] = [
  'account',
  'budget_item',
  'budget_period_item',
  'category',
  'merchant',
  'security',
  'tag',
  'transaction',
];

/**
 * Whether `type` is a subject type a tag or a note can be written on today. A row may keep
 * another, a legacy value from before check_known_or_unchanged, which refuses a new row of
 * it: such a note can be edited, resolved or dismissed, but takes no reply.
 */
export const isReferencedType = (type: string): type is ReferencedType => Object.hasOwn(REFERENCED_TABLES, type);

/**
 * Lock the rows `ids` of a subject type for a tag or a note put on them, changed or taken
 * off: FOR KEY SHARE, in id order, as {@link lockTransactionsForReference}
 * locks transactions (which this calls for them). A delete under way is waited for, and its
 * rows are then left out of the answer, so the write answers a 404 rather than leave a tag
 * or note pointing at nothing; one that starts now waits for this write, and deletes the tag
 * or note with its subject. The database takes the same lock as it inserts one
 * (trg_*_lock_subjects; and as one is moved onto it, trg_*_lock_subject_on_update), and
 * refuses one whose subject isn't there or is another ledger's.
 * A wait past the pool's lock_timeout, or a deadlock, is a 409 to try again
 * (TRANSACTION_BUSY for a transaction, RECORD_BUSY otherwise), nothing saved. Answers the
 * ids locked.
 */
export async function lockRowsForReference(type: ReferencedType, ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  if (type === 'transaction') return lockTransactionsForReference((eb) => eb('id', 'in', [...ids]));
  try {
    const { rows } = await sql<{ id: number }>`
      SELECT id FROM ${sql.table(REFERENCED_TABLES[type])} WHERE id = ANY(${[...ids]}::int[]) ORDER BY id FOR KEY SHARE
    `.execute(getDb());
    return rows.map((row) => row.id);
  } catch (err) {
    if (!isLockConflict(err)) throw err;
    logger.warn({ err, subjectType: type }, 'A tag or note write could not lock its subject in time; nothing saved');
    throw new ControlPlaneError(
      409,
      'RECORD_BUSY',
      `Another change to this ${REFERENCED_LABELS[type]} was being saved at the same time, so nothing was saved. Try again.`
    );
  }
}

/**
 * {@link lockRowsForReference} for the subjects of several notes (or tags) at once, in
 * {@link REFERENCE_LOCK_ORDER}: answers the ones still there. One of a type this doesn't
 * know (a legacy value check_known_or_unchanged kept) has no table to lock, and is answered
 * as it is, as before v2.0.0: the caller decides what it may do with it (a reply on one is
 * refused by the database, {@link isReferencedType}).
 */
export async function lockSubjectsForReference<T extends { subject_type: string; subject_id: number }>(subjects: readonly T[]): Promise<T[]> {
  const locked = new Map<string, Set<number>>();
  for (const type of REFERENCE_LOCK_ORDER) {
    const ids = [...new Set(subjects.filter((s) => s.subject_type === type).map((s) => s.subject_id))];
    if (ids.length > 0) locked.set(type, new Set(await lockRowsForReference(type, ids)));
  }
  return subjects.filter((s) => !isReferencedType(s.subject_type) || locked.get(s.subject_type)!.has(s.subject_id));
}
