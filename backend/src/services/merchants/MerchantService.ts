import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { getDb, withSavepoint } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { containsPattern } from '../../utils/likePattern.js';
import { isUuid } from '../../middleware/routeParams.js';
import { storeImage, imageUrl, deleteImageByUrl, isTenantImageUrl } from '../ImageService.js';
import { isMerchantNameConflict, merchantNameConflictTarget } from '../merchantNames.js';
import { asId, firstMissingReference } from '../tenantReferences.js';
import { applyMerchantAutoTags } from '../tags/TaggingService.js';
import { lockRowsForDelete, lockTransactions } from '../transactions/locks.js';
import {
  merchantImageNotAllowed,
  merchantInUse,
  merchantInvalidReference,
  merchantNameTaken,
  merchantNotFound,
  merchantNotFoundBrief,
  mergeMerchantNotFound,
  mergeWithItself,
  noImageUploaded,
  replacementNotFound,
  replacesItself,
} from './MerchantError.js';
import { oneRow } from '../../utils/present.js';

const logger = createLogger({ service: 'MerchantService' });

/**
 * A merchant's own columns, as a single merchant, a create, an update and an image upload
 * answer them (merchantResponseSchema). Its auto-tag is one of them: Edit Merchant seeds its
 * picker from it, and saving sends it back; without it the edit cleared it.
 */
const MERCHANT_COLUMNS = [
  'id', 'uuid', 'name', 'merchant_website', 'merchant_accountid', 'merchant_image', 'notes', 'instructions',
  'transaction_auto_tag_id', 'created_at', 'updated_at',
] as const;

/** A merchant with how many transactions and matching rules it has, as the full lists answer it. */
export interface MerchantWithCounts {
  id: number;
  uuid: string | null;
  name: string;
  merchant_website: string | null;
  merchant_accountid: string | null;
  merchant_image: string | null;
  notes: string | null;
  instructions: string | null;
  transaction_auto_tag_id: number | null;
  created_at: Date | null;
  updated_at: Date | null;
  transaction_count: number;
  rule_count: number;
}

/** A merchant as a client writes it. Fields not sent are cleared. */
export interface MerchantInput {
  name: string;
  merchant_website?: string | null;
  merchant_accountid?: string | null;
  merchant_image?: unknown;
  notes?: string | null;
  instructions?: string | null;
  /** The tag its transactions get automatically: one of this ledger's tags, or null. */
  transaction_auto_tag_id?: number | null;
}

/** How many rows of each kind point at a merchant. */
export interface MerchantUsage {
  budget_items: number;
  transactions: number;
  recurring: number;
  attachments: number;
}

/**
 * The id of the merchant `uuid` names, or null. Anything that isn't a uuid (a body's
 * targetMerchantUuid, say) names none: get_merchant_id_by_uuid would fail casting it.
 */
export async function merchantIdOf(uuid: unknown): Promise<number | null> {
  if (!isUuid(uuid)) return null;
  const result = await sql<{ merchant_id: number | null }>`SELECT get_merchant_id_by_uuid(${uuid}) as merchant_id`.execute(getDb());
  return result.rows[0]?.merchant_id ?? null;
}

/**
 * Whether a merchant_image a client sent may be stored: none, the merchant's current one
 * unchanged, or one of this ledger's images. Replacing a merchant's image deletes the old
 * one, so naming anything else (another ledger's image, a profile picture) would get it
 * deleted.
 */
async function merchantImageAllowed(sent: unknown, current: string | null = null): Promise<boolean> {
  if (sent === undefined || sent === null || sent === '') return true;
  if (typeof sent !== 'string') return false;
  if (current !== null && sent === current) return true;
  return isTenantImageUrl(getDb(), sent);
}

/** Matches merchants whose name, website or notes contain `term`, ignoring case; its %, _ and \ match themselves. */
function searchCondition(term: string): RawBuilder<boolean> {
  const pattern = containsPattern(term.toLowerCase());
  return sql<boolean>`(
    LOWER(m.name) LIKE ${pattern}
    OR LOWER(m.merchant_website) LIKE ${pattern}
    OR LOWER(m.notes) LIKE ${pattern}
  )`;
}

/**
 * Merchants by name (`id` breaking ties) with their transaction and rule counts,
 * optionally searched and paged.
 *
 * The page is chosen from merchants alone, then counted: joining every
 * transaction and rule first, then grouping, cost the whole history for one page. A
 * page's counts are a lookup per merchant (idx_transactions_merchant); the whole list's
 * are one pass over transactions grouped by merchant, which is cheaper than a lookup
 * for every merchant.
 */
export function merchantsWithCountsQuery(opts: { search?: string; page?: { limit: number; offset: number } } = {}) {
  const page = sql`
    SELECT m.id, m.uuid, m.name, m.merchant_website, m.merchant_accountid, m.merchant_image,
           m.notes, m.instructions, m.transaction_auto_tag_id, m.created_at, m.updated_at
      FROM merchants m
     ${opts.search ? sql`WHERE ${searchCondition(opts.search)}` : sql``}
     ORDER BY m.name ASC, m.id ASC
     ${opts.page ? sql`LIMIT ${opts.page.limit} OFFSET ${opts.page.offset}` : sql``}`;
  const counts = opts.page
    ? sql`
      (SELECT COUNT(*) FROM transactions t WHERE t.merchant_id = p.id) AS transaction_count,
      (SELECT COUNT(*) FROM merchant_matching_rules mr WHERE mr.merchant_id = p.id) AS rule_count
    FROM page p`
    : sql`
      COALESCE(tc.n, 0) AS transaction_count,
      COALESCE(rc.n, 0) AS rule_count
    FROM page p
    LEFT JOIN (SELECT t.merchant_id, COUNT(*) AS n FROM transactions t WHERE t.merchant_id IS NOT NULL GROUP BY t.merchant_id) tc
      ON tc.merchant_id = p.id
    LEFT JOIN (SELECT mr.merchant_id, COUNT(*) AS n FROM merchant_matching_rules mr GROUP BY mr.merchant_id) rc
      ON rc.merchant_id = p.id`;
  return sql<Omit<MerchantWithCounts, 'transaction_count' | 'rule_count'> & { transaction_count: string; rule_count: string }>`
    WITH page AS (${page})
    SELECT p.id, p.uuid, p.name, p.merchant_website, p.merchant_accountid, p.merchant_image,
           p.notes, p.instructions, p.transaction_auto_tag_id, p.created_at, p.updated_at,
      ${counts}
    ORDER BY p.name ASC, p.id ASC
  `;
}

/** {@link merchantsWithCountsQuery}'s rows, with the counts as numbers. */
async function merchantsWithCounts(opts: { search?: string; page?: { limit: number; offset: number } } = {}): Promise<MerchantWithCounts[]> {
  const result = await merchantsWithCountsQuery(opts).execute(getDb());
  return result.rows.map((merchant) => ({
    ...merchant,
    transaction_count: parseInt(merchant.transaction_count, 10),
    rule_count: parseInt(merchant.rule_count, 10),
  }));
}

/**
 * Locks merchants first, in id order, for a write that deletes one and moves its uses to
 * another: the merchant deleted FOR UPDATE (`forDelete`), the one that takes its
 * uses FOR KEY SHARE (what moving a row to it checks, so an edit moving a transaction to it
 * isn't held up). Merging, deleting with a replacement and removing the unused merchants
 * all take their merchants before anything else, so one waits for another holding nothing:
 * locked as they were deleted, after their transactions and rules were moved, two of them
 * deadlocked, which Postgres broke by failing one (a 500, or a 409 TRANSACTION_BUSY). A wait
 * past the pool's lock_timeout is a 409 RECORD_BUSY. Answers the ids still there.
 */
async function lockMerchants(locks: ReadonlyArray<{ id: number; forDelete: boolean }>): Promise<Set<number>> {
  const ordered = [...locks].sort((a, b) => a.id - b.id);
  return lockRowsForDelete('these merchants', async () => {
    const locked = new Set<number>();
    for (const { id, forDelete } of ordered) {
      const row = getDb().selectFrom('merchants').select('id').where('id', '=', id);
      if (await (forDelete ? row.forUpdate() : row.forKeyShare()).executeTakeFirst()) locked.add(id);
    }
    return locked;
  });
}

/**
 * Moves to merchant `toId` what deleting merchant `fromId` would otherwise take with it
 * (ON DELETE CASCADE / SET NULL), other than its rules: its attachments, its budget-item
 * usage counts, and the ledger's balance-adjustment setting. Merging and deleting with a
 * replacement both call it; before v3.0.0, a migration merged duplicate names the same way.
 */
async function moveMerchantRecords(fromId: number, toId: number): Promise<void> {
  await getDb().updateTable('attachments').set({ merchant_id: toId }).where('merchant_id', '=', fromId).execute();

  // One usage row per budget item and merchant: where `toId` has the budget item too, its
  // row takes the other's count and latest use, and the other's row goes.
  await sql`
    UPDATE budget_item_usage_history t
       SET usage_count = COALESCE(t.usage_count, 0) + COALESCE(s.usage_count, 0),
           last_used_date = GREATEST(t.last_used_date, s.last_used_date)
      FROM budget_item_usage_history s
     WHERE s.merchant_id = ${fromId}
       AND t.merchant_id = ${toId}
       AND t.budget_item_id = s.budget_item_id
  `.execute(getDb());
  await sql`
    DELETE FROM budget_item_usage_history s
     USING budget_item_usage_history t
     WHERE s.merchant_id = ${fromId}
       AND t.merchant_id = ${toId}
       AND t.budget_item_id = s.budget_item_id
  `.execute(getDb());
  await getDb().updateTable('budget_item_usage_history').set({ merchant_id: toId }).where('merchant_id', '=', fromId).execute();

  // tenants has no RLS: name the active ledger's row.
  await getDb()
    .updateTable('tenants')
    .set({ balance_adjustment_merchant_id: toId, updated_at: sql<Date>`NOW()` })
    .where('id', '=', sql<number>`current_tenant_id()`)
    .where('balance_adjustment_merchant_id', '=', fromId)
    .execute();
}

/** Points the budget items, transactions and recurring items of merchant `fromId` at `toId`. */
async function moveMerchantUses(fromId: number, toId: number): Promise<void> {
  // The items in id order first, as a zone change and every other write of
  // several items lock them: the UPDATE alone took them in the order it found them, and could
  // hold one another write waited for while it waited for one that write held. FOR NO KEY
  // UPDATE, what the UPDATE takes: a transaction written with one (FOR KEY SHARE) doesn't wait.
  await lockRowsForDelete('these budget items', () =>
    getDb().selectFrom('budget_items').select('id').where('merchant_id', '=', fromId).orderBy('id').forNoKeyUpdate().execute()
  );
  await getDb().updateTable('budget_items').set({ merchant_id: toId }).where('merchant_id', '=', fromId).execute();
  // In id order, as every write of several transactions locks them: a transfer's two
  // sides share their merchant.
  await lockTransactions((eb) => eb('merchant_id', '=', fromId));
  await getDb().updateTable('transactions').set({ merchant_id: toId }).where('merchant_id', '=', fromId).execute();
  await getDb().updateTable('recurring').set({ merchant_id: toId }).where('merchant_id', '=', fromId).execute();
}

/**
 * The ledger's merchants. Names are unique ignoring case (uq_merchants_tenant_lower_name);
 * a website is an http(s) URL (checked by the request schemas); an image is one of
 * the ledger's stored images.
 */
export class MerchantService {
  /** Every merchant by name (then id): with its counts, or `lite`, only what a selector needs. */
  list(lite: boolean) {
    if (lite) {
      return getDb()
        .selectFrom('merchants as m')
        .select(['m.id', 'm.uuid', 'm.name', 'm.merchant_website'])
        .orderBy('m.name', 'asc')
        .orderBy('m.id', 'asc')
        .execute();
    }
    return merchantsWithCounts();
  }

  /**
   * A page of merchants by name (then id), those whose name, website or notes contain `search`
   * when it isn't blank, and how many there are in all. `lite` leaves out the counts,
   * which are the expensive part.
   */
  async listPage(opts: { search: string; limit: number; offset: number; lite: boolean }) {
    const search = opts.search && opts.search.trim().length > 0 ? opts.search.trim() : '';

    let countQuery = getDb()
      .selectFrom('merchants as m')
      .select((eb) => eb.fn.count<string>(eb.ref('m.id')).distinct().as('total'));
    if (search) countQuery = countQuery.where(searchCondition(search));
    const total = parseInt(String((await countQuery.executeTakeFirstOrThrow()).total), 10);

    let merchants: Array<{ id: number; uuid: string | null; name: string; merchant_website: string | null; merchant_image: string | null }>;
    if (opts.lite) {
      let liteQuery = getDb().selectFrom('merchants as m').select(['m.id', 'm.uuid', 'm.name', 'm.merchant_website', 'm.merchant_image']);
      if (search) liteQuery = liteQuery.where(searchCondition(search));
      merchants = await liteQuery.orderBy('m.name', 'asc').orderBy('m.id', 'asc').limit(opts.limit).offset(opts.offset).execute();
    } else {
      merchants = await merchantsWithCounts({ search, page: { limit: opts.limit, offset: opts.offset } });
    }
    return { merchants, total };
  }

  /** Up to ten merchants whose name contains `query` (not blank), for autocomplete: the exact name first, then the shortest. */
  async search(query: string) {
    const term = query.trim().toLowerCase();
    return getDb()
      .selectFrom('merchants')
      .select(['id', 'uuid', 'name', 'merchant_website', 'merchant_image'])
      .where((eb) => eb(eb.fn('lower', ['name']), 'like', containsPattern(term)))
      .orderBy(sql`CASE WHEN LOWER(name) = ${term} THEN 0 ELSE 1 END`)
      .orderBy(sql`LENGTH(name)`)
      .orderBy('name', 'asc')
      .limit(10)
      .execute();
  }

  /** The merchant `uuid` names. */
  async find(uuid: string) {
    const merchantId = await merchantIdOf(uuid);
    if (!merchantId) throw merchantNotFoundBrief();
    // The uuid lookup found it, so the row is there: an internal failure, not a refusal.
    return getDb().selectFrom('merchants').select(MERCHANT_COLUMNS).where('id', '=', merchantId).executeTakeFirstOrThrow();
  }

  /**
   * A new merchant, unless its image isn't the ledger's, its auto-tag isn't one of the
   * ledger's tags, or its name is taken (now, or by a concurrent request). The auto-tag Add
   * Merchant sends was dropped; a new merchant has no transactions to tag yet.
   */
  async create(input: MerchantInput) {
    if (!(await merchantImageAllowed(input.merchant_image))) throw merchantImageNotAllowed();
    // Locked as the insert's foreign key would lock it: a tag deleted meanwhile is a 400 here, not a 500 there.
    const missingTag = await firstMissingReference({ transaction_auto_tag_id: input.transaction_auto_tag_id }, { lock: true });
    if (missingTag) throw merchantInvalidReference(missingTag);

    const created = await getDb()
      .insertInto('merchants')
      .values({
        name: input.name,
        merchant_website: input.merchant_website || null,
        merchant_accountid: input.merchant_accountid || null,
        merchant_image: (input.merchant_image as string | undefined) || null,
        notes: input.notes || null,
        instructions: input.instructions || null,
        transaction_auto_tag_id: asId(input.transaction_auto_tag_id),
      })
      .onConflict((oc) => oc.expression(merchantNameConflictTarget).doNothing())
      .returning(MERCHANT_COLUMNS)
      .executeTakeFirst();
    if (!created) throw merchantNameTaken();
    return created;
  }

  /**
   * Rewrites the merchant `uuid` names; fields not sent are cleared. When its auto-tag
   * changes, the auto-tags are applied again to all of its transactions.
   */
  async update(uuid: string, input: MerchantInput) {
    const merchantId = await merchantIdOf(uuid);
    if (!merchantId) {
      logger.warn({ uuid }, 'Merchant update failed: merchant not found');
      throw merchantNotFound();
    }

    // The merchant first (FOR NO KEY UPDATE, what the UPDATE below takes), then its auto-tag:
    // the order a tag's delete takes them (TagService.remove locks the merchants it empties
    // before it deletes the tag), so the two wait for each other instead of deadlocking.
    const current = await getDb().selectFrom('merchants').selectAll().where('id', '=', merchantId).forNoKeyUpdate().executeTakeFirst();
    if (!current) throw merchantNotFound();

    if (!(await merchantImageAllowed(input.merchant_image, current.merchant_image ?? null))) {
      logger.warn({ uuid }, "Merchant update failed: merchant_image is not one of this tenant's images");
      throw merchantImageNotAllowed();
    }

    // transaction_auto_tag_id names one of this ledger's tags, locked as the UPDATE's
    // foreign key would lock it, as on create: a tag deleted meanwhile is a 400
    // here, where the UPDATE's foreign key check failed it, a 500.
    const missingTag = await firstMissingReference({ transaction_auto_tag_id: input.transaction_auto_tag_id }, { lock: true });
    if (missingTag) throw merchantInvalidReference(missingTag);

    const sameName = await getDb()
      .selectFrom('merchants')
      .select('id')
      .where(sql<boolean>`LOWER(name) = LOWER(${input.name})`)
      .where('uuid', '!=', uuid)
      .executeTakeFirst();
    if (sameName) {
      logger.warn({ uuid, existingMerchantId: sameName.id }, 'Merchant update failed: duplicate name');
      throw merchantNameTaken();
    }

    // A name another merchant took after the check above (a concurrent request) is
    // refused by the unique index: also a name taken. In a savepoint, so the request's
    // transaction can still answer.
    let updated;
    try {
      updated = await withSavepoint(() => updateMerchantRow(merchantId, input));
    } catch (err) {
      if (!isMerchantNameConflict(err)) throw err;
      logger.warn({ uuid }, 'Merchant update failed: duplicate name');
      throw merchantNameTaken();
    }

    const autoTagId = input.transaction_auto_tag_id === undefined ? undefined : asId(input.transaction_auto_tag_id);
    if (autoTagId !== undefined && current.transaction_auto_tag_id !== autoTagId) {
      logger.info(
        { merchantId: updated.id, oldTagId: current.transaction_auto_tag_id, newTagId: autoTagId },
        'Merchant auto-tag rule changed, applying retroactive auto-tagging'
      );
      const count = await applyMerchantAutoTags(updated.id);
      logger.info({ merchantId: updated.id, transactionsUpdated: count }, 'Applied retroactive auto-tags to transactions');
    }

    logger.info({ uuid, merchantId }, 'Merchant updated successfully');
    return updated;
  }

  /**
   * Deletes the merchant `uuid` names. One in use (by budget items, transactions,
   * recurring items or attachments) needs a replacement, given by uuid (merchantDeleteSchema
   * checked it is one), which takes those over. Its matching rules go with it (ON DELETE
   * CASCADE): they describe this merchant, and moved they would change how the
   * replacement's transactions match.
   */
  async remove(uuid: string, replacementUuid: string | null): Promise<void> {
    const merchantId = await merchantIdOf(uuid);
    if (!merchantId) throw merchantNotFound();
    const replacement = replacementUuid
      ? await getDb().selectFrom('merchants').select('id').where('uuid', '=', replacementUuid).executeTakeFirst()
      : undefined;

    // The merchant and its replacement locked first, in id order (lockMerchants): one
    // deleted meanwhile is not found.
    const locked = await lockMerchants([
      { id: merchantId, forDelete: true },
      ...(replacement && replacement.id !== merchantId ? [{ id: replacement.id, forDelete: false }] : []),
    ]);
    if (!locked.has(merchantId)) throw merchantNotFound();

    // Attachments count too: receipts aren't deleted with their merchant (ON DELETE
    // RESTRICT); a replacement merchant takes them.
    const counts = oneRow((
      await sql<{ budget_items_count: string; transactions_count: string; recurring_count: string; attachments_count: string }>`
        SELECT
          (SELECT COUNT(*) FROM budget_items WHERE merchant_id = ${merchantId}) as budget_items_count,
          (SELECT COUNT(*) FROM transactions WHERE merchant_id = ${merchantId}) as transactions_count,
          (SELECT COUNT(*) FROM recurring WHERE merchant_id = ${merchantId}) as recurring_count,
          (SELECT COUNT(*) FROM attachments WHERE merchant_id = ${merchantId}) as attachments_count
      `.execute(getDb())
    ).rows, 'the usage counts');
    const usage: MerchantUsage = {
      budget_items: parseInt(counts.budget_items_count),
      transactions: parseInt(counts.transactions_count),
      recurring: parseInt(counts.recurring_count),
      attachments: parseInt(counts.attachments_count),
    };
    const inUse = usage.budget_items + usage.transactions + usage.recurring + usage.attachments > 0;

    if (inUse && !replacementUuid) throw merchantInUse(usage);

    if (replacementUuid) {
      if (!replacement) throw replacementNotFound();
      if (replacement.id === merchantId) throw replacesItself();
      if (!locked.has(replacement.id)) throw replacementNotFound();

      // Atomic with the delete in the request's transaction.
      await moveMerchantUses(merchantId, replacement.id);
      await moveMerchantRecords(merchantId, replacement.id);
    }

    await getDb().deleteFrom('merchants').where('id', '=', merchantId).execute();
  }

  /**
   * Merges the merchant `sourceUuid` names into `targetUuid`'s and deletes it: the
   * target takes its uses, its matching rules (but those the target has already) and its
   * budget-item rules. Uuids are compared as the ids they name, so another case of the
   * same uuid is the same merchant; a target that isn't a uuid names none.
   */
  async merge(sourceUuid: string, targetUuid: unknown): Promise<void> {
    const sourceId = await merchantIdOf(sourceUuid);
    const targetId = await merchantIdOf(targetUuid);
    if (!sourceId || !targetId) throw mergeMerchantNotFound();
    if (sourceId === targetId) throw mergeWithItself();

    // The source (deleted below) and the target locked first, in id order (lockMerchants).
    // Removing the unused merchants locks them FOR UPDATE and deletes their rules:
    // when the merge moved the source's rules first and locked the source only as it deleted
    // it, each waited for the other, a deadlock (a 500). One gone meanwhile is not found.
    const locked = await lockMerchants([
      { id: sourceId, forDelete: true },
      { id: targetId, forDelete: false },
    ]);
    if (locked.size < 2) throw mergeMerchantNotFound();

    // Atomic in the request's transaction (rolled back on a throw).
    await moveMerchantUses(sourceId, targetId);

    // The source's rules move, except those the target has already, which go.
    await sql`
      DELETE FROM merchant_matching_rules
      WHERE merchant_id = ${sourceId}
      AND (method, matching_text) IN (
        SELECT method, matching_text
        FROM merchant_matching_rules
        WHERE merchant_id = ${targetId}
      )
    `.execute(getDb());
    await getDb().updateTable('merchant_matching_rules').set({ merchant_id: targetId }).where('merchant_id', '=', sourceId).execute();

    // The source's budget-item rules, then what deleting it would otherwise take with it.
    await getDb().updateTable('budget_item_matching_rules').set({ merchant_id: targetId }).where('merchant_id', '=', sourceId).execute();
    await moveMerchantRecords(sourceId, targetId);

    await getDb().deleteFrom('merchants').where('id', '=', sourceId).execute();
  }

  /**
   * Stores an uploaded image (its type taken from its bytes, its metadata stripped) as the
   * merchant's, then deletes the one it replaced so a re-upload doesn't leave it behind.
   */
  async replaceImage(uuid: string, file: { mimetype: string; buffer: Buffer } | undefined, userId: number | null) {
    const merchantId = await merchantIdOf(uuid);
    if (!merchantId) throw merchantNotFound();
    if (!file) throw noImageUploaded();

    const existing = await getDb().selectFrom('merchants').select('merchant_image').where('id', '=', merchantId).executeTakeFirst();
    const imageUuid = await storeImage(getDb(), { mimeType: file.mimetype, data: file.buffer, createdByUserId: userId });
    const updated = await getDb()
      .updateTable('merchants')
      .set({ merchant_image: imageUrl(imageUuid) })
      .where('id', '=', merchantId)
      .returning(MERCHANT_COLUMNS)
      .executeTakeFirst();

    // The old image goes only now, and only when nothing else in the ledger shows it
    // (merchant_image may name an account's or a goal's image too).
    await deleteImageByUrl(getDb(), existing?.merchant_image ?? null);
    return updated;
  }

  /**
   * Deletes the merchants nothing refers to (no transaction, attachment, budget item,
   * recurring item, budget-item rule or budget-item usage history, and not the ledger's
   * balance-adjustment merchant), with their matching rules, and answers them by name.
   *
   * They're locked first, in id order: the delete alone took them in the order it
   * scanned them, and could deadlock with a note written on two of them (lockRowsForDelete).
   * Then each goes only if nothing refers to it as the rows stand once locked: one given a
   * transaction since it was found unused keeps it, where the delete emptied that
   * transaction's merchant. A wait past the pool's lock_timeout is a 409 RECORD_BUSY.
   */
  async removeUnused(): Promise<Array<{ uuid: string; name: string }>> {
    const candidates = await getDb().selectFrom('merchants as m').select('m.id').where(UNUSED_MERCHANT).execute();
    if (candidates.length === 0) return [];
    const locked = await lockRowsForDelete('these merchants', () =>
      getDb()
        .selectFrom('merchants')
        .select('id')
        .where('id', 'in', candidates.map((m) => m.id))
        .orderBy('id')
        .forUpdate()
        .execute()
    );
    if (locked.length === 0) return [];
    return getDb()
      .with('removed', (db) =>
        db
          .deleteFrom('merchants as m')
          .where('m.id', 'in', locked.map((m) => m.id))
          .where(UNUSED_MERCHANT)
          .returning(['m.id', 'm.uuid', 'm.name'])
      )
      .selectFrom('removed')
      .select(['uuid', 'name'])
      .orderBy('name')
      .orderBy('id')
      .execute();
  }
}

/**
 * On `merchants as m`: a merchant nothing refers to. No transaction or attachment, nor
 * anything else its delete would change: it would empty a budget item's merchant, delete
 * its recurring items, budget-item rules and usage history (ON DELETE CASCADE: the counts
 * budget-item suggestions learn from), or clear the ledger's balance-adjustment
 * merchant (tenants has no RLS, so the active ledger's row is named).
 */
const UNUSED_MERCHANT = sql<SqlBool>`
  NOT EXISTS (SELECT 1 FROM transactions t WHERE t.merchant_id = m.id)
  AND NOT EXISTS (SELECT 1 FROM attachments at WHERE at.merchant_id = m.id)
  AND NOT EXISTS (SELECT 1 FROM budget_items bi WHERE bi.merchant_id = m.id)
  AND NOT EXISTS (SELECT 1 FROM recurring r WHERE r.merchant_id = m.id)
  AND NOT EXISTS (SELECT 1 FROM budget_item_matching_rules bir WHERE bir.merchant_id = m.id)
  AND NOT EXISTS (SELECT 1 FROM budget_item_usage_history uh WHERE uh.merchant_id = m.id)
  AND NOT EXISTS (SELECT 1 FROM tenants tn WHERE tn.id = current_tenant_id() AND tn.balance_adjustment_merchant_id = m.id)
`;

/** Writes merchant `merchantId`'s fields; one not sent is cleared. */
function updateMerchantRow(merchantId: number, input: MerchantInput) {
  return getDb()
    .updateTable('merchants')
    .set({
      name: input.name,
      merchant_website: input.merchant_website || null,
      merchant_accountid: input.merchant_accountid || null,
      merchant_image: (input.merchant_image as string | undefined) || null,
      notes: input.notes || null,
      instructions: input.instructions === undefined ? null : input.instructions,
      // The id as a number ('' or null for none), as firstMissingReference read it: '' reached the column, a 500.
      transaction_auto_tag_id: asId(input.transaction_auto_tag_id),
    })
    .where('id', '=', merchantId)
    .returning(MERCHANT_COLUMNS)
    .executeTakeFirstOrThrow();
}
