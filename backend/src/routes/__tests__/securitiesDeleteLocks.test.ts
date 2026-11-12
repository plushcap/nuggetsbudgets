import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Long enough that the deadlock detector (1 s), not a lock timeout, decides.
const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '8000';
  process.env.LOG_LEVEL ??= 'silent';
  return previous;
});

/**
 * Every request transaction of this file reads tables in their physical order (no index or
 * bitmap scans), so a delete that locks rows as it scans them meets them in the order they
 * were written, whatever plan the database would pick for the table's size.
 */
vi.mock('../../db/withTenant.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/withTenant.js')>();
  const { sql } = await import('kysely');
  return {
    ...actual,
    withTenant: <T>(tenantId: number, fn: Parameters<typeof actual.withTenant<T>>[1]) =>
      actual.withTenant(tenantId, async (trx) => {
        await sql`SELECT set_config('enable_indexscan', 'off', true), set_config('enable_indexonlyscan', 'off', true),
                         set_config('enable_bitmapscan', 'off', true)`.execute(trx);
        return fn(trx);
      }),
  };
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createAnnotationsRoutes } from '../annotations.js';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { PriceIngestService } from '../../services/investments/PriceIngestService.js';
import type { PriceProviderClient } from '../../services/investments/PriceProviderClient.js';

/**
 * The securities deletes, against writes that hold their rows (the shape the
 * pass-through cleanup was fixed for):
 *
 * - POST /securities/bulk-delete took its rows as it scanned them. Against a manual resolve of
 *   notes on two of them (which locks its subjects in id order, FOR KEY SHARE), holding the
 *   higher one it waited for the lower one the resolve held, while the resolve waited for the
 *   higher one: a deadlock, which Postgres broke by failing one of them.
 * - DELETE /securities/:uuid and the bulk delete checked "not held" in the statement that
 *   deleted. A buy of the security under way (its lot's foreign key holds the security FOR KEY
 *   SHARE) made the delete wait; once the buy committed, the delete went ahead on what it had
 *   read before, and its cascade deleted the lot and event the buy had just written.
 *
 * Each now locks its rows in id order first (lockRowsForDelete), then deletes those still not
 * held as the rows stand once locked.
 *
 * The race is set up from a third connection, as in deletesLockInIdOrder.test.ts: it holds the
 * lower row FOR KEY SHARE (as an insert with a foreign key to it would), so the delete waits
 * there; the resolve then takes the lower row (a key share waits for no other) and goes for
 * the higher one. The rows are written higher id first, so a delete that scans the table
 * meets the higher one first.
 */
describe('securities deletes lock their rows in id order', () => {
  let app: Express;
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Securities delete locks');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/annotations', createAnnotationsRoutes());
    app.use('/api/investments', createInvestmentsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  const query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows as T[];
  /** Two ids from `sequence`, lower first. */
  const twoIds = async (sequence: string): Promise<[number, number]> => {
    const rows = await query<{ id: string }>(`SELECT nextval($1::regclass) AS id FROM generate_series(1, 2)`, [sequence]);
    const [lower, higher] = rows.map((r) => Number(r.id)).sort((a, b) => a - b);
    return [lower!, higher!];
  };
  const blockedBy = async (pid: number) =>
    (await query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).map((r) => r.pid);
  const pidOf = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const waitUntil = async (check: () => Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const remaining = async (ids: number[]) => (await query<{ id: number }>(`SELECT id FROM securities WHERE id = ANY($1::int[]) ORDER BY id`, [ids])).map((r) => r.id);
  /** Two unused securities, the higher id written first; their ids, lower first, and uuids. */
  const twoSecurities = async (label: string) => {
    const ids = await twoIds('securities_id_seq');
    const rows = await query<{ id: number; uuid: string }>(
      `INSERT INTO securities (id, ticker, name) VALUES ($2, $3 || 'H', 'Higher ' || $3), ($1, $3 || 'L', 'Lower ' || $3) RETURNING id, uuid`,
      [...ids, label]
    );
    const uuidOf = (id: number) => rows.find((r) => r.id === id)!.uuid;
    return { ids, uuids: [uuidOf(ids[0]), uuidOf(ids[1])] as [string, string] };
  };

  it('the bulk delete takes them in id order: neither it nor a resolve of their notes answers a server error', async () => {
    const { ids, uuids } = await twoSecurities('BLK');
    await query(
      `INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('security', $1, 'question', 'Lower?'), ('security', $2, 'question', 'Higher?')`,
      ids
    );
    const gate: PoolClient = await tenant.pool.connect();
    let removing: Promise<request.Response> | undefined;
    let resolving: Promise<request.Response> | undefined;
    try {
      await gate.query('BEGIN');
      const gatePid = await pidOf(gate);
      await gate.query('SELECT 1 FROM securities WHERE id = $1 FOR KEY SHARE', [ids[0]]);
      // Higher first in the request too, as a client may list them.
      removing = request(app).post('/api/investments/securities/bulk-delete').send({ uuids: [uuids[1], uuids[0]] }).then((res) => res);
      await waitUntil(async () => (await blockedBy(gatePid)).length > 0);
      const removerPid = (await blockedBy(gatePid))[0]!;
      let resolved = false;
      resolving = request(app)
        .post('/api/annotations/manual-resolve')
        .send({ scope: 'all' })
        .then((res) => {
          resolved = true;
          return res;
        });
      // The resolve either goes through (the delete holds none of its rows) or waits for the
      // delete at the higher row (it holds that one).
      await waitUntil(async () => resolved || (await blockedBy(removerPid)).length > 0);
    } finally {
      await gate.query('COMMIT').catch(() => undefined);
      gate.release();
    }
    const [removed, resolvedRes] = await Promise.all([removing!, resolving!]);

    expect(resolvedRes.status, JSON.stringify(resolvedRes.body)).toBe(200);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ deleted: 2, skipped: [] });
    expect(await remaining(ids)).toEqual([]);
  }, 30_000);

  /** Run `remove` while a buy of `securityId` is under way, which commits once the delete waits for it. */
  const deleteDuringBuy = async (securityId: number, remove: () => Promise<request.Response>) => {
    const account = (await query<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Delete race brokerage', 'investment', 'investments', 'Asset') RETURNING id`))[0]!.id;
    const gate: PoolClient = await tenant.pool.connect();
    let removing: Promise<request.Response> | undefined;
    try {
      await gate.query('BEGIN');
      const gatePid = await pidOf(gate);
      // What a buy writes: its event and its lot, each with a foreign key to the security.
      const event = (
        await gate.query<{ id: number }>(
          `INSERT INTO holding_events (account_id, security_id, event_type, event_date, shares, price_per_share, total_amount)
           VALUES ($1, $2, 'buy', '2026-01-02', 1, 10, -10) RETURNING id`,
          [account, securityId]
        )
      ).rows[0]!.id;
      await gate.query(
        `INSERT INTO tax_lots (account_id, security_id, created_by_event_id, acquisition_date, holding_period_start, shares_original, shares_remaining,
                               cost_basis_per_share, total_cost_basis, acquisition_method)
         VALUES ($1, $2, $3, '2026-01-02', '2026-01-02', 1, 1, 10, 10, 'purchase')`,
        [account, securityId, event]
      );
      removing = remove().then((res) => res);
      await waitUntil(async () => (await blockedBy(gatePid)).length > 0);
    } finally {
      await gate.query('COMMIT').catch(() => undefined);
      gate.release();
    }
    const removed = await removing!;
    const left = await query<{ lots: number; events: number }>(
      `SELECT (SELECT COUNT(*)::int FROM tax_lots WHERE security_id = $1) AS lots, (SELECT COUNT(*)::int FROM holding_events WHERE security_id = $1) AS events`,
      [securityId]
    );
    return { removed, left: left[0]! };
  };

  it('a single delete leaves a security bought while it waited for its lock, and the buy with it', async () => {
    const { ids, uuids } = await twoSecurities('ONE');
    const { removed, left } = await deleteDuringBuy(ids[0], () => request(app).delete(`/api/investments/securities/${uuids[0]}`));

    expect(removed.status, JSON.stringify(removed.body)).toBe(409);
    expect(removed.body.error).toMatch(/^Cannot delete: this security has positions or transaction history/);
    expect(await remaining(ids)).toEqual(ids);
    expect(left).toEqual({ lots: 1, events: 1 });
  }, 30_000);

  it('a bulk delete leaves a security bought while it waited for its lock, and deletes the other', async () => {
    const { ids, uuids } = await twoSecurities('TWO');
    const { removed, left } = await deleteDuringBuy(ids[0], () => request(app).post('/api/investments/securities/bulk-delete').send({ uuids }));

    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toEqual({
      deleted: 1,
      deletedUuids: [uuids[1]],
      skipped: [{ uuid: uuids[0], reason: 'held: has positions or transaction history' }],
    });
    expect(await remaining(ids)).toEqual([ids[0]]);
    expect(left).toEqual({ lots: 1, events: 1 });
  }, 30_000);

  /**
   * Writes to several securities against the bulk delete of two of them. A
   * bulk price upsert's price insert holds its security FOR KEY SHARE and its freshness
   * trigger updates the security's row, record by record in the request's order; an
   * underlying-holdings snapshot's rows hold each underlying FOR KEY SHARE, row by row. The
   * delete locks its rows FOR UPDATE in id order. With the writer holding the higher one,
   * the delete took the lower one and waited for the higher, while the writer went on to the
   * lower: a deadlock, which Postgres broke by failing one of them (the delete's 409
   * RECORD_BUSY, or the writer's record or request).
   *
   * Three securities, low < middle < high. The writer names them high, middle, low; a third
   * connection holds the middle one FOR UPDATE, so the writer stops there; the delete of low
   * and high starts and waits for the writer; then the third connection lets go.
   */
  const threeSecurities = async (label: string) => {
    const ids = (await query<{ id: string }>(`SELECT nextval('securities_id_seq') AS id FROM generate_series(1, 3)`)).map((r) => Number(r.id)).sort((a, b) => a - b);
    const rows = await query<{ id: number; uuid: string; ticker: string }>(
      `INSERT INTO securities (id, ticker, name) VALUES ($1, $4 || 'L', 'Low ' || $4), ($2, $4 || 'M', 'Middle ' || $4), ($3, $4 || 'H', 'High ' || $4)
       RETURNING id, uuid, ticker`,
      [...ids, label]
    );
    const byId = (id: number) => rows.find((r) => r.id === id)!;
    return { ids, low: byId(ids[0]!), middle: byId(ids[1]!), high: byId(ids[2]!) };
  };

  const writerAgainstDelete = async <T = request.Response>(
    middleId: number,
    deleteUuids: string[],
    write: () => Promise<T>
  ): Promise<{ written: T; removed: request.Response }> => {
    const gate: PoolClient = await tenant.pool.connect();
    let writing: Promise<T> | undefined;
    let removing: Promise<request.Response> | undefined;
    try {
      await gate.query('BEGIN');
      const gatePid = await pidOf(gate);
      await gate.query('SELECT 1 FROM securities WHERE id = $1 FOR UPDATE', [middleId]);
      writing = write().then((res) => res);
      await waitUntil(async () => (await blockedBy(gatePid)).length > 0);
      const writerPid = (await blockedBy(gatePid))[0]!;
      removing = request(app).post('/api/investments/securities/bulk-delete').send({ uuids: deleteUuids }).then((res) => res);
      await waitUntil(async () => (await blockedBy(writerPid)).length > 0);
    } finally {
      await gate.query('COMMIT').catch(() => undefined);
      gate.release();
    }
    const [written, removed] = await Promise.all([writing!, removing!]);
    return { written, removed };
  };

  it('a bulk price upsert locks its securities in id order: it and a bulk delete of them both go through', async () => {
    const { ids, low, middle, high } = await threeSecurities('PRC');
    const price = (uuid: string, close: string) => ({ security_uuid: uuid, price_date: '2026-03-02', close });
    const { written, removed } = await writerAgainstDelete(middle.id, [low.uuid, high.uuid], () =>
      request(app).post('/api/investments/prices/bulk').send({ prices: [price(high.uuid, '30'), price(middle.uuid, '20'), price(low.uuid, '10')] })
    );

    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect(written.body).toMatchObject({ total: 3, succeeded: 3 });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ deleted: 2, skipped: [] });
    // The prices went in first; the delete then took low and high with theirs.
    expect(await remaining(ids)).toEqual([middle.id]);
    expect(await query(`SELECT close FROM security_prices WHERE security_id = $1`, [middle.id])).toEqual([{ close: '20.0000' }]);
  }, 30_000);

  it('an underlying-holdings snapshot locks its securities in id order: it and a bulk delete of them both go through', async () => {
    const { ids, low, middle, high } = await threeSecurities('UND');
    const fund = (await query<{ uuid: string }>(`INSERT INTO securities (ticker, name, security_type) VALUES ('UNDF', 'Underlying fund', 'etf') RETURNING uuid`))[0]!.uuid;
    const holding = (ticker: string) => ({ underlying_ticker: ticker, weight_percentage: '30' });
    const { written, removed } = await writerAgainstDelete(middle.id, [low.uuid, high.uuid], () =>
      request(app).post('/api/investments/underlying-holdings').send({
        security_uuid: fund, snapshot_date: '2026-03-02', holdings: [holding(high.ticker), holding(middle.ticker), holding(low.ticker)],
      })
    );

    expect(written.status, JSON.stringify(written.body)).toBe(201);
    expect(written.body).toMatchObject({ rows_written: 3 });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ deleted: 2, skipped: [] });
    // The snapshot went in first; the delete then took low and high with their rows in it.
    expect(await remaining(ids)).toEqual([middle.id]);
    expect(await query(`SELECT underlying_security_id FROM fund_underlying_holdings WHERE security_id = (SELECT id FROM securities WHERE uuid = $1)`, [fund]))
      .toEqual([{ underlying_security_id: middle.id }]);
  }, 30_000);

  /**
   * A spinoff or stock merger against the bulk delete of its two securities. The
   * action locked its security FOR UPDATE, then wrote lots of the other (the new security, the
   * acquirer), whose foreign key locks it FOR KEY SHARE. With the other the lower id, the
   * delete took it and waited for the action's security, while the action waited for it: a
   * deadlock, which Postgres broke by failing one of them (the delete's 409 RECORD_BUSY, or
   * the action's 500). A third connection holds the action's security FOR KEY SHARE (as a buy
   * of it under way would), so the action waits there first; the delete then starts.
   */
  it.each([
    ['spinoff', (held: string, other: string) => ({ source_security_uuid: held, new_security_uuid: other, action_date: '2021-01-04', allocation_fraction: '0.25', share_ratio: '0.5' })],
    ['merger-stock', (held: string, other: string) => ({ security_uuid: held, acquirer_security_uuid: other, action_date: '2021-01-04', exchange_ratio: '2' })],
  ] as const)('a %s locks its two securities in id order: it and a bulk delete of them both go through', async (action, body) => {
    const { ids, uuids } = await twoSecurities(action === 'spinoff' ? 'SPN' : 'MRG');
    // The action's own security is the higher one, and has a lot; the other is unused.
    const [other, held] = uuids;
    const account = (await query<{ uuid: string }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Action brokerage', 'investment', 'investments', 'Asset') RETURNING uuid`))[0]!.uuid;
    const buy = await request(app).post('/api/investments/events/buy').send({ account_uuid: account, security_uuid: held, event_date: '2020-01-15', shares: 10, price_per_share: 10 });
    expect(buy.status, buy.text).toBe(201);

    const gate: PoolClient = await tenant.pool.connect();
    let acting: Promise<request.Response> | undefined;
    let removing: Promise<request.Response> | undefined;
    try {
      await gate.query('BEGIN');
      const gatePid = await pidOf(gate);
      await gate.query('SELECT 1 FROM securities WHERE id = $1 FOR KEY SHARE', [ids[1]]);
      acting = request(app).post(`/api/investments/corporate-actions/${action}`).send(body(held, other)).then((res) => res);
      await waitUntil(async () => (await blockedBy(gatePid)).length > 0);
      const actorPid = (await blockedBy(gatePid))[0]!;
      removing = request(app).post('/api/investments/securities/bulk-delete').send({ uuids }).then((res) => res);
      await waitUntil(async () => (await blockedBy(actorPid)).length > 0);
    } finally {
      await gate.query('COMMIT').catch(() => undefined);
      gate.release();
    }
    const [acted, removed] = await Promise.all([acting!, removing!]);

    expect(acted.status, JSON.stringify(acted.body)).toBe(201);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    // The action went first: both now hold lots, so neither is deleted.
    expect(removed.body).toMatchObject({ deleted: 0 });
    expect(removed.body.skipped.map((s: { reason: string }) => s.reason)).toEqual(['held: has positions or transaction history', 'held: has positions or transaction history']);
    expect(await remaining(ids)).toEqual(ids);
  }, 30_000);

  it('the scheduled price sync writes in id order: it and a bulk delete of them both go through', async () => {
    // The provider answers in its own order (here high, middle, low); each price's freshness
    // trigger updates its security's row, so the sync locked them in that order.
    const { ids, low, middle, high } = await threeSecurities('ING');
    const provider: Pick<PriceProviderClient, 'fetchEodCloses'> = {
      fetchEodCloses: async () => [high, middle, low].map((s) => ({ ticker: s.ticker, date: '2026-03-02', close: 10, volume: 1 })),
    };
    const ingest = new PriceIngestService(provider as PriceProviderClient);
    const { written, removed } = await writerAgainstDelete(middle.id, [low.uuid, high.uuid], () =>
      ingest.updateMarketPrices(tenant.tenantId).then((r) => r, (err: Error) => err)
    );

    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ deleted: 2, skipped: [] });
    expect(written).toMatchObject({ updated: 3 });
    expect(written).toMatchObject({ busy: 0 });
    expect(await remaining(ids)).toEqual([middle.id]);
  }, 30_000);

  it('an underlying-holdings snapshot whose underlyings a delete removed while it waited creates them again, rather than a 500', async () => {
    const { ids, low, middle, high } = await threeSecurities('GON');
    const fund = (await query<{ id: number; uuid: string }>(`INSERT INTO securities (ticker, name, security_type) VALUES ('GONF', 'Gone fund', 'etf') RETURNING id, uuid`))[0]!;
    // A price of the high one, which a third connection holds: the delete has locked all three
    // and waits there, in its cascade.
    await query(`INSERT INTO security_prices (security_id, price_date, close) VALUES ($1, '2026-01-02', 1)`, [high.id]);
    const gate: PoolClient = await tenant.pool.connect();
    let removing: Promise<request.Response> | undefined;
    let writing: Promise<request.Response> | undefined;
    try {
      await gate.query('BEGIN');
      const gatePid = await pidOf(gate);
      await gate.query('SELECT 1 FROM security_prices WHERE security_id = $1 FOR UPDATE', [high.id]);
      removing = request(app).post('/api/investments/securities/bulk-delete').send({ uuids: [low.uuid, middle.uuid, high.uuid] }).then((res) => res);
      await waitUntil(async () => (await blockedBy(gatePid)).length > 0);
      const deleterPid = (await blockedBy(gatePid))[0]!;
      // The snapshot reads the three as there, then waits for the delete to lock them.
      writing = request(app).post('/api/investments/underlying-holdings').send({
        security_uuid: fund.uuid, snapshot_date: '2026-03-02',
        holdings: [high, middle, low].map((s) => ({ underlying_ticker: s.ticker, weight_percentage: '30' })),
      }).then((res) => res);
      await waitUntil(async () => (await blockedBy(deleterPid)).length > 0);
    } finally {
      await gate.query('COMMIT').catch(() => undefined);
      gate.release();
    }
    const [removed, written] = await Promise.all([removing!, writing!]);

    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ deleted: 3 });
    expect(written.status, JSON.stringify(written.body)).toBe(201);
    expect(written.body).toMatchObject({ rows_written: 3 });
    // Its holdings are securities of those tickers again, created anew: none is a deleted one.
    const held = await query<{ id: number; ticker: string }>(
      `SELECT s.id, s.ticker FROM fund_underlying_holdings fuh JOIN securities s ON s.id = fuh.underlying_security_id WHERE fuh.security_id = $1 ORDER BY s.ticker`,
      [fund.id]
    );
    expect(held.map((r) => r.ticker)).toEqual([high.ticker, low.ticker, middle.ticker]);
    expect(held.filter((r) => ids.includes(r.id))).toEqual([]);
  }, 30_000);
});
