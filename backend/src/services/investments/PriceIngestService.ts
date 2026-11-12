import { sql } from 'kysely';
import { getDb, withTenant } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { DomainError } from '../domainErrors.js';
import { priceProviderClient, type EodQuote, type PriceProviderClient } from './PriceProviderClient.js';
import { lockSecuritiesForWrite } from './securityLocks.js';
import { PER_SHARE, fitsColumn, numericUnits, unitsToText } from '../../utils/decimal.js';
import { isCalendarDate } from '../../utils/calendarDate.js';

const logger = createLogger({ service: 'PriceIngestService' });

export interface PriceIngestResult {
  total: number; // securities in the pricing universe
  updated: number; // closes written/updated
  failed: number; // securities we wanted a price for and have none written for (the provider returned none, or busy)
  /** Securities whose closes weren't written because another change held them past lock_timeout. */
  busy: number;
}

/** A quote as its security_prices row is written: the close as exact text, rounded to 4 places. */
type PriceRow = { date: string; close: string; volume: number | null };

/**
 * A provider's quote as its row is written, or null for one its columns can't hold: a
 * close that isn't a positive number or is too large for NUMERIC(12,4), or a day that isn't a
 * calendar date. Written as it came, such a close failed its batch's insert, which stopped the
 * ledger's sync at that batch on every run. A volume that isn't a whole number bigint holds is
 * written as none, the close kept.
 */
function priceRow(q: EodQuote): PriceRow | null {
  if (!isCalendarDate(q.date) || !Number.isFinite(q.close) || q.close <= 0) return null;
  let units: bigint;
  try {
    units = numericUnits(q.close, PER_SHARE.scale);
  } catch {
    return null; // a number written with an exponent (1e+21, 1e-7): too large, or rounds to nothing
  }
  // After rounding: a close of 0.00004 is written as 0.0000.
  if (units <= 0n || !fitsColumn(units, PER_SHARE)) return null;
  const volume = q.volume !== null && Number.isSafeInteger(q.volume) && q.volume >= 0 ? q.volume : null;
  return { date: q.date, close: unitsToText(units, PER_SHARE.scale), volume };
}

/** Securities whose closes are written in one transaction: the most held locked at once. */
export const PRICE_WRITE_BATCH = 100;

/**
 * A ledger's price sync that stopped at a batch it couldn't write, for a reason other than a
 * lock (a database error): the batches before it are committed, and `result` counts what they
 * wrote, so the sync run can say so. `cause` is the error, for the log only.
 */
export class PriceIngestFailure extends Error {
  constructor(readonly result: PriceIngestResult, options: { cause: unknown }) {
    super('A price sync stopped at a batch it could not write', options);
    this.name = 'PriceIngestFailure';
  }
}

/**
 * Fetches EOD closes for the current tenant's pricing universe (active securities
 * plus anything with an open lot) and upserts them into security_prices: reads the
 * universe and writes the prices in short transactions of the tenant's, and asks the price
 * provider with none open. Call it outside a transaction.
 *
 * The closes are written in security id order, PRICE_WRITE_BATCH securities per transaction,
 * each batch's securities locked first (lockSecuritiesForWrite): each close's freshness trigger
 * updates its security's row, and in the order the provider answered that deadlocked with a
 * bulk price upsert or a delete of several of them, which lock in id order, and
 * could fail the ledger's whole sync. A batch that can't lock its securities within the pool's
 * lock_timeout (a long delete holds one) is skipped, with nothing of it written: its securities
 * count as failed and as `busy`, which the sync run records for the ledger (a partial run), and
 * the next run tries them again. The other batches are written. A batch that fails for another
 * reason stops the sync there, with what the batches before it wrote committed: it throws a
 * PriceIngestFailure that counts them.
 */
export class PriceIngestService {
  constructor(private readonly provider: PriceProviderClient = priceProviderClient) {}

  async updateMarketPrices(tenantId: number): Promise<PriceIngestResult> {
    // Pricing universe: active securities OR anything currently held.
    const securities = await withTenant(tenantId, () => sql<{ id: number; ticker: string }>`
      SELECT DISTINCT s.id, s.ticker
      FROM securities s
      WHERE s.is_active = true
         OR EXISTS (SELECT 1 FROM tax_lots tl WHERE tl.security_id = s.id AND tl.is_open = true)
    `.execute(getDb()));

    const idByTicker = new Map<string, number>();
    for (const s of securities.rows) idByTicker.set(s.ticker.trim().toUpperCase(), s.id);
    const tickers = [...idByTicker.keys()];
    if (tickers.length === 0) return { total: 0, updated: 0, failed: 0, busy: 0 };

    const quotes = await this.provider.fetchEodCloses(tickers);
    // Each security's closes, in id order, but those their columns can't hold (priceRow): a
    // security left with none counts as failed.
    const bySecurity = new Map<number, PriceRow[]>();
    let unusable = 0;
    for (const q of quotes) {
      const securityId = idByTicker.get(q.ticker.toUpperCase());
      if (securityId == null) continue;
      const row = priceRow(q);
      if (row === null) {
        unusable++;
        continue;
      }
      bySecurity.set(securityId, [...(bySecurity.get(securityId) ?? []), row]);
    }
    if (unusable > 0) logger.warn({ closes: unusable }, "Price sync left out closes the provider sent that can't be stored");
    const ids = [...bySecurity.keys()].sort((a, b) => a - b);

    let updated = 0;
    let busy = 0;
    const priced = new Set<number>();
    for (let i = 0; i < ids.length; i += PRICE_WRITE_BATCH) {
      const batch = ids.slice(i, i + PRICE_WRITE_BATCH);
      try {
        const written = await withTenant(tenantId, async () => {
          // A security deleted since the universe was read is left out (its insert would fail).
          const locked = await lockSecuritiesForWrite({ ids: batch });
          let closes = 0;
          for (const { id } of locked) {
            for (const q of bySecurity.get(id)!) {
              await this.writeClose(id, q);
              closes++;
            }
          }
          return { closes, securities: locked.map((r) => r.id) };
        });
        // Counted once the batch is committed: a batch that fails is rolled back whole.
        updated += written.closes;
        for (const id of written.securities) priced.add(id);
      } catch (err) {
        if (!(err instanceof DomainError && err.code === 'RECORD_BUSY')) {
          const result = { total: tickers.length, updated, failed: tickers.length - priced.size, busy };
          logger.warn(result, 'Price sync stopped at a batch it could not write; the batches before it are saved');
          throw new PriceIngestFailure(result, { cause: err });
        }
        busy += batch.length;
        logger.warn({ securities: batch.length }, 'Price sync skipped securities another change held; the next run will try them again');
      }
    }
    const failed = tickers.length - priced.size;
    logger.info({ total: tickers.length, updated, failed, busy }, 'Updated market prices');
    return { total: tickers.length, updated, failed, busy };
  }

  /** Write a security's close for a day, or replace the one written. */
  private async writeClose(securityId: number, q: PriceRow): Promise<void> {
    await getDb()
      .insertInto('security_prices')
      .values({
        security_id: securityId,
        price_date: q.date,
        close: q.close,
        volume: q.volume,
        source: 'stooq',
      })
      .onConflict((oc) =>
        oc.columns(['security_id', 'price_date']).doUpdateSet((eb) => ({
          close: eb.ref('excluded.close'),
          volume: eb.ref('excluded.volume'),
          source: eb.ref('excluded.source'),
        }))
      )
      .execute();
  }
}
