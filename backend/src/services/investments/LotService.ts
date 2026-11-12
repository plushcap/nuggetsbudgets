import { sql, type Selectable } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import type { TaxLots } from '../../db/schema.generated.js';
import { appToday } from '../../utils/appDate.js';
import { createLogger } from '../../utils/logger.js';
import { DomainError } from '../domainErrors.js';
import { isLockConflict } from '../transactions/locks.js';
import { isUuid } from '../../middleware/routeParams.js';
import { insertHoldingEvent } from './HoldingsService.js';
import { lockSecurityLots } from './WashSaleService.js';

const logger = createLogger({ service: 'LotService' });

/** A refusal of a change to a tax lot. */
export class LotError extends DomainError {}

/** No lot with this uuid in the ledger (RLS hides another ledger's). */
const lotMissing = (): LotError => new LotError(404, 'LOT_NOT_FOUND', 'Lot not found');

/** A sale under average cost pooled the lot by its covered status as it is. */
const lotPooled = (): LotError =>
  new LotError(
    409,
    'LOT_POOLED',
    "A sale under average cost may have pooled this lot, or the lot a merger or spinoff made it from, by its covered status as it is: that sale's basis, and the basis of the lots it re-based, were worked out from it. Its covered status can't be changed now."
  );

/** The lot's security is held by a corporate action under way, or a sale: try again. */
const lotBusy = (): LotError =>
  new LotError(409, 'RECORD_BUSY', 'Another change to this security\'s lots was being saved at the same time, so nothing was changed. Try again.');

/**
 * `WITH RECURSIVE chain`: lot `uuid` and every lot it was made from (parent_lot_id), however
 * many, each with its account, security, acquisition date, the event that created it
 * (`made_by`) and the event that created the next lot down from it (`next_made_by`, null for
 * the lot itself). A loop in parent_lot_id (no app path makes one) ends where a lot comes round
 * again (CYCLE).
 */
const lotChain = (uuid: string) => sql`
  WITH RECURSIVE chain(id, parent_lot_id, account_id, security_id, acquired, made_by, next_made_by) AS (
    SELECT id, parent_lot_id, account_id, security_id, acquisition_date, created_by_event_id, NULL::int
      FROM tax_lots WHERE uuid = ${uuid}::uuid
    UNION ALL
    SELECT p.id, p.parent_lot_id, p.account_id, p.security_id, p.acquisition_date, p.created_by_event_id, c.made_by
      FROM tax_lots p JOIN chain c ON p.id = c.parent_lot_id
  ) CYCLE id SET in_loop USING path`;

/**
 * Corrections to a ledger's tax lots: what the buy, sale and import paths
 * (HoldingsService) don't change once a lot is written.
 */
export class LotService {
  /**
   * Set whether lot `uuid` is covered (broker basis reporting), the flag average cost pools
   * lots by (costBasis.ts planSell: covered and noncovered lots are separate pools), and answer
   * the lot. Nothing changes when it already says so. A change is recorded as a lot_correction
   * holding event (who, when, from and to).
   *
   * Refused (409 LOT_POOLED) once an average-cost sale (one with no recorded method counts
   * too) could have pooled the lot, or a lot it was made from, by the flag as it is: that sale
   * took its basis from the pools as the flags stood, and re-based every lot of the pool it
   * sold from, so a new flag would leave those figures worked out from the old one. A sale of
   * a lot's security in that lot's account counts for it when it is dated on or after the lot
   * was acquired, or was recorded after the lot was (before 73a263d1 a sale entered late, dated
   * before a lot was bought, still pooled it; one recorded later is counted whatever its date:
   * refusing a correction is safe, allowing a wrong one isn't).
   *
   * A lot a stock merger or a spinoff made (parent_lot_id) carries its parent's flag and basis
   * as they were when the action was recorded, so each lot up the chain counts too, each with
   * its own account, security and acquisition date (such a lot answered 200 when
   * its parent had been pooled), but only for a sale recorded before the next lot down was made
   * from it (an event id below that lot's created_by_event_id): an action
   * can be dated before a sale recorded ahead of it, and its child took the parent as that sale
   * left it, while a sale recorded after a spinoff re-bases the source, not the lot made from
   * it. A sale and a corporate action of a security both lock it (lockSecurityLots, FOR UPDATE),
   * so the order their events were recorded in is the order they took effect in.
   *
   * Any other sale, of this lot or others, took each lot's own basis, which the flag doesn't
   * enter, so a lot partly or wholly sold that way can be corrected. Lots a spinoff or a merger
   * made from this one keep their own flag.
   *
   * The lots of every security in the chain are locked first, in id order (lockSecurityLots),
   * as a sale locks them, so a sale under way is waited for and then seen. A wait past the lock
   * timeout, or a deadlock, is a 409 RECORD_BUSY.
   */
  async setCovered(uuid: string, isCovered: boolean, userId?: number): Promise<Selectable<TaxLots>> {
    if (!isUuid(uuid)) throw lotMissing();
    // A lot's chain never changes once written (its parent, security, account and acquisition date).
    const chain = (await sql<{ security_id: number }>`${lotChain(uuid)} SELECT security_id FROM chain`.execute(getDb())).rows;
    if (chain.length === 0) throw lotMissing();
    try {
      for (const securityId of [...new Set(chain.map((r) => r.security_id))].sort((x, y) => x - y)) await lockSecurityLots(securityId);
    } catch (err) {
      if (!isLockConflict(err)) throw err;
      logger.warn({ err }, "A lot correction could not lock its securities' lots in time; nothing changed");
      throw lotBusy();
    }
    const lot = await getDb().selectFrom('tax_lots').selectAll().where('uuid', '=', uuid).executeTakeFirst();
    if (!lot) throw lotMissing();
    if (lot.is_covered === isCovered) return lot;

    const pooledBy = await sql<{ id: number }>`
      ${lotChain(uuid)}
      SELECT he.id
        FROM chain c
        JOIN holding_events he ON he.account_id = c.account_id AND he.security_id = c.security_id
       WHERE he.event_type = 'sell'
         AND COALESCE(he.metadata->>'method', 'average_cost') = 'average_cost'
         AND (he.event_date >= c.acquired OR he.id > c.made_by)
         AND (c.next_made_by IS NULL OR he.id < c.next_made_by)
       LIMIT 1
    `.execute(getDb());
    if (pooledBy.rows.length > 0) throw lotPooled();

    const event = await insertHoldingEvent({
      account_id: lot.account_id,
      security_id: lot.security_id,
      user_id: userId ?? null,
      event_type: 'lot_correction',
      event_date: await appToday(),
      source: 'manual',
      description: isCovered ? 'Lot marked covered' : 'Lot marked noncovered',
      metadata: sql`${JSON.stringify({ lot_uuid: lot.uuid, is_covered: { from: lot.is_covered, to: isCovered } })}::jsonb`,
    });
    const updated = await getDb().updateTable('tax_lots').set({ is_covered: isCovered }).where('id', '=', lot.id).returningAll().executeTakeFirstOrThrow();
    logger.info({ lotId: lot.id, eventId: event.id }, "Corrected a lot's covered status");
    return updated;
  }
}
