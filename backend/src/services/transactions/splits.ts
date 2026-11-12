import { sql, type Selectable } from 'kysely';
import type { Transactions } from '../../db/schema.generated.js';
import { getDb } from '../../db/withTenant.js';
import { asId, firstMissingReference, tenantTagIds } from '../tenantReferences.js';
import { createLogger } from '../../utils/logger.js';
import { toCents, centsToAmount, centsToNumber } from '../../utils/money.js';
import { badRequest, incomeOnLiability, invalidReference, invalidTagReference, invalidUuidReference, notFound, splitOfSplitRefused, transferSplitRefused } from './refusal.js';
import { INCOME_ON_LIABILITY_SPLIT_ERROR, isIncomeOnLiability } from './rules.js';
import { periodItemId } from './lookup.js';
import { lockingTransactions } from './locks.js';
import { present } from '../../utils/present.js';
import { isUuid } from '../../middleware/routeParams.js';
import { getTransactionDetail, type TransactionDetail } from './list.js';
import { transactionType } from '@nuggets/shared';

/**
 * Splitting a transaction across budget items (POST /:uuid/split, which also re-splits
 * one) and putting it back together (DELETE /:uuid/unsplit).
 *
 * The parent keeps the money: a split moves only its envelope to its splits, so neither
 * changes an account balance, and balances are computed on read. The splits add
 * up to the parent to the cent, which the database checks at COMMIT, so
 * the parent and its splits are written in the request's one transaction.
 */

const logger = createLogger({ service: 'TransactionSplits' });

/**
 * Lock the splits of transaction `parentId` for deleting them (FOR UPDATE, in id order),
 * once the parent is locked (locks.ts). A split another write holds past the pool's
 * lock_timeout is a 409 TRANSACTION_BUSY, nothing saved.
 */
async function lockSplitsForDelete(parentId: number): Promise<void> {
  await lockingTransactions(() =>
    getDb().selectFrom('transactions').select('id').where('parent_transaction_id', '=', parentId).orderBy('id').forUpdate().execute()
  );
}

/**
 * One split as a request sends it. Each may name its budget item, period and tags by
 * uuid alongside (or instead of) the numeric ids. Checked loosely, as the route always
 * has: `amount` is a number, the rest is resolved here.
 */
export interface SplitInput {
  amount: number;
  description?: string;
  budget_item_id?: number | null;
  budget_item_uuid?: string | null | undefined;
  budget_period_id?: number | null;
  budget_period_uuid?: string | null | undefined;
  budget_period_item_id?: number | null;
  tag_ids?: unknown[];
  tag_uuids?: unknown[];
  [key: string]: unknown;
}

/** The ids of the rows of `table` with these uuids. */
async function idsByUuid(table: 'budget_items' | 'budget_period' | 'tags', uuids: string[]): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  if (uuids.length === 0) return ids;
  const rows = await getDb().selectFrom(table).select(['id', 'uuid']).where('uuid', 'in', uuids).execute();
  // Keyed in lower case, as Postgres answers a uuid; look one up with toLowerCase().
  for (const row of rows) if (row.uuid) ids.set(row.uuid.toLowerCase(), row.id);
  return ids;
}

/**
 * Resolve each split's uuids to ids, check its ids name rows of this ledger, and
 * file it in its envelope when it names a budget item and a period. Fills in the splits
 * as it goes, as the route always did.
 */
async function resolveSplits(splits: SplitInput[]): Promise<void> {
  const uuidsOf = (key: 'budget_item_uuid' | 'budget_period_uuid'): string[] => {
    const set = new Set<string>();
    for (const s of splits) if (typeof s[key] === 'string') set.add(s[key]);
    return Array.from(set);
  };
  const tagUuids = new Set<string>();
  for (const s of splits) {
    // Only uuids are looked up (text that isn't one names no tag, and would fail the query).
    if (Array.isArray(s.tag_uuids)) for (const t of s.tag_uuids) if (isUuid(t)) tagUuids.add(t);
  }
  const budgetItemIds = await idsByUuid('budget_items', uuidsOf('budget_item_uuid'));
  const periodIds = await idsByUuid('budget_period', uuidsOf('budget_period_uuid'));
  const tagIds = await idsByUuid('tags', Array.from(tagUuids));

  for (const split of splits) {
    // A budget item or period named by uuid (transactionSplitSchema checked it is one) is the
    // ledger's, or the split is refused, 400 INVALID_REFERENCE, nothing written: one
    // that named another ledger's row, or none, was dropped, the split saved without it.
    if (split.budget_item_uuid && !split.budget_item_id) {
      const id = budgetItemIds.get(split.budget_item_uuid.toLowerCase());
      if (id === undefined) throw invalidUuidReference('budget_item_uuid');
      split.budget_item_id = id;
    }
    if (split.budget_period_uuid && !split.budget_period_id) {
      const id = periodIds.get(split.budget_period_uuid.toLowerCase());
      if (id === undefined) throw invalidUuidReference('budget_period_uuid');
      split.budget_period_id = id;
    }
    // Each tag a split names is the ledger's, or the split is refused, 400 INVALID_REFERENCE,
    // as its other references are: one that named another ledger's tag, or none,
    // was dropped, the split saved without it, 200.
    if (Array.isArray(split.tag_uuids) && split.tag_uuids.length > 0) {
      const resolved = split.tag_uuids.map((u) => (typeof u === 'string' ? tagIds.get(u.toLowerCase()) : undefined));
      if (resolved.some((id) => id === undefined)) throw invalidTagReference('tag_uuids');
      split.tag_ids = Array.from(new Set([...(split.tag_ids || []), ...(resolved as number[])]));
    }
    // Numeric ids a split sent name rows of this ledger, and so do its tags.
    const missing = await firstMissingReference({
      budget_item_id: split.budget_item_id,
      budget_period_id: split.budget_period_id,
      budget_period_item_id: split.budget_period_item_id,
    });
    if (missing) throw invalidReference(missing);
    if (Array.isArray(split.tag_ids)) {
      const asked = split.tag_ids.map(asId);
      if (asked.some((id) => id === null)) throw invalidTagReference('tag_ids');
      const found = await tenantTagIds(asked as number[]);
      if (found.length !== asked.length) throw invalidTagReference('tag_ids');
      split.tag_ids = found;
    }
    // The envelope, when both pieces are there (as create files one).
    if (split.budget_item_id && split.budget_period_id && !split.budget_period_item_id) {
      const envelope = await periodItemId(split.budget_item_id, split.budget_period_id);
      if (envelope !== null) split.budget_period_item_id = envelope;
    }
  }
}

/**
 * Split a transaction into `splits`, replacing the splits it has. `splitCents` are the
 * splits' amounts in whole cents, which the route has checked.
 */
export async function splitTransaction(uuid: string, splits: SplitInput[], splitCents: number[]): Promise<TransactionDetail> {
  const db = getDb();
  // The parent, locked: an edit of its amount made meanwhile waits, or is waited
  // for, so the splits are checked against the amount it ends up with. And
  // locked before a re-split deletes its splits, as everything locks a parent before
  // its splits (locks.ts). A lock held too long is a 409 TRANSACTION_BUSY.
  const parent = await lockingTransactions(() =>
    db.selectFrom('transactions').selectAll().where('uuid', '=', uuid).forUpdate().executeTakeFirst()
  );
  if (!parent) throw notFound('Transaction not found');
  // One split of a transaction isn't split again: splits are one level deep.
  if (parent.parent_transaction_id !== null) throw splitOfSplitRefused();
  // A side of a transfer isn't split, nor split again: one split before the rule
  // keeps its splits until it is unsplit.
  if (parent.transfer_transaction_id !== null) throw transferSplitRefused();

  // The splits take the parent's type and account, and a liability account takes no
  // income: an income on one from before that rule is refused here, not by the
  // database when its splits are inserted (a 500).
  if (parent.type === transactionType.enum.income) {
    // FOR KEY SHARE, as the database reads it: an edit making the account a liability
    // is waited for.
    const account = await db.selectFrom('accounts').select('type').where('id', '=', parent.account_id).forKeyShare().executeTakeFirst();
    if (isIncomeOnLiability(parent.type, account?.type)) throw incomeOnLiability(INCOME_ON_LIABILITY_SPLIT_ERROR);
  }

  // The splits add up to the parent, to the cent, checked before anything is
  // written: a re-split deletes the existing children below.
  const splitsCents = splitCents.reduce((sum, cents) => sum + cents, 0);
  const parentCents = toCents(parent.amount ?? '0') ?? 0;
  if (splitsCents !== parentCents) {
    logger.warn({
      uuid,
      parentAmount: centsToNumber(parentCents),
      splitsSum: centsToNumber(splitsCents),
      difference: centsToNumber(Math.abs(splitsCents - parentCents)),
    }, 'Split amounts do not sum to parent amount');
    throw badRequest('Split amounts must sum to transaction amount', {
      expected: centsToNumber(parentCents),
      actual: centsToNumber(splitsCents),
    });
  }

  await resolveSplits(splits);

  // A re-split replaces the splits there are, locked first, after the parent, in id order:
  // one held by another write (a bulk edit) is then a 409, not a 500 at the delete.
  if (parent.is_split_parent) {
    await lockSplitsForDelete(parent.id);
    await db.deleteFrom('transactions').where('parent_transaction_id', '=', parent.id).execute();
    logger.info({ parentId: parent.id }, 'Deleted existing splits for re-split');
  }

  // Mark parent as split and clear its ENVELOPE assignment only.
  //
  // The envelope moves to the children (calculate_actual_for_period_item
  // excludes is_split_parent rows), so budget_item_id/budget_period_item_id
  // must be cleared. But budget_period_id is deliberately KEPT: the parent
  // is the row that carries the money for account/period reconciliation.
  // The zero-balance close-out sums PARENTS only
  // (`parent_transaction_id IS NULL AND budget_period_id = <period>`), so a
  // parent with a null period still counts toward the account balance while
  // silently dropping out of the period — leaving an unexplainable gap.
  await db
    .updateTable('transactions')
    .set({ is_split_parent: true, budget_item_id: null, budget_period_item_id: null })
    .where('id', '=', parent.id)
    .execute();

  // The splits, which take the parent's type, status, account, merchant, date, review
  // status and assignee. Their (tag, split) pairs go in one insert after.
  let childCount = 0;
  const childTagTagIds: number[] = [];
  const childTagChildIds: number[] = [];
  for (const [index, split] of splits.entries()) {
    const child = await db
      .insertInto('transactions')
      .values({
        parent_transaction_id: parent.id,
        amount: centsToAmount(present(splitCents[index], "each split's cents")),
        description: split.description || parent.description,
        type: parent.type,
        status: parent.status,
        account_id: parent.account_id,
        merchant_id: parent.merchant_id,
        transaction_date: parent.transaction_date,
        review_status: parent.review_status,
        assigned_to: parent.assigned_to,
        budget_item_id: split.budget_item_id || null,
        budget_period_id: split.budget_period_id || null,
        budget_period_item_id: split.budget_period_item_id || null,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    childCount++;
    if (Array.isArray(split.tag_ids)) {
      for (const tagId of split.tag_ids as number[]) {
        childTagTagIds.push(tagId);
        childTagChildIds.push(child.id);
      }
    }
  }
  if (childTagTagIds.length > 0) {
    await sql`
      INSERT INTO taggings (tag_id, taggable_type, taggable_id)
      SELECT u.tag_id, 'transaction', u.child_id
      FROM UNNEST(${childTagTagIds}::int[], ${childTagChildIds}::int[]) AS u(tag_id, child_id)
      ON CONFLICT DO NOTHING
    `.execute(db);
  }

  logger.info({ parentId: parent.id, parentUuid: uuid, childCount }, 'Transaction split successfully');

  // The parent with its names, tags and splits (each with its budget item and tags), as
  // GET /:uuid answers it: the split answer listed the splits without them.
  const updated = await getTransactionDetail(uuid);
  // The parent was locked and updated in this transaction: not finding it is an internal failure (a 500).
  if (!updated) throw new Error('The split parent could not be read back');
  return updated;
}

/** Delete a split transaction's splits; it is an ordinary transaction again. */
export async function unsplitTransaction(uuid: string): Promise<Selectable<Transactions>> {
  const db = getDb();
  // The parent, locked before its splits are (locks.ts): deleting the splits first and
  // then updating the parent deadlocked with Delete Transactions, which locks the parent
  // first. An edit or a split of it made meanwhile waits for this one too. Then its splits,
  // which it deletes. A lock held too long is a 409 TRANSACTION_BUSY.
  const parent = await lockingTransactions(() =>
    db
      .selectFrom('transactions')
      .selectAll()
      .where('uuid', '=', uuid)
      .where('is_split_parent', '=', true)
      .forUpdate()
      .executeTakeFirst()
  );
  if (!parent) throw notFound('Split transaction not found');

  await lockSplitsForDelete(parent.id);
  await db.deleteFrom('transactions').where('parent_transaction_id', '=', parent.id).execute();
  await db.updateTable('transactions').set({ is_split_parent: false }).where('id', '=', parent.id).execute();

  logger.info({ parentId: parent.id, parentUuid: uuid }, 'Transaction unsplit successfully');

  return db.selectFrom('transactions').selectAll().where('uuid', '=', uuid).executeTakeFirstOrThrow();
}
