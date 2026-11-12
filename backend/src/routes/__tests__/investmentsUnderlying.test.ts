import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Holdings-level look-through: populate a fund's underlying securities, then
// resolve portfolio exposure all the way to individual stocks. Requires Postgres.
describe('Investments underlying holdings + look-through exposure', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountUuid: string;
  const secUuids: string[] = [];

  const createFund = async (prefix: string) => {
    const r = await request(app)
      .post('/api/investments/securities')
      .send({ ticker: `${prefix}${Date.now() % 100000}${secUuids.length}`, name: `${prefix} Fund`, security_type: 'etf', asset_class: 'equity', is_pass_through: true })
      .expect(201);
    secUuids.push(r.body.uuid);
    return r.body.uuid as string;
  };
  const buy = (security: string, shares: number, price: number, date = '2020-01-15') =>
    request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: security, event_date: date, shares, price_per_share: price }).expect(201);
  const addPrice = async (securityUuid: string, close: number, date = '2026-06-25') => {
    const idRow = await pool.query('SELECT id FROM securities WHERE uuid = $1', [securityUuid]);
    await pool.query(
      `INSERT INTO security_prices (security_id, price_date, close, source) VALUES ($1, $2, $3, 'test')
       ON CONFLICT (security_id, price_date) DO UPDATE SET close = EXCLUDED.close`,
      [idRow.rows[0].id, date, close]
    );
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Investments underlying holdings + look-through exposure');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING id, uuid`, [`UH Brokerage ${Date.now()}`]);
    accountUuid = acct.rows[0].uuid;
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('upserts underlying holdings (auto-creating tickers), is idempotent, and reads them back', async () => {
    const fund = await createFund('UF');
    const ticker = `AAP${Date.now() % 100000}`;
    const payload = {
      security_uuid: fund,
      snapshot_date: '2026-06-25',
      holdings: [
        { underlying_ticker: ticker, underlying_name: 'Test Acme', weight_percentage: 60 },
        { underlying_ticker: `MSF${Date.now() % 100000}`, weight_percentage: 40, shares: 10 },
      ],
    };
    const first = await request(app).post('/api/investments/underlying-holdings').send(payload).expect(201);
    expect(first.body.rows_written).toBe(2);
    // Re-applying the same snapshot updates in place, not duplicates.
    await request(app).post('/api/investments/underlying-holdings').send(payload).expect(201);
    const read = await request(app).get(`/api/investments/securities/${fund}/underlying-holdings`).expect(200);
    expect(read.body.length).toBe(2);
    expect(read.body[0].weight_percentage).toBe(60); // ordered by weight desc
    expect(read.body[0].ticker).toBe(ticker.toUpperCase());
  });

  it('batch-upserts many holdings in one call, dedupes duplicate tickers, and updates on re-apply', async () => {
    const fund = await createFund('UG');
    // 50 distinct tickers (0.5% each = 25%) plus a duplicate of the first.
    const tickers = Array.from({ length: 50 }, (_, i) => `BULK${Date.now() % 100000}_${i}`);
    const holdings = tickers.map((t) => ({ underlying_ticker: t, weight_percentage: 0.5 }));
    holdings.push({ underlying_ticker: tickers[0], weight_percentage: 0.9 }); // duplicate → last wins
    const res = await request(app).post('/api/investments/underlying-holdings').send({ security_uuid: fund, snapshot_date: '2026-06-25', holdings }).expect(201);
    expect(res.body.rows_written).toBe(50); // 51 input rows, deduped to 50 securities
    const read = await request(app).get(`/api/investments/securities/${fund}/underlying-holdings`).expect(200);
    expect(read.body.length).toBe(50);
    // Duplicate resolved last-wins: the first ticker carries the 0.9 weight.
    expect(read.body.find((r: { ticker: string }) => r.ticker === tickers[0].toUpperCase()).weight_percentage).toBe(0.9);
    // Re-apply with a changed weight updates in place (excluded ref), no duplication.
    await request(app).post('/api/investments/underlying-holdings').send({ security_uuid: fund, snapshot_date: '2026-06-25', holdings: [{ underlying_ticker: tickers[1], weight_percentage: 0.75 }] }).expect(201);
    const reread = await request(app).get(`/api/investments/securities/${fund}/underlying-holdings`).expect(200);
    expect(reread.body.length).toBe(50);
    expect(reread.body.find((r: { ticker: string }) => r.ticker === tickers[1].toUpperCase()).weight_percentage).toBe(0.75);
  });

  it('finds an underlying stored with a lower-case ticker rather than create it again', async () => {
    const fund = await createFund('LC');
    const ticker = `lc${Date.now() % 100000}`;
    const stored = await pool.query<{ id: number }>(`INSERT INTO securities (ticker, name) VALUES ($1, 'Lower case Co') RETURNING id`, [ticker]);
    await request(app)
      .post('/api/investments/underlying-holdings')
      .send({ security_uuid: fund, snapshot_date: '2026-06-25', holdings: [{ underlying_ticker: ticker.toUpperCase(), weight_percentage: 1 }] })
      .expect(201);
    const same = await pool.query<{ id: number }>('SELECT id FROM securities WHERE upper(ticker) = $1', [ticker.toUpperCase()]);
    expect(same.rows.map((r) => r.id)).toEqual([stored.rows[0]!.id]);
    const held = await pool.query<{ underlying_security_id: number }>(
      'SELECT underlying_security_id FROM fund_underlying_holdings WHERE security_id = (SELECT id FROM securities WHERE uuid = $1)', [fund]
    );
    expect(held.rows).toEqual([{ underlying_security_id: stored.rows[0]!.id }]);
  });

  it('accepts a source tag longer than the old 32-char limit (regression for 22001)', async () => {
    const fund = await createFund('US');
    const longSource = 'issuer.example LRGIDX holdings fact sheet 2026-06-26 (downloaded)'; // >32 chars
    await request(app)
      .post('/api/investments/underlying-holdings')
      .send({ security_uuid: fund, snapshot_date: '2026-06-25', holdings: [{ underlying_ticker: `LS${Date.now() % 100000}`, weight_percentage: 100 }], source: longSource })
      .expect(201);
    const read = await request(app).get(`/api/investments/securities/${fund}/underlying-holdings`).expect(200);
    expect(read.body.length).toBe(1);
  });

  it('stores sub-0.0001% tail weights at full precision', async () => {
    const fund = await createFund('UP');
    const ticker = `PR${Date.now() % 100000}`;
    await request(app)
      .post('/api/investments/underlying-holdings')
      .send({ security_uuid: fund, snapshot_date: '2026-06-25', holdings: [{ underlying_ticker: ticker, weight_percentage: 0.000123 }] })
      .expect(201);
    const read = await request(app).get(`/api/investments/securities/${fund}/underlying-holdings`).expect(200);
    expect(read.body[0].weight_percentage).toBeCloseTo(0.000123, 6);
  });

  it('backfills the security name when a later import supplies one for a bare ticker', async () => {
    const fund = await createFund('UN');
    const ticker = `NM${Date.now() % 100000}`;
    // First import: ticker only → security auto-created with name == ticker.
    await request(app)
      .post('/api/investments/underlying-holdings')
      .send({ security_uuid: fund, snapshot_date: '2026-06-25', holdings: [{ underlying_ticker: ticker, weight_percentage: 100 }] })
      .expect(201);
    let read = await request(app).get(`/api/investments/securities/${fund}/underlying-holdings`).expect(200);
    expect(read.body[0].name).toBe(ticker.toUpperCase());
    // Second import: same ticker with a real name → backfilled onto the security.
    await request(app)
      .post('/api/investments/underlying-holdings')
      .send({ security_uuid: fund, snapshot_date: '2026-06-26', holdings: [{ underlying_ticker: ticker, underlying_name: 'Acme Holdings Inc', weight_percentage: 100 }] })
      .expect(201);
    read = await request(app).get(`/api/investments/securities/${fund}/underlying-holdings`).expect(200);
    expect(read.body[0].name).toBe('Acme Holdings Inc');
  });

  it('rejects underlying weights summing above 105% and writes nothing', async () => {
    const fund = await createFund('UB');
    // Weight-sum is a business rule (not schema): the service rejects it with the reason,
    // and the request transaction rolls back whatever it wrote.
    const rejected = await request(app)
      .post('/api/investments/underlying-holdings')
      .send({ security_uuid: fund, snapshot_date: '2026-06-25', holdings: [{ underlying_ticker: `X${Date.now() % 100000}`, weight_percentage: 60 }, { underlying_ticker: `Y${Date.now() % 100000}`, weight_percentage: 50 }] })
      .expect(400);
    expect(rejected.body).toMatchObject({ code: 'INVALID_REQUEST', error: expect.stringMatching(/^underlying weights sum to 110%/) });
    const read = await request(app).get(`/api/investments/securities/${fund}/underlying-holdings`).expect(200);
    expect(read.body.length).toBe(0);
  });

  it('resolves portfolio exposure through a fund to its underlying stocks', async () => {
    const fund = await createFund('UE');
    await buy(fund, 100, 50);
    await addPrice(fund, 100); // 100 shares * $100 = $10,000 market value
    const acmec = `EA${Date.now() % 100000}`;
    const widgt = `EM${Date.now() % 100000}`;
    await request(app)
      .post('/api/investments/underlying-holdings')
      .send({ security_uuid: fund, snapshot_date: '2026-06-25', holdings: [{ underlying_ticker: acmec, weight_percentage: 60 }, { underlying_ticker: widgt, weight_percentage: 40 }] })
      .expect(201);

    const exp = await request(app).get('/api/investments/reports/underlying-exposure').expect(200);
    const byTicker = Object.fromEntries(exp.body.exposures.map((e: { ticker: string; amount: number }) => [e.ticker, e.amount]));
    expect(byTicker[acmec.toUpperCase()]).toBeCloseTo(6000, 2);
    expect(byTicker[widgt.toUpperCase()]).toBeCloseTo(4000, 2);
    expect(exp.body.unknown_value).toBeCloseTo(0, 2);
    // The fund itself is fully resolved away — no self-exposure row.
    expect(exp.body.exposures.some((e: { ticker: string }) => e.ticker.startsWith('UE'))).toBe(false);
  });

  it("scales a fund whose weights add up to over 100% to its value", async () => {
    // An account of its own, so the report holds only this fund: $100 of it, 60% + 45%.
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING uuid`, [`UH Over ${Date.now()}`]);
    const fund = await createFund('UV');
    await request(app).post('/api/investments/events/buy')
      .send({ account_uuid: acct.rows[0].uuid, security_uuid: fund, event_date: '2020-01-15', shares: 1, price_per_share: 90 }).expect(201);
    await addPrice(fund, 100);
    const [over, under] = [`OV${Date.now() % 100000}`, `UN${Date.now() % 100000}`];
    await request(app)
      .post('/api/investments/underlying-holdings')
      .send({ security_uuid: fund, snapshot_date: '2026-06-25', holdings: [{ underlying_ticker: over, weight_percentage: 60 }, { underlying_ticker: under, weight_percentage: 45 }] })
      .expect(201);

    const exp = await request(app).get(`/api/investments/reports/underlying-exposure?account=${acct.rows[0].uuid}`).expect(200);
    // It showed $60 + $45 = $105 of a $100 total.
    expect(exp.body).toMatchObject({
      total_value: 100,
      unknown_value: 0,
      exposures: [
        { ticker: over.toUpperCase(), amount: 57.14, percentage: 57.14 },
        { ticker: under.toUpperCase(), amount: 42.86, percentage: 42.86 },
      ],
    });
  });

  it('treats an untracked fund as opaque (value goes to unknown)', async () => {
    const fund = await createFund('UO');
    await buy(fund, 50, 20);
    await addPrice(fund, 40); // 50 * 40 = $2,000
    await request(app)
      .post('/api/investments/underlying-holdings')
      .send({ security_uuid: fund, snapshot_date: '2026-06-25', holdings: [{ underlying_ticker: `OO${Date.now() % 100000}`, weight_percentage: 100 }] })
      .expect(201);
    // Turn tracking off — fund becomes opaque.
    await request(app).post('/api/investments/underlying-tracking').send({ security_uuid: fund, track_underlying_holdings: false }).expect(200);

    const exp = await request(app).get(`/api/investments/reports/underlying-exposure?account=${accountUuid}`).expect(200);
    // This fund's $2,000 is now unresolved; it must not appear as a leaf exposure.
    expect(exp.body.unknown_value).toBeGreaterThanOrEqual(2000);
  });
});
