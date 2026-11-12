import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A sale takes a lot's remaining total basis pro rata, by design: S of
 * its R remaining shares take total × S / R, rounded to the cent once, and the sale of its last
 * share takes what is left. It was figured from the lot's basis per share, kept to 4 places,
 * which left basis on a lot sold in parts, took more than it had, or missed the fees in it. The
 * sale's dry run, the tax-planning what-ifs and a cash merger read the same total.
 */
describe('A sale takes a lot\'s remaining basis pro rata', () => {
  let app: Express;
  let tenant: TestTenant;
  let pool: Pool;
  const stamp = Date.now() % 1_000_000;
  let n = 0;
  let account: string;
  const post = (path: string, body: object) => request(app).post(`/api/investments${path}`).send(body);
  const security = async () => (await post('/securities', { ticker: `PR${stamp}${(n += 1)}`, name: 'Pro rata Co', security_type: 'stock' }).expect(201)).body.uuid as string;
  const buy = async (sec: string, shares: string, price: string, fees = '0', date = '2024-01-02') =>
    (await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: date, shares, price_per_share: price, fees }).expect(201)).body.lot_uuid as string;
  const sell = (sec: string, shares: string, price: string, extra: object = {}) =>
    post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2025-03-03', shares, price_per_share: price, method: 'fifo', ...extra });
  /** A lot as stored: its shares, remaining total and basis per share as text. */
  const lotRow = async (lotUuid: string) =>
    (await pool.query('SELECT shares_remaining::text AS shares, total_cost_basis::text AS total, cost_basis_per_share::text AS per_share, is_open FROM tax_lots WHERE uuid = $1', [lotUuid])).rows[0];
  /** The basis each sale of a lot consumed, in the order they were recorded. */
  const consumed = async (lotUuid: string) =>
    (await pool.query('SELECT lc.basis_consumed::text AS basis FROM lot_consumptions lc JOIN tax_lots tl ON tl.id = lc.tax_lot_id WHERE tl.uuid = $1 ORDER BY lc.id', [lotUuid])).rows.map((r) => r.basis);

  beforeAll(async () => {
    tenant = await createTestTenant('Investments pro-rata basis');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    account = (await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'investment', 'investments', 'Asset') RETURNING uuid`, [`Pro rata ${stamp}`])).rows[0].uuid;
  });
  afterAll(async () => { await tenant.cleanup(); });

  it('sold a share at a time, a lot gives all its basis', async () => {
    // 3 shares at $33.3333: $100.00 ($99.9999), $33.3333 a share. From the per-share basis each
    // sale took $33.33, $99.99 in all, and the lot closed with its last cent unsold.
    const sec = await security();
    const lot = await buy(sec, '3', '33.3333');
    expect(await lotRow(lot)).toMatchObject({ total: '100.00', per_share: '33.3333' });
    for (const expected of [33.33, 33.34, 33.33]) {
      const res = await sell(sec, '1', '40');
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.plan.totalBasis).toBe(expected);
    }
    expect(await consumed(lot)).toEqual(['33.33', '33.34', '33.33']);
    expect(await lotRow(lot)).toMatchObject({ shares: '0.000000', total: '0.00', is_open: false });
  });

  it('takes no more than the lot has: $0.20 in three sales, not $0.21', async () => {
    // 3 shares at $0.0667: $0.20 ($0.2001). The per-share basis took $0.07 three times.
    const sec = await security();
    const lot = await buy(sec, '3', '0.0667');
    expect(await lotRow(lot)).toMatchObject({ total: '0.20', per_share: '0.0667' });
    for (let i = 0; i < 3; i++) await sell(sec, '1', '1').expect(201);
    expect(await consumed(lot)).toEqual(['0.07', '0.07', '0.06']);
    expect(await lotRow(lot)).toMatchObject({ total: '0.00', is_open: false });
  });

  it('a sale of the whole lot takes its fees, and its dry run answers the same plan', async () => {
    // 1,000,000 shares at $0.0012 with $4.95 in fees: $1,204.95, $0.0012 a share. Sold whole at
    // $0.0012 it lost the fees; from the per-share basis it realized $0.00.
    const sec = await security();
    const lot = await buy(sec, '1000000', '0.0012', '4.95');
    expect(await lotRow(lot)).toMatchObject({ total: '1204.95', per_share: '0.0012' });
    const dry = await sell(sec, '1000000', '0.0012', { dry_run: true }).expect(200);
    const real = await sell(sec, '1000000', '0.0012').expect(201);
    expect(real.body.plan).toMatchObject({ totalBasis: 1204.95, totalProceeds: 1200, totalRealized: -4.95 });
    expect(dry.body.plan).toEqual(real.body.plan);
  });

  it('a part of a lot takes its part of the total; the lot keeps the rest and its basis per share', async () => {
    const sec = await security();
    const lot = await buy(sec, '1000000', '0.0012', '4.95');
    // Half: $602.475, $602.48 (500,000 × $0.0012 was $600.00).
    const half = await sell(sec, '500000', '0.0013').expect(201);
    expect(half.body.plan.totalBasis).toBe(602.48);
    expect(await lotRow(lot)).toMatchObject({ shares: '500000.000000', total: '602.47', per_share: '0.0012', is_open: true });
  });

  it('the tax-planning what-ifs read the lot\'s remaining total', async () => {
    const sec = await security();
    const lot = await buy(sec, '1000000', '0.0012', '4.95');
    await sell(sec, '500000', '0.0013').expect(201); // leaves 500,000 shares and $602.47
    await post('/prices', { security_uuid: sec, price_date: '2025-03-03', close: '0.0012' }).expect(201);
    // Selling the rest at $0.0012 brings $600.00 for $602.47: $2.47 lost (from the per-share
    // basis, $600.00 of basis and nothing lost).
    const impact = await request(app).get('/api/investments/reports/sell-tax-impact')
      .query({ account, security: sec, shares: '500000', price: '0.0012', date: '2025-06-01' }).expect(200);
    expect(impact.body.plan).toMatchObject({ totalBasis: 602.47, totalRealized: -2.47 });
    const suggestions = await request(app).get('/api/investments/reports/lot-suggestions')
      .query({ account, security: sec, objective: 'maximize_loss', price: '0.0012' }).expect(200);
    expect(suggestions.body.lots).toEqual([expect.objectContaining({ uuid: lot, totalCostBasis: 602.47, unrealizedGain: -2.47 })]);
    const harvest = await request(app).get('/api/investments/reports/tax-loss-harvest').query({ account }).expect(200);
    expect(harvest.body.candidates).toEqual([expect.objectContaining({ lot_uuid: lot, market_value: 600, unrealized_loss: 2.47 })]);
  });

  it('the loss a wash sale adds to a replacement lot is all sold with it', async () => {
    // $1,000 lost on 3 shares; 3 bought back at $100 within 30 days take it: $1,300.00,
    // $433.3333 a share. Sold a share at a time, the per-share basis took $433.33 three times
    // and a cent of the disallowed loss was never deducted.
    const sec = await security();
    await buy(sec, '3', '400', '0', '2025-02-01');
    await post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2025-02-02', shares: '3', price_per_share: '66.6666', method: 'fifo' }).expect(201);
    const replacement = await buy(sec, '3', '100', '0', '2025-02-03');
    expect(await lotRow(replacement)).toMatchObject({ total: '1300.00', per_share: '433.3333' });
    for (let i = 0; i < 3; i++) await sell(sec, '1', '500').expect(201);
    expect(await consumed(replacement)).toEqual(['433.33', '433.34', '433.33']);
  });

  it('an average-cost sale re-bases every lot of the pool, and its dry run previews the wash sale from it', async () => {
    // 1 sh at $10 (Jan 2) and 1 at $20 (Jan 20); one sold at average cost on Jan 25 at $5: the
    // share comes from the $10 lot, the basis from the pool, $15, a $10 loss. The $20 lot then
    // holds the pool's other $15, not its own $20 (where $5 of basis was lost), and as a share
    // bought within 30 days it takes the $10 disallowed: $25.
    const sec = await security();
    const first = await buy(sec, '1', '10', '0', '2025-01-02');
    const second = await buy(sec, '1', '20', '0', '2025-01-20');
    const sale = { account_uuid: account, security_uuid: sec, event_date: '2025-01-25', shares: '1', price_per_share: '5', method: 'average_cost' };
    const expected = { flagged: 1, disallowed: 10, adjustments: [{ lot_uuid: second, replacement_shares: 1, basis_added: 10, total_cost_basis: 25, cost_basis_per_share: 25 }] };
    const dry = await post('/events/sell', { ...sale, dry_run: true }).expect(200);
    expect(dry.body.plan).toMatchObject({ totalBasis: 15, totalRealized: -10 });
    expect(dry.body.wash_sale).toEqual(expected);
    expect(await lotRow(second)).toMatchObject({ total: '20.00', per_share: '20.0000' }); // the dry run wrote nothing
    const real = await post('/events/sell', sale).expect(201);
    expect(real.body.wash_sale).toEqual(expected);
    expect(await consumed(first)).toEqual(['15.00']);
    expect(await lotRow(first)).toMatchObject({ shares: '0.000000', total: '0.00', is_open: false });
    expect(await lotRow(second)).toMatchObject({ shares: '1.000000', total: '25.00', per_share: '25.0000', is_open: true });
  });

  it('an average-cost pool sold in two sales keeps every cent of its basis', async () => {
    // $4,000.01 over 183.333333 sh in three lots; 70 then 80 sold. What the sales record and
    // what the lots keep add up to it after each.
    const sec = await security();
    const lots = [await buy(sec, '100', '10', '0', '2020-01-02'), await buy(sec, '50', '40', '0.01', '2021-01-04'), await buy(sec, '33.333333', '30', '0.00', '2022-01-03')];
    const kept = async () => (await pool.query('SELECT sum(total_cost_basis)::text AS t FROM tax_lots WHERE uuid = ANY($1)', [lots])).rows[0].t;
    const recorded = async () => (await pool.query('SELECT coalesce(sum(lc.basis_consumed), 0)::text AS t FROM lot_consumptions lc JOIN tax_lots tl ON tl.id = lc.tax_lot_id WHERE tl.uuid = ANY($1)', [lots])).rows[0].t;
    expect(await kept()).toBe('4000.01');
    await post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2025-03-03', shares: '70', price_per_share: '20', method: 'average_cost' }).expect(201);
    expect([await recorded(), await kept()]).toEqual(['1527.28', '2472.73']);
    expect(await Promise.all(lots.map(async (l) => (await lotRow(l)).total))).toEqual(['654.55', '1090.91', '727.27']);
    await post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2025-03-04', shares: '80', price_per_share: '20', method: 'average_cost' }).expect(201);
    const [r, k] = [await recorded(), await kept()];
    expect((await pool.query('SELECT ($1::numeric + $2::numeric)::text AS t', [r, k])).rows[0].t).toBe('4000.01');
    expect((await lotRow(lots[2])).total).toBe(k); // the last lot holds all that is left
  });

  it('an average-cost sale keeps covered and noncovered lots in separate pools', async () => {
    // Imported noncovered lots (before 2012): 10 sh for $100 and 10 for $300. Bought covered:
    // 10 for $500 and 10 for $700. 25 sold at average cost take both noncovered lots ($400, all
    // of their pool) and 5 covered ($300 of $1,200): $700, not 25 x $40 = $1,000 from one pool.
    const sec = await security();
    const imported = await post('/lots/batch-import', { lots: [
      { account_uuid: account, security_uuid: sec, acquisition_date: '2010-01-04', shares: 10, total_cost_basis: 100, is_covered: false },
      { account_uuid: account, security_uuid: sec, acquisition_date: '2011-01-03', shares: 10, total_cost_basis: 300, is_covered: false },
    ] }).expect(201);
    const [n1, n2] = imported.body.results.map((r: { lot_uuid: string }) => r.lot_uuid);
    const c1 = await buy(sec, '10', '50', '0', '2015-01-02');
    const c2 = await buy(sec, '10', '70', '0', '2016-01-04');
    const sold = await post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2025-03-03', shares: '25', price_per_share: '40', method: 'average_cost' }).expect(201);
    expect(sold.body.plan.totalBasis).toBe(700);
    expect([await consumed(n1), await consumed(n2), await consumed(c1), await consumed(c2)]).toEqual([['200.00'], ['200.00'], ['300.00'], []]);
    expect(await lotRow(c1)).toMatchObject({ shares: '5.000000', total: '300.00', per_share: '60.0000' });
    expect(await lotRow(c2)).toMatchObject({ shares: '10.000000', total: '600.00', per_share: '60.0000' });
  });

  it('the what-if of an average-cost sale across both pools is the sale', async () => {
    // As above: noncovered $100 + $300, covered $500 + $700. The estimate of 25 shares read the
    // pools apart too ($700); reading every lot as covered it was $1,000.
    const sec = await security();
    await post('/lots/batch-import', { lots: [
      { account_uuid: account, security_uuid: sec, acquisition_date: '2010-01-04', shares: 10, total_cost_basis: 100, is_covered: false },
      { account_uuid: account, security_uuid: sec, acquisition_date: '2011-01-03', shares: 10, total_cost_basis: 300, is_covered: false },
    ] }).expect(201);
    await buy(sec, '10', '50', '0', '2015-01-02');
    await buy(sec, '10', '70', '0', '2016-01-04');
    const whatIf = await request(app).get('/api/investments/reports/sell-tax-impact')
      .query({ account, security: sec, shares: '25', price: '40', date: '2025-03-03', method: 'average_cost' }).expect(200);
    const real = await post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2025-03-03', shares: '25', price_per_share: '40', method: 'average_cost' }).expect(201);
    expect(whatIf.body.plan.totalBasis).toBe(700);
    expect(whatIf.body.plan).toEqual(real.body.plan);
  });

  describe('a new lot is covered or noncovered as its source is', () => {
    const coveredFlags = async (sec: string) =>
      (await pool.query('SELECT is_covered FROM tax_lots WHERE security_id = (SELECT id FROM securities WHERE uuid = $1) ORDER BY id', [sec])).rows.map((r) => r.is_covered);
    const importNoncovered = async (sec: string) =>
      (await post('/lots/batch-import', { lots: [{ account_uuid: account, security_uuid: sec, acquisition_date: '2010-01-04', shares: 10, total_cost_basis: 100, is_covered: false }] }).expect(201)).body.results[0].lot_uuid as string;

    it('a stock merger\'s lot from a noncovered one stays out of the covered pool', async () => {
      // A 2010 import, noncovered, merged 1:1 in 2020: the new lot was stored covered (the
      // column's default), so an average-cost sale pooled its $100 with a 2021 lot's $500
      // and recorded $300 for 10 of the 20 shares. Kept apart, the 10 oldest are its $100.
      const sec = await security();
      const acq = await security();
      await importNoncovered(sec);
      await post('/corporate-actions/merger-stock', { security_uuid: sec, acquirer_security_uuid: acq, action_date: '2020-02-03', exchange_ratio: '1' }).expect(201);
      await buy(acq, '10', '50', '0', '2021-01-04');
      expect.soft(await coveredFlags(acq)).toEqual([false, true]);
      const sold = await post('/events/sell', { account_uuid: account, security_uuid: acq, event_date: '2025-03-03', shares: '10', price_per_share: '40', method: 'average_cost' }).expect(201);
      expect(sold.body.plan.totalBasis).toBe(100);
    });

    it('a spinoff\'s lot is covered as its source lot is', async () => {
      const sec = await security();
      const child = await security();
      await importNoncovered(sec);
      await buy(sec, '10', '20', '0', '2013-05-01'); // covered
      await post('/corporate-actions/spinoff', { source_security_uuid: sec, new_security_uuid: child, action_date: '2015-06-01', allocation_fraction: '0.1', share_ratio: '1' }).expect(201);
      expect(await coveredFlags(child)).toEqual([false, true]);
    });

    it('a buy or reinvested dividend before 2012 is noncovered unless it says otherwise', async () => {
      const sec = await security();
      await buy(sec, '1', '10', '0', '2010-05-03'); // before 2012: noncovered
      await buy(sec, '1', '10', '0', '2012-01-03'); // from 2012: covered
      await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2010-06-01', shares: '1', price_per_share: '10', is_covered: true }).expect(201);
      await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2020-06-01', shares: '1', price_per_share: '10', is_covered: false }).expect(201);
      for (const day of ['2011-12-30', '2012-01-02']) {
        await post('/events/dividend', { account_uuid: account, security_uuid: sec, event_date: day, total_amount: '10', reinvest: true, price_per_share: '10' }).expect(201);
      }
      expect(await coveredFlags(sec)).toEqual([false, true, true, false, false, true]);
    });

    it('an imported lot without the flag is covered by its date, as a buy is', async () => {
      const sec = await security();
      const lots = [
        { acquisition_date: '2011-12-30' }, // before 2012: noncovered
        { acquisition_date: '2012-01-03' }, // from 2012: covered
        { acquisition_date: '2010-06-01', is_covered: true },
        { acquisition_date: '2020-06-01', is_covered: false },
      ].map((lot) => ({ account_uuid: account, security_uuid: sec, shares: 1, total_cost_basis: 10, ...lot }));
      await post('/lots/batch-import', { lots }).expect(201);
      expect(await coveredFlags(sec)).toEqual([false, true, true, false]);
    });
  });

  describe('a sale dated before a buy sells only the lots held on its date', () => {
    // L1: 10 sh at $10 on Jan 2; L2: 10 sh at $30 on Mar 10. A sale dated Mar 1 (recorded late)
    // can only sell L1's shares: it took L2's too, with a negative holding period, and an
    // average-cost sale took $100 of basis (the pool with L2, $400 / 20 sh) and re-based L2.
    const twoLots = async () => {
      const sec = await security();
      return { sec, l1: await buy(sec, '10', '10', '0', '2025-01-02'), l2: await buy(sec, '10', '30', '0', '2025-03-10') };
    };
    const backDated = (sec: string, shares: string, extra: object) =>
      post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2025-03-01', shares, price_per_share: '20', ...extra });

    it('average cost: the pool is the lots held then, and a later lot is left as it is', async () => {
      const { sec, l1, l2 } = await twoLots();
      const dry = await backDated(sec, '5', { method: 'average_cost', dry_run: true }).expect(200);
      const real = await backDated(sec, '5', { method: 'average_cost' }).expect(201);
      for (const res of [dry, real]) expect(res.body.plan).toMatchObject({ totalBasis: 50, totalRealized: 50 });
      expect(await lotRow(l1)).toMatchObject({ shares: '5.000000', total: '50.00', per_share: '10.0000' });
      expect(await lotRow(l2)).toMatchObject({ shares: '10.000000', total: '300.00', per_share: '30.0000' });
    });

    it('FIFO and LIFO: not the later lot\'s shares, and not more than were held', async () => {
      const { sec, l1, l2 } = await twoLots();
      // The answer says why to someone who holds 20 today.
      const short = await backDated(sec, '15', { method: 'fifo' });
      expect(short.status, JSON.stringify(short.body)).toBe(400);
      expect(short.body).toMatchObject({ code: 'INVALID_REQUEST', error: 'Insufficient shares on 2025-03-01: requested 15, held 10 on that date (10 more were acquired after it)' });
      // More than were ever held: the plain answer.
      const tooMany = await post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2025-04-01', shares: '25', price_per_share: '20', method: 'fifo' });
      expect(tooMany.body).toMatchObject({ code: 'INVALID_REQUEST', error: 'Insufficient shares: requested 25, available 20' });
      // LIFO took the newest lot, L2, bought after the sale.
      const lifo = await backDated(sec, '5', { method: 'lifo' }).expect(201);
      expect(lifo.body.plan.consumptions).toEqual([expect.objectContaining({ sharesConsumed: 5, basisConsumed: 50, holdingPeriodDays: 58 })]);
      expect(await consumed(l1)).toEqual(['50.00']);
      expect(await consumed(l2)).toEqual([]);
    });

    it('specific ID: a lot acquired after the sale is refused, saying why', async () => {
      const { sec, l2 } = await twoLots();
      for (const dryRun of [true, false]) {
        const res = await backDated(sec, '5', { method: 'specific_id', specific_lots: [{ lot_uuid: l2, shares: '5' }], dry_run: dryRun });
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body).toMatchObject({
          code: 'INVALID_REQUEST',
          error: `Lot ${l2} was acquired on 2025-03-10, after this sale's date (2025-03-01): a sale can only sell shares held on its date`,
        });
      }
      expect(await consumed(l2)).toEqual([]);
    });

    it('the what-ifs and lot suggestions for a date read the lots held then', async () => {
      const { sec, l1, l2 } = await twoLots();
      const impact = (date: string) => request(app).get('/api/investments/reports/sell-tax-impact')
        .query({ account, security: sec, shares: '15', price: '20', date, method: 'fifo' });
      expect((await impact('2025-03-01')).body).toMatchObject({ code: 'INVALID_REQUEST', error: 'Insufficient shares on 2025-03-01: requested 15, held 10 on that date (10 more were acquired after it)' });
      expect((await impact('2025-03-10').expect(200)).body.plan.totalBasis).toBe(250);
      const suggested = async (query: object) => (await request(app).get('/api/investments/reports/lot-suggestions')
        .query({ account, security: sec, objective: 'highest_cost', price: '20', ...query }).expect(200)).body.lots.map((l: { uuid: string }) => l.uuid);
      expect(await suggested({ date: '2025-03-01' })).toEqual([l1]);
      expect(await suggested({})).toEqual([l2, l1]); // today: both
    });

    it('a stock merger converts the lots held on its date, and leaves a later one open', async () => {
      const { sec, l1, l2 } = await twoLots();
      const acq = await security();
      await post('/corporate-actions/merger-stock', { security_uuid: sec, acquirer_security_uuid: acq, action_date: '2025-02-03', exchange_ratio: '2' }).expect(201);
      expect(await lotRow(l1)).toMatchObject({ shares: '0.000000', total: '0.00', is_open: false });
      expect(await lotRow(l2)).toMatchObject({ shares: '10.000000', total: '300.00', is_open: true });
      const converted = (await pool.query('SELECT shares_remaining::text AS shares, total_cost_basis::text AS total FROM tax_lots WHERE security_id = (SELECT id FROM securities WHERE uuid = $1)', [acq])).rows;
      expect(converted).toEqual([{ shares: '20.000000', total: '100.00' }]); // L1's 10 shares, $100
    });

    it('a merger disposes of the lots held on its date', async () => {
      const { sec, l1, l2 } = await twoLots();
      await post('/corporate-actions/merger-cash', { security_uuid: sec, action_date: '2025-02-03', cash_per_share: '12' }).expect(201);
      expect(await consumed(l1)).toEqual(['100.00']);
      expect(await lotRow(l1)).toMatchObject({ is_open: false });
      expect(await consumed(l2)).toEqual([]);
      expect(await lotRow(l2)).toMatchObject({ shares: '10.000000', total: '300.00', is_open: true });
    });
  });

  it('a cash merger after part of the lot is sold takes what is left of its total', async () => {
    const sec = await security();
    const lot = await buy(sec, '1000000', '0.0012', '4.95', '2023-01-02');
    await sell(sec, '500000', '0.0013').expect(201); // $602.48 taken, $602.47 left
    await post('/corporate-actions/merger-cash', { security_uuid: sec, action_date: '2025-06-02', cash_per_share: '0.0012' }).expect(201);
    // $602.47, where 500,000 × $0.0012 took $600.00: the lot gave its $1,204.95 in all.
    expect(await consumed(lot)).toEqual(['602.48', '602.47']);
    expect(await lotRow(lot)).toMatchObject({ total: '0.00', is_open: false });
  });
});
