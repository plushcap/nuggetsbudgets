import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * One security per ticker, by design. A ledger's key on
 * its securities was (tenant_id, ticker, exchange): the ticker as written, and two with no
 * exchange never conflicted, so ABC could be created twice, or abc beside it. It is now UNIQUE
 * NULLS NOT DISTINCT (tenant_id, ticker_key, exchange): a create or rename to a ticker (in any
 * case) and exchange (none matching none) another security has is a 409 SECURITY_EXISTS that
 * answers that one, and a holdings snapshot that creates an underlying finds one created at the
 * same time instead of failing the key.
 */
describe('One security per ticker and exchange', () => {
  let app: Express;
  let other: Express;
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  const tag = `${Date.now() % 100000}`;
  const ticker = (base: string) => `${base}${tag}`;

  const mount = (t: TestTenant) => {
    const a = express();
    a.use(express.json());
    a.use(t.context());
    a.use('/api/investments', createInvestmentsRoutes());
    return a;
  };
  const create = (body: Record<string, unknown>, on = app) =>
    request(on).post('/api/investments/securities').send({ name: 'Ticker Co', security_type: 'stock', ...body });
  const rename = (uuid: string, body: Record<string, unknown>) => request(app).put(`/api/investments/securities/${uuid}`).send(body);
  const exists = (res: request.Response, uuid: string) => {
    expect({ status: res.status, code: res.body.code, security: res.body.security?.uuid }, JSON.stringify(res.body))
      .toEqual({ status: 409, code: 'SECURITY_EXISTS', security: uuid });
  };

  beforeAll(async () => {
    tenant = await createTestTenant('One security per ticker');
    otherTenant = await createTestTenant('One security per ticker, other ledger');
    app = mount(tenant);
    other = mount(otherTenant);
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await otherTenant?.cleanup();
  });

  it('refuses a second security with a ticker in any case and no exchange, and answers the first', async () => {
    const first = (await create({ ticker: ticker('Tku') }).expect(201)).body;
    expect(first.exchange).toBeNull();
    exists(await create({ ticker: ticker('TKU') }), first.uuid);
    exists(await create({ ticker: ` ${ticker('tku')} ` }), first.uuid);
    // An exchange of only spaces is none.
    exists(await create({ ticker: ticker('tku'), exchange: '  ' }), first.uuid);
    exists(await create({ ticker: ticker('tku'), exchange: null }), first.uuid);
    // The answer is the security as GET answers it, for the caller to use.
    const refused = (await create({ ticker: ticker('TKU') }).expect(409)).body;
    expect(refused.security).toEqual((await request(app).get(`/api/investments/securities/${first.uuid}`).expect(200)).body);
    expect(refused.message).toContain('is already recorded');

    // On an exchange it is another security, one per exchange.
    const nyse = (await create({ ticker: ticker('TKU'), exchange: ' NYSE ' }).expect(201)).body;
    expect(nyse.exchange).toBe('NYSE');
    exists(await create({ ticker: ticker('tku'), exchange: 'NYSE' }), nyse.uuid);
    // An exchange in any case is one exchange, stored in upper case.
    exists(await create({ ticker: ticker('tku'), exchange: ' nyse' }), nyse.uuid);
    expect((await create({ ticker: ticker('TKU'), exchange: 'lse' }).expect(201)).body.exchange).toBe('LSE');
    // The database keeps them in that form, so the key compares them so: a writer that didn't
    // trim the ticker, or upper-case the exchange, is refused, not let past the key.
    // Every character JavaScript's trim() removes, a no-break space and U+FEFF too (the database
    // took them, and a ticker stored with one was a second security), and an empty ticker.
    const raw: Array<readonly [string, string | null]> = [
      [` ${ticker('TKU')} `, null], [ticker('TKU'), 'nyse'], [ticker('TKW'), ''], [ticker('TKW'), ' X'],
      [`${ticker('TKU')}\u00a0`, null], [`\ufeff${ticker('TKU')}`, null], [`${ticker('TKU')}\u000b`, null], [`\u3000${ticker('TKU')}`, null],
      [ticker('TKW'), 'LSE\u00a0'], [ticker('TKW'), '\u2003LSE'], ['', null], ['\u00a0', null],
    ];
    for (const [t, exchange] of raw) {
      const refusedRaw = await tenant.pool.query(`INSERT INTO securities (ticker, name, exchange) VALUES ($1, 'Raw Co', $2)`, [t, exchange])
        .then(() => null, (err: { code: string; constraint?: string }) => `${err.code} ${err.constraint}`);
      expect(refusedRaw, `${t}/${exchange}`).toMatch(/^23514 securities_(ticker_trimmed|exchange_normalized)$/);
    }

    // The API trims them as the database does: one ticker, one exchange.
    exists(await create({ ticker: `\u00a0${ticker('tku')}\ufeff` }), first.uuid);
    exists(await create({ ticker: ticker('TKU'), exchange: '\u00a0lse\u3000' }), (await tenant.pool.query(
      `SELECT uuid FROM securities WHERE ticker_key = upper($1) AND exchange = 'LSE'`, [ticker('tku')])).rows[0].uuid);
    expect((await create({ ticker: '\u00a0\u2003' })).status).toBe(400);

    // Another ledger has its own.
    expect((await create({ ticker: ticker('TKU') }, other)).status).toBe(201);
    // No exchange, NYSE and LSE.
    const count = await tenant.pool.query(`SELECT count(*)::int AS n FROM securities WHERE ticker_key = upper($1)`, [ticker('tku')]);
    expect(count.rows[0].n).toBe(3);
  });

  it('refuses a rename to a ticker or exchange another security has, and answers that one', async () => {
    const a = (await create({ ticker: ticker('RNA') }).expect(201)).body;
    const b = (await create({ ticker: ticker('RNB') }).expect(201)).body;
    const onExchange = (await create({ ticker: ticker('RNA'), exchange: 'LSE' }).expect(201)).body;
    exists(await rename(b.uuid, { ticker: ticker('rna') }), a.uuid);
    exists(await rename(a.uuid, { exchange: 'LSE' }), onExchange.uuid);
    exists(await rename(onExchange.uuid, { exchange: '' }), a.uuid);
    exists(await rename(onExchange.uuid, { exchange: null }), a.uuid);
    // Nothing changed.
    expect((await request(app).get(`/api/investments/securities/${b.uuid}`).expect(200)).body.ticker).toBe(ticker('RNB'));

    // Its own ticker in another case, another field, or a free ticker: changed.
    expect((await rename(a.uuid, { ticker: ticker('rna') }).expect(200)).body.ticker).toBe(ticker('rna'));
    expect((await rename(a.uuid, { name: 'Renamed Co' }).expect(200)).body.name).toBe('Renamed Co');
    expect((await rename(b.uuid, { ticker: ticker('RNC'), exchange: 'LSE' }).expect(200)).body).toMatchObject({ ticker: ticker('RNC'), exchange: 'LSE' });
  });

  it('answers 400 for a ticker or exchange too long for its column as stored, in upper case, never a 500', async () => {
    // Upper case can be longer: ß is SS, ﬃ is FFI. Checked before it, 'ﬃ' x 17 (51 in upper case)
    // and 'ß' x 26 (52) passed and failed the column (22001), and so did a snapshot's 'ß' x 20.
    const tooLong = async (res: request.Response) => {
      expect({ status: res.status, code: res.body.code }, JSON.stringify(res.body)).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
      return JSON.stringify(res.body);
    };
    expect(await tooLong(await create({ ticker: ticker('EXP'), exchange: '\ufb03'.repeat(17) }))).toContain('at most 50 characters in upper case');
    const sec = (await create({ ticker: ticker('EXQ'), exchange: '\ufb03'.repeat(16) }).expect(201)).body;
    expect(sec.exchange).toBe('FFI'.repeat(16));
    await tooLong(await request(app).put(`/api/investments/securities/${sec.uuid}`).send({ exchange: '\u00df'.repeat(26) }));
    expect((await request(app).put(`/api/investments/securities/${sec.uuid}`).send({ exchange: '\u00df'.repeat(25) }).expect(200)).body.exchange).toBe('SS'.repeat(25));
    await tooLong(await create({ ticker: 'X'.repeat(21) }));
    // A ticker is stored as written: 20 of ß fit.
    expect((await create({ ticker: '\u00df'.repeat(19) + ticker('').slice(-1) }).expect(201)).body.ticker).toHaveLength(20);

    // A snapshot whose ticker would be too long in upper case, as it creates the security, is
    // refused as a whole, as one with any other bad row is: nothing is written.
    const fund = (await create({ ticker: ticker('FXP'), security_type: 'etf' }).expect(201)).body.uuid as string;
    const snapshot = (underlying: string) => request(app).post('/api/investments/underlying-holdings').send({
      security_uuid: fund, snapshot_date: '2026-10-01', holdings: [{ underlying_ticker: ticker('OKU'), weight_percentage: 10 }, { underlying_ticker: underlying, weight_percentage: 10 }],
    });
    expect(await tooLong(await snapshot('\u00df'.repeat(20)))).toContain('at most 20 characters in upper case');
    const written = await tenant.pool.query(`SELECT count(*)::int AS n FROM securities WHERE ticker_key = upper($1)`, [ticker('OKU')]);
    expect(written.rows[0].n).toBe(0);
    expect((await snapshot('\u00df'.repeat(10))).status).toBeLessThan(300);
    expect((await tenant.pool.query(`SELECT count(*)::int AS n FROM securities WHERE ticker = $1`, ['SS'.repeat(10)])).rows[0].n).toBe(1);
  });

  /**
   * Waits until a statement of this ledger's app waits for a lock on securities: a create or
   * rename the test holds a conflicting row against (the race cases below).
   */
  async function waitForLockWait(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const waiting = await tenant.pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%securities%'`
      );
      if (waiting.rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('The request never waited for the held row');
  }

  /** `send` while another transaction holds `hold` (uncommitted), then `outcome` it. */
  async function whileHeld(hold: string, params: unknown[], send: () => Promise<request.Response>, outcome: 'COMMIT' | 'ROLLBACK' = 'COMMIT') {
    const client = await tenant.pool.connect();
    try {
      await client.query('BEGIN');
      const held = (await client.query(hold, params)).rows[0] as { uuid: string } | undefined;
      const answer = send();
      await waitForLockWait();
      await client.query(outcome);
      return { held, res: await answer };
    } finally {
      client.release();
    }
  }

  it('a create racing another create of its ticker answers 409 with that one once it commits, and 201 when it rolls back', async () => {
    const committed = ticker('RCC');
    const won = await whileHeld(`INSERT INTO securities (ticker, name) VALUES ($1, 'Held Co') RETURNING uuid`, [committed], () => create({ ticker: committed.toLowerCase() }).then((r) => r));
    exists(won.res, won.held!.uuid);
    const rolledBack = ticker('RCR');
    const lost = await whileHeld(`INSERT INTO securities (ticker, name) VALUES ($1, 'Held Co') RETURNING uuid`, [rolledBack], () => create({ ticker: rolledBack.toLowerCase() }).then((r) => r), 'ROLLBACK');
    expect(lost.res.status, JSON.stringify(lost.res.body)).toBe(201);
  });

  it('a rename racing a create of the ticker it renames to answers 409 with that one', async () => {
    const b = (await create({ ticker: ticker('RRX') }).expect(201)).body;
    const target = ticker('RRY');
    const { held, res } = await whileHeld(
      `INSERT INTO securities (ticker, name) VALUES ($1, 'Held Co') RETURNING uuid`, [target],
      () => request(app).put(`/api/investments/securities/${b.uuid}`).send({ ticker: target.toLowerCase() }).then((r) => r)
    );
    exists(res, held!.uuid);
    expect((await request(app).get(`/api/investments/securities/${b.uuid}`).expect(200)).body.ticker).toBe(ticker('RRX'));
  });

  it('a change of exchange racing a rename of the same security is checked against its ticker as renamed', async () => {
    // This race: the exchange change read the old ticker unlocked, passed its check,
    // and hit the key once the rename committed: a 500.
    const there = (await create({ ticker: ticker('ZZY'), exchange: 'LSE' }).expect(201)).body;
    const sec = (await create({ ticker: ticker('ZZX') }).expect(201)).body;
    const { res } = await whileHeld(
      `UPDATE securities SET ticker = $1 WHERE uuid = $2 RETURNING uuid`, [ticker('ZZY'), sec.uuid],
      () => request(app).put(`/api/investments/securities/${sec.uuid}`).send({ exchange: 'lse' }).then((r) => r)
    );
    exists(res, there.uuid);
    expect((await request(app).get(`/api/investments/securities/${sec.uuid}`).expect(200)).body).toMatchObject({ ticker: ticker('ZZY'), exchange: null });
  });

  it('a holdings snapshot finds an underlying created by hand while it waited, instead of failing the key', async () => {
    const fund = (await create({ ticker: ticker('FND'), security_type: 'etf' }).expect(201)).body.uuid as string;
    const racer = ticker('RACE');
    const client = await tenant.pool.connect();
    try {
      await client.query('BEGIN');
      // Created by hand (POST /securities takes no snapshot's lock), not committed yet.
      await client.query(`INSERT INTO securities (ticker, name) VALUES ($1, 'Race Co')`, [racer]);
      const snapshot = request(app).post('/api/investments/underlying-holdings').send({
        security_uuid: fund,
        snapshot_date: '2026-10-01',
        holdings: [{ underlying_ticker: racer.toLowerCase(), weight_percentage: 40 }, { underlying_ticker: ticker('NEW'), weight_percentage: 30 }],
      }).then((res) => res);
      // The snapshot's insert waits for the row above on the unique key.
      for (let i = 0; i < 100; i++) {
        const waiting = await tenant.pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'insert into "securities"%'`
        );
        if (waiting.rows[0].n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await client.query('COMMIT');
      const res = await snapshot;
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    } finally {
      client.release();
    }
    const rows = await tenant.pool.query(
      `SELECT s.ticker, count(*) OVER (PARTITION BY s.ticker_key)::int AS copies
         FROM fund_underlying_holdings fuh JOIN securities s ON s.id = fuh.underlying_security_id
         JOIN securities f ON f.id = fuh.security_id WHERE f.uuid = $1 ORDER BY s.ticker`,
      [fund]
    );
    expect(rows.rows).toEqual([{ ticker: ticker('NEW'), copies: 1 }, { ticker: racer, copies: 1 }]);
    const racers = await tenant.pool.query(`SELECT count(*)::int AS n FROM securities WHERE ticker_key = upper($1)`, [racer]);
    expect(racers.rows[0].n).toBe(1);
  });
});
