import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { TransactionRangePreviewInput } from '@nuggets/shared';
import { getDb, withTenant } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { errorCode } from '../../utils/errors.js';
import { appToday } from '../../utils/appDate.js';
import { accountBalanceService } from '../AccountBalanceService.js';
import { DomainError, defaultErrorCode } from '../domainErrors.js';
import { oneRow } from '../../utils/present.js';

const logger = createLogger({ service: 'RangeDeletion' });

/**
 * Delete Transactions (data management): every transaction of a date range, previewed
 * first and then deleted exactly as previewed, or not at all.
 *
 * A preview answers the range's totals and a selectionKey naming what a deletion would
 * remove. The deletion sends the key back; it checks it (checkUnchanged), the caller backs
 * up if asked, and then deleteRange locks the set, checks the key again and deletes it, in
 * a short transaction of its own (no transaction is open during the backup, which takes as
 * long as pg_dump does).
 */

/** The range a preview or a deletion is of (the request body, checked). */
export type DeletionRange = TransactionRangePreviewInput;

/** A range-deletion request refused: answered with its status, `{ error, code, message }`. */
export class RangeDeletionError extends DomainError {
  constructor(status: 400 | 409, message: string, code: string = defaultErrorCode(status)) {
    super(status, code, message);
  }
}

/**
 * The ids of the transactions a bulk deletion of dateFrom..dateTo removes, as a subquery:
 * the range's own transactions (a split's splits go with it), never an opening balance,
 * and with excludeBudgetPeriod none in a budget period. A split with a split in a
 * budget period counts as in one, though it may have none of its own (before v3.0.0, a
 * migration gave it its splits' period only when they all had the same one): it
 * stays, splits and all. A transfer goes only whole: a side whose other side isn't picked
 * too (that side's date was moved out of the range, or only one side is in a budget
 * period) stays, and so does its other side, rather than leave one side moving money on
 * its own. The preview and the deletion read the same set (deletionNow), so
 * the preview counts what is deleted; the deletion checks it still is (selectionKeyOf).
 */
function deletableTransactionIds({ dateFrom, dateTo, excludeBudgetPeriod }: DeletionRange) {
  return sql`
    WITH picked AS (
      SELECT t.id, t.transfer_transaction_id
        FROM transactions t
       WHERE t.transaction_date >= ${dateFrom}::date
         AND t.transaction_date <= ${dateTo}::date
         AND t.parent_transaction_id IS NULL
         AND t.type IS DISTINCT FROM 'starting balance'
         AND (${excludeBudgetPeriod} = false OR (
               t.budget_period_id IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM transactions s
                  WHERE s.parent_transaction_id = t.id AND s.budget_period_id IS NOT NULL)))
    )
    SELECT id FROM picked
     WHERE transfer_transaction_id IS NULL
        OR transfer_transaction_id IN (SELECT id FROM picked)
  `;
}

/**
 * Names a set of transactions (their ids, in order) and what the deletion removes with them
 * as it is now (`contents`, deletionNow's fingerprint): the preview answers it, and Delete
 * sends it back. Another key means a transaction joined or left the range after the preview
 * (a bank sync, another member), or something the deletion removes changed: an
 * amount, a split, a tag, a note. Delete then deletes nothing, so it never deletes an edit
 * its backup may not have.
 */
function selectionKeyOf(ids: readonly number[], contents: string): string {
  return createHash('sha256').update(`${ids.join(',')}|${contents}`).digest('hex');
}

/** The totals a preview shows, and Delete answers, for a set of transactions. */
interface DeletionSummary {
  count: number;
  affected_accounts: number;
  total_income: string;
  total_expenses: string;
  earliest_date: string | null;
  latest_date: string | null;
}

/** The totals of a preview or a deletion, as their answers carry them. */
export interface DeletionTotals {
  count: number;
  affectedAccounts: number;
  totalIncome: number;
  totalExpenses: number;
  earliestDate: string | null;
  latestDate: string | null;
}

/**
 * What a bulk deletion of the range removes now: its ids (in order, for selectionKeyOf),
 * the other sides of its transfers, its totals, and a fingerprint of everything that goes
 * with it, in one statement, so they are all of the same set. Runs in the caller's tenant
 * transaction.
 *
 * The fingerprint (`contents`) is a digest of what the deletion removes, as the people of
 * the ledger see it: the transactions and their splits, and what goes with them, by the
 * polymorphic-reference trigger or ON DELETE CASCADE: their tags, annotations, attachments
 * and bill links. Their content, not their bookkeeping: a bank sync rewrites every row the
 * bank sends again (import_imported_at, and so updated_at), changed or not, so a version
 * column would turn every sync into a change. Each row is jsonb, which prints
 * a date as YYYY-MM-DD whatever the session's DateStyle, but a timestamptz in the session's
 * time zone: so the one instant here, an annotation's resolved_at, is seconds since the
 * epoch, and the key is the same on any connection.
 */
async function deletionNow(range: DeletionRange) {
  // kept as raw sql: aggregate query with conditional SUM(CASE ...), DISTINCT
  // COUNT, array_agg and ::int/::text casts not expressible via the query builder
  const result = await sql<DeletionSummary & { ids: number[]; counterparts: number[]; contents: string }>`
    WITH chosen AS MATERIALIZED (
      SELECT id, account_id, amount, transaction_date, transfer_transaction_id
        FROM transactions
       WHERE id IN (${deletableTransactionIds(range)})
    ),
    removed AS MATERIALIZED (
      SELECT t.id, jsonb_build_object(
               'amount', t.amount, 'type', t.type, 'date', t.transaction_date,
               'description', t.description, 'notes', t.notes, 'account', t.account_id,
               'budget_item', t.budget_item_id, 'budget_period', t.budget_period_id,
               'budget_period_item', t.budget_period_item_id, 'merchant', t.merchant_id,
               'status', t.status, 'review_status', t.review_status, 'assigned_to', t.assigned_to,
               'split_parent', t.is_split_parent, 'parent', t.parent_transaction_id,
               'transfer', t.transfer_transaction_id,
               'external_id', t.external_transaction_id, 'external_link', t.external_link
             ) AS content
        FROM transactions t
       WHERE t.id IN (SELECT id FROM chosen) OR t.parent_transaction_id IN (SELECT id FROM chosen)
    ),
    parts AS (
      SELECT concat_ws(':', 't', r.id, r.content::text) AS part FROM removed r
      UNION ALL
      SELECT concat_ws(':', 'g', tg.taggable_id, tg.tag_id) FROM taggings tg
       WHERE tg.taggable_type = 'transaction' AND tg.taggable_id IN (SELECT id FROM removed)
      UNION ALL
      SELECT concat_ws(':', 'a', an.id, jsonb_build_object(
               'subject', an.subject_id, 'parent', an.parent_id, 'author_kind', an.author_kind,
               'author', an.author_user_id, 'agent', an.agent_name, 'kind', an.kind, 'body', an.body,
               'meta', an.meta, 'status', an.status, 'resolved_at', extract(epoch FROM an.resolved_at),
               'resolved_by', an.resolved_by_user_id, 'severity', an.severity, 'pinned', an.pinned,
               'feedback', an.feedback, 'feedback_reason', an.feedback_reason
             )::text) FROM annotations an
       WHERE an.subject_type = 'transaction' AND an.subject_id IN (SELECT id FROM removed)
      UNION ALL
      SELECT concat_ws(':', 'f', at.id, jsonb_build_object(
               'transaction', at.transaction_id, 'name', at.name, 'original_filename', at.original_filename,
               'file', at.safe_filename, 'size', at.file_size, 'mime_type', at.mime_type,
               'bill_date', at.bill_date, 'notes', at.notes, 'attachment_type', at.attachment_type,
               'merchant', at.merchant_id, 'budget_item', at.budget_item_id
             )::text) FROM attachments at
       WHERE at.transaction_id IN (SELECT id FROM removed)
      UNION ALL
      SELECT concat_ws(':', 'b', bt.transaction_id, bt.bill_occurrence_id, bt.matched_by) FROM bill_occurrence_transactions bt
       WHERE bt.transaction_id IN (SELECT id FROM removed)
    )
    SELECT
      COUNT(*)::int as count,
      COUNT(DISTINCT account_id)::int as affected_accounts,
      COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as total_income,
      COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) as total_expenses,
      MIN(transaction_date)::text as earliest_date,
      MAX(transaction_date)::text as latest_date,
      COALESCE(array_agg(id ORDER BY id), '{}') as ids,
      COALESCE(array_agg(transfer_transaction_id) FILTER (WHERE transfer_transaction_id IS NOT NULL), '{}') as counterparts,
      (SELECT encode(sha256(convert_to(COALESCE(string_agg(part, ',' ORDER BY part COLLATE "C"), ''), 'UTF8')), 'hex') FROM parts) as contents
    FROM chosen
  `.execute(getDb());
  return oneRow(result.rows, 'the deletion summary');
}

/** A summary's totals, as an answer carries them (amounts as numbers). */
function totalsOf(summary: DeletionSummary, count = summary.count): DeletionTotals {
  return {
    count,
    affectedAccounts: summary.affected_accounts,
    totalIncome: parseFloat(summary.total_income) || 0,
    totalExpenses: parseFloat(summary.total_expenses) || 0,
    earliestDate: summary.earliest_date,
    latestDate: summary.latest_date,
  };
}

/** "The future" is after today in the application time zone; calendar days compare as strings. */
async function assertNotFuture({ dateFrom, dateTo }: DeletionRange): Promise<void> {
  const today = await appToday();
  if (dateFrom > today || dateTo > today) throw new RangeDeletionError(400, 'Cannot delete transactions in the future');
}

/** The set the preview found has changed: one added, moved or removed, or something it removes edited. */
function previewOutdated(count: number): RangeDeletionError {
  logger.info({ count }, 'Transactions in the range changed since the preview - nothing deleted');
  return new RangeDeletionError(
    409,
    'The transactions in this range have changed since the preview, so nothing was deleted. Preview again to see what would be deleted now.',
    'PREVIEW_OUTDATED'
  );
}

/** The selectionKey a preview of the range answers now, in the caller's tenant transaction (for tests). */
export async function selectionKeyNow(range: DeletionRange): Promise<string> {
  const now = await deletionNow(range);
  return selectionKeyOf(now.ids, now.contents);
}

/** What deleting the range would remove now, and the key a deletion of it sends back. In the caller's tenant transaction. */
export async function previewRangeDeletion(range: DeletionRange): Promise<DeletionTotals & { selectionKey: string }> {
  await assertNotFuture(range);
  const now = await deletionNow(range);
  logger.info({ count: now.count, affectedAccounts: now.affected_accounts }, 'Transaction deletion preview completed');
  return { ...totalsOf(now), selectionKey: selectionKeyOf(now.ids, now.contents) };
}

/** The transactions a deletion locks: the set the check found, and the other sides of its transfers. */
export interface DeletionCandidates {
  readonly ids: readonly number[];
}

/**
 * Step 1 of a deletion, before any backup: the range's set now, without locks, in a short
 * transaction of `tenantId`'s. A change since the preview (`selectionKey`) is refused
 * here: 409 PREVIEW_OUTDATED. Answers what step 3 locks.
 */
export async function checkRangeUnchanged(tenantId: number, range: DeletionRange, selectionKey: string): Promise<DeletionCandidates> {
  await assertNotFuture(range);
  const previewed = await withTenant(tenantId, () => deletionNow(range));
  if (selectionKeyOf(previewed.ids, previewed.contents) !== selectionKey) throw previewOutdated(previewed.count);
  return { ids: [...previewed.ids, ...previewed.counterparts] };
}

/**
 * Whether `error`, or the database error it wraps, is a lock this deletion couldn't get:
 * a deadlock Postgres broke (40P01), or a lock wait past lock_timeout (55P03). Either rolled
 * the deletion back whole.
 */
function lockConflict(error: unknown): 'deadlock' | 'lock_timeout' | null {
  const codes = [errorCode(error), error instanceof Error ? errorCode(error.cause) : undefined];
  if (codes.includes('40P01')) return 'deadlock';
  if (codes.includes('55P03')) return 'lock_timeout';
  return null;
}

/**
 * Steps 3 to 5 of a deletion, in one short transaction of `tenantId`'s, which an error rolls
 * back: lock the set, check it is still the preview's (`selectionKey`, else 409
 * PREVIEW_OUTDATED), and delete it. Answers its totals and how many were deleted.
 *
 * Every write locks transactions in id order, as this does, but one outside them
 * (a script, a migration) can still deadlock with it: Postgres then fails one of the two.
 * Or a lock it needs is held past the pool's lock_timeout (DB_LOCK_TIMEOUT_MS): a long
 * write of the same rows, or of their tags, notes or attachments. Either way this
 * one rolled back, with nothing deleted: 409 DELETION_CONFLICT, to try again.
 */
export async function deleteRange(
  tenantId: number,
  range: DeletionRange,
  selectionKey: string,
  { ids: candidates }: DeletionCandidates
): Promise<DeletionTotals> {
  try {
    return await withTenant(tenantId, async () => {
      // Step 3: lock what the set depends on: the transactions the check found (`candidates`:
      // the previewed ones and the other sides of their transfers) and their splits (a split
      // in a budget period keeps its split), in one statement, in id order, as every write of
      // several transactions locks them (locks.ts). By id, which doesn't change: a row
      // that changed while its lock waited is re-checked only against this statement's
      // WHERE. Once a parent is locked no split can join it (its foreign key check waits on
      // the parent's lock); one that joined while this waited isn't locked here, but step 4
      // reads it, and it changes the fingerprint.
      await sql`
        SELECT id FROM transactions
         WHERE id = ANY(${[...candidates]}::int[]) OR parent_transaction_id = ANY(${[...candidates]}::int[])
         ORDER BY id FOR UPDATE
      `.execute(getDb());

      // Step 4: the set again, in a statement of its own, so it reads what committed while
      // the locks waited (a date moved out of the range, a split put in a budget period)
      // and during the backup (an amount, a tag, a note: the fingerprint). Its rows
      // are locked now, so it's what the deletion removes; it must still be the preview's.
      // A tag or a note written on one locks it first (FOR KEY SHARE: locks.ts, and
      // the trg_*_lock_transactions triggers): one being written now was waited for, and
      // is read here; one started from now on waits for this deletion, then finds its
      // transaction gone. So none is deleted below that this didn't read.
      const locked = await deletionNow(range);
      if (selectionKeyOf(locked.ids, locked.contents) !== selectionKey) throw previewOutdated(locked.count);
      if (locked.count === 0) {
        logger.info('No transactions found to delete');
        return totalsOf(locked, 0);
      }

      // Step 5: delete exactly that set, by its ids (a split's splits go with it).
      const deleteResult = await getDb()
        .deleteFrom('transactions')
        .where(sql<boolean>`id = ANY(${locked.ids}::int[])`)
        .executeTakeFirst();
      const deletedCount = Number(deleteResult.numDeletedRows ?? 0);
      logger.info(
        { deletedCount, affectedAccounts: locked.affected_accounts, dateFrom: range.dateFrom, dateTo: range.dateTo },
        'Transactions deleted successfully'
      );

      // Balances are computed on read; record today's net worth.
      if (locked.affected_accounts > 0) await accountBalanceService.triggerNetWorthSnapshot();
      return totalsOf(locked, deletedCount);
    });
  } catch (error) {
    const conflict = lockConflict(error);
    if (!conflict) throw error;
    logger.warn(
      { err: error, conflict },
      conflict === 'deadlock'
        ? 'Transaction deletion deadlocked with another write - rolled back, nothing deleted'
        : 'Transaction deletion timed out waiting for a lock - rolled back, nothing deleted'
    );
    throw new RangeDeletionError(
      409,
      'Another change to these transactions was being saved at the same time, so nothing was deleted. Try again.',
      'DELETION_CONFLICT'
    );
  }
}
