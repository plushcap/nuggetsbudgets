import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Tax-planning / advisory integration tests (require Postgres test DB).
describe('Investments tax-planning API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountUuid: string;
  let securityUuid: string;

  beforeAll(async () => {
    tenant = await createTestTenant('Investments tax-planning API');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING id, uuid`, [`TP Brokerage ${Date.now()}`]);
    accountUuid = acct.rows[0].uuid;
    const sec = await request(app).post('/api/investments/securities').send({ ticker: `TP${Date.now() % 100000}`, name: 'TaxPlan Co', security_type: 'stock', asset_class: 'equity' }).expect(201);
    securityUuid = sec.body.uuid;
    // Long-term lot bought high; current price low => unrealized loss.
    await request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2020-01-15', shares: 100, price_per_share: 80 }).expect(201);
    await request(app).post('/api/investments/prices').send({ security_uuid: securityUuid, price_date: '2025-06-01', close: 50 }).expect(201);
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('previews sell tax impact (LT loss, negative estimated tax)', async () => {
    const res = await request(app)
      .get(`/api/investments/reports/sell-tax-impact?account=${accountUuid}&security=${securityUuid}&shares=100&date=2025-06-01&method=fifo&lt_rate=0.15`)
      .expect(200);
    expect(res.body.tax.longTermGain).toBe(-3000); // 100*(50-80)
    expect(res.body.tax.estimatedLongTermTax).toBe(-450); // -3000*0.15
    expect(res.body.estimated).toBe(true);
  });

  it('finds the loss lot as a TLH candidate', async () => {
    const res = await request(app).get(`/api/investments/reports/tax-loss-harvest?account=${accountUuid}`).expect(200);
    expect(res.body.candidates.length).toBeGreaterThanOrEqual(1);
    expect(res.body.candidates[0].unrealized_loss).toBe(3000);
  });

  it("reads min_loss exactly, in cents, and refuses one it can't", async () => {
    const harvest = (minLoss: string) => request(app).get(`/api/investments/reports/tax-loss-harvest?account=${accountUuid}&min_loss=${encodeURIComponent(minLoss)}`);
    // The lot has lost $3,000.00: more than 2999.99, not more than 3000.
    expect((await harvest('2999.99').expect(200)).body.candidates).toHaveLength(1);
    expect((await harvest('3000').expect(200)).body.candidates).toHaveLength(0);
    // 1e307 overflowed to a 500; -5 listed lots at a gain; 0.289 rounded to 0.29.
    for (const bad of ['1e307', '-5', '0.289', '99999999999']) {
      const res = await harvest(bad);
      expect(res.status, bad).toBe(400);
    }
  });

  it('gives each refused min_loss its own reason', async () => {
    const harvest = (minLoss: string) => request(app).get(`/api/investments/reports/tax-loss-harvest?account=${accountUuid}&min_loss=${encodeURIComponent(minLoss)}`);
    // 1e2 and 0x10 have no decimal places: they were "a number with at most 2 decimal places".
    for (const bad of ['1e2', '0x10', 'abc', 'Infinity', '1,000']) {
      const res = await harvest(bad);
      expect(res.status, bad).toBe(400);
      expect(res.body, bad).toMatchObject({ code: 'VALIDATION_ERROR', message: 'min_loss must be an amount in dollars, written in digits (such as 100 or 99.95)' });
    }
    expect((await harvest('0.289')).body).toMatchObject({ code: 'INVALID_AMOUNT', error: 'min_loss must be a number with at most 2 decimal places' });
    expect((await harvest('99999999999')).body).toMatchObject({ code: 'INVALID_AMOUNT', error: expect.stringMatching(/^min_loss must be between /) });
    expect((await harvest('-5')).body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'min_loss must not be negative' });
    // Written plainly, with a sign, spaces or trailing zeros, it is read.
    for (const good of ['100', ' 2999.99 ', '+2999.990', '.5']) {
      expect((await harvest(good)).status, good).toBe(200);
    }
    // Sent twice: not one amount.
    const twice = await request(app).get(`/api/investments/reports/tax-loss-harvest?min_loss=1&min_loss=2`);
    expect(twice.status).toBe(400);
    expect(twice.body.code).toBe('VALIDATION_ERROR');
  });

  it('suggests lots for an objective', async () => {
    const res = await request(app).get(`/api/investments/reports/lot-suggestions?account=${accountUuid}&security=${securityUuid}&objective=maximize_loss`).expect(200);
    expect(res.body.lots[0].unrealizedGain).toBe(-3000);
    expect(res.body.lots[0].uuid).toBeTruthy();
  });

  it('estimates a sale by the method the sale would use when none is given, and refuses an unknown one', async () => {
    // 10 sh at $10 and 10 at $30; 10 sold at $20. FIFO takes $100, HIFO $300, average cost $200.
    // The estimate always took FIFO, whatever the account's or security's setting.
    const sec = (await request(app).post('/api/investments/securities').send({ ticker: `TQ${Date.now() % 100000}`, name: 'Method Co', security_type: 'stock' }).expect(201)).body.uuid;
    for (const [date, price] of [['2024-01-02', 10], ['2024-02-01', 30]] as const) {
      await request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: sec, event_date: date, shares: 10, price_per_share: price }).expect(201);
    }
    const estimate = (method?: string) => request(app).get('/api/investments/reports/sell-tax-impact')
      .query({ account: accountUuid, security: sec, shares: 10, price: 20, date: '2025-06-01', ...(method !== undefined ? { method } : {}) });
    const setMethod = (method: string) => request(app).post('/api/investments/cost-basis-method').send({ account_uuid: accountUuid, security_uuid: sec, method }).expect(200);

    expect((await estimate().expect(200)).body).toMatchObject({ method: 'fifo', plan: { totalBasis: 100 } });
    await setMethod('hifo');
    expect((await estimate().expect(200)).body).toMatchObject({ method: 'hifo', plan: { totalBasis: 300 } });
    await setMethod('average_cost');
    expect((await estimate().expect(200)).body).toMatchObject({ method: 'average_cost', plan: { totalBasis: 200 } });
    // A method given is the one used.
    expect((await estimate('fifo').expect(200)).body).toMatchObject({ method: 'fifo', plan: { totalBasis: 100 } });
    // Specific lots can't be picked for an estimate: a 400 that says what to do.
    await setMethod('specific_id');
    const specific = await estimate();
    expect(specific.status).toBe(400);
    expect(specific.body).toMatchObject({ code: 'INVALID_REQUEST', error: expect.stringMatching(/^This holding is sold by specific lots/) });
    // An unknown method is a 400 (the route's query schema), never a 500.
    for (const bad of ['bogus', 'FIFO']) {
      const res = await estimate(bad);
      expect(res.status, bad).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'method must be one of fifo, lifo, hifo, specific_id, average_cost' });
    }
    // `?method=` is not given: the holding's method, here specific lots, so the same 400 as without one.
    expect((await estimate('')).body).toMatchObject({ code: 'INVALID_REQUEST', error: expect.stringMatching(/^This holding is sold by specific lots/) });
  });

  it('reports concentration (single holding = 100%)', async () => {
    const res = await request(app).get(`/api/investments/reports/concentration?threshold=10`).expect(200);
    const row = res.body.rows.find((r: { ticker: string }) => r.ticker.startsWith('TP'));
    expect(row.portfolioPct).toBe(100);
    expect(row.exceedsThreshold).toBe(true);
  });

  // Last: its holding, with a price, would change the portfolio the concentration test reads.
  it('leaves out a lot acquired after today: no sale today could sell it', async () => {
    const acct = (await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING uuid`, [`TP Later ${Date.now()}`])).rows[0].uuid;
    const sec = (await request(app).post('/api/investments/securities').send({ ticker: `TL${Date.now() % 100000}`, name: 'Later Co', security_type: 'stock' }).expect(201)).body.uuid;
    const { today, later } = (await pool.query("SELECT app_today()::text AS today, (app_today() + 20)::text AS later")).rows[0];
    const buy = async (day: string) =>
      (await request(app).post('/api/investments/events/buy').send({ account_uuid: acct, security_uuid: sec, event_date: day, shares: 10, price_per_share: 40 }).expect(201)).body.lot_uuid;
    const held = await buy('2024-03-01');
    const boughtToday = await buy(today);
    await buy(later);
    await request(app).post('/api/investments/prices').send({ security_uuid: sec, price_date: '2024-06-03', close: 30 }).expect(201);

    const res = await request(app).get(`/api/investments/reports/tax-loss-harvest?account=${acct}`).expect(200);
    // Each lot has lost $100; the one dated in 20 days isn't one to harvest today.
    expect(res.body.candidates.map((c: { lot_uuid: string }) => c.lot_uuid).sort()).toEqual([held, boughtToday].sort());
  });
});
