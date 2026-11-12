import { sql, type Selectable } from 'kysely';
import { CALENDAR_DAY_YEARS, isCalendarDay, type SecurityCreateInput, type SecurityUpdateInput } from '@nuggets/shared';
import { getDb, withSavepoint } from '../../db/withTenant.js';
import type { Securities } from '../../db/schema.generated.js';
import { createLogger } from '../../utils/logger.js';
import { containsPattern } from '../../utils/likePattern.js';
import { publicErrorMessage } from '../../utils/apiError.js';
import { EXPENSE_RATIO_PERCENT, PER_SHARE, WHOLE, requestUnits, unitsToText, type DecimalValue } from '../../utils/decimal.js';
import { DomainError } from '../domainErrors.js';
import { notFoundError } from '../controlPlaneErrors.js';
import { lockRowsForDelete } from '../transactions/locks.js';
import { isUuid } from '../../middleware/routeParams.js';
import { errorCode, errorConstraint } from '../../utils/errors.js';
import { SECURITY_TICKER_KEY, securitiesBusy, securityExists, securityHeld, securityMissing } from './investmentErrors.js';
import { lockSecuritiesForWrite } from './securityLocks.js';

const logger = createLogger({ service: 'SecurityService' });

/** A price as POST /prices and each of POST /prices/bulk's records take it (priceUpsertSchema). */
export interface PriceInput {
  security_uuid: string;
  price_date: string;
  close: DecimalValue;
  adjusted_close?: DecimalValue | null | undefined;
  volume?: DecimalValue | null | undefined;
  source?: string | undefined;
}

/** One record's outcome in a bulk price upsert. */
export interface PriceUpsertResult {
  index: number;
  ok: boolean;
  error?: string;
}

/** A security row, as the catalog answers it. */
export type SecurityRow = Selectable<Securities>;

/** The fields of a security a request may set, beside its expense ratio (read exactly). */
const PLAIN_FIELDS = ['ticker', 'name', 'security_type', 'exchange', 'currency', 'is_active', 'is_custom', 'is_pass_through', 'track_underlying_holdings', 'notes'] as const;

/** A request's expense ratio, read as sent, as exact text for NUMERIC(6,4). */
function expenseRatioText(value: DecimalValue | null | undefined): string | null {
  return value != null ? unitsToText(requestUnits(value, 'expense_ratio_percentage', EXPENSE_RATIO_PERCENT), EXPENSE_RATIO_PERCENT.scale) : null;
}

/** A price's figures, read as sent, to the columns' places: a close of 12.34567 is refused, not rounded. */
function priceFigures(p: PriceInput) {
  return {
    close: unitsToText(requestUnits(p.close, 'close', PER_SHARE), PER_SHARE.scale),
    adjusted_close: p.adjusted_close != null ? unitsToText(requestUnits(p.adjusted_close, 'adjusted_close', PER_SHARE), PER_SHARE.scale) : null,
    volume: p.volume != null ? unitsToText(requestUnits(p.volume, 'volume', WHOLE), WHOLE.scale) : null,
  };
}

/**
 * The security of the ledger with this ticker, in any case, and this exchange (none matching
 * none), other than `exceptUuid`: the one {@link SECURITY_TICKER_KEY} lets the ledger have. On
 * ticker_key and exchange, plain columns the key's index serves under RLS.
 */
async function securityWithTicker(ticker: string, exchange: string | null, exceptUuid?: string): Promise<SecurityRow | undefined> {
  let q = getDb().selectFrom('securities').selectAll().where('ticker_key', '=', sql<string>`upper(${ticker}::text)`);
  q = exchange === null ? q.where('exchange', 'is', null) : q.where('exchange', '=', storedExchange(exchange));
  if (exceptUuid !== undefined) q = q.where('uuid', '!=', exceptUuid);
  return q.executeTakeFirst();
}

/**
 * An exchange as it is stored and compared (securities_exchange_normalized):
 * upper case as the database has it. The request schema trims it and upper-cases
 * it already; writing the database's own upper() keeps the stored value what the check compares.
 */
const storedExchange = (exchange: string) => sql<string>`upper(${exchange}::text)`;

/**
 * Write a security (`write`, in a savepoint) unless another has its ticker and exchange (`key`,
 * read when called: an update reads them from its row, locked): then a 409 SECURITY_EXISTS that
 * answers that one. Checked first, and again when the write hits
 * {@link SECURITY_TICKER_KEY} (a request that wrote the same ticker meanwhile, which the key's
 * index waited for): the savepoint keeps the request's transaction usable to read it. If that one
 * is gone again by then (renamed or deleted since), the write is a 409 RECORD_BUSY to try again,
 * never the key's error (a 500).
 */
async function writeUnlessTickerTaken<T>(key: { ticker: string; exchange: string | null }, exceptUuid: string | undefined, write: () => Promise<T>): Promise<T> {
  const taken = await securityWithTicker(key.ticker, key.exchange, exceptUuid);
  if (taken) throw securityExists(taken);
  try {
    return await withSavepoint(write);
  } catch (err) {
    if (errorCode(err) !== '23505' || errorConstraint(err) !== SECURITY_TICKER_KEY) throw err;
    const existing = await securityWithTicker(key.ticker, key.exchange, exceptUuid);
    throw existing ? securityExists(existing) : securitiesBusy();
  }
}

/** Securities a delete may remove: not held (no tax lots, no holding events). */
const notHeld = sql`
  NOT EXISTS (SELECT 1 FROM tax_lots tl WHERE tl.security_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM holding_events he WHERE he.security_id = s.id)`;

/** Pass-through funds nothing uses: not held, and not an underlying of another fund. */
const passThroughUnused = sql`
  s.is_pass_through = true
    AND ${notHeld}
    AND NOT EXISTS (SELECT 1 FROM fund_underlying_holdings fuh WHERE fuh.underlying_security_id = s.id)`;

/**
 * The ledger's securities catalog: listing, searching, creating, editing and
 * deleting securities, their prices, and the cleanups of unused ones. Every query runs on
 * getDb(), the request's tenant transaction, so RLS keeps it to the active ledger.
 */
export class SecurityService {
  /** Every security (active ones only, unless `includeInactive`), by ticker, with its latest close. */
  async list(input: { includeInactive: boolean }) {
    let q = getDb()
      .selectFrom('securities')
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('security_prices as sp')
            .select(['sp.close as latest_price'])
            .whereRef('sp.security_id', '=', 'securities.id')
            .orderBy('sp.price_date', 'desc')
            .limit(1)
            .as('lp'),
        (join) => join.onTrue()
      )
      .selectAll('securities')
      .select('lp.latest_price')
      .orderBy('securities.ticker');
    if (!input.includeInactive) q = q.where('securities.is_active', '=', true);
    return q.execute();
  }

  /**
   * One page of the catalog, searched by ticker or name (the term's own %, _ and \ match
   * themselves), with the count of all that match. Kept apart from {@link list} so the
   * security pickers that need the whole list keep working unchanged.
   */
  async listPage(input: { page: number; limit: number; offset: number; includeInactive: boolean; search: string }) {
    const { page, limit, offset } = input;
    let base = getDb().selectFrom('securities');
    if (!input.includeInactive) base = base.where('securities.is_active', '=', true);
    if (input.search) {
      const like = containsPattern(input.search);
      base = base.where((eb) => eb.or([eb('securities.ticker', 'ilike', like), eb('securities.name', 'ilike', like)]));
    }

    const totalRow = await base.select((eb) => eb.fn.countAll().as('count')).executeTakeFirst();
    const total = Number(totalRow?.count ?? 0);

    const data = await base
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('security_prices as sp')
            .select(['sp.close as latest_price'])
            .whereRef('sp.security_id', '=', 'securities.id')
            .orderBy('sp.price_date', 'desc')
            .limit(1)
            .as('lp'),
        (join) => join.onTrue()
      )
      .selectAll('securities')
      .select('lp.latest_price')
      .orderBy('securities.ticker')
      .orderBy('securities.id')
      .limit(limit)
      .offset(offset)
      .execute();

    return { data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  }

  /** The pass-through funds the cleanup would delete: how many, and the first 50. */
  async previewPassThroughCleanup() {
    const rows = await sql<{ uuid: string; ticker: string; name: string }>`
      SELECT s.uuid, s.ticker, s.name FROM securities s
      WHERE ${passThroughUnused}
      ORDER BY s.ticker
    `.execute(getDb());
    return { count: rows.rows.length, samples: rows.rows.slice(0, 50) };
  }

  /**
   * Delete the pass-through funds nothing uses (imported, but not held and not an underlying
   * of another fund); the foreign keys' cascades remove their prices and compositions.
   *
   * Locked first, in id order: the delete alone took them in the order it scanned
   * them, and could deadlock with a note written on two of them (lockRowsForDelete). Then
   * each goes only if it is still unused as the rows stand once locked. A wait past the
   * pool's lock_timeout is a 409 RECORD_BUSY to try again, nothing deleted.
   */
  async deletePassThroughUnused() {
    const locked = await lockRowsForDelete('these securities', () =>
      sql<{ id: number }>`SELECT s.id FROM securities s WHERE ${passThroughUnused} ORDER BY s.id FOR UPDATE OF s`.execute(getDb())
    );
    if (locked.rows.length === 0) return { deleted: 0 };
    const result = await sql`
      DELETE FROM securities s WHERE s.id = ANY(${locked.rows.map((r) => r.id)}::int[]) AND ${passThroughUnused}
    `.execute(getDb());
    return { deleted: Number(result.numAffectedRows ?? 0) };
  }

  /**
   * "What can I safely delete?": the securities not held (no tax lots, no holding events),
   * up to `limit`, with how many there are. Catalog entries, stubs an agent created and
   * securities only in a fund's OLD underlying-holdings snapshots all qualify (a delete
   * cascades those rows away); `currently_underlying` flags one in a fund's latest snapshot
   * (informational, not left out).
   */
  async listUnused(input: { search: string; customOnly: boolean; limit: number }) {
    const like = containsPattern(input.search);
    const where = sql`
      ${notHeld}
      ${input.customOnly ? sql`AND s.is_custom = true` : sql``}
      ${input.search ? sql`AND (s.ticker ILIKE ${like} OR s.name ILIKE ${like})` : sql``}
    `;
    const items = await sql<{
      uuid: string; ticker: string; name: string; security_type: string;
      is_pass_through: boolean; is_custom: boolean; currently_underlying: boolean;
    }>`
      SELECT s.uuid, s.ticker, s.name, s.security_type, s.is_pass_through, s.is_custom,
        EXISTS (
          SELECT 1 FROM fund_underlying_holdings fuh
          WHERE fuh.underlying_security_id = s.id
            AND fuh.snapshot_date = (SELECT MAX(snapshot_date) FROM fund_underlying_holdings f2 WHERE f2.security_id = fuh.security_id)
        ) AS currently_underlying
      FROM securities s
      WHERE ${where}
      ORDER BY s.ticker, s.id
      LIMIT ${input.limit}
    `.execute(getDb());
    const countRow = await sql<{ count: string }>`SELECT COUNT(*) AS count FROM securities s WHERE ${where}`.execute(getDb());
    return { count: Number(countRow.rows[0]?.count ?? 0), returned: items.rows.length, items: items.rows };
  }

  /**
   * Delete the securities `uuids` names that aren't held (the foreign keys' cascades clear
   * their prices, compositions and underlying-holding rows), and say why each other one
   * wasn't: held, or not found (a malformed uuid names none).
   *
   * Locked first, in id order, then deleted only if still not held as the rows stand once
   * locked (lockRowsForDelete, as the pass-through cleanup does). The delete alone took its
   * rows in the order it scanned them, which could deadlock with a note resolved on two of
   * them; and it checked "not held" with what it read before it waited for a row, so a buy
   * that held the security (its lot's foreign key) and then committed had its new lot and
   * event deleted by the cascade. A wait past the pool's lock_timeout is a 409 RECORD_BUSY,
   * nothing deleted.
   *
   * Only those not held when first read are locked: a held one is skipped anyway, and
   * locking it FOR UPDATE kept a buy, a sale or a price of it waiting for the delete, or made
   * the delete wait for one of those, for nothing. One that a buy holds by the time it is
   * locked is waited for and skipped, as above.
   */
  async deleteMany(uuids: string[]) {
    // Compared as uuids, in any case, where the column was cast to text for a text compare.
    const keyOf = (uuid: string) => uuid.toLowerCase();
    const wanted = [...new Set(uuids.filter(isUuid).map(keyOf))];
    const found = wanted.length === 0
      ? []
      : (await sql<{ id: number; uuid: string; free: boolean }>`
          SELECT s.id, s.uuid, (${notHeld}) AS free FROM securities s WHERE s.uuid = ANY(${wanted}::uuid[])
        `.execute(getDb())).rows;
    const free = found.filter((r) => r.free).map((r) => r.id);
    const locked = free.length === 0
      ? []
      : await lockRowsForDelete('these securities', () =>
        getDb().selectFrom('securities').select(['id', 'uuid']).where('id', 'in', free).orderBy('id').forUpdate().execute()
      );
    const deleted = locked.length === 0
      ? []
      : (await sql<{ uuid: string }>`
          DELETE FROM securities s WHERE s.id = ANY(${locked.map((r) => r.id)}::int[]) AND ${notHeld} RETURNING s.uuid
        `.execute(getDb())).rows;
    const deletedUuids = new Set(deleted.map((r) => r.uuid));

    // What wasn't deleted: held when read, or locked → held; else (not there, or deleted
    // meanwhile) → not found.
    const present = new Set([...found.filter((r) => !r.free).map((r) => r.uuid), ...locked.map((r) => r.uuid)]);
    const skipped = uuids
      .filter((u) => !deletedUuids.has(keyOf(u)))
      .map((u) => ({ uuid: u, reason: present.has(keyOf(u)) ? 'held: has positions or transaction history' : 'not found' }));
    return { deleted: deleted.length, deletedUuids: wanted.filter((u) => deletedUuids.has(u)), skipped };
  }

  /**
   * Delete one security: a 404 when it isn't there, a 409 when it is held. Locked first and
   * then deleted only if still not held, as {@link deleteMany} does: a buy under way is waited
   * for, and makes it held.
   */
  async delete(uuid: string) {
    const locked = await lockRowsForDelete('this security', () =>
      getDb().selectFrom('securities').select('id').where('uuid', '=', uuid).forUpdate().executeTakeFirst()
    );
    if (!locked) throw securityMissing();
    const deleted = await sql`DELETE FROM securities s WHERE s.id = ${locked.id} AND ${notHeld}`.execute(getDb());
    if (Number(deleted.numAffectedRows ?? 0) === 0) throw securityHeld();
    return { deleted: 1, uuid };
  }

  /**
   * A new security, unless the ledger has one with its ticker (in any case) and exchange (none
   * matching none): then a 409 SECURITY_EXISTS whose `security` is that one.
   */
  async create(input: SecurityCreateInput): Promise<SecurityRow> {
    const exchange = input.exchange ?? null;
    return writeUnlessTickerTaken({ ticker: input.ticker, exchange }, undefined, () => getDb()
      .insertInto('securities')
      .values({
        ticker: input.ticker,
        name: input.name,
        security_type: input.security_type,
        exchange: exchange === null ? null : storedExchange(exchange),
        currency: input.currency,
        is_active: input.is_active,
        is_custom: input.is_custom,
        is_pass_through: input.is_pass_through,
        track_underlying_holdings: input.track_underlying_holdings,
        expense_ratio_percentage: expenseRatioText(input.expense_ratio_percentage),
        notes: input.notes ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow());
  }

  async get(uuid: string): Promise<SecurityRow> {
    const row = await getDb().selectFrom('securities').selectAll().where('uuid', '=', uuid).executeTakeFirst();
    if (!row) throw securityMissing();
    return row;
  }

  /**
   * Change the fields `input` gives; the others stay as they are. A new ticker or exchange that
   * another security of the ledger has is a 409 SECURITY_EXISTS answering that one.
   */
  async update(uuid: string, input: SecurityUpdateInput): Promise<SecurityRow> {
    const patch: Record<string, unknown> = {};
    for (const k of PLAIN_FIELDS) {
      if (input[k] !== undefined) patch[k] = input[k];
    }
    if (input.expense_ratio_percentage !== undefined) patch.expense_ratio_percentage = expenseRatioText(input.expense_ratio_percentage);
    if (typeof input.exchange === 'string') patch.exchange = storedExchange(input.exchange);
    const write = async () => {
      const row = await getDb().updateTable('securities').set(patch).where('uuid', '=', uuid).returningAll().executeTakeFirst();
      if (!row) throw securityMissing();
      return row;
    };
    if (input.ticker === undefined && input.exchange === undefined) return write();
    // The row locked before its ticker and exchange are read: read unlocked, a
    // rename of it under way was checked against its old ticker, and hit the key once it committed.
    const current = await getDb().selectFrom('securities').select(['ticker', 'exchange']).where('uuid', '=', uuid).forUpdate().executeTakeFirst();
    if (!current) throw securityMissing();
    return writeUnlessTickerTaken({ ticker: input.ticker ?? current.ticker, exchange: input.exchange !== undefined ? input.exchange : current.exchange }, uuid, write);
  }

  /** A security's recorded prices, newest first; a 404 for an unknown security, not an empty list. */
  async listPrices(uuid: string) {
    const security = await getDb().selectFrom('securities').select('id').where('uuid', '=', uuid).executeTakeFirst();
    if (!security) throw notFoundError('security');
    const rows = await sql`
      SELECT sp.* FROM security_prices sp
      JOIN securities s ON s.id = sp.security_id
      WHERE s.uuid = ${uuid}
      ORDER BY sp.price_date DESC
    `.execute(getDb());
    return rows.rows;
  }

  /**
   * Record a security's close on a day, or replace the one recorded.
   *
   * The security is locked first (lockSecuritiesForWrite), as a bulk upsert locks its
   * securities: replacing a recorded close locks its row, and the freshness trigger then
   * updates the security's, which a delete of it holds FOR UPDATE while its cascade waits for
   * that price's row, a deadlock. Locked first, the price waits for the delete and finds the
   * security gone (a 404), or the delete waits for the price.
   */
  async upsertPrice(p: PriceInput) {
    const figures = priceFigures(p);
    const [sec] = isUuid(p.security_uuid) ? await lockSecuritiesForWrite({ uuids: [p.security_uuid.toLowerCase()] }) : [];
    if (!sec) throw notFoundError('security');
    return this.writePrice(sec.id, p, figures);
  }

  /** Write a close of a security the caller has locked. */
  private async writePrice(securityId: number, p: PriceInput, figures: ReturnType<typeof priceFigures>) {
    return getDb()
      .insertInto('security_prices')
      .values({
        security_id: securityId,
        price_date: p.price_date,
        ...figures,
        source: p.source ?? 'mcp_manual',
      })
      .onConflict((oc) =>
        oc.columns(['security_id', 'price_date']).doUpdateSet({
          ...figures,
          source: p.source ?? 'mcp_manual',
        })
      )
      .returning(['uuid', 'price_date'])
      .executeTakeFirstOrThrow();
  }

  /**
   * Record several prices. A failed record doesn't roll back the others: each is
   * written in a savepoint of its own, and the answer gives each one's outcome.
   *
   * Their securities are locked first, in id order (lockSecuritiesForWrite): each price's
   * insert and its freshness trigger lock its security, and in the request's order that
   * deadlocked with a delete of several of them. A lock taken in a record's
   * savepoint would also go with it if that record failed.
   */
  async upsertPrices(prices: PriceInput[]) {
    const locked = await lockSecuritiesForWrite({ uuids: prices.map((p) => p.security_uuid).filter(isUuid).map((u) => u.toLowerCase()) });
    const idByUuid = new Map(locked.map((r) => [r.uuid, r.id]));
    const results: PriceUpsertResult[] = [];
    for (let i = 0; i < prices.length; i++) {
      const price = prices[i]!;
      // The same days /prices takes (calendarDay): a real one, from 1800 to 2999.
      if (!isCalendarDay(price.price_date)) {
        results.push({ index: i, ok: false, error: `price_date must be a real YYYY-MM-DD date, from ${CALENDAR_DAY_YEARS.min} to ${CALENDAR_DAY_YEARS.max}` });
        continue;
      }
      try {
        await withSavepoint(async () => {
          const figures = priceFigures(price);
          const securityId = idByUuid.get(price.security_uuid.toLowerCase());
          if (securityId === undefined) throw notFoundError('security');
          await this.writePrice(securityId, price, figures);
        });
        results.push({ index: i, ok: true });
      } catch (err) {
        // An unknown security says so; a database error's text stays in the log.
        if (!(err instanceof DomainError)) logger.warn({ err, index: i }, 'Bulk price upsert could not save a price');
        results.push({ index: i, ok: false, error: publicErrorMessage(err, 'This price could not be saved') });
      }
    }
    return { total: results.length, succeeded: results.filter((r) => r.ok).length, results };
  }
}
