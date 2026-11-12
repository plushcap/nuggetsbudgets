import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Corporate actions are date-aware and recorded once, and a lot's total_cost_basis is
 * its remaining basis. Each test uses its own security.
 */
describe('Investments corporate actions: dates, retries and remaining basis', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountUuid: string;
  let n = 0;

  const createSec = async () => {
    const r = await request(app).post('/api/investments/securities').send({ ticker: `CD${Date.now() % 100000}${n++}`, name: 'Dates Co', security_type: 'stock' }).expect(201);
    return r.body.uuid as string;
  };
  const buy = async (security: string, date: string, shares: number, price: number) =>
    (await request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: security, event_date: date, shares, price_per_share: price }).expect(201)).body.lot_uuid as string;
  const sellLot = (security: string, lotUuid: string, date: string, shares: number, price: number) =>
    request(app).post('/api/investments/events/sell').send({
      account_uuid: accountUuid, security_uuid: security, event_date: date, shares, price_per_share: price,
      method: 'specific_id', specific_lots: [{ lot_uuid: lotUuid, shares }],
    }).expect(201);
  const lot = async (security: string, lotUuid: string) => {
    const res = await request(app).get(`/api/investments/holdings/${security}/lots?account=${accountUuid}`).expect(200);
    const l = res.body.find((x: { uuid: string }) => x.uuid === lotUuid);
    return { shares: Number(l.shares_remaining), perShare: Number(l.cost_basis_per_share), total: Number(l.total_cost_basis), isOpen: l.is_open as boolean };
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Investments corporate action dates');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING uuid`, [`CD Brokerage ${Date.now()}`]);
    accountUuid = acct.rows[0].uuid;
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('splits only the lots acquired before the split date', async () => {
    const sec = await createSec();
    const old = await buy(sec, '2019-05-01', 100, 40); // $4,000
    const later = await buy(sec, '2023-02-01', 50, 100); // $5,000, bought after the split
    const res = await request(app).post('/api/investments/corporate-actions/split').send({ security_uuid: sec, action_date: '2020-08-31', numerator: 4, denominator: 1 }).expect(201);
    expect(res.body.affected_lots).toBe(1);
    // 2019 lot: 100 sh x 4 = 400 sh, $4,000 / 400 = $10/sh, total unchanged.
    expect(await lot(sec, old)).toMatchObject({ shares: 400, perShare: 10, total: 4000 });
    // 2023 lot: already post-split shares; stays 50 sh at $100.
    expect(await lot(sec, later)).toMatchObject({ shares: 50, perShare: 100, total: 5000 });
  });

  it('refuses the same split recorded again (a retried request), dry run included', async () => {
    const sec = await createSec();
    const l = await buy(sec, '2019-05-01', 100, 40);
    const body = { security_uuid: sec, action_date: '2020-08-31', numerator: 4, denominator: 1 };
    await request(app).post('/api/investments/corporate-actions/split').send(body).expect(201);
    const again = await request(app).post('/api/investments/corporate-actions/split').send(body).expect(409);
    expect(again.body.code).toBe('CORPORATE_ACTION_ALREADY_RECORDED');
    await request(app).post('/api/investments/corporate-actions/split').send({ ...body, dry_run: true }).expect(409);
    // Applied once: 400 sh, not 1,600.
    expect(await lot(sec, l)).toMatchObject({ shares: 400, perShare: 10 });
    const actions = await pool.query(`SELECT count(*)::int AS n FROM security_corporate_actions sca JOIN securities s ON s.id = sca.security_id WHERE s.uuid = $1`, [sec]);
    expect(actions.rows[0].n).toBe(1);
  });

  it('refuses a return of capital recorded again', async () => {
    const sec = await createSec();
    const l = await buy(sec, '2020-01-15', 100, 20);
    const body = { security_uuid: sec, action_date: '2022-01-01', amount_per_share: 5 };
    await request(app).post('/api/investments/corporate-actions/return-of-capital').send(body).expect(201);
    await request(app).post('/api/investments/corporate-actions/return-of-capital').send(body).expect(409);
    expect((await lot(sec, l)).perShare).toBe(15); // $20 - $5 once, not $10
  });

  it('refuses a spinoff into the same security on the same day recorded again', async () => {
    const src = await createSec();
    const child = await createSec();
    const l = await buy(src, '2020-01-15', 100, 50);
    const body = { source_security_uuid: src, new_security_uuid: child, action_date: '2021-01-01', allocation_fraction: 0.2, share_ratio: 0.5 };
    await request(app).post('/api/investments/corporate-actions/spinoff').send(body).expect(201);
    await request(app).post('/api/investments/corporate-actions/spinoff').send(body).expect(409);
    expect((await lot(src, l)).perShare).toBe(40); // $5,000 x 0.8 / 100 once, not $32
  });

  it('refuses a split dated before a sale already recorded on the lot', async () => {
    const sec = await createSec();
    const l = await buy(sec, '2019-05-01', 100, 40);
    await sellLot(sec, l, '2021-06-01', 30, 60);
    // The 2021 sale's 30 shares are in units the 2020 split would change: refused, lot untouched.
    const res = await request(app).post('/api/investments/corporate-actions/split').send({ security_uuid: sec, action_date: '2020-08-31', numerator: 4, denominator: 1 }).expect(409);
    expect(res.body.code).toBe('CORPORATE_ACTION_BEFORE_RECORDED_SALES');
    expect(await lot(sec, l)).toMatchObject({ shares: 70, perShare: 40 });
    // A split after the sale is fine: 70 x 4 = 280 sh at $10.
    await request(app).post('/api/investments/corporate-actions/split').send({ security_uuid: sec, action_date: '2022-08-31', numerator: 4, denominator: 1 }).expect(201);
    expect(await lot(sec, l)).toMatchObject({ shares: 280, perShare: 10, total: 2800 });
  });

  it('a sell leaves total_cost_basis as the basis of the shares left', async () => {
    const sec = await createSec();
    const l = await buy(sec, '2024-01-02', 100, 10); // $1,000
    await sellLot(sec, l, '2024-06-03', 50, 12);
    // 50 sh left at $10: $500 (was left at $1,000).
    expect(await lot(sec, l)).toMatchObject({ shares: 50, perShare: 10, total: 500, isOpen: true });
    await sellLot(sec, l, '2024-07-01', 50, 12);
    expect(await lot(sec, l)).toMatchObject({ shares: 0, total: 0, isOpen: false });
  });

  it('a return of capital lowers total_cost_basis with the per-share basis', async () => {
    const sec = await createSec();
    const l = await buy(sec, '2024-01-02', 100, 20); // $2,000
    await request(app).post('/api/investments/corporate-actions/return-of-capital').send({ security_uuid: sec, action_date: '2024-06-03', amount_per_share: 5 }).expect(201);
    // $20 - $5 = $15/sh; 100 x $15 = $1,500 (was left at $2,000).
    expect(await lot(sec, l)).toMatchObject({ perShare: 15, total: 1500 });
  });

  it('a wash-sale bump on a half-sold lot adds to the basis of the shares left', async () => {
    // Issue scenario: a 100-sh/$1,000 lot is half sold, then gets a $100 wash adjustment.
    const sec = await createSec();
    const loss = await buy(sec, '2025-01-02', 10, 30); // $300, sold at a loss below
    const repl = await buy(sec, '2025-03-01', 100, 10); // $1,000, the replacement
    await sellLot(sec, repl, '2025-03-05', 50, 11); // half sold (a gain): 50 sh / $500 left
    // 10 sh bought at $30 sold at $20: -$100, within 30 days of the replacement buy.
    const sold = await sellLot(sec, loss, '2025-03-10', 10, 20);
    expect(sold.body.plan.totalRealized).toBe(-100);
    expect(sold.body.wash_sale.disallowed).toBe(100);
    // $10 + $100 / 50 sh = $12/sh, $600 total; the old recompute gave (1000 + 100) / 50 = $22.
    expect(await lot(sec, repl)).toMatchObject({ shares: 50, perShare: 12, total: 600 });
  });

  it('a wash-sale bump after a return of capital keeps the return of capital', async () => {
    const sec = await createSec();
    const loss = await buy(sec, '2025-01-02', 10, 30); // $300
    const repl = await buy(sec, '2025-03-01', 100, 20); // $2,000
    // $5/sh return of capital on both lots: loss lot $25/sh, replacement $15/sh ($1,500).
    await request(app).post('/api/investments/corporate-actions/return-of-capital').send({ security_uuid: sec, action_date: '2025-03-03', amount_per_share: 5 }).expect(201);
    // 10 sh at basis $25 sold at $20: -$50, disallowed (replacement bought 9 days before).
    const sold = await sellLot(sec, loss, '2025-03-10', 10, 20);
    expect(sold.body.plan.totalRealized).toBe(-50);
    expect(sold.body.wash_sale.disallowed).toBe(50);
    // $15 + $50 / 100 = $15.50/sh, $1,550; the old recompute gave (2000 + 50) / 100 = $20.50.
    expect(await lot(sec, repl)).toMatchObject({ perShare: 15.5, total: 1550 });
  });

  it('a merger closes its lots with no basis left', async () => {
    const sec = await createSec();
    const l = await buy(sec, '2020-01-15', 100, 30);
    await request(app).post('/api/investments/corporate-actions/merger-cash').send({ security_uuid: sec, action_date: '2025-01-01', cash_per_share: 50 }).expect(201);
    expect(await lot(sec, l)).toMatchObject({ shares: 0, total: 0, isOpen: false });
    await request(app).post('/api/investments/corporate-actions/merger-cash').send({ security_uuid: sec, action_date: '2025-01-01', cash_per_share: 50 }).expect(409);
  });
});
