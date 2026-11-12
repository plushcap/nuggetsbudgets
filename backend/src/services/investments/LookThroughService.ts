import { sql, type SqlBool } from 'kysely';
import type { FundCompositionRow, LookThroughAnswer, UnderlyingExposureAnswer, UnderlyingHoldingRow } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import {
  validateCompositionWeights,
  computeLookThrough,
  validateUnderlyingWeights,
  computeUnderlyingExposure,
  type LookThroughHolding,
  type ExposureHolding,
  type UnderlyingWeightRow,
} from './lookThrough.js';
import { invalidRequestError, notFoundError } from '../controlPlaneErrors.js';
import { lockSecuritiesForWrite } from './securityLocks.js';
import { SECURITY_TICKER_KEY, securitiesBusy } from './investmentErrors.js';
import { isLockConflict } from '../transactions/locks.js';
import {
  EXPENSE_RATIO_PERCENT, SHARES, SHARE_VALUE_SCALE, WEIGHT_PERCENT, numericUnits, requestUnits, unitsToNumber, unitsToText, type DecimalValue,
} from '../../utils/decimal.js';
import { securityType as securityTypes, trimSpaces } from '@nuggets/shared';

const logger = createLogger({ service: 'LookThroughService' });

/** pg_advisory_xact_lock's class for a ledger's creates of underlying securities ('UNDS'). */
const UNDERLYING_CREATES_LOCK_CLASS = 0x554e4453;

/**
 * Take the ledger's lock on creating underlying securities, to the end of the transaction. A
 * wait past the pool's lock_timeout, or a deadlock, is a 409 RECORD_BUSY, nothing written.
 */
async function lockUnderlyingCreates(): Promise<void> {
  try {
    await sql`SELECT pg_advisory_xact_lock(${UNDERLYING_CREATES_LOCK_CLASS}::int, current_tenant_id())`.execute(getDb());
  } catch (err) {
    if (!isLockConflict(err)) throw err;
    logger.warn({ err }, 'A holdings snapshot could not take the lock on creating securities in time; nothing saved');
    throw securitiesBusy();
  }
}

/** A request weight in percent as exact text, to the column's 6 places. */
const weightText = (value: DecimalValue) =>
  unitsToText(requestUnits(value, 'weight_percentage', WEIGHT_PERCENT), WEIGHT_PERCENT.scale);

// Dimensions that describe only one *sleeve* of a holding. Equity-sleeve
// dimensions are meaningless for a bond; bond-sleeve dimensions for a stock.
const EQUITY_DIMS = new Set(['sector', 'market_cap', 'style']);
const BOND_DIMS = new Set(['credit_quality', 'rate_sensitivity']);
const GEO_DIMS = new Set(['region', 'country']);

/**
 * Reject a composition dimension that can't apply to this security type — e.g. a
 * sector on a bond, credit quality on a stock, geography on cash/crypto. Returns
 * null when allowed. Funds (etf/mutual_fund) can hold any mix, so equity/bond
 * sleeve dimensions are always allowed for them. Unknown (non-standard)
 * dimensions are allowed — dimension is free-text by design.
 */
function dimensionTypeError(securityType: string, dimension: string): string | null {
  const isFund = securityType === securityTypes.enum.etf || securityType === securityTypes.enum.mutual_fund;
  if (GEO_DIMS.has(dimension) && (securityType === securityTypes.enum.money_market || securityType === securityTypes.enum.crypto)) {
    return `error: ${dimension} does not apply to a ${securityType} — it has no geographic breakdown`;
  }
  if (EQUITY_DIMS.has(dimension) && !(securityType === securityTypes.enum.stock || isFund)) {
    return `error: ${dimension} describes stock holdings, which a ${securityType} does not have`;
  }
  if (BOND_DIMS.has(dimension) && !(securityType === securityTypes.enum.bond || isFund)) {
    return `error: ${dimension} describes bond holdings, which a ${securityType} does not have`;
  }
  return null;
}

/**
 * Fund composition writes + look-through allocation. Pure math is in
 * lookThrough.ts; this persists snapshots and assembles the holdings view.
 */
/** `source` columns are VARCHAR(128); clamp agent-provided tags so an over-long
 * provenance string (a fund name or URL) never triggers a 22001 insert error. */
const SOURCE_MAX = 128;

export class LookThroughService {
  private clampSource(source?: string): string {
    const s = (source ?? '').trim() || 'mcp_manual';
    if (s.length <= SOURCE_MAX) return s;
    logger.warn({ length: s.length }, 'Source tag truncated to fit column');
    return s.slice(0, SOURCE_MAX);
  }

  private async securityIdByUuid(uuid: string): Promise<number> {
    const row = await getDb().selectFrom('securities').select('id').where('uuid', '=', uuid).executeTakeFirst();
    if (!row) throw notFoundError('security');
    return row.id;
  }

  /**
   * Upsert a composition snapshot for a fund across one or more dimensions.
   * Validates each dimension's weights sum within tolerance BEFORE
   * writing; a failure rejects the whole call without touching existing snapshots.
   *
   * The fund is locked first (lockSecuritiesForWrite), and read as it stands once
   * locked: replacing a dimension deletes its rows, then the inserts' foreign key waits for
   * the fund, which a delete of it holds FOR UPDATE while its cascade waits for those rows,
   * a deadlock. Locked first, the write waits for the delete and finds the fund gone (a 404),
   * or the delete waits for the write.
   */
  async upsertComposition(input: {
    securityUuid: string;
    snapshotDate: string;
    dimensions: Record<string, Array<{ dimension_value: string; weight_percentage: DecimalValue }>>;
    source?: string;
    userId?: number;
  }) {
    const [locked] = await lockSecuritiesForWrite({ uuids: [input.securityUuid.toLowerCase()] });
    const sec = locked && await getDb()
      .selectFrom('securities')
      .select(['id', 'is_pass_through', 'security_type'])
      .where('id', '=', locked.id)
      .executeTakeFirst();
    if (!sec) throw notFoundError('security');
    const securityId = sec.id;
    // Validate all dimensions first (reject the whole call before any write).
    for (const [dimension, rows] of Object.entries(input.dimensions)) {
      // A dimension that can't apply to this security type (sector on a bond,
      // credit quality on a stock, …) is a mistake — reject with a clear reason.
      const typeError = dimensionTypeError(sec.security_type, dimension);
      if (typeError) throw invalidRequestError(typeError);
      // A plain (non-pass-through) security holds a single category per dimension;
      // only a pass-through fund splits into multiple weighted rows.
      if (!sec.is_pass_through && rows.length > 1) {
        throw invalidRequestError(
          `error: ${dimension} can have only one category for a non pass-through security — mark it as a pass-through fund to split it into weighted categories`
        );
      }
      validateCompositionWeights(rows.map((r) => ({ dimensionValue: r.dimension_value, weightPercentage: r.weight_percentage })));
    }
    const source = this.clampSource(input.source);
    let written = 0;
    for (const [dimension, rows] of Object.entries(input.dimensions)) {
      // Replace the whole (security, dimension, snapshot) set: drop existing rows
      // first so values removed in an editor don't linger and skew look-through.
      // Scoped to this dimension, so other dimensions' snapshots are untouched.
      await getDb()
        .deleteFrom('fund_compositions')
        .where('security_id', '=', securityId)
        .where('dimension', '=', dimension)
        .where('snapshot_date', '=', sql<string>`${input.snapshotDate}::date`)
        .execute();
      for (const r of rows) {
        await getDb()
          .insertInto('fund_compositions')
          .values({
            security_id: securityId,
            dimension,
            dimension_value: r.dimension_value,
            weight_percentage: weightText(r.weight_percentage),
            snapshot_date: input.snapshotDate,
            source,
            created_by_user_id: input.userId ?? null,
          })
          .onConflict((oc) =>
            oc.columns(['security_id', 'dimension', 'dimension_value', 'snapshot_date']).doUpdateSet({
              weight_percentage: weightText(r.weight_percentage),
              source,
            })
          )
          .execute();
        written++;
      }
    }
    logger.info({ securityId, dimensions: Object.keys(input.dimensions).length, written }, 'Upserted composition');
    return { security_uuid: input.securityUuid, snapshot_date: input.snapshotDate, rows_written: written };
  }

  async updateExpenseRatio(input: { securityUuid: string; expenseRatioPercentage: DecimalValue }) {
    // Read as sent, to the column's 4 places: 0.12345 is refused, not rounded.
    const ratio = requestUnits(input.expenseRatioPercentage, 'expense_ratio_percentage', EXPENSE_RATIO_PERCENT);
    const securityId = await this.securityIdByUuid(input.securityUuid);
    await getDb()
      .updateTable('securities')
      .set({ expense_ratio_percentage: unitsToText(ratio, EXPENSE_RATIO_PERCENT.scale), last_expense_ratio_update_at: sql`NOW()` })
      .where('id', '=', securityId)
      .execute();
    return { security_uuid: input.securityUuid, expense_ratio_percentage: unitsToNumber(ratio, EXPENSE_RATIO_PERCENT.scale) };
  }

  /** Current composition (latest snapshot per dimension) for a fund. */
  async getFundComposition(securityUuid: string): Promise<FundCompositionRow[]> {
    const securityId = await this.securityIdByUuid(securityUuid);
    const rows = await sql<{ dimension: string; dimension_value: string; weight_percentage: string; snapshot_date: string }>`
      SELECT fc.dimension, fc.dimension_value, fc.weight_percentage, fc.snapshot_date
      FROM fund_compositions fc
      JOIN (
        SELECT dimension, MAX(snapshot_date) AS latest FROM fund_compositions
        WHERE security_id = ${securityId} GROUP BY dimension
      ) m ON m.dimension = fc.dimension AND m.latest = fc.snapshot_date
      WHERE fc.security_id = ${securityId}
      ORDER BY fc.dimension, fc.weight_percentage DESC
    `.execute(getDb());
    return rows.rows.map((r) => ({ ...r, weight_percentage: Number(r.weight_percentage) }));
  }

  /** "Where is my money?" — aggregate exposure along one dimension. */
  async getLookThroughAllocation(dimension: string, accountUuid?: string): Promise<LookThroughAnswer> {
    const accountId = accountUuid
      ? (await getDb().selectFrom('accounts').select('id').where('uuid', '=', accountUuid).executeTakeFirst())?.id ?? null
      : null;

    // Classification is composition-driven for EVERY security now (no direct
    // securities column): a plain security has one row per dimension, a
    // pass-through fund has weighted rows. A security with no rows for this
    // dimension contributes to the "unknown" bucket.
    const holdingsRows = await sql<{ security_id: number; ticker: string; market_value: string | null }>`
      SELECT tl.security_id,
             s.ticker,
             SUM(tl.shares_remaining) * lp.close AS market_value
      FROM tax_lots tl
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN LATERAL (
        SELECT close FROM security_prices sp WHERE sp.security_id = tl.security_id ORDER BY sp.price_date DESC LIMIT 1
      ) lp ON true
      WHERE tl.is_open = true
        ${accountId != null ? sql`AND tl.account_id = ${accountId}` : sql``}
      GROUP BY tl.security_id, s.ticker, lp.close
    `.execute(getDb());

    // The market value as SQL gives it, exact: computeLookThrough sums it in units.
    const held = holdingsRows.rows
      .map((h) => ({ ...h, marketValue: h.market_value ?? '0' }))
      .filter((h) => numericUnits(h.marketValue, SHARE_VALUE_SCALE) > 0n);

    // Every holding's latest composition along the dimension, in one query (before, one per holding).
    const comp = held.length === 0
      ? { rows: [] }
      : await sql<{ security_id: number; dimension_value: string; weight_percentage: string }>`
          SELECT fc.security_id, fc.dimension_value, fc.weight_percentage
          FROM fund_compositions fc
          JOIN (
            SELECT security_id, MAX(snapshot_date) AS latest FROM fund_compositions
            WHERE security_id = ANY(${held.map((h) => h.security_id)}::int[]) AND dimension = ${dimension}
            GROUP BY security_id
          ) m ON m.security_id = fc.security_id AND m.latest = fc.snapshot_date
          WHERE fc.dimension = ${dimension}
          ORDER BY fc.security_id, fc.id
        `.execute(getDb());
    const compositionOf = new Map<number, Array<{ dimensionValue: string; weightPercentage: string }>>();
    for (const c of comp.rows) {
      compositionOf.set(c.security_id, [...(compositionOf.get(c.security_id) ?? []), { dimensionValue: c.dimension_value, weightPercentage: c.weight_percentage }]);
    }

    const holdings: LookThroughHolding[] = [];
    for (const h of held) {
      const marketValue = h.marketValue;
      const composition = compositionOf.get(h.security_id) ?? null;
      holdings.push({
        securityId: h.security_id,
        ticker: h.ticker,
        marketValue,
        // Composition-sourced for all; computeLookThrough sends no-composition → unknown.
        isPassThrough: true,
        ownDimensionValue: null,
        composition,
      });
    }

    return { dimension, ...computeLookThrough(holdings) };
  }

  // ----------------------------------------------------------- underlying holdings

  /** Resolve a set of tickers to security ids in bulk, creating any that don't
   * exist in a single multi-row insert (so a fund's full holdings list — up to
   * tens of thousands of tickers — can be pasted in one shot without N queries). */
  private async resolveOrCreateSecurityIds(items: Array<{ ticker: string; name?: string | undefined }>, fundId: number): Promise<Map<string, number>> {
    // Normalize + dedupe; first non-empty name wins.
    const wanted = new Map<string, string | undefined>();
    for (const it of items) {
      // Trimmed of what the database's check trims (trimSpaces), and in upper case: what is stored.
      const t = trimSpaces(it.ticker).toUpperCase();
      const name = it.name?.trim() || undefined;
      if (!wanted.has(t)) wanted.set(t, name);
      else if (!wanted.get(t) && name) wanted.set(t, name);
    }
    const tickers = [...wanted.keys()];
    // In any case, as the map below reads them: looked up as written, a security stored
    // with a lower-case ticker wasn't found, and was created again in upper case. On the stored
    // ticker_key (upper(ticker)), which an index serves under RLS, where upper(ticker), not
    // leakproof, read every security of the ledger.
    const byTicker = (list: string[]) => sql<SqlBool>`ticker_key = ANY(${list}::text[])`;
    const findExisting = () => getDb().selectFrom('securities').select(['id', 'ticker']).where(byTicker(tickers)).execute();
    let found = await findExisting();
    // A snapshot that creates securities is the ledger's only one doing so, and reads again under
    // the lock which tickers are there: two that created the same new ticker at once both
    // read it as missing and both created it, two securities with one ticker (the unique key is
    // (tenant_id, ticker, exchange), and their exchange is null). Taken before any security's
    // row, so one waiting for it holds none a snapshot holding it may wait for.
    const there = new Set(found.map((r) => r.ticker.toUpperCase()));
    if (tickers.some((t) => !there.has(t))) {
      await lockUnderlyingCreates();
      found = await findExisting();
    }
    // The fund and every existing underlying, in id order, before any of them is written: the
    // names below, the holding rows' foreign keys and the fund's own update lock them, and in
    // the holdings' order that deadlocked with a delete of several. The ones
    // created below are this transaction's own until it commits.
    //
    // Mapped from the rows as they stand once locked, not as read before: one a delete removed
    // while this waited is gone (its holdings pointed at it, and the insert's foreign key failed
    // with a 500), so its ticker is created again below, as an unknown one is.
    const locked = await lockSecuritiesForWrite({ ids: [fundId, ...found.map((r) => r.id)] });
    if (!locked.some((r) => r.id === fundId)) throw notFoundError('security');
    const existing = locked.filter((r) => r.id !== fundId && wanted.has(r.ticker.toUpperCase()));
    const map = new Map<string, number>();
    // Of two a ticker names in different cases (on different exchanges), the one written in upper
    // case, else the first by id (locked rows come in id order).
    for (const r of existing) {
      const t = r.ticker.toUpperCase();
      if (!map.has(t) || r.ticker === t) map.set(t, r.id);
    }
    // Backfill names onto securities that were auto-created bare (name == ticker)
    // when this call supplies a real name — so pasting holdings with names fills
    // in tickers added by an earlier nameless import.
    const toName = existing.filter((r) => {
      const want = wanted.get(r.ticker.toUpperCase());
      return want && want !== r.name && (!r.name || r.name === r.ticker);
    });
    for (const r of toName) {
      await getDb().updateTable('securities').set({ name: wanted.get(r.ticker.toUpperCase())! }).where('id', '=', r.id).execute();
    }
    if (toName.length) logger.info({ count: toName.length }, 'Backfilled underlying security names');
    let missing = tickers.filter((t) => !map.has(t));
    if (missing.length) {
      // Whatever made a ticker missing (unknown when first read, or deleted while this waited for
      // its row), it is created only under the create lock, and only if no other
      // snapshot has created it since: two that both found a security deleted under them created
      // it twice. Taken here after rows when the first read found every ticker (a no-op when held
      // already): a snapshot holding it may wait for one of those rows, a deadlock Postgres
      // breaks by failing one, a 409 to try again (lockUnderlyingCreates, lockSecuritiesForWrite).
      await lockUnderlyingCreates();
      const createdMeanwhile = await getDb().selectFrom('securities').select('id').where(byTicker(missing)).execute();
      for (const r of await lockSecuritiesForWrite({ ids: createdMeanwhile.map((row) => row.id) })) {
        if (wanted.has(r.ticker.toUpperCase())) map.set(r.ticker.toUpperCase(), r.id);
      }
      missing = tickers.filter((t) => !map.has(t));
    }
    if (missing.length) {
      // Chunk creates too (each row binds several params). One the ledger's unique key on ticker
      // and exchange already has (a security created by hand, not under the create
      // lock, after the reads above; the key waits for it to commit) isn't created again: it is
      // found below, as one created meanwhile is. Inserted, it failed the key, a 500.
      const CHUNK = 1000;
      let created = 0;
      for (let i = 0; i < missing.length; i += CHUNK) {
        const slice = missing.slice(i, i + CHUNK);
        const rows = await getDb()
          .insertInto('securities')
          .values(slice.map((t) => ({ ticker: t, name: wanted.get(t) || t, security_type: 'stock', currency: 'USD', is_custom: true })))
          .onConflict((oc) => oc.constraint(SECURITY_TICKER_KEY).doNothing())
          .returning(['id', 'ticker'])
          .execute();
        for (const r of rows) map.set(r.ticker.toUpperCase(), r.id);
        created += rows.length;
      }
      if (created) logger.info({ count: created }, 'Auto-created underlying securities');
      const found = tickers.filter((t) => !map.has(t));
      if (found.length) {
        const there = await getDb().selectFrom('securities').select('id').where(byTicker(found)).execute();
        for (const r of await lockSecuritiesForWrite({ ids: there.map((row) => row.id) })) {
          if (wanted.has(r.ticker.toUpperCase()) && !map.has(r.ticker.toUpperCase())) map.set(r.ticker.toUpperCase(), r.id);
        }
      }
    }
    return map;
  }

  /** Toggle whether a fund's positions are resolved to underlying securities. */
  async setUnderlyingTracking(input: { securityUuid: string; track: boolean }) {
    const securityId = await this.securityIdByUuid(input.securityUuid);
    await getDb().updateTable('securities').set({ track_underlying_holdings: input.track }).where('id', '=', securityId).execute();
    return { security_uuid: input.securityUuid, track_underlying_holdings: input.track };
  }

  /**
   * Upsert a fund's underlying-holdings snapshot (the actual securities it holds,
   * by ticker). Validates weights (each >0, ≤100; sum ≤105%) before any write;
   * unknown tickers are auto-created. Setting holdings also marks the fund as
   * pass-through and tracked so look-through resolves it.
   */
  async upsertUnderlyingHoldings(input: {
    securityUuid: string;
    snapshotDate: string;
    holdings: Array<{ underlying_ticker: string; underlying_name?: string; weight_percentage: DecimalValue; shares?: DecimalValue }>;
    source?: string;
  }) {
    const securityId = await this.securityIdByUuid(input.securityUuid);
    validateUnderlyingWeights(input.holdings.map((h) => ({ weightPercentage: h.weight_percentage })));

    const idByTicker = await this.resolveOrCreateSecurityIds(input.holdings.map((h) => ({ ticker: h.underlying_ticker, name: h.underlying_name })), securityId);
    const source = this.clampSource(input.source);

    // Build rows, deduping by underlying security (last-wins) so a single
    // multi-row upsert never hits the same conflict target twice.
    const rowByUnderlying = new Map<number, { security_id: number; underlying_security_id: number; weight_percentage: string; shares: string | null; snapshot_date: string; source: string }>();
    for (const h of input.holdings) {
      const underlyingId = idByTicker.get(trimSpaces(h.underlying_ticker).toUpperCase());
      if (underlyingId == null) throw invalidRequestError(`error: could not resolve ticker ${h.underlying_ticker}`);
      if (underlyingId === securityId) throw invalidRequestError(`error: a fund cannot hold itself (${h.underlying_ticker})`);
      rowByUnderlying.set(underlyingId, {
        security_id: securityId,
        underlying_security_id: underlyingId,
        weight_percentage: weightText(h.weight_percentage),
        shares: h.shares != null ? unitsToText(requestUnits(h.shares, 'shares', SHARES), SHARES.scale) : null,
        snapshot_date: input.snapshotDate,
        source,
      });
    }
    const rows = [...rowByUnderlying.values()];

    // Chunked multi-row upserts keep param counts well under PG's limit.
    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await getDb()
        .insertInto('fund_underlying_holdings')
        .values(rows.slice(i, i + CHUNK))
        .onConflict((oc) =>
          oc.columns(['security_id', 'underlying_security_id', 'snapshot_date']).doUpdateSet((eb) => ({
            weight_percentage: eb.ref('excluded.weight_percentage'),
            shares: eb.ref('excluded.shares'),
            source: eb.ref('excluded.source'),
          }))
        )
        .execute();
    }

    // A fund with underlying holdings is pass-through and should be looked through.
    await getDb()
      .updateTable('securities')
      .set({ is_pass_through: true, track_underlying_holdings: true, last_composition_update_at: sql`NOW()` })
      .where('id', '=', securityId)
      .execute();
    logger.info({ securityId, written: rows.length }, 'Upserted underlying holdings');
    return { security_uuid: input.securityUuid, snapshot_date: input.snapshotDate, rows_written: rows.length };
  }

  /** A fund's current underlying holdings (latest snapshot), joined to tickers. */
  async getUnderlyingHoldings(securityUuid: string): Promise<UnderlyingHoldingRow[]> {
    const securityId = await this.securityIdByUuid(securityUuid);
    const rows = await sql<{ underlying_uuid: string; ticker: string; name: string; weight_percentage: string; shares: string | null; snapshot_date: string }>`
      SELECT us.uuid AS underlying_uuid, us.ticker, us.name, fuh.weight_percentage, fuh.shares, fuh.snapshot_date
      FROM fund_underlying_holdings fuh
      JOIN securities us ON us.id = fuh.underlying_security_id
      WHERE fuh.security_id = ${securityId}
        AND fuh.snapshot_date = (SELECT MAX(snapshot_date) FROM fund_underlying_holdings WHERE security_id = ${securityId})
      ORDER BY fuh.weight_percentage DESC
    `.execute(getDb());
    return rows.rows.map((r) => ({
      underlying_uuid: r.underlying_uuid,
      ticker: r.ticker,
      name: r.name,
      weight_percentage: Number(r.weight_percentage),
      shares: r.shares != null ? Number(r.shares) : null,
      snapshot_date: r.snapshot_date,
    }));
  }

  /**
   * Portfolio exposure resolved all the way to individual underlying securities —
   * answers "what is my total exposure to ACMEC?". Combines direct
   * holdings with funds recursively expanded via their latest underlying snapshot.
   */
  async getUnderlyingExposure(accountUuid?: string): Promise<UnderlyingExposureAnswer> {
    const accountId = accountUuid
      ? (await getDb().selectFrom('accounts').select('id').where('uuid', '=', accountUuid).executeTakeFirst())?.id ?? null
      : null;

    // Open positions with market value + pass-through flag.
    const holdingsRows = await sql<{ security_id: number; ticker: string; is_pass_through: boolean; market_value: string | null }>`
      SELECT tl.security_id, s.ticker, s.is_pass_through,
             SUM(tl.shares_remaining) * lp.close AS market_value
      FROM tax_lots tl
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN LATERAL (
        SELECT close FROM security_prices sp WHERE sp.security_id = tl.security_id ORDER BY sp.price_date DESC LIMIT 1
      ) lp ON true
      WHERE tl.is_open = true
        ${accountId != null ? sql`AND tl.account_id = ${accountId}` : sql``}
      GROUP BY tl.security_id, s.ticker, s.is_pass_through, lp.close
    `.execute(getDb());

    const holdings: ExposureHolding[] = holdingsRows.rows.map((h) => ({
      securityId: h.security_id,
      ticker: h.ticker,
      marketValue: h.market_value ?? '0',
      isPassThrough: h.is_pass_through,
    }));

    // Latest underlying snapshot for every *tracked* fund (covers fund-of-funds).
    // Untracked funds are left opaque so their value lands in the unknown bucket.
    const underlyingRows = await sql<{ security_id: number; underlying_security_id: number; underlying_ticker: string; weight_percentage: string }>`
      SELECT fuh.security_id, fuh.underlying_security_id, us.ticker AS underlying_ticker, fuh.weight_percentage
      FROM fund_underlying_holdings fuh
      JOIN securities us ON us.id = fuh.underlying_security_id
      JOIN securities fs ON fs.id = fuh.security_id AND fs.track_underlying_holdings = true
      JOIN (
        SELECT security_id, MAX(snapshot_date) AS latest FROM fund_underlying_holdings GROUP BY security_id
      ) m ON m.security_id = fuh.security_id AND m.latest = fuh.snapshot_date
    `.execute(getDb());

    const underlyingMap = new Map<number, UnderlyingWeightRow[]>();
    for (const r of underlyingRows.rows) {
      const list = underlyingMap.get(r.security_id) ?? [];
      list.push({ underlyingSecurityId: r.underlying_security_id, underlyingTicker: r.underlying_ticker, weightPercentage: r.weight_percentage });
      underlyingMap.set(r.security_id, list);
    }

    // Pass-through ids (so opaque funds route to unknown, not self-exposure).
    const ptRows = await getDb().selectFrom('securities').select('id').where('is_pass_through', '=', true).execute();
    const passThroughIds = new Set(ptRows.map((r) => r.id));

    const result = computeUnderlyingExposure(holdings, underlyingMap, passThroughIds);

    // Decorate leaf exposures with their security uuid for UI linking.
    const ids = result.exposures.map((e) => e.securityId);
    const uuidRows = ids.length
      ? await getDb().selectFrom('securities').select(['id', 'uuid', 'name']).where('id', 'in', ids).execute()
      : [];
    const meta = new Map(uuidRows.map((r) => [r.id, { uuid: r.uuid, name: r.name }]));
    return {
      total_value: result.totalValue,
      unknown_value: result.unknownValue,
      below_a_cent: result.belowACent,
      exposures: result.exposures.map((e) => ({
        security_uuid: meta.get(e.securityId)?.uuid ?? null,
        ticker: e.ticker,
        name: meta.get(e.securityId)?.name ?? null,
        amount: e.amount,
        percentage: e.percentage,
      })),
    };
  }
}
