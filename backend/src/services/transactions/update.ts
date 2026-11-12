import { sql, type Selectable, type Updateable } from 'kysely';
import { websiteUrlProblem, transactionType } from '@nuggets/shared';
import type { Transactions } from '../../db/schema.generated.js';
import { getDb } from '../../db/withTenant.js';
import { getCurrentTenantId } from '../../context/requestContext.js';
import { isAssignableUser } from '../MembershipService.js';
import { firstMissingReference } from '../tenantReferences.js';
import { createLogger } from '../../utils/logger.js';
import { toCents, readCents, invalidAmountAnswer, centsToAmount } from '../../utils/money.js';
import {
  badRequest,
  incomeOnLiability,
  invalidAssignee,
  invalidReference,
  notFound,
  TransactionRefusal,
  transferAmountZero,
} from './refusal.js';
import { periodItemId, recordNetWorth, transactionIdByUuid } from './lookup.js';
import { lockingTransactions, lockTransactions } from './locks.js';
import {
  INVALID_TYPE_ERROR,
  TRANSACTION_TYPES,
  TRANSFER_TYPES,
  isIncomeOnLiability,
  signForType,
  transactionVocabularyError,
} from './rules.js';
import { oneRow } from '../../utils/present.js';

/** Changing and deleting transactions: one edit, a bulk edit, and a delete. */

const logger = createLogger({ service: 'TransactionUpdates' });

/** A transaction after an edit (PUT /:uuid): t.* plus joined names. */
export type UpdatedTransaction = Omit<Selectable<Transactions>, 'transaction_date'> & {
  transaction_date: string; // cast to TEXT in the query
  account_name: string | null;
  account_uuid: string | null;
  budget_item_name: string | null;
  budget_period_name: string | null;
  merchant_name: string | null;
};

const EDITABLE_FIELDS = [
  'description', 'notes', 'amount', 'type', 'status', 'budget_item_id',
  'merchant_id', 'budget_period_id', 'budget_period_item_id', 'review_status', 'transaction_date', 'assigned_to',
  'external_transaction_id', 'external_link'
];
const BULK_EDITABLE_FIELDS = [
  'review_status', 'status', 'budget_item_id', 'budget_period_id',
  'budget_period_item_id', 'assigned_to'
];
/** Foreign keys, where '' (as a form sends "none") is null. */
const KEY_FIELDS = ['budget_item_id', 'merchant_id', 'budget_period_id', 'budget_period_item_id', 'assigned_to'];
/** Free text, where '' is null. */
const TEXT_FIELDS = ['description', 'notes', 'external_transaction_id', 'external_link'];

/** The fields of `updates` in `allowed`, with "none" as null. */
function pickUpdate(updates: Record<string, unknown>, allowed: string[], emptyTextIsNull: boolean): Record<string, unknown> {
  const updateData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.includes(key)) continue;
    let processedValue = value;
    if (KEY_FIELDS.includes(key) && (value === '' || value === null || value === undefined)) processedValue = null;
    if (emptyTextIsNull && TEXT_FIELDS.includes(key) && value === '') processedValue = null;
    updateData[key] = processedValue;
  }
  return updateData;
}

/**
 * Whether `link` is an http(s) URL, written with its scheme. It's user-provided and rendered as a
 * hyperlink for the ledger's members, so it is checked as a website is (websiteUrlProblem): no
 * user name or password in it, which reads as another site's address.
 */
function isHttpUrl(link: string): boolean {
  try {
    const parsed = new URL(link);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && websiteUrlProblem(link).problem === null;
  } catch {
    return false;
  }
}

/**
 * PUT /api/transactions/bulk: set the review status, status, envelope or assignee of
 * many transactions at once. Uuids that name nothing are skipped; none found is a 404.
 */
export async function bulkUpdateTransactions(
  transactionUuids: unknown[],
  updates: Record<string, unknown>,
): Promise<{ updated: number; transactions: { id: number; uuid: string; review_status: string | null; status: string | null }[] }> {
  // One at a time: they run on the request's transaction, where a Promise.all would only
  // queue them on its connection.
  const transactionIds: number[] = [];
  for (const uuid of transactionUuids) {
    const id = await transactionIdByUuid(uuid as string);
    if (id !== null && id !== undefined) transactionIds.push(id);
  }
  if (transactionIds.length === 0) throw notFound('No valid transactions found');

  const updateData = pickUpdate(updates, BULK_EDITABLE_FIELDS, false);
  if (Object.keys(updateData).length === 0) throw badRequest('No valid fields to update');

  const vocabularyError = transactionVocabularyError(updateData);
  if (vocabularyError) throw badRequest(vocabularyError);

  // Numeric ids from the body name rows of this ledger.
  const missing = await firstMissingReference({
    budget_item_id: updateData.budget_item_id,
    budget_period_id: updateData.budget_period_id,
    budget_period_item_id: updateData.budget_period_item_id,
  });
  if (missing) throw invalidReference(missing);

  if (updateData.assigned_to != null && !(await isAssignableUser(updateData.assigned_to, getCurrentTenantId()))) {
    throw invalidAssignee();
  }

  // In id order, as every write of several transactions locks them (locks.ts): the
  // UPDATE alone locks them in the order it scans them, both sides of a transfer included.
  await lockTransactions((eb) => eb('id', 'in', transactionIds));
  const result = await getDb()
    .updateTable('transactions')
    .set({ ...(updateData as Updateable<Transactions>), updated_at: sql<Date>`CURRENT_TIMESTAMP` })
    .where('id', 'in', transactionIds)
    .returning(['id', 'uuid', 'review_status', 'status'])
    .execute();
  return { updated: result.length, transactions: result };
}

/**
 * PUT /api/transactions/:uuid: edit one transaction, under the money rules and
 * the ledger's references. Answers the transaction as it now is.
 */
export async function updateTransaction(uuid: string, updates: Record<string, unknown>): Promise<UpdatedTransaction> {
  const transactionId = await transactionIdByUuid(uuid);
  if (!transactionId) throw notFound('Transaction not found');

  // Locked, so a split of this transaction made meanwhile waits for this edit
  // and checks its splits against the amount this one leaves. The other side of a
  // transfer is locked with it, in id order: two edits of a transfer's two sides
  // then wait for each other instead of deadlocking. A lock held too long (Delete
  // Transactions holding the range) is a 409 TRANSACTION_BUSY.
  const locked = await lockingTransactions(() =>
    getDb()
      .selectFrom('transactions')
      .select(['id', 'account_id', 'amount', 'type', 'status', 'review_status', 'is_split_parent', 'parent_transaction_id', 'transfer_transaction_id'])
      .where((eb) => eb.or([
        eb('id', '=', transactionId),
        eb('id', '=', eb.selectFrom('transactions as t').select('t.transfer_transaction_id').where('t.id', '=', transactionId)),
      ]))
      .orderBy('id')
      .forUpdate()
      .execute()
  );
  const target = locked.find((row) => row.id === transactionId);
  if (!target) throw notFound('Transaction not found');

  // A split parent's budget items are its children's. The DB trigger keeps
  // the parent's cleared whatever is sent; say so rather than drop it quietly.
  if ((updates.budget_item_id || updates.budget_period_item_id) && target.is_split_parent) {
    throw badRequest('This transaction is split. Change the budget item on each split instead.');
  }

  const updateData = pickUpdate(updates, EDITABLE_FIELDS, true);

  const vocabularyError = transactionVocabularyError(updateData, target);
  if (vocabularyError) throw badRequest(vocabularyError);

  // Numeric ids from the body name rows of this ledger.
  const missing = await firstMissingReference({
    merchant_id: updateData.merchant_id,
    budget_item_id: updateData.budget_item_id,
    budget_period_id: updateData.budget_period_id,
    budget_period_item_id: updateData.budget_period_item_id,
  });
  if (missing) throw invalidReference(missing);

  // Never store a javascript:/data: or other non-http(s) link. ('' was made null
  // above, which clears the field.)
  if (typeof updateData.external_link === 'string' && updateData.external_link.length > 0 && !isHttpUrl(updateData.external_link)) {
    throw badRequest('external_link must be a valid http(s) URL');
  }

  // Money rules, as create applies them: the amount is whole cents and
  // signed for its type. A split's amount is the sum of its splits, so neither
  // the parent's nor a split's amount or type changes here. The two sides of a
  // transfer stay equal and opposite: a new amount moves both, and each side
  // keeps its direction.
  let otherSide: { id: number; amount: string; type: string } | null = null;
  if ('amount' in updateData || 'type' in updateData) {
    const sentType = 'type' in updateData ? updateData.type : target.type;
    if (sentType !== target.type && (typeof sentType !== 'string' || !TRANSACTION_TYPES.includes(sentType))) {
      throw badRequest(INVALID_TYPE_ERROR);
    }
    const type = sentType as string;
    // No income on a liability account (an edit can't move a transaction to another
    // account). One from before that rule keeps its type when it's sent back as it was,
    // left out of the write: the database refuses any write of that type to that account.
    if (type === transactionType.enum.income) {
      // FOR KEY SHARE, as the database reads it: an edit making the account a
      // liability is waited for.
      const account = await getDb().selectFrom('accounts').select('type').where('id', '=', target.account_id).forKeyShare().executeTakeFirst();
      if (isIncomeOnLiability(type, account?.type)) {
        if (type !== target.type) throw incomeOnLiability();
        delete updateData.type;
      }
    }
    const currentCents = toCents(target.amount ?? '0') ?? 0;
    const sent = 'amount' in updateData ? readCents(updateData.amount) : { cents: currentCents };
    if (!('cents' in sent)) throw new TransactionRefusal(400, invalidAmountAnswer('amount', sent.problem));
    const sentCents = sent.cents;

    // What was there sent back unchanged (a whole-form save) is left as it is.
    let cents = sentCents;
    if (sentCents !== currentCents || type !== target.type) {
      const otherId = target.transfer_transaction_id;
      const other = otherId == null ? undefined : await lockingTransactions(() =>
        getDb()
          .selectFrom('transactions')
          .select(['id', 'is_split_parent'])
          .where('id', '=', otherId)
          .forUpdate()
          .executeTakeFirst()
      );
      cents = other && currentCents !== 0
        ? (currentCents < 0 ? -Math.abs(sentCents) : Math.abs(sentCents))
        : signForType(type, sentCents);

      if (cents !== currentCents || type !== target.type) {
        if (target.is_split_parent) {
          throw badRequest('This transaction is split. To change its amount or type, change its splits or unsplit it first.');
        }
        if (target.parent_transaction_id != null) {
          throw badRequest('This is one split of a transaction. Change the splits on that transaction instead.');
        }
        if (other) {
          if (!TRANSFER_TYPES.includes(type)) {
            throw badRequest('This transaction is one side of a transfer, so its type can only be payment or transfer.');
          }
          if (other.is_split_parent) {
            throw badRequest('The other side of this transfer is split. Unsplit it first to change the amount or type.');
          }
          // A transfer moves money, as creating one requires: 0 on one side would
          // set both to 0, which the database's check (equal and opposite) lets through.
          // One already 0, from before, keeps saving as it is (cents === currentCents).
          if (cents === 0 && cents !== currentCents) throw transferAmountZero();
          otherSide = { id: other.id, amount: centsToAmount(-cents), type };
        }
      }
    }
    updateData.amount = centsToAmount(cents);
  }

  // A budget item and period sent together file the transaction in that envelope,
  // when the period has one for the item.
  if (updates.budget_item_id && updates.budget_period_id) {
    const envelope = await periodItemId(updates.budget_item_id as number, updates.budget_period_id as number);
    if (envelope !== null) updateData.budget_period_item_id = envelope;
  }

  if (Object.keys(updateData).length === 0) throw badRequest('No valid fields to update');

  if (updateData.assigned_to != null && !(await isAssignableUser(updateData.assigned_to, getCurrentTenantId()))) {
    throw invalidAssignee();
  }

  const updated = await getDb()
    .updateTable('transactions')
    .set({ ...(updateData as Updateable<Transactions>), updated_at: sql<Date>`CURRENT_TIMESTAMP` })
    // WHERE condition (no user filtering - shared data)
    .where('id', '=', transactionId)
    .returning(['id', 'uuid', 'account_id'])
    .executeTakeFirst();
  if (!updated) throw notFound('Transaction not found');

  // The other side of the transfer, with the opposite amount.
  if (otherSide) {
    await getDb()
      .updateTable('transactions')
      .set({ amount: otherSide.amount, type: otherSide.type, updated_at: sql<Date>`CURRENT_TIMESTAMP` })
      .where('id', '=', otherSide.id)
      .execute();
  }

  if (updated.account_id) await recordNetWorth();

  // Multi-join t.* select, kept as raw sql
  const fetched = await sql<UpdatedTransaction>`
    SELECT
      t.*,
      t.transaction_date::TEXT as transaction_date,
      a.name as account_name,
      a.uuid as account_uuid,
      bi.name as budget_item_name,
      bp.name as budget_period_name,
      m.name as merchant_name
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN budget_items bi ON t.budget_item_id = bi.id
    LEFT JOIN budget_period bp ON t.budget_period_id = bp.id
    LEFT JOIN merchants m ON t.merchant_id = m.id
    WHERE t.id = ${updated.id}
  `.execute(getDb());

  logger.info({
    transactionId: updated.id,
    uuid,
    accountId: updated.account_id,
    transferTransactionId: otherSide?.id,
  }, 'Transaction updated successfully');

  return oneRow(fetched.rows, 'the updated transaction');
}

/**
 * DELETE /api/transactions/:uuid: delete a transaction, with its splits (by cascade)
 * and the other side of a transfer. One split on its own isn't deleted.
 */
export async function deleteTransaction(uuid: string): Promise<void> {
  const transactionId = await transactionIdByUuid(uuid);
  if (!transactionId) throw notFound('Transaction not found');

  const transaction = await getDb()
    .selectFrom('transactions')
    .select(['account_id', 'parent_transaction_id', 'transfer_transaction_id'])
    .where('id', '=', transactionId)
    .executeTakeFirst();
  const accountId = transaction?.account_id;

  // A split's amounts add up to the transaction it's part of, so one split
  // isn't deleted on its own.
  if (transaction?.parent_transaction_id != null) {
    throw badRequest('This is one split of a transaction. Change the splits on that transaction, or unsplit it, instead.');
  }

  // The two sides of a transfer go together: one left behind would
  // show money arriving that never left, or leaving for nowhere.
  const transferTransactionId = transaction?.transfer_transaction_id ?? null;
  const ids = transferTransactionId == null ? [transactionId] : [transactionId, transferTransactionId];

  // Both sides and their splits, locked in id order first (locks.ts): the DELETE alone
  // takes them in the order it scans them, and the splits after both sides.
  await lockTransactions((eb) => eb.or([eb('id', 'in', ids), eb('parent_transaction_id', 'in', ids)]), { forDelete: true });
  const result = await getDb().deleteFrom('transactions').where('id', 'in', ids).executeTakeFirst();
  if (Number(result.numDeletedRows) === 0) throw notFound('Transaction not found');

  if (accountId) await recordNetWorth();

  logger.info({ transactionId, uuid, accountId, transferTransactionId }, 'Transaction deleted successfully');
}
