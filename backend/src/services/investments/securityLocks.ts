import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { isLockConflict } from '../transactions/locks.js';
import { securitiesBusy } from './investmentErrors.js';

const logger = createLogger({ service: 'SecurityLocks' });

/** A security lockSecuritiesForWrite locked, as its row stands once locked. */
export interface LockedSecurity {
  id: number;
  uuid: string;
  ticker: string;
  name: string;
}

/**
 * Lock the securities a write touches several of, in id order, FOR NO KEY UPDATE, before it
 * writes anything (a bulk price upsert, an underlying-holdings snapshot).
 *
 * Such a write locks each security as it reaches it: a price's or a holding row's foreign key
 * takes it FOR KEY SHARE, and a freshness trigger (stamp_security_last_price_update) or the
 * write itself updates its row, which takes FOR NO KEY UPDATE. In the request's order, that
 * deadlocked with a delete of several of them, which locks its rows FOR UPDATE in id order
 * (SecurityService.deleteMany, the pass-through cleanup): holding a higher one, the write
 * went for a lower one the delete held while the delete waited for the higher one, and
 * Postgres broke it by failing one of them. Locked here first, in the same
 * order, the two wait for each other at the first row they share, and go one after the
 * other. FOR NO KEY UPDATE is the strongest lock those writes take, so none of them has to
 * wait again later; it doesn't block a buy or sale (FOR KEY SHARE).
 *
 * Answers the rows locked, as they stand once locked; a uuid or id the ledger hasn't (RLS
 * hides another ledger's), or one a delete removed while this waited for it, is left out, so a
 * caller writes from what this answers, not from what it read before. A wait past the pool's
 * lock_timeout, or a deadlock with a write outside the app, is a 409 RECORD_BUSY to try again,
 * nothing written (the error aborted the transaction).
 */
export async function lockSecuritiesForWrite(which: { ids: number[] } | { uuids: string[] }): Promise<LockedSecurity[]> {
  const securities = () => getDb().selectFrom('securities').select(['id', 'uuid', 'ticker', 'name']);
  const query = 'ids' in which
    ? which.ids.length > 0 ? securities().where('id', 'in', [...new Set(which.ids)]) : null
    : which.uuids.length > 0 ? securities().where('uuid', 'in', [...new Set(which.uuids)]) : null;
  if (!query) return [];
  try {
    return await query.orderBy('id').forNoKeyUpdate().execute();
  } catch (err) {
    if (!isLockConflict(err)) throw err;
    logger.warn({ err }, 'A write could not lock its securities in time; nothing saved');
    throw securitiesBusy();
  }
}
