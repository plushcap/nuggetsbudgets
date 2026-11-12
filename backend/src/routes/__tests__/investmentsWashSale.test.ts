import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Wash-sale integration tests (require Postgres test DB). A loss is disallowed for the
// shares replaced within 30 days before or after the sale, and added to the
// replacement lot's basis. Each test has its own security, so their windows don't meet.
describe('Investments wash sale API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountUuid: string;
  let securityUuid: string;
  let n = 0;

  const createSec = async () =>
    (await request(app).post('/api/investments/securities').send({ ticker: `WS${Date.now() % 100000}${n++}`, name: 'Wash Co', security_type: 'stock' }).expect(201)).body.uuid as string;
  const buy = (security: string, date: string, shares: number, price: number) =>
    request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: security, event_date: date, shares, price_per_share: price }).expect(201);
  const sell = (security: string, date: string, shares: number, price: number, lotUuid?: string) =>
    request(app).post('/api/investments/events/sell').send({
      account_uuid: accountUuid, security_uuid: security, event_date: date, shares, price_per_share: price,
      ...(lotUuid ? { method: 'specific_id', specific_lots: [{ lot_uuid: lotUuid, shares }] } : { method: 'fifo' }),
    }).expect(201);
  const lot = async (security: string, lotUuid: string) => {
    const res = await request(app).get(`/api/investments/holdings/${security}/lots?account=${accountUuid}`).expect(200);
    const l = res.body.find((x: { uuid: string }) => x.uuid === lotUuid);
    return { shares: Number(l.shares_remaining), perShare: Number(l.cost_basis_per_share), total: Number(l.total_cost_basis) };
  };
  /** The security's sold lots: realized and disallowed loss, wash flag, in sale order. */
  const consumptions = async (security: string) =>
    (await pool.query(
      `SELECT lc.realized_gain_loss::float AS realized, lc.disallowed_loss::float AS disallowed, lc.is_wash_sale AS wash
         FROM lot_consumptions lc JOIN tax_lots tl ON tl.id = lc.tax_lot_id JOIN securities s ON s.id = tl.security_id
        WHERE s.uuid = $1 ORDER BY lc.id`,
      [security]
    )).rows;

  beforeAll(async () => {
    tenant = await createTestTenant('Investments wash sale API');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING id, uuid`, [`WS Brokerage ${Date.now()}`]);
    accountUuid = acct.rows[0].uuid;
    securityUuid = await createSec();
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('disallows a loss when a replacement was bought within 30 days and bumps its basis', async () => {
    // Lot A: sold at a loss. Lot B: replacement bought 5 days before the sale.
    await buy(securityUuid, '2025-01-01', 100, 50);
    const lotB = await buy(securityUuid, '2025-02-10', 100, 50);

    const sold = await sell(securityUuid, '2025-02-15', 100, 40);
    expect(sold.body.plan.totalRealized).toBe(-1000); // 100*(40-50)
    expect(sold.body.wash_sale.flagged).toBe(1);
    expect(sold.body.wash_sale.disallowed).toBe(1000);

    // Replacement lot B basis bumped by the disallowed $1000 (5000 -> 6000).
    expect((await lot(securityUuid, lotB.body.lot_uuid)).total).toBe(6000);

    const report = await request(app).get('/api/investments/reports/wash-sales').expect(200);
    expect(report.body.length).toBeGreaterThanOrEqual(1);
    expect(report.body[0].disallowed_loss).toBe(1000);
  });

  it('is no wash sale when the only purchase is of the shares sold', async () => {
    // Issue scenario: buy 100 on Jan 2 at $50, sell all 100 on Jan 20 at $40, no other buys.
    // The -$1,000 loss is allowed; it was disallowed and added to no lot.
    const sec = await createSec();
    await buy(sec, '2025-01-02', 100, 50);
    const sold = await sell(sec, '2025-01-20', 100, 40);
    expect(sold.body.plan.totalRealized).toBe(-1000);
    expect(sold.body.wash_sale).toMatchObject({ flagged: 0, disallowed: 0 });
    expect(await consumptions(sec)).toEqual([{ realized: -1000, disallowed: 0, wash: false }]);
  });

  it('disallows only the shares a 0.4-share DRIP replaces', async () => {
    // Issue scenario: 100 sh sold at a $1,000 loss while a $15 DRIP of 0.4 sh lands within
    // 30 days. Disallowed = $1,000 x 0.4 / 100 = $4, not $1,000.
    const sec = await createSec();
    await buy(sec, '2025-01-02', 100, 50);
    const drip = await request(app).post('/api/investments/events/dividend').send({
      account_uuid: accountUuid, security_uuid: sec, event_date: '2025-02-10', total_amount: 15, reinvest: true, price_per_share: 37.5,
    }).expect(201); // $15 / $37.50 = 0.4 sh
    const sold = await sell(sec, '2025-02-15', 100, 40);
    expect(sold.body.plan.totalRealized).toBe(-1000);
    expect(sold.body.wash_sale).toMatchObject({ flagged: 1, disallowed: 4 });
    expect(await consumptions(sec)).toEqual([{ realized: -1000, disallowed: 4, wash: true }]);
    // The DRIP lot carries the $4: $15 + $4 = $19, $37.50 + $4 / 0.4 = $47.50/sh.
    expect(await lot(sec, drip.body.lot_uuid)).toMatchObject({ shares: 0.4, perShare: 47.5, total: 19 });
  });

  it('flags a loss when the replacement is bought after the sale', async () => {
    // Sold 100 at a $1,000 loss on Mar 3 with nothing in the window; bought 100 back on
    // Mar 20 (17 days later) at $42: the loss is disallowed when that buy is recorded.
    const sec = await createSec();
    await buy(sec, '2025-01-02', 100, 50);
    const sold = await sell(sec, '2025-03-03', 100, 40);
    expect(sold.body.wash_sale).toMatchObject({ flagged: 0, disallowed: 0 });
    const back = await buy(sec, '2025-03-20', 100, 42);
    expect(back.body.wash_sale).toMatchObject({ flagged: 1, disallowed: 1000 });
    expect(await consumptions(sec)).toEqual([{ realized: -1000, disallowed: 1000, wash: true }]);
    // $4,200 + $1,000 = $5,200, $52/sh.
    expect(await lot(sec, back.body.lot_uuid)).toMatchObject({ shares: 100, perShare: 52, total: 5200 });
  });

  it('a replacement lot absorbs one loss share per share it holds', async () => {
    // A: 100 @ $50, B: 100 @ $60 (January, outside the window). R: 100 @ $45 on Mar 1.
    // A sold Mar 3 at $40 (-$1,000): R's 100 sh replace it, all $1,000 disallowed.
    // B sold Mar 4 at $40 (-$2,000): R has no shares left to replace it, so it's allowed.
    const sec = await createSec();
    const a = await buy(sec, '2025-01-02', 100, 50);
    const b = await buy(sec, '2025-01-03', 100, 60);
    const r = await buy(sec, '2025-03-01', 100, 45);
    expect((await sell(sec, '2025-03-03', 100, 40, a.body.lot_uuid)).body.wash_sale).toMatchObject({ flagged: 1, disallowed: 1000 });
    expect((await sell(sec, '2025-03-04', 100, 40, b.body.lot_uuid)).body.wash_sale).toMatchObject({ flagged: 0, disallowed: 0 });
    expect(await consumptions(sec)).toEqual([
      { realized: -1000, disallowed: 1000, wash: true },
      { realized: -2000, disallowed: 0, wash: false },
    ]);
    // $4,500 + $1,000 once.
    expect(await lot(sec, r.body.lot_uuid)).toMatchObject({ perShare: 55, total: 5500 });
    // A buy recorded later in the window replaces B's loss.
    const later = await buy(sec, '2025-03-25', 50, 41);
    // 50 of B's 100 loss shares: $2,000 x 50 / 100 = $1,000.
    expect(later.body.wash_sale).toMatchObject({ flagged: 1, disallowed: 1000 });
  });

  it('two buys at once replace a loss once', async () => {
    // Sold 100 at a $1,000 loss on Mar 3; two buys of 100 recorded at once, each enough to
    // replace all of it: one takes the $1,000, the other nothing ($1,000 in all, not $2,000).
    const sec = await createSec();
    await buy(sec, '2025-01-02', 100, 50);
    await sell(sec, '2025-03-03', 100, 40);
    const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
    const blocker = await owner.connect();
    let results: Array<{ body: { wash_sale: { disallowed: number } } }>;
    try {
      // Hold both buys at their first read of wash_sale_records, so neither has written
      // when the other reads (unless detection takes turns).
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE wash_sale_records IN ACCESS EXCLUSIVE MODE');
      const both = Promise.all([buy(sec, '2025-03-20', 100, 42), buy(sec, '2025-03-21', 100, 43)]);
      for (let i = 0; i < 100; i++) {
        const waiting = await owner.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND (query LIKE '%wash_sale_records%' OR query LIKE '%pg_advisory_xact_lock%')`
        );
        if (waiting.rows[0].n >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await blocker.query('COMMIT');
      results = await both;
    } finally {
      blocker.release();
      await owner.end();
    }
    expect(results.map((r) => r.body.wash_sale.disallowed).sort()).toEqual([0, 1000]);
    expect(await consumptions(sec)).toEqual([{ realized: -1000, disallowed: 1000, wash: true }]);
  });

  describe('a dry run answers the adjustments the real call makes', () => {
    const post = (path: string, body: object) => request(app).post(`/api/investments${path}`).send(body);
    /** 100 sh bought at $50 and sold at $40 on Mar 3: $1,000 lost, nothing yet replacing it. */
    const lossSale = async (sec: string) => {
      await buy(sec, '2025-01-02', 100, 50);
      await sell(sec, '2025-03-03', 100, 40);
    };
    const adjustment = (lotUuid: string | null, shares: number, added: number, total: number, perShare: number) =>
      ({ lot_uuid: lotUuid, replacement_shares: shares, basis_added: added, total_cost_basis: total, cost_basis_per_share: perShare });

    it('a sale\'s: the replacement lots\' basis after it', async () => {
      // A: 100 @ $50 (Jan 2); B: 100 @ $45 (Jan 15). Selling 150 FIFO on Jan 20 at $40 loses
      // $1,000 on A and $250 on B; B's 50 unsold shares replace 50 of A's ($500), which B's
      // remaining $2,250 takes: $2,750, $55 a share. Nothing is written.
      const sec = await createSec();
      await buy(sec, '2025-01-02', 100, 50);
      const b = await buy(sec, '2025-01-15', 100, 45);
      const sale = { account_uuid: accountUuid, security_uuid: sec, event_date: '2025-01-20', shares: 150, price_per_share: 40, method: 'fifo' };
      const expected = { flagged: 1, disallowed: 500, adjustments: [adjustment(b.body.lot_uuid, 50, 500, 2750, 55)] };
      const dry = await post('/events/sell', { ...sale, dry_run: true }).expect(200);
      expect(dry.body.wash_sale).toEqual(expected);
      expect(await consumptions(sec)).toEqual([]);
      const real = await post('/events/sell', sale).expect(201);
      expect(real.body.wash_sale).toEqual(expected);
      // A sale with no loss answers that it makes none.
      const gain = await post('/events/sell', { ...sale, event_date: '2025-01-21', shares: 10, price_per_share: 60, dry_run: true }).expect(200);
      expect(gain.body.wash_sale).toEqual({ flagged: 0, disallowed: 0, adjustments: [] });
    });

    it('a buy\'s, a reinvested dividend\'s and an import\'s: the lot it would create, with no uuid yet', async () => {
      const sec = await createSec();
      await lossSale(sec);
      // 50 sh at $42 replace 50 of the 100: $500, on $2,100: $2,600, $52 a share.
      const buyBody = { account_uuid: accountUuid, security_uuid: sec, event_date: '2025-03-20', shares: 50, price_per_share: 42 };
      const dryBuy = await post('/events/buy', { ...buyBody, dry_run: true }).expect(200);
      expect(dryBuy.body.wash_sale).toEqual({ flagged: 1, disallowed: 500, adjustments: [adjustment(null, 50, 500, 2600, 52)] });
      // $15 reinvested at $37.50, 0.4 sh: $4 more, $19, $47.50 a share.
      const drip = { account_uuid: accountUuid, security_uuid: sec, event_date: '2025-03-21', total_amount: 15, reinvest: true, price_per_share: 37.5 };
      const dryDrip = await post('/events/dividend', { ...drip, dry_run: true }).expect(200);
      expect(dryDrip.body.wash_sale).toEqual({ flagged: 1, disallowed: 4, adjustments: [adjustment(null, 0.4, 4, 19, 47.5)] });
      // Two imported lots of 30 and 40 sh: each takes its shares' part ($300, then $400), the
      // second counting what the first matched, as the import does.
      const lots = [
        { account_uuid: accountUuid, security_uuid: sec, acquisition_date: '2025-03-22', shares: 30, total_cost_basis: 1200 },
        { account_uuid: accountUuid, security_uuid: sec, acquisition_date: '2025-03-23', shares: 40, total_cost_basis: 1600 },
      ];
      const dryImport = await post('/lots/batch-import', { lots, dry_run: true }).expect(200);
      expect(dryImport.body.results.map((r: { wash_sale: unknown }) => r.wash_sale)).toEqual([
        { flagged: 1, disallowed: 300, adjustments: [adjustment(null, 30, 300, 1500, 50)] },
        { flagged: 1, disallowed: 400, adjustments: [adjustment(null, 40, 400, 2000, 50)] },
      ]);
      expect(await consumptions(sec)).toEqual([{ realized: -1000, disallowed: 0, wash: false }]);

      // The real calls, one after another: each answers what its dry run did, with its lot's
      // uuid (the import's lots replace what the buy and dividend left: 30 and 19.6 sh).
      const realBuy = await post('/events/buy', buyBody).expect(201);
      expect(realBuy.body.wash_sale).toEqual({ ...dryBuy.body.wash_sale, adjustments: [{ ...dryBuy.body.wash_sale.adjustments[0], lot_uuid: realBuy.body.lot_uuid }] });
      const realDrip = await post('/events/dividend', drip).expect(201);
      expect(realDrip.body.wash_sale).toEqual({ ...dryDrip.body.wash_sale, adjustments: [{ ...dryDrip.body.wash_sale.adjustments[0], lot_uuid: realDrip.body.lot_uuid }] });
      const realImport = await post('/lots/batch-import', { lots }).expect(201);
      expect(realImport.body.results.map((r: { wash_sale: unknown }) => r.wash_sale)).toEqual([
        { flagged: 1, disallowed: 300, adjustments: [adjustment(realImport.body.results[0].lot_uuid, 30, 300, 1500, 50)] },
        { flagged: 1, disallowed: 196, adjustments: [adjustment(realImport.body.results[1].lot_uuid, 19.6, 196, 1796, 44.9)] },
      ]);
    });
  });

  it('in one sale of two lots, the other lot\'s unsold shares replace, the sold ones do not', async () => {
    // A: 100 @ $50 (Jan 2), B: 100 @ $45 (Jan 15). Sell 150 FIFO on Jan 20 at $40:
    // A -$1,000 (100 sh), B -$250 (50 sh). B's 50 unsold shares were bought within 30 days
    // and replace 50 of A's: $1,000 x 50 / 100 = $500 disallowed. Nothing replaces B's own
    // loss (its other shares came in the same purchase; A is all sold). The old engine
    // disallowed $1,250, $250 of it added to no lot.
    const sec = await createSec();
    await buy(sec, '2025-01-02', 100, 50);
    const b = await buy(sec, '2025-01-15', 100, 45);
    const sold = await sell(sec, '2025-01-20', 150, 40);
    expect(sold.body.plan.totalRealized).toBe(-1250);
    expect(sold.body.wash_sale).toMatchObject({ flagged: 1, disallowed: 500 });
    expect(await consumptions(sec)).toEqual([
      { realized: -1000, disallowed: 500, wash: true },
      { realized: -250, disallowed: 0, wash: false },
    ]);
    // B: 50 sh x $45 = $2,250 + $500 = $2,750, $55/sh.
    expect(await lot(sec, b.body.lot_uuid)).toMatchObject({ shares: 50, perShare: 55, total: 2750 });
  });

  // A split scales the replacement lot's shares, shares_original too, but left the
  // wash sale record's count of the shares it used: after a 2:1 split half the lot looked
  // unmatched, and a second loss washed into shares already matched. Entered in date order.
  describe('a split of a replacement lot', () => {
    const records = async (lotUuid: string) =>
      (await pool.query<{ replacement_shares: string; loss_shares: string }>(
        `SELECT replacement_shares::text, loss_shares::text FROM wash_sale_records WHERE replacement_lot_id = (SELECT id FROM tax_lots WHERE uuid = $1) ORDER BY id`,
        [lotUuid]
      )).rows;
    const split = (security: string, date: string, numerator = 2, denominator = 1) =>
      request(app).post('/api/investments/corporate-actions/split').send({ security_uuid: security, action_date: date, numerator, denominator }).expect(201);

    it('scales the shares the record used of it, so a second loss does not wash into them', async () => {
      const sec = await createSec();
      await buy(sec, '2021-01-05', 100, 50); // K: $5,000
      const l = (await buy(sec, '2021-05-20', 50, 40)).body.lot_uuid as string; // L: $2,000
      // FIFO from K: 50 sh x ($30 - $50) = -$1,000, washed into L's 50 shares.
      await sell(sec, '2021-06-01', 50, 30);
      expect(await records(l)).toEqual([{ replacement_shares: '50.000000', loss_shares: '50.000000' }]);
      await split(sec, '2021-06-05');
      // L holds 100 shares now, all of them matched; the loss's 50 sold shares stay 50.
      expect(await lot(sec, l)).toMatchObject({ shares: 100, total: 3000 });
      expect(await records(l)).toEqual([{ replacement_shares: '100.000000', loss_shares: '50.000000' }]);
      // K's 100 post-split shares sold at a loss within 30 days of L's purchase: L has none left to replace them.
      await sell(sec, '2021-06-10', 100, 14);
      const [, second] = await consumptions(sec);
      expect(second).toMatchObject({ wash: false, disallowed: 0 });
      expect(await lot(sec, l)).toMatchObject({ shares: 100, total: 3000 });
    });

    it("leaves the loss's unmatched shares to a later replacement", async () => {
      const sec = await createSec();
      await buy(sec, '2021-01-05', 100, 50);
      const l = (await buy(sec, '2021-05-20', 20, 40)).body.lot_uuid as string;
      // 50 sh at a $20 loss each, 20 of them washed into L.
      await sell(sec, '2021-06-01', 50, 30);
      await split(sec, '2021-06-05');
      expect(await records(l)).toEqual([{ replacement_shares: '40.000000', loss_shares: '20.000000' }]);
      // A buy within 30 days after the sale, and after the split, replaces 15 of the loss's other
      // 30 shares: its 30 are the split's (counted one for one, they were 30 of them,
      // and disallowed twice the loss they replace).
      const m = (await buy(sec, '2021-06-08', 30, 20)).body.lot_uuid as string;
      expect(await records(m)).toEqual([{ replacement_shares: '30.000000', loss_shares: '15.000000' }]);
      // 35 of the 50 sold are matched: $700 of the $1,000 loss.
      const [first] = await consumptions(sec);
      expect(first).toMatchObject({ wash: true, disallowed: 700 });
      // The loss's last 15 shares are 30 of a later lot's.
      const last = (await buy(sec, '2021-06-09', 100, 20)).body.lot_uuid as string;
      expect(await records(last)).toEqual([{ replacement_shares: '30.000000', loss_shares: '15.000000' }]);
      expect((await consumptions(sec))[0]).toMatchObject({ wash: true, disallowed: 1000 });
    });

    // These pass: a reverse split, its rounding
    // up of two records, and a lot that is both a replacement and a loss lot.
    it('scales the record down with a reverse split, so the lot has no shares left to replace a second loss', async () => {
      const sec = await createSec();
      await buy(sec, '2021-01-05', 100, 50);
      const l = (await buy(sec, '2021-05-20', 50, 40)).body.lot_uuid as string;
      await sell(sec, '2021-06-01', 50, 30);
      await split(sec, '2021-06-05', 1, 3);
      expect(await records(l)).toEqual([{ replacement_shares: '16.666667', loss_shares: '50.000000' }]);
      expect((await lot(sec, l)).shares).toBe(16.666667);
      // K's other 50 (16.666667 after the split) sold at a loss: L has none left.
      await sell(sec, '2021-06-10', 16.666667, 10);
      const [, second] = await consumptions(sec);
      expect(second).toMatchObject({ wash: false, disallowed: 0 });
    });

    it('lets no later loss wash into a lot two records rounded up past its shares', async () => {
      const sec = await createSec();
      await buy(sec, '2021-01-05', 10, 50);
      await buy(sec, '2021-01-06', 10, 50);
      const l = (await buy(sec, '2021-05-20', 3, 40)).body.lot_uuid as string;
      await sell(sec, '2021-06-01', 1.5, 30);
      await sell(sec, '2021-06-02', 1.5, 30);
      await split(sec, '2021-06-05', 1, 7);
      // Each 1.5 / 7 = 0.2142857 rounds up: 0.428572 matched of the lot's 0.428571.
      expect(await records(l)).toEqual([
        { replacement_shares: '0.214286', loss_shares: '1.500000' },
        { replacement_shares: '0.214286', loss_shares: '1.500000' },
      ]);
      await sell(sec, '2021-06-10', 1, 1);
      const [, , third] = await consumptions(sec);
      expect(third).toMatchObject({ wash: false, disallowed: 0 });
    });

    it('scales both records of a lot that is a replacement and then a loss lot', async () => {
      const sec = await createSec();
      await buy(sec, '2021-01-05', 100, 50);
      const l = (await buy(sec, '2021-05-20', 60, 40)).body.lot_uuid as string;
      await sell(sec, '2021-06-01', 50, 30); // K's loss washed into 50 of L's 60
      const m = (await buy(sec, '2021-06-03', 40, 20)).body.lot_uuid as string;
      await sell(sec, '2021-06-04', 20, 25, l); // L's loss washed into 20 of M's 40
      await split(sec, '2021-06-06', 3, 2);
      expect(await records(l)).toEqual([{ replacement_shares: '75.000000', loss_shares: '50.000000' }]);
      expect(await records(m)).toEqual([{ replacement_shares: '30.000000', loss_shares: '20.000000' }]);
      expect({ l: (await lot(sec, l)).shares, m: (await lot(sec, m)).shares }).toEqual({ l: 60, m: 60 });
    });

    // Guards behaviour that was already so (it passes without the fixes beside it): a merger's
    // lots are made by merger_stock events, which detection never takes as replacements, so the
    // records of the lot they come from needn't be carried to them.
    it("(existing behaviour) a lot a stock merger made from it is never a replacement, so it can't absorb a loss", async () => {
      const sec = await createSec();
      const acquirer = await createSec();
      await buy(sec, '2021-01-05', 100, 50);
      await buy(sec, '2021-05-20', 50, 40);
      await sell(sec, '2021-06-01', 50, 30);
      await request(app).post('/api/investments/corporate-actions/merger-stock').send({ security_uuid: sec, acquirer_security_uuid: acquirer, action_date: '2021-06-05', exchange_ratio: 2 }).expect(201);
      // The acquirer's lots come from a merger, not a purchase: a loss on them washes into neither.
      const lots = (await request(app).get(`/api/investments/holdings/${acquirer}/lots?account=${accountUuid}`).expect(200)).body as Array<{ uuid: string; acquisition_date: string }>;
      const fromK = lots.find((x) => Number((x as unknown as { shares_remaining: string }).shares_remaining) === 100)!;
      await sell(acquirer, '2021-06-10', 100, 1, fromK.uuid);
      const sold = await consumptions(acquirer);
      expect(sold).toHaveLength(1);
      expect(sold[0]).toMatchObject({ wash: false, disallowed: 0 });
    });
  });
});
