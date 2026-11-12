import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { notFound } from './refusal.js';
import { tagIdByUuid } from './lookup.js';
import { lockTransactionsForReference } from './locks.js';
import { isTagDeletedMeanwhile } from '../tags/TaggingService.js';
import { taggableType } from '@nuggets/shared';

/** Tagging one transaction (POST/DELETE /api/transactions/:uuid/tags/:tagUuid). */

const logger = createLogger({ service: 'TransactionTags' });

/**
 * Both ids, or the 404 for the first that names nothing: the transaction, then the tag. The
 * transaction is locked first (FOR KEY SHARE): a deletion under way is waited for, and
 * then it's not found, and one that starts now waits for this tag.
 */
async function resolve(uuid: string, tagUuid: string): Promise<{ transactionId: number; tagId: number }> {
  const [transactionId] = await lockTransactionsForReference((eb) => eb('uuid', '=', uuid));
  const tagId = await tagIdByUuid(tagUuid);
  if (!transactionId) throw notFound('Transaction not found');
  if (!tagId) throw notFound('Tag not found');
  return { transactionId, tagId };
}

/** Tag a transaction; tagging it again changes nothing. */
export async function addTransactionTag(uuid: string, tagUuid: string): Promise<void> {
  const { transactionId, tagId } = await resolve(uuid, tagUuid);
  try {
    await getDb()
      .insertInto('taggings')
      .values({ tag_id: tagId, taggable_type: 'transaction', taggable_id: transactionId })
      .onConflict((oc) => oc.columns(['tenant_id', 'tag_id', 'taggable_type', 'taggable_id']).doNothing())
      .execute();
  } catch (err) {
    // Deleted since resolve() found it: the 404 resolve answers, not a 500.
    if (isTagDeletedMeanwhile(err)) throw notFound('Tag not found');
    throw err;
  }
  logger.info({ transactionId, tagId }, 'Tag applied to transaction');
}

/** Take a tag off a transaction (nothing to take off is fine). */
export async function removeTransactionTag(uuid: string, tagUuid: string): Promise<void> {
  const { transactionId, tagId } = await resolve(uuid, tagUuid);
  await getDb()
    .deleteFrom('taggings')
    .where('tag_id', '=', tagId)
    .where('taggable_type', '=', taggableType.enum.transaction)
    .where('taggable_id', '=', transactionId)
    .execute();
  logger.info({ transactionId, tagId }, 'Tag removed from transaction');
}
