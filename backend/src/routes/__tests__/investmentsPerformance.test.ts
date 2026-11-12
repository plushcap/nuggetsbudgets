import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Performance integration tests (requires Postgres test DB). Each case has its own
// account and securities. Expected returns are worked by hand in the comments
// (and were checked against an independent xIRR / Modified Dietz); IRR and TWR are
// rounded to 4 places by the service.
describe('Investments performance API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountUuid: string;
  let securityUuid: string;
  let n = 0;

  const createAccount = async () =>
    (await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING uuid`, [`Perf Brokerage ${Date.now()} ${n++}`])).rows[0].uuid as string;
  const createSec = async () =>
    (await request(app).post('/api/investments/securities').send({ ticker: `PF${Date.now() % 100000}${n++}`, name: 'Perf Co', security_type: 'stock' }).expect(201)).body.uuid as string;
  const buy = (account: string, security: string, date: string, shares: number, price: number) =>
    request(app).post('/api/investments/events/buy').send({ account_uuid: account, security_uuid: security, event_date: date, shares, price_per_share: price }).expect(201);
  const price = (security: string, date: string, close: number) =>
    request(app).post('/api/investments/prices').send({ security_uuid: security, price_date: date, close }).expect(201);
  const performance = async (account: string, query: string) =>
    (await request(app).get(`/api/investments/reports/performance?account=${account}&${query}`).expect(200)).body;

  beforeAll(async () => {
    tenant = await createTestTenant('Investments performance API');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    accountUuid = await createAccount();
    securityUuid = await createSec();
    // Buy 100 @ $50 a year ago; current price $60 → +20% on $5000.
    await buy(accountUuid, securityUuid, '2024-06-26', 100, 50);
    await price(securityUuid, '2025-06-26', 60);
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('reports performance metrics from cash flows + current value', async () => {
    const res = await performance(accountUuid, 'end_date=2025-06-26');
    expect(res.current_value).toBe(6000); // 100 * 60
    expect(res.net_invested).toBe(5000);
    expect(res.total_return).toBeCloseTo(0.2, 2); // (6000-5000)/5000
    expect(res.irr).toBeGreaterThan(0.18); // ~20% over ~1yr
    expect(res.irr).toBeLessThan(0.22);
    expect(res.timeline.length).toBeGreaterThanOrEqual(1);
  });

  // Imported lots are money in at cost.
  it('counts an imported lot as money in at its cost', async () => {
    // 100 sh imported with $15,000 basis on 2025-01-02, worth $200/sh ($20,000) on
    // 2026-01-02, when 5 more are bought at $200 ($1,000). End value 105 x $200 = $21,000.
    // IRR: -15,000 at t=0, -1,000 and +21,000 at t=1 (365 days): 15,000(1+r) = 20,000, r = 1/3.
    // Dietz: (21,000 - 16,000) / (15,000 x 1 + 1,000 x 0) = 1/3. Total: 5,000 / 16,000 = 0.3125.
    // The import wasn't a flow, so it was all [-1,000, +21,000] on one day: total +2,000%.
    const account = await createAccount();
    const sec = await createSec();
    await request(app).post('/api/investments/lots/batch-import').send({ lots: [{ account_uuid: account, security_uuid: sec, acquisition_date: '2025-01-02', shares: 100, total_cost_basis: 15000 }] }).expect(201);
    await buy(account, sec, '2026-01-02', 5, 200);
    await price(sec, '2026-01-02', 200);
    const res = await performance(account, 'end_date=2026-01-02');
    expect(res).toMatchObject({ current_value: 21000, total_contributed: 16000, net_invested: 16000, irr: 0.3333, twr: 0.3333, total_return: 0.3125 });
  });

  // A reinvested dividend is internal, and so is a fee event.
  it('treats a reinvested dividend and a fee event as internal', async () => {
    // $10,000 (100 @ $100) on 2025-01-02; a $300 dividend reinvested at $100 (3 sh) on
    // 2025-07-01; a $50 advisory fee; price flat at $100. End value 103 x $100 = $10,300.
    // Only the $10,000 is money in: IRR = 10,300 / 10,000 - 1 = 3% over 365 days; Dietz
    // 300 / 10,000 = 3%; total 3%. Counting the DRIP as new money gave 0% on all three.
    const account = await createAccount();
    const sec = await createSec();
    await buy(account, sec, '2025-01-02', 100, 100);
    await request(app).post('/api/investments/events/dividend').send({ account_uuid: account, security_uuid: sec, event_date: '2025-07-01', total_amount: 300, reinvest: true, price_per_share: 100 }).expect(201);
    await request(app).post('/api/investments/events/fee').send({ account_uuid: account, fee_type: 'advisory', amount: 50, event_date: '2025-09-01' }).expect(201);
    await price(sec, '2026-01-02', 100);
    const res = await performance(account, 'end_date=2026-01-02');
    expect(res).toMatchObject({ current_value: 10300, total_contributed: 10000, net_invested: 10000, total_fees: 50, irr: 0.03, twr: 0.03, total_return: 0.03 });
  });

  // A window starts from the value held at its start.
  it('starts a date range from the value held at its start, and values its end with prices by then', async () => {
    // 1,000 sh bought in 2023; $100 at the close of 2024-12-31: begin value $100,000.
    // 10 more at $100 ($1,000) on 2025-03-02; $109 at the close of 2025-12-31: end value
    // 1,010 x $109 = $110,090. A later $200 close (2026-01-15) is past the end: not used.
    // Dietz over 2024-12-31 .. 2025-12-31 (365 days), the buy weighted 304/365:
    //   (110,090 - 100,000 - 1,000) / (100,000 + 1,000 x 304/365) = 9,090 / 100,832.88 = 0.0901.
    // IRR: -100,000 at 2024-12-31, -1,000 at +61 days, +110,090 at +365 days: r = 0.09015 -> 0.0902.
    // Total: (110,090 - 101,000) / 101,000 = 0.09. With begin value 0 and the latest close
    // (1,010 x $200 = $202,000), Dietz was 201,000 / ~835: about +24,000%.
    const account = await createAccount();
    const sec = await createSec();
    await buy(account, sec, '2023-06-01', 1000, 50);
    await price(sec, '2024-12-31', 100);
    await buy(account, sec, '2025-03-02', 10, 100);
    await price(sec, '2025-12-31', 109);
    await price(sec, '2026-01-15', 200);
    const res = await performance(account, 'start_date=2025-01-01&end_date=2025-12-31');
    expect(res).toMatchObject({ begin_value: 100000, current_value: 110090, total_contributed: 1000, net_invested: 101000, twr: 0.0901, irr: 0.0902, total_return: 0.09 });
  });

  it('counts the shares held at the start of a range across a later split and sale', async () => {
    // 100 sh @ $40 (2024-01-02); $50 at the close of 2024-12-31: begin value 100 x $50 = $5,000.
    // 2:1 split on 2025-03-03 (200 sh), 50 sold at $30 on 2025-06-02 ($1,500 out), $32 at the
    // close of 2025-12-31: end value 150 x $32 = $4,800. The lot now holds 150 post-split
    // shares; at the start it held 150 / 2 + 50 / 2 = 100.
    // Dietz (365 days, the sale weighted 212/365):
    //   (4,800 - 5,000 + 1,500) / (5,000 - 1,500 x 212/365) = 1,300 / 4,128.77 = 0.3149.
    // IRR: -5,000 at 2024-12-31, +1,500 at +153 days, +4,800 at +365 days: 0.3111.
    // Total: (4,800 - 3,500) / 3,500 = 0.3714.
    const account = await createAccount();
    const sec = await createSec();
    await buy(account, sec, '2024-01-02', 100, 40);
    await price(sec, '2024-12-31', 50);
    await request(app).post('/api/investments/corporate-actions/split').send({ security_uuid: sec, action_date: '2025-03-03', numerator: 2, denominator: 1 }).expect(201);
    await request(app).post('/api/investments/events/sell').send({ account_uuid: account, security_uuid: sec, event_date: '2025-06-02', shares: 50, price_per_share: 30 }).expect(201);
    await price(sec, '2025-12-31', 32);
    const res = await performance(account, 'start_date=2025-01-01&end_date=2025-12-31');
    expect(res).toMatchObject({ begin_value: 5000, current_value: 4800, total_distributed: 1500, net_invested: 3500, twr: 0.3149, irr: 0.3111, total_return: 0.3714 });
  });

  it('counts the shares held at the start of a range in a security a stock merger later closed', async () => {
    // 100 X @ $10 (2024-01-02); X $12 at the close of 2024-12-31: begin value $1,200. X merged
    // into Y at 0.5 on 2025-06-02 (50 Y), Y $30 at the close of 2025-12-31: end value $1,500.
    // No money in or out: IRR = Dietz = total = 1,500 / 1,200 - 1 = 25% over 365 days.
    const account = await createAccount();
    const x = await createSec();
    const y = await createSec();
    await buy(account, x, '2024-01-02', 100, 10);
    await price(x, '2024-12-31', 12);
    await request(app).post('/api/investments/corporate-actions/merger-stock').send({ security_uuid: x, acquirer_security_uuid: y, action_date: '2025-06-02', exchange_ratio: 0.5 }).expect(201);
    await price(y, '2025-12-31', 30);
    const res = await performance(account, 'start_date=2025-01-01&end_date=2025-12-31');
    expect(res).toMatchObject({ begin_value: 1200, current_value: 1500, net_invested: 1200, irr: 0.25, twr: 0.25, total_return: 0.25 });
  });

  it('answers 404 for an account it can\'t see, not the whole portfolio', async () => {
    await request(app).get('/api/investments/reports/performance?account=00000000-0000-7000-8000-000000000000').expect(404);
  });

  it('gives no returns when a holding has no price, rather than valuing it at $0', async () => {
    // 10 sh bought for $100 with no price recorded: as $0 the total return was -100%.
    const account = await createAccount();
    const sec = await createSec();
    await buy(account, sec, '2025-02-03', 10, 10);
    const res = await performance(account, 'end_date=2025-12-31');
    expect(res).toMatchObject({ unpriced_securities: 1, irr: null, twr: null, total_return: null, annualized_return: null });
  });
});
