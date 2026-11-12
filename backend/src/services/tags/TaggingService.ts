import { sql } from 'kysely';
import { getDb, withSavepoint } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { errorCode, errorConstraint } from '../../utils/errors.js';
import { isUuid } from '../../middleware/routeParams.js';
import { firstMissingReference } from '../tenantReferences.js';
import {
  budgetItemAlreadyTagged,
  budgetItemNotFound,
  merchantNotFound,
  namespaceReplaceConflict,
  namespaceTagNotFound,
  namespaceTaken,
  notInNamespace,
  notReportRoot,
  reportRootNotFound,
  tagInvalidReference,
  taggingNotFound,
  transactionAlreadyTagged,
  transactionNotFound,
} from './TagError.js';
import { NAMESPACE_INDEX } from './TagService.js';
import { lockRowsForReference, lockTransactionsForReference, type TransactionsWhere } from '../transactions/locks.js';
import { oneRow } from '../../utils/present.js';
import { taggableType } from '@nuggets/shared';

const logger = createLogger({ service: 'TaggingService' });

/** The tag a budget item already has in a report namespace. */
export interface NamespaceHolder {
  uuid: string | null;
  name: string;
  hierarchy_path: string | null;
}

/**
 * The id of the transaction `uuid` names, locked for a tag put on it or taken off (FOR KEY
 * SHARE): a deletion under way is waited for, and then it's not found; one that starts
 * now waits for this write, and sees it.
 */
async function transactionIdOf(uuid: string): Promise<number | null> {
  const [id] = await lockTransactionsForReference((eb) => eb('uuid', '=', uuid));
  return id ?? null;
}

async function budgetItemIdOf(uuid: string): Promise<number | null> {
  const row = await getDb().selectFrom('budget_items').select('id').where('uuid', '=', uuid).executeTakeFirst();
  return row?.id ?? null;
}

/**
 * {@link budgetItemIdOf}, the item locked for a tag put on it (FOR KEY SHARE), as a
 * transaction is: a deletion under way is waited for, and then it's not found; one that
 * starts now waits for this write, and deletes the tag with the item.
 */
async function lockedBudgetItemIdOf(uuid: string): Promise<number | null> {
  const id = await budgetItemIdOf(uuid);
  if (id === null) return null;
  const [locked] = await lockRowsForReference('budget_item', [id]);
  return locked ?? null;
}

/**
 * Runs apply_transaction_auto_tags over the transactions `where` picks, in one call; how many
 * it tagged. They are locked first (FOR KEY SHARE, in id order: lockTransactionsForReference),
 * and the function is given the ids locked: it takes the same lock itself, but a wait
 * for it past the pool's lock_timeout (Delete Transactions holding them) failed there with
 * 55P03 and answered a 500. Here it is the 409 TRANSACTION_BUSY a tag written on one
 * transaction answers, nothing saved. One deleted meanwhile isn't locked, and isn't
 * tagged.
 */
async function applyAutoTags(where: TransactionsWhere): Promise<number> {
  const ids = await lockTransactionsForReference(where);
  if (ids.length === 0) return 0;
  const result = await sql<{ count: number }>`SELECT apply_transaction_auto_tags(${ids}::int[]) AS count`.execute(getDb());
  return oneRow(result.rows, 'apply_transaction_auto_tags').count;
}

/** Applies the auto-tags to every transaction of merchant `merchantId`; how many it tagged. */
export function applyMerchantAutoTags(merchantId: number): Promise<number> {
  return applyAutoTags((eb) => eb('merchant_id', '=', merchantId));
}

/** Applies the auto-tags to every transaction of budget item `budgetItemId`; how many it tagged. */
export function applyBudgetItemAutoTags(budgetItemId: number): Promise<number> {
  return applyAutoTags((eb) => eb('budget_item_id', '=', budgetItemId));
}

/** The foreign keys of a tagging to its tag, and to the report root its tag is under. */
const TAG_FOREIGN_KEYS = new Set(['taggings_tag_id_fkey', 'taggings_report_root_id_fkey']);

/**
 * Whether a tagging insert was refused because its tag, or the report root its tag is under,
 * was deleted meanwhile: the tag was there when the request looked it up, and its
 * delete committed while the insert's foreign key check waited for it (23503). It answered a
 * 500; the caller answers what the same request answers once the tag is gone. The error
 * aborted the request's transaction (or its savepoint), which the error answer rolls back.
 */
export function isTagDeletedMeanwhile(err: unknown): boolean {
  return errorCode(err) === '23503' && TAG_FOREIGN_KEYS.has(errorConstraint(err) ?? '');
}

/**
 * Tags on transactions and budget items. A budget item has at most one tag of each
 * report namespace (idx_taggings_one_tag_per_report_namespace); `userId` on a write is
 * who made it, for the audit column only.
 */
export class TaggingService {
  /** The tags on the transaction `transactionUuid` names, by name, with their hierarchy path. */
  async transactionTags(transactionUuid: string) {
    const result = await sql<{
      id: number;
      uuid: string | null;
      name: string;
      color: string | null;
      icon: string | null;
      parent_id: number | null;
      level: number | null;
      hierarchy_path: string | null;
    }>`
      SELECT
        t.id, t.uuid, t.name, t.color, t.icon,
        t.parent_id, t.level,
        get_tag_hierarchy_path(t.id) as hierarchy_path
      FROM tags t
      INNER JOIN taggings tg ON tg.tag_id = t.id
      INNER JOIN transactions tr ON tr.id = tg.taggable_id
      WHERE tr.uuid = ${transactionUuid} AND tg.taggable_type = 'transaction'
      ORDER BY t.name ASC
    `.execute(getDb());
    return result.rows;
  }

  /** Tags a transaction with tag `tagId`. A duplicate is refused, and the error answer rolls the request back. */
  async tagTransaction(
    transactionUuid: string,
    tagId: number,
    userId: number
  ): Promise<{ id: number; uuid: string }> {
    const transactionId = await transactionIdOf(transactionUuid);
    if (transactionId === null) throw transactionNotFound();

    const missing = await firstMissingReference({ tag_id: tagId });
    if (missing) throw tagInvalidReference(missing);

    try {
      const created = await getDb()
        .insertInto('taggings')
        .values({ tag_id: tagId, taggable_type: 'transaction', taggable_id: transactionId, user_id: userId, type: 'manual' })
        .returning(['id', 'uuid'])
        .executeTakeFirstOrThrow();
      logger.info({ transactionId, tagId }, 'Tag added to transaction');
      return created;
    } catch (err) {
      if (errorCode(err) === '23505') throw transactionAlreadyTagged();
      // Deleted since firstMissingReference found it: the 400 that check answers.
      if (isTagDeletedMeanwhile(err)) throw tagInvalidReference('tag_id');
      throw err;
    }
  }

  /** Takes tag `tagId` off a transaction. */
  async untagTransaction(
    transactionUuid: string,
    tagId: number
  ): Promise<void> {
    const transactionId = await transactionIdOf(transactionUuid);
    if (transactionId === null) throw transactionNotFound();

    const deleted = await getDb()
      .deleteFrom('taggings')
      .where('tag_id', '=', tagId)
      .where('taggable_type', '=', taggableType.enum.transaction)
      .where('taggable_id', '=', transactionId)
      .returning('id')
      .execute();
    if (deleted.length === 0) throw taggingNotFound('transaction');

    logger.info({ transactionId, tagId }, 'Tag removed from transaction');
  }

  /** The tags on the budget item `budgetItemUuid` names, by namespace (none last), then name. */
  async budgetItemTags(budgetItemUuid: string) {
    const result = await sql<{
      id: number;
      uuid: string | null;
      name: string;
      color: string | null;
      icon: string | null;
      parent_id: number | null;
      level: number | null;
      hierarchy_path: string | null;
      report_root_id: number | null;
      report_root_uuid: string | null;
      report_root_name: string | null;
    }>`
      SELECT
        t.id,
        t.uuid,
        t.name,
        t.color,
        t.icon,
        t.parent_id,
        t.level,
        get_tag_hierarchy_path(t.id) AS hierarchy_path,
        tg.report_root_id,
        rr.uuid AS report_root_uuid,
        rr.name AS report_root_name
      FROM tags t
      INNER JOIN taggings tg ON tg.tag_id = t.id
      INNER JOIN budget_items bi ON bi.id = tg.taggable_id
      LEFT JOIN tags rr ON rr.id = tg.report_root_id
      WHERE bi.uuid = ${budgetItemUuid}
        AND tg.taggable_type = 'budget_item'
      ORDER BY rr.name NULLS LAST, t.name ASC
    `.execute(getDb());

    logger.info({ budgetItemUuid, tagCount: result.rows.length }, 'Retrieved budget item tags');
    return result.rows;
  }

  /**
   * Tags a budget item with tag `tagId`. Refused when the item has that tag already, or
   * another tag of its report namespace (`existing` names that one).
   */
  async tagBudgetItem(
    budgetItemUuid: string,
    tagId: number,
    userId: number
  ): Promise<{ id: number; uuid: string }> {
    const budgetItemId = await lockedBudgetItemIdOf(budgetItemUuid);
    if (budgetItemId === null) throw budgetItemNotFound();

    const missing = await firstMissingReference({ tag_id: tagId });
    if (missing) throw tagInvalidReference(missing);

    let created: { id: number; uuid: string };
    try {
      // In a savepoint: the conflict lookups below still have to run in this transaction.
      created = await withSavepoint(() =>
        getDb()
          .insertInto('taggings')
          .values({ tag_id: tagId, taggable_type: 'budget_item', taggable_id: budgetItemId, user_id: userId, type: 'manual' })
          .returning(['id', 'uuid'])
          .executeTakeFirstOrThrow()
      );
    } catch (err) {
      // Deleted since firstMissingReference found it: the 400 that check answers.
      if (isTagDeletedMeanwhile(err)) throw tagInvalidReference('tag_id');
      if (errorCode(err) !== '23505') throw err;
      // The namespace index fires before the plain unique key, so tell a namespace held by
      // another tag from this same tag being on the item already.
      if (errorConstraint(err) === NAMESPACE_INDEX) {
        const holder = await sql<NamespaceHolder>`
          SELECT t.uuid, t.name, get_tag_hierarchy_path(t.id) AS hierarchy_path
          FROM taggings tg
          INNER JOIN tags t ON t.id = tg.tag_id
          WHERE tg.taggable_type = 'budget_item'
            AND tg.taggable_id = ${budgetItemId}
            AND tg.report_root_id = (SELECT get_tag_report_root(${tagId}))
            AND tg.tag_id != ${tagId}
          LIMIT 1
        `.execute(getDb());
        const alreadyTagged =
          !holder.rows[0] &&
          (await getDb()
            .selectFrom('taggings')
            .select('id')
            .where('taggable_type', '=', taggableType.enum.budget_item)
            .where('taggable_id', '=', budgetItemId)
            .where('tag_id', '=', tagId)
            .executeTakeFirst());
        if (!alreadyTagged) throw namespaceTaken(holder.rows[0] || null);
      }
      throw budgetItemAlreadyTagged();
    }

    logger.info({ budgetItemId, tagId }, 'Tag added to budget item');
    return created;
  }

  /**
   * Sets the budget item's tag in the namespace of report root `rootTagUuid` to the tag
   * `tagUuid` names (one of that namespace's), or clears it for null, in one step.
   */
  async setBudgetItemNamespaceTag(
    budgetItemUuid: string,
    rootTagUuid: string,
    tagUuid: string | null | undefined,
    userId: number
  ): Promise<{ tagId: number | null; tagging: { id: number; uuid: string; tag_id: number; report_root_id: number | null } | null }> {
    const budgetItemId = await lockedBudgetItemIdOf(budgetItemUuid);
    if (budgetItemId === null) throw budgetItemNotFound();

    const root = await getDb().selectFrom('tags').select(['id', 'is_report_root']).where('uuid', '=', rootTagUuid).executeTakeFirst();
    if (!root) throw reportRootNotFound();
    if (!root.is_report_root) throw notReportRoot();

    let newTagId: number | null = null;
    if (tagUuid !== null && tagUuid !== undefined) {
      // A string that isn't a uuid names no tag; the lookup would fail casting it.
      if (!isUuid(tagUuid)) throw namespaceTagNotFound();
      const tag = await getDb().selectFrom('tags').select('id').where('uuid', '=', tagUuid).executeTakeFirst();
      if (!tag) throw namespaceTagNotFound();
      newTagId = tag.id;
      const namespace = await sql<{ root_id: number | null }>`SELECT get_tag_report_root(${newTagId}) AS root_id`.execute(getDb());
      if (oneRow(namespace.rows, 'get_tag_report_root').root_id !== root.id) throw notInNamespace();
    }

    let tagging;
    try {
      // In a savepoint, so a unique violation from a concurrent writer undoes just this
      // delete and insert.
      tagging = await withSavepoint(async () => {
        await getDb()
          .deleteFrom('taggings')
          .where('taggable_type', '=', taggableType.enum.budget_item)
          .where('taggable_id', '=', budgetItemId)
          .where('report_root_id', '=', root.id)
          .execute();
        return newTagId === null
          ? null
          : getDb()
              .insertInto('taggings')
              .values({ tag_id: newTagId, taggable_type: 'budget_item', taggable_id: budgetItemId, user_id: userId, type: 'manual' })
              .returning(['id', 'uuid', 'tag_id', 'report_root_id'])
              .executeTakeFirstOrThrow();
      });
    } catch (err) {
      if (errorCode(err) === '23505' && errorConstraint(err) === NAMESPACE_INDEX) throw namespaceReplaceConflict();
      // Deleted since it was looked up: the 404 that lookup answers.
      if (isTagDeletedMeanwhile(err)) throw namespaceTagNotFound();
      throw err;
    }

    logger.info({ budgetItemId, rootTagId: root.id, newTagId }, 'Budget item namespace tag replaced');
    return { tagId: newTagId, tagging };
  }

  /** Takes tag `tagId` off a budget item. */
  async untagBudgetItem(
    budgetItemUuid: string,
    tagId: number
  ): Promise<void> {
    const budgetItemId = await budgetItemIdOf(budgetItemUuid);
    if (budgetItemId === null) throw budgetItemNotFound();

    const deleted = await getDb()
      .deleteFrom('taggings')
      .where('tag_id', '=', tagId)
      .where('taggable_type', '=', taggableType.enum.budget_item)
      .where('taggable_id', '=', budgetItemId)
      .returning('id')
      .execute();
    if (deleted.length === 0) throw taggingNotFound('budget item');

    logger.info({ budgetItemId, tagId }, 'Tag removed from budget item');
  }

  /** Applies the auto-tags again to every transaction of a budget item; how many it tagged. */
  async autoTagBudgetItem(budgetItemUuid: string): Promise<number> {
    const budgetItemId = await budgetItemIdOf(budgetItemUuid);
    if (budgetItemId === null) throw budgetItemNotFound();
    const count = await applyBudgetItemAutoTags(budgetItemId);
    logger.info({ budgetItemId, transactionCount: count }, 'Retroactively applied auto-tags for budget item');
    return count;
  }

  /** Applies the auto-tags again to every transaction of a merchant; how many it tagged. */
  async autoTagMerchant(merchantUuid: string): Promise<number> {
    const merchant = await getDb().selectFrom('merchants').select('id').where('uuid', '=', merchantUuid).executeTakeFirst();
    if (!merchant) throw merchantNotFound();
    const count = await applyMerchantAutoTags(merchant.id);
    logger.info({ merchantId: merchant.id, transactionCount: count }, 'Retroactively applied auto-tags for merchant');
    return count;
  }
}
