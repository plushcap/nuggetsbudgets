import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Backfilling behind a split. A buy, sale,
 * reinvested dividend or imported lot dated before a recorded split was refused (409
 * EVENT_BEFORE_RECORDED_CORPORATE_ACTION): the split was applied without it. With
 * `adjusted_for_splits` its shares and prices are already the split's, as a broker's history
 * gives them: it is recorded as given, the split isn't applied to it again, and nothing refuses it.
 *
 * What proves each figure: the same history recorded in date order, in a second account (or
 * security), unflagged, gives the same lots, basis, proceeds, gains, holding periods, wash-sale
 * adjustments and earlier values. A split and a merger recorded after the flagged lot apply to it
 * as to any. A return of capital, spinoff or merger after the event still refuses it.
 */
describe('Events recorded in figures adjusted for the splits after them', () => {
  let app: Express;
  let tenant: TestTenant;
  let n = 0;

  const account = async (name: string) =>
    (await tenant.pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'investment', 'investments', 'Asset') RETURNING uuid`, [`${name} ${n++}`])).rows[0].uuid as string;
  const security = async () =>
    (await request(app).post('/api/investments/securities').send({ ticker: `AJ${Date.now() % 100000}${n++}`, name: 'Adjusted Co', security_type: 'stock' }).expect(201)).body.uuid as string;
  const post = (path: string, body: Record<string, unknown>) => request(app).post(`/api/investments${path}`).send(body);
  const buy = (acct: string, sec: string, date: string, shares: number | string, price: number | string, extra: Record<string, unknown> = {}) =>
    post('/events/buy', { account_uuid: acct, security_uuid: sec, event_date: date, shares, price_per_share: price, ...extra });
  const sell = (acct: string, sec: string, date: string, shares: number | string, price: number | string, extra: Record<string, unknown> = {}) =>
    post('/events/sell', { account_uuid: acct, security_uuid: sec, event_date: date, shares, price_per_share: price, method: 'fifo', ...extra });
  const split = (sec: string, date: string, numerator: number, denominator: number) =>
    post('/corporate-actions/split', { security_uuid: sec, action_date: date, numerator, denominator, reverse: numerator < denominator });
  const ok = async (res: request.Response | Promise<request.Response>) => {
    const r = await res;
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body;
  };
  const refusedFor = async (res: request.Response | Promise<request.Response>, actionType: string) => {
    const r = await res;
    expect({ status: r.status, code: r.body.code, action_type: r.body.action_type }, JSON.stringify(r.body))
      .toEqual({ status: 409, code: 'EVENT_BEFORE_RECORDED_CORPORATE_ACTION', action_type: actionType });
    return r.body;
  };
  const ADJUSTED = { adjusted_for_splits: true };

  /** An account's lots of a security, as they stand, in their exact text. */
  const lots = async (acct: string, sec: string) =>
    (await tenant.pool.query(
      `SELECT tl.acquisition_date AS acquired, tl.holding_period_start AS held_from, tl.shares_original::text AS original,
              tl.shares_remaining::text AS shares, tl.cost_basis_per_share::text AS per_share, tl.total_cost_basis::text AS basis, tl.is_open AS open
         FROM tax_lots tl JOIN securities s ON s.id = tl.security_id JOIN accounts a ON a.id = tl.account_id
        WHERE s.uuid = $1 AND a.uuid = $2 ORDER BY tl.acquisition_date, tl.id`, [sec, acct])).rows;
  /** An account's sales of a security, lot by lot, as recorded. */
  const consumptions = async (acct: string, sec: string) =>
    (await tenant.pool.query(
      `SELECT he.event_date AS sold, lc.shares_consumed::text AS shares, lc.basis_consumed::text AS basis, lc.proceeds::text AS proceeds,
              lc.realized_gain_loss::text AS gain, lc.holding_period_days AS days, lc.is_long_term AS long_term,
              lc.disallowed_loss::text AS disallowed
         FROM lot_consumptions lc JOIN holding_events he ON he.id = lc.sell_event_id JOIN tax_lots tl ON tl.id = lc.tax_lot_id
         JOIN securities s ON s.id = tl.security_id JOIN accounts a ON a.id = tl.account_id
        WHERE s.uuid = $1 AND a.uuid = $2 ORDER BY he.event_date, lc.id`, [sec, acct])).rows;
  /** The wash sale records whose replacement is a lot of this account and security. */
  const washRecords = async (acct: string, sec: string) =>
    (await tenant.pool.query(
      `SELECT w.replacement_shares::text AS replacement, w.loss_shares::text AS loss, w.disallowed_loss::text AS disallowed
         FROM wash_sale_records w JOIN tax_lots tl ON tl.id = w.replacement_lot_id
         JOIN securities s ON s.id = tl.security_id JOIN accounts a ON a.id = tl.account_id
        WHERE s.uuid = $1 AND a.uuid = $2 ORDER BY w.id`, [sec, acct])).rows;
  const without = <T extends Record<string, unknown>>(rows: T[], key: keyof T) => rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== key)));

  beforeAll(async () => {
    tenant = await createTestTenant('Events adjusted for later splits');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('records a buy, a reinvested dividend and an imported lot adjusted for a later split as given, and stores which splits', async () => {
    const acct = await account('Backfill');
    const sec = await security();
    await ok(buy(acct, sec, '2020-01-10', 100, 10));
    await ok(split(sec, '2021-06-01', 2, 1));
    // Unflagged, each is refused as before.
    await refusedFor(buy(acct, sec, '2021-03-01', 20, 10), 'split');

    // 20 shares at $10 after the 2:1 split: 10 at $20 bought then.
    const dry = await ok(buy(acct, sec, '2021-03-01', 20, 10, { ...ADJUSTED, dry_run: true }));
    expect(dry.would_create_lot).toEqual({ shares: 20, total_cost_basis: 200, cost_basis_per_share: 10 });
    await ok(buy(acct, sec, '2021-03-01', 20, 10, ADJUSTED));
    await ok(post('/events/dividend', { account_uuid: acct, security_uuid: sec, event_date: '2021-05-01', total_amount: 50, reinvest: true, price_per_share: 12.5, ...ADJUSTED }));
    const imported = await ok(post('/lots/batch-import', {
      lots: [
        { account_uuid: acct, security_uuid: sec, acquisition_date: '2021-02-01', shares: 10, total_cost_basis: 100, ...ADJUSTED },
        { account_uuid: acct, security_uuid: sec, acquisition_date: '2021-07-01', shares: 5, total_cost_basis: 100 },
      ],
    }));
    expect(imported.created).toBe(2);

    // Recorded as given: the split didn't apply to them again, and the first lot is as it left it.
    expect(await lots(acct, sec)).toEqual([
      { acquired: '2020-01-10', held_from: '2020-01-10', original: '200.000000', shares: '200.000000', per_share: '5.0000', basis: '1000.00', open: true },
      { acquired: '2021-02-01', held_from: '2021-02-01', original: '10.000000', shares: '10.000000', per_share: '10.0000', basis: '100.00', open: true },
      { acquired: '2021-03-01', held_from: '2021-03-01', original: '20.000000', shares: '20.000000', per_share: '10.0000', basis: '200.00', open: true },
      { acquired: '2021-05-01', held_from: '2021-05-01', original: '4.000000', shares: '4.000000', per_share: '12.5000', basis: '50.00', open: true },
      { acquired: '2021-07-01', held_from: '2021-07-01', original: '5.000000', shares: '5.000000', per_share: '20.0000', basis: '100.00', open: true },
    ]);
    // Each adjusted event names the split it was adjusted through; the others none.
    const stored = await tenant.pool.query(
      `SELECT he.event_type, he.event_date, sca.action_type, sca.action_date
         FROM holding_events he JOIN securities s ON s.id = he.security_id
         LEFT JOIN security_corporate_actions sca ON sca.id = he.adjusted_through_action_id
        WHERE s.uuid = $1 AND he.event_type <> 'split' ORDER BY he.event_date, he.id`, [sec]);
    expect(stored.rows).toEqual([
      { event_type: 'buy', event_date: '2020-01-10', action_type: null, action_date: null },
      { event_type: 'historical_import', event_date: '2021-02-01', action_type: 'split', action_date: '2021-06-01' },
      { event_type: 'buy', event_date: '2021-03-01', action_type: 'split', action_date: '2021-06-01' },
      { event_type: 'dividend_reinvest', event_date: '2021-05-01', action_type: 'split', action_date: '2021-06-01' },
      { event_type: 'historical_import', event_date: '2021-07-01', action_type: null, action_date: null },
    ]);
    // The events list says which.
    const listed = (await request(app).get(`/api/investments/events?security=${sec}`).expect(200)).body.data;
    expect(listed.map((e: { event_type: string; event_date: string; adjusted_for_splits: boolean }) => [e.event_type, e.event_date, e.adjusted_for_splits])).toEqual([
      ['historical_import', '2021-07-01', false],
      ['split', '2021-06-01', false],
      ['dividend_reinvest', '2021-05-01', true],
      ['buy', '2021-03-01', true],
      ['historical_import', '2021-02-01', true],
      ['buy', '2020-01-10', false],
    ]);

    // A flag with no split after the event changes nothing: an event like any other.
    await ok(buy(acct, sec, '2021-08-01', 1, 30, ADJUSTED));
    const plain = await tenant.pool.query(
      `SELECT he.adjusted_through_action_id FROM holding_events he JOIN securities s ON s.id = he.security_id WHERE s.uuid = $1 AND he.event_date = '2021-08-01'`, [sec]);
    expect(plain.rows).toEqual([{ adjusted_through_action_id: null }]);
  });

  it('a sale adjusted for a later split sells today\'s shares of the lots held on its date, with the figures of a sale recorded before the split', async () => {
    const [inOrder, backfill] = [await account('In order'), await account('Backfill sale')];
    const sec = await security();
    // In date order: 100 at $10, 30 sold at $25 (and $5 fees), 25 more at $26, then a 2:1 split.
    await ok(buy(inOrder, sec, '2020-01-10', 100, 10));
    await ok(sell(inOrder, sec, '2021-03-01', 30, 25, { fees: 5 }));
    await ok(buy(inOrder, sec, '2021-04-01', 25, 26));
    // Backfilled: the first buy, the split, then the rest in today's shares: 50 at $13 and the
    // sale of 60 at $12.50. The April lot, bought after the sale's date, isn't one it sells.
    await ok(buy(backfill, sec, '2020-01-10', 100, 10));
    await ok(split(sec, '2021-06-01', 2, 1));
    await ok(buy(backfill, sec, '2021-04-01', 50, 13, ADJUSTED));
    await refusedFor(sell(backfill, sec, '2021-03-01', 60, 12.5, { fees: 5 }), 'split');
    const dry = await ok(sell(backfill, sec, '2021-03-01', 60, 12.5, { fees: 5, dry_run: true, ...ADJUSTED }));
    expect(dry.plan.consumptions).toHaveLength(1);
    expect(dry.plan).toMatchObject({ totalProceeds: 745, totalBasis: 300, totalRealized: 445 });
    // More than was held on its date (200 now, the April lot not yet bought) is refused.
    expect((await sell(backfill, sec, '2021-03-01', 201, 12.5, ADJUSTED)).status).toBe(400);
    await ok(sell(backfill, sec, '2021-03-01', 60, 12.5, { fees: 5, ...ADJUSTED }));

    // The same lots, basis and gains; the shares sold in the backfill's own terms (today's).
    const inOrderLots = await lots(inOrder, sec);
    expect(inOrderLots[0]).toEqual({ acquired: '2020-01-10', held_from: '2020-01-10', original: '200.000000', shares: '140.000000', per_share: '5.0000', basis: '700.00', open: true });
    expect(await lots(backfill, sec)).toEqual(inOrderLots);
    const sold = await consumptions(backfill, sec);
    expect(without(sold, 'shares')).toEqual(without(await consumptions(inOrder, sec), 'shares'));
    expect(sold).toEqual([{ sold: '2021-03-01', shares: '60.000000', basis: '300.00', proceeds: '745.00', gain: '445.00', days: 416, long_term: true, disallowed: '0.00' }]);

    // Worth the same on a day before the sale (prices are stored as traded, before the split).
    await ok(post('/prices', { security_uuid: sec, price_date: '2021-02-26', close: 24 }));
    await ok(post('/prices', { security_uuid: sec, price_date: '2021-06-30', close: 14 }));
    const begin = async (acct: string) =>
      (await request(app).get(`/api/investments/reports/performance?account=${acct}&start_date=2021-02-28&end_date=2021-06-30`).expect(200)).body;
    const [a, b] = [await begin(inOrder), await begin(backfill)];
    // 100 shares held then, at $24.
    expect(a.begin_value).toBe(2400);
    expect(b.begin_value).toBe(a.begin_value);
    // 140 + 50 shares at $14 at the end, in both.
    expect(b.current_value).toBe(2660);
    expect(a.current_value).toBe(2660);
  });

  it('a later split and a stock merger apply to an adjusted lot as to any', async () => {
    const [inOrder, backfill] = [await account('In order'), await account('Backfill')];
    const sec = await security();
    const acquirer = await security();
    // In date order: 100 at $10, then 10 at $20, then a 2:1 split.
    await ok(buy(inOrder, sec, '2020-01-10', 100, 10));
    await ok(buy(inOrder, sec, '2021-03-01', 10, 20, { fees: 1 }));
    await ok(buy(backfill, sec, '2020-01-10', 100, 10));
    await ok(split(sec, '2021-06-01', 2, 1));
    // Backfilled after it: the 2021 buy in today's shares.
    await ok(buy(backfill, sec, '2021-03-01', 20, 10, { fees: 1, ...ADJUSTED }));
    expect(await lots(backfill, sec)).toEqual(await lots(inOrder, sec));

    // A split recorded after it applies to it, as to every lot held then.
    expect((await ok(split(sec, '2022-01-10', 3, 1))).affected_lots).toBe(4);
    // A split dated between it and the split it was adjusted for would have changed it: refused,
    // as one dated before any recorded action that follows a lot it changes is.
    expect((await split(sec, '2021-04-01', 2, 1)).body.code).toBe('CORPORATE_ACTION_BEFORE_RECORDED_SALES');
    const afterSplit = await lots(backfill, sec);
    expect(afterSplit[1]).toEqual({ acquired: '2021-03-01', held_from: '2021-03-01', original: '60.000000', shares: '60.000000', per_share: '3.3500', basis: '201.00', open: true });
    expect(afterSplit).toEqual(await lots(inOrder, sec));

    // A stock merger into the acquirer converts it with its basis and holding period.
    await ok(post('/corporate-actions/merger-stock', { security_uuid: sec, acquirer_security_uuid: acquirer, action_date: '2023-01-10', exchange_ratio: 0.5 }));
    const merged = await lots(backfill, acquirer);
    expect(merged).toEqual([
      { acquired: '2023-01-10', held_from: '2020-01-10', original: '300.000000', shares: '300.000000', per_share: '3.3333', basis: '1000.00', open: true },
      { acquired: '2023-01-10', held_from: '2021-03-01', original: '30.000000', shares: '30.000000', per_share: '6.7000', basis: '201.00', open: true },
    ]);
    expect(merged).toEqual(await lots(inOrder, acquirer));
    expect((await lots(backfill, sec)).every((l) => !l.open)).toBe(true);
  });

  it('a cash merger after an adjusted lot disposes of it with the gain of a lot recorded in order', async () => {
    const [inOrder, backfill] = [await account('In order'), await account('Backfill')];
    const sec = await security();
    await ok(buy(inOrder, sec, '2020-01-10', 100, 10));
    await ok(buy(inOrder, sec, '2021-03-01', 10, 20));
    await ok(buy(backfill, sec, '2020-01-10', 100, 10));
    await ok(split(sec, '2021-06-01', 2, 1));
    await ok(buy(backfill, sec, '2021-03-01', 20, 10, ADJUSTED));
    await ok(post('/corporate-actions/merger-cash', { security_uuid: sec, action_date: '2022-04-01', cash_per_share: 8 }));
    const cashed = await consumptions(backfill, sec);
    expect(cashed.map((c) => [c.shares, c.basis, c.proceeds, c.gain, c.long_term])).toEqual([
      ['200.000000', '1000.00', '1600.00', '600.00', true],
      ['20.000000', '200.00', '160.00', '-40.00', true],
    ]);
    expect(cashed).toEqual(await consumptions(inOrder, sec));
  });

  it('pools an adjusted lot under average cost as a lot recorded in order', async () => {
    const [inOrder, backfill] = [await account('In order'), await account('Backfill')];
    const sec = await security();
    for (const acct of [inOrder, backfill]) {
      await ok(post('/cost-basis-method', { account_uuid: acct, security_uuid: sec, method: 'average_cost' }));
    }
    await ok(buy(inOrder, sec, '2020-01-10', 100, 10));
    await ok(buy(inOrder, sec, '2021-03-01', 50, 16));
    await ok(buy(backfill, sec, '2020-01-10', 100, 10));
    await ok(split(sec, '2021-06-01', 2, 1));
    await ok(buy(backfill, sec, '2021-03-01', 100, 8, ADJUSTED));
    // An average-cost sale after both re-bases the pool: the same in each.
    for (const acct of [inOrder, backfill]) await ok(sell(acct, sec, '2022-02-01', 120, 9, { method: 'average_cost' }));
    expect(await consumptions(backfill, sec)).toEqual(await consumptions(inOrder, sec));
    const pooled = await lots(backfill, sec);
    expect(pooled).toEqual(await lots(inOrder, sec));
    // (1,000 + 800) over 300 shares, 120 sold: 180 left holding 1,080.
    expect(pooled.reduce((sum, l) => sum + Number(l.basis), 0)).toBeCloseTo(1080, 2);
  });

  it('matches wash sales across the split in one day\'s shares: an adjusted lot replacing a loss sold before it', async () => {
    const [inOrder, backfill] = [await account('In order'), await account('Backfill')];
    const [inOrderSec, backfillSec] = [await security(), await security()];
    for (const [acct, sec] of [[inOrder, inOrderSec], [backfill, backfillSec]] as const) {
      await ok(buy(acct, sec, '2020-12-01', 100, 30));
      // A $1,000 loss on 100 shares, before a 2:1 split.
      await ok(sell(acct, sec, '2021-05-20', 100, 20));
    }
    // In order: 100 bought at $20 within 30 days replaces it, then the split doubles them.
    await ok(buy(inOrder, inOrderSec, '2021-05-25', 100, 20));
    await ok(split(inOrderSec, '2021-06-01', 2, 1));
    // Backfilled: the split, then the buy in today's shares, 200 at $10.
    await ok(split(backfillSec, '2021-06-01', 2, 1));
    const dry = await ok(buy(backfill, backfillSec, '2021-05-25', 200, 10, { ...ADJUSTED, dry_run: true }));
    expect(dry.wash_sale).toMatchObject({ flagged: 1, disallowed: 1000, adjustments: [{ replacement_shares: 200, basis_added: 1000, total_cost_basis: 3000, cost_basis_per_share: 15 }] });
    const bought = await ok(buy(backfill, backfillSec, '2021-05-25', 200, 10, ADJUSTED));
    expect(bought.wash_sale).toMatchObject({ flagged: 1, disallowed: 1000, adjustments: [{ replacement_shares: 200 }] });

    // All 200 replace all 100 sold, as the split scaled the in-order record.
    expect(await washRecords(backfill, backfillSec)).toEqual([{ replacement: '200.000000', loss: '100.000000', disallowed: '1000.00' }]);
    expect(await washRecords(backfill, backfillSec)).toEqual(await washRecords(inOrder, inOrderSec));
    expect(await lots(backfill, backfillSec)).toEqual(await lots(inOrder, inOrderSec));
    // So a second loss in the window has nothing left to wash into.
    for (const [acct, sec] of [[inOrder, inOrderSec], [backfill, backfillSec]] as const) {
      await ok(buy(acct, sec, '2021-06-02', 10, 30));
      await ok(sell(acct, sec, '2021-06-15', 10, 20, { method: 'lifo' }));
    }
    expect(await washRecords(backfill, backfillSec)).toEqual(await washRecords(inOrder, inOrderSec));
    expect(await consumptions(backfill, backfillSec)).toEqual(await consumptions(inOrder, inOrderSec));
  });

  it('a buy after a split replaces a loss sold before it in the split\'s shares, adjusted or not', async () => {
    const acct = await account('Split in the window');
    const sec = await security();
    await ok(buy(acct, sec, '2020-12-01', 100, 30));
    await ok(sell(acct, sec, '2021-05-20', 100, 20));
    await ok(split(sec, '2021-06-01', 2, 1));
    // 200 bought after the split are the 100 sold before it: all of the loss, all of the lot.
    const bought = await ok(buy(acct, sec, '2021-06-10', 200, 10));
    expect(bought.wash_sale.adjustments).toEqual([expect.objectContaining({ replacement_shares: 200, basis_added: 1000 })]);
    expect(await washRecords(acct, sec)).toEqual([{ replacement: '200.000000', loss: '100.000000', disallowed: '1000.00' }]);
  });

  it('a loss sold in adjusted figures is matched in today\'s shares, and a later split scales its replacement only', async () => {
    const acct = await account('Adjusted loss');
    const sec = await security();
    await ok(buy(acct, sec, '2020-12-01', 100, 30));
    await ok(split(sec, '2021-06-01', 2, 1));
    // 200 of today's shares (100 then) sold at $10 ($20 then): a $1,000 loss.
    const sold = await ok(sell(acct, sec, '2021-05-20', 200, 10, ADJUSTED));
    expect(sold.plan).toMatchObject({ totalBasis: 3000, totalProceeds: 2000, totalRealized: -1000 });
    // 100 bought after the split replace half of it.
    await ok(buy(acct, sec, '2021-06-10', 100, 10));
    expect(await washRecords(acct, sec)).toEqual([{ replacement: '100.000000', loss: '100.000000', disallowed: '500.00' }]);
    // A 2:1 split recorded later doubles the lot and its replacement shares; the loss's other
    // 100 shares are 200 of the next lot's.
    await ok(split(sec, '2021-06-20', 2, 1));
    await ok(buy(acct, sec, '2021-06-18', 400, 5, ADJUSTED));
    expect(await washRecords(acct, sec)).toEqual([
      { replacement: '200.000000', loss: '100.000000', disallowed: '500.00' },
      { replacement: '200.000000', loss: '100.000000', disallowed: '500.00' },
    ]);
  });

  it('a lot an adjusted sale closes keeps its sale day\'s shares and basis per share, as in date order, with its wash record', async () => {
    // Closed by the backfilled sale, the lot kept the splits applied to
    // it while it was open, 180 shares at 0.6722, where date order closed it before them at 30 at
    // 4.0333; the lots answer shows both figures. Here the lot is a wash replacement too.
    // Wash sales match across a ledger's accounts, so each history has a security of its own.
    const [inOrder, backfill] = [await account('In order'), await account('Backfill closed')];
    const [inSec, bfSec] = [await security(), await security()];
    for (const [acct, sec] of [[inOrder, inSec], [backfill, bfSec]] as const) {
      await ok(buy(acct, sec, '2020-12-01', 100, 30));
      // A $1,000 loss on 100 shares; 30 bought five days later replace 30 of them ($300).
      await ok(sell(acct, sec, '2021-01-10', 100, 20));
      await ok(buy(acct, sec, '2021-01-15', 30, 4, { fees: 1 }));
    }
    // In date order the 30 are sold before the splits.
    await ok(sell(inOrder, inSec, '2021-04-01', 30, 6));
    for (const sec of [inSec, bfSec]) {
      await ok(split(sec, '2021-06-01', 2, 1));
      await ok(split(sec, '2021-09-01', 3, 1));
    }
    // Backfilled: the same sale in today's shares, 180 at $1.
    await ok(sell(backfill, bfSec, '2021-04-01', 180, 1, ADJUSTED));

    const closedLots = await lots(backfill, bfSec);
    expect(closedLots[1]).toEqual({ acquired: '2021-01-15', held_from: '2021-01-15', original: '30.000000', shares: '0.000000', per_share: '14.0333', basis: '0.00', open: false });
    expect(closedLots).toEqual(await lots(inOrder, inSec));
    expect(await washRecords(backfill, bfSec)).toEqual([{ replacement: '30.000000', loss: '30.000000', disallowed: '300.00' }]);
    expect(await washRecords(backfill, bfSec)).toEqual(await washRecords(inOrder, inSec));
    // The sale's own figures are as given: today's shares, the same money.
    expect(without(await consumptions(backfill, bfSec), 'shares')).toEqual(without(await consumptions(inOrder, inSec), 'shares'));
    // And the lots answer, the one reader that shows a closed lot's two figures, says the same.
    const answered = async (acct: string, sec: string) =>
      (await request(app).get(`/api/investments/holdings/${sec}/lots?account=${acct}`).expect(200)).body
        .map((l: Record<string, unknown>) => [l.acquisition_date, l.shares_original, l.cost_basis_per_share, l.shares_remaining, l.is_open]);
    expect(await answered(backfill, bfSec)).toEqual(await answered(inOrder, inSec));

    // A lot the adjusted sale leaves open holds today's shares, as in date order.
    const [inOrderOpen, backfillOpen] = [await account('In order, part sold'), await account('Backfill, part sold')];
    const other = await security();
    await ok(buy(inOrderOpen, other, '2021-01-15', 30, 4, { fees: 1 }));
    await ok(buy(backfillOpen, other, '2021-01-15', 30, 4, { fees: 1 }));
    await ok(sell(inOrderOpen, other, '2021-04-01', 10, 6));
    await ok(split(other, '2021-06-01', 6, 1));
    await ok(sell(backfillOpen, other, '2021-04-01', 60, 1, ADJUSTED));
    // Its basis per share too: the adjusted sale works it out from its basis,
    // 80.67 / 120 (0.6723), as the split after the sale does in date order; left as the split had
    // it, it was 121.00 / 180 (0.6722).
    const [openBackfill, openInOrder] = [await lots(backfillOpen, other), await lots(inOrderOpen, other)];
    expect(openBackfill).toEqual(openInOrder);
    expect(openBackfill[0]).toMatchObject({ original: '180.000000', shares: '120.000000', per_share: '0.6723', basis: '80.67', open: true });
  });

  describe('a lot closed or left open by an adjusted sale has its figures of date order', () => {
    /** Both histories' lots, wash records and lots answer, each in a security of its own. */
    const compare = async (io: [string, string], bf: [string, string]) => {
      const answer = async ([acct, sec]: [string, string]) =>
        ((await request(app).get(`/api/investments/holdings/${sec}/lots?account=${acct}`).expect(200)).body as Array<Record<string, unknown>>)
          .map((l) => [l.acquisition_date, l.shares_original, l.shares_remaining, l.cost_basis_per_share, l.total_cost_basis, l.is_open]);
      expect(await lots(...bf)).toEqual(await lots(...io));
      expect(await washRecords(...bf)).toEqual(await washRecords(...io));
      expect(await answer(bf)).toEqual(await answer(io));
    };
    const pair = async () => {
      const [io, bf] = [await account('In order'), await account('Backfill')];
      const [s1, s2] = [await security(), await security()];
      return { io: [io, s1] as [string, string], bf: [bf, s2] as [string, string] };
    };

    it('a closed replacement lot through a reverse split and a split: its shares and its record, exactly (CLOSEREV)', async () => {
      const { io, bf } = await pair();
      await ok(buy(...io, '2021-01-05', 7, 10));
      await ok(buy(...io, '2021-02-01', 10, 12));
      await ok(sell(...io, '2021-03-01', 7, 8));
      await ok(sell(...io, '2021-03-05', 10, 15));
      await ok(split(io[1], '2021-06-01', 1, 3));
      await ok(split(io[1], '2021-09-01', 2, 1));
      await ok(buy(...bf, '2021-01-05', 7, 10));
      await ok(buy(...bf, '2021-02-01', 10, 12));
      await ok(sell(...bf, '2021-03-01', 7, 8));
      await ok(split(bf[1], '2021-06-01', 1, 3));
      await ok(split(bf[1], '2021-09-01', 2, 1));
      // 10 shares are 3.333333 after 1:3 and 6.666666 after 2:1; divided back by 2/3, 9.999999.
      const held = (await lots(...bf)).find((l) => l.open)!.shares;
      expect(held).toBe('6.666666');
      await ok(sell(...bf, '2021-03-05', held, 22.5, ADJUSTED));
      expect((await lots(...bf))[1]).toMatchObject({ original: '10.000000', per_share: '13.4000', open: false });
      expect(await washRecords(...bf)).toEqual([{ replacement: '7.000000', loss: '7.000000', disallowed: '14.00' }]);
      await compare(io, bf);
    });

    it('a closed lot through a reverse split and its inverse, a ratio of 1 on balance (CLOSEREV2)', async () => {
      const { io, bf } = await pair();
      await ok(buy(...io, '2021-01-05', 7, 10));
      await ok(sell(...io, '2021-03-05', 7, 15));
      await ok(split(io[1], '2021-06-01', 1, 3));
      await ok(split(io[1], '2021-09-01', 3, 1));
      await ok(buy(...bf, '2021-01-05', 7, 10));
      await ok(split(bf[1], '2021-06-01', 1, 3));
      await ok(split(bf[1], '2021-09-01', 3, 1));
      const held = (await lots(...bf))[0]!.shares;
      expect(held).toBe('6.999999');
      await ok(sell(...bf, '2021-03-05', held, 15, ADJUSTED));
      expect((await lots(...bf))[0]).toMatchObject({ original: '7.000000', per_share: '10.0000' });
      await compare(io, bf);
    });

    it('a closed lot with several wash adjustments: its basis per share as date order works it out (CLOSEWASH)', async () => {
      const { io, bf } = await pair();
      // Five $1 losses of a share each, all replaced by 7 shares bought 2021-03-01.
      for (const side of [io, bf]) {
        for (let i = 0; i < 5; i++) await ok(buy(...side, `2021-01-0${i + 1}`, 1, 10));
        await ok(buy(...side, '2021-03-01', 7, 10));
        for (let i = 0; i < 5; i++) await ok(sell(...side, `2021-03-0${i + 2}`, 1, 9));
      }
      await ok(sell(...io, '2021-03-20', 7, 12));
      await ok(split(io[1], '2021-06-01', 2, 1));
      await ok(split(bf[1], '2021-06-01', 2, 1));
      await ok(sell(...bf, '2021-03-20', 14, 6, ADJUSTED));
      // $75 over 7 shares (10.7143): it was 10 plus 0.1429 five times, 10.7145, in date order.
      expect((await lots(...io)).find((l) => l.acquired === '2021-03-01')).toMatchObject({ original: '7.000000', per_share: '10.7143', open: false });
      await compare(io, bf);
    });

    it('the lot correction answer of such a closed lot is date order\'s too (PATCHLOT)', async () => {
      const { io, bf } = await pair();
      await ok(buy(...io, '2021-01-05', 7, 10));
      await ok(sell(...io, '2021-03-05', 7, 15));
      await ok(split(io[1], '2021-06-01', 1, 3));
      await ok(buy(...bf, '2021-01-05', 7, 10));
      await ok(split(bf[1], '2021-06-01', 1, 3));
      await ok(sell(...bf, '2021-03-05', (await lots(...bf))[0]!.shares, 45, ADJUSTED));
      const corrected = async ([acct, sec]: [string, string]) => {
        const uuid = ((await request(app).get(`/api/investments/holdings/${sec}/lots?account=${acct}`).expect(200)).body as Array<{ uuid: string }>)[0]!.uuid;
        const body = (await request(app).patch(`/api/investments/lots/${uuid}`).send({ is_covered: false }).expect(200)).body;
        return [body.shares_original, body.cost_basis_per_share, body.total_cost_basis];
      };
      expect(await corrected(bf)).toEqual(await corrected(io));
      expect(await corrected(bf)).toEqual(['7.000000', '10.0000', '0.00']);
    });

    for (const [label, matches, ratio, price] of [['five $1 wash adjustments, 2:1 (OPENWASH)', 5, 2, 5], ['six $1 wash adjustments, 3:1 (OPENWASH2)', 6, 3, '3.3333']] as const) {
      it(`an open replacement lot with ${label}: one basis per share in either order`, async () => {
        const { io, bf } = await pair();
        // Date order: the loss lots, the replacement, the losses, then the split.
        for (let i = 0; i < matches; i++) await ok(buy(...io, `2021-01-0${i + 1}`, 1, 10));
        await ok(buy(...io, '2021-03-01', matches, 10));
        for (let i = 0; i < matches; i++) await ok(sell(...io, `2021-03-0${i + 2}`, 1, 9));
        await ok(split(io[1], '2021-06-01', ratio, 1));
        // Backfilled: the loss lots, the split, then the replacement and the losses in its shares.
        for (let i = 0; i < matches; i++) await ok(buy(...bf, `2021-01-0${i + 1}`, 1, 10));
        await ok(split(bf[1], '2021-06-01', ratio, 1));
        await ok(buy(...bf, '2021-03-01', matches * ratio, price, ADJUSTED));
        for (let i = 0; i < matches; i++) await ok(sell(...bf, `2021-03-0${i + 2}`, ratio, 9 / ratio, ADJUSTED));
        const open = async (side: [string, string]) => (await lots(...side)).filter((l) => l.open && l.acquired === '2021-03-01');
        // Each adjustment's basis per share is worked out from the lot's basis, as a split works
        // it out: it added a rounded share of each adjustment, 3.6669 against
        // 3.6667 after six.
        expect(await open(bf)).toEqual(await open(io));
      });
    }

    it('a lot the person entered after a reverse split, closed by an adjusted sale: within the bound its rounding allows', async () => {
      // Date order: 10 shares bought, sold before a 1:3. Backfilled: the person enters both after
      // it, in its shares, as their broker shows them, rounded to the millionth: 3.333333. Divided
      // back, 9.999999: the person's own rounding, which nothing can undo. The bound: within
      // floor(1 / (2R) + 1/2) millionths, R = 1/3: 2.
      const { io, bf } = await pair();
      await ok(buy(...io, '2021-01-05', 10, 12));
      await ok(sell(...io, '2021-03-05', 10, 15));
      await ok(split(io[1], '2021-06-01', 1, 3));
      await ok(split(bf[1], '2021-06-01', 1, 3));
      await ok(buy(...bf, '2021-01-05', '3.333333', 36, ADJUSTED));
      await ok(sell(...bf, '2021-03-05', '3.333333', 45, ADJUSTED));
      const [closedIo, closedBf] = [(await lots(...io))[0]!, (await lots(...bf))[0]!];
      expect(closedIo.original).toBe('10.000000');
      expect(closedBf.original).toBe('9.999999');
      const millionths = (text: string) => Math.round(Number(text) * 1e6);
      expect(Math.abs(millionths(closedBf.original) - millionths(closedIo.original))).toBeLessThanOrEqual(Math.floor(1 / (2 * (1 / 3)) + 0.5));
      // Its basis per share is its basis over those shares: 120.00 / 9.999999.
      expect(closedBf.per_share).toBe('12.0000');
    });
  });

  it('refuses a split dated across a recorded wash sale match, which date order would have matched in its shares', async () => {
    // A $1,000 loss on 50 shares, 50 bought after it; a 2:1 split dated
    // between them, recorded after the match, was accepted and left the record one for one.
    const [inOrder, recorded] = [await account('In order'), await account('Split after the match')];
    const [inOrderSec, recordedSec] = [await security(), await security()];
    for (const [acct, sec] of [[inOrder, inOrderSec], [recorded, recordedSec]] as const) {
      await ok(buy(acct, sec, '2021-01-05', 100, 50));
      await ok(sell(acct, sec, '2021-06-01', 50, 30));
    }
    await ok(split(inOrderSec, '2021-06-05', 2, 1));
    await ok(buy(inOrder, inOrderSec, '2021-06-10', 50, 20));
    // In date order the 50 bought after the split are 25 sold before it: half the loss.
    expect(await washRecords(inOrder, inOrderSec)).toEqual([{ replacement: '50.000000', loss: '25.000000', disallowed: '500.00' }]);
    expect((await lots(inOrder, inOrderSec)).at(-1)).toMatchObject({ shares: '50.000000', basis: '1500.00' });

    await ok(buy(recorded, recordedSec, '2021-06-10', 50, 20));
    const before = { records: await washRecords(recorded, recordedSec), lots: await lots(recorded, recordedSec) };
    for (const [numerator, denominator] of [[2, 1], [1, 2]] as const) {
      const res = await split(recordedSec, '2021-06-05', numerator, denominator);
      expect({ status: res.status, code: res.body.code }, JSON.stringify(res.body)).toEqual({ status: 409, code: 'CORPORATE_ACTION_BEFORE_RECORDED_SALES' });
      expect(res.body.message).toContain('wash sale');
      const dry = await post('/corporate-actions/split', { security_uuid: recordedSec, action_date: '2021-06-05', numerator, denominator, reverse: numerator < denominator, dry_run: true });
      expect(dry.status).toBe(409);
    }
    // On the sale's own day it was refused already: the sale took shares of a lot the split changes.
    expect((await split(recordedSec, '2021-06-01', 2, 1)).status).toBe(409);
    expect({ records: await washRecords(recorded, recordedSec), lots: await lots(recorded, recordedSec) }).toEqual(before);
    // A split after both is on one side of the match: recorded, scaling the replacement and its record.
    await ok(split(recordedSec, '2021-07-01', 2, 1));
    expect(await washRecords(recorded, recordedSec)).toEqual([{ replacement: '100.000000', loss: '50.000000', disallowed: '1000.00' }]);
  });

  it('still refuses an adjusted event before a recorded return of capital, spinoff or merger', async () => {
    const acct = await account('Other actions');
    const roc = await security();
    await ok(buy(acct, roc, '2020-01-10', 100, 10));
    await ok(split(roc, '2021-06-01', 2, 1));
    await ok(post('/corporate-actions/return-of-capital', { security_uuid: roc, action_date: '2022-06-01', amount_per_share: 1 }));
    const refused = await refusedFor(buy(acct, roc, '2021-03-01', 20, 10, ADJUSTED), 'return_of_capital');
    expect(refused.message).toContain('skip only the splits');
    await refusedFor(sell(acct, roc, '2021-03-01', 20, 10, ADJUSTED), 'return_of_capital');
    // After the return of capital, the split before it doesn't refuse one.
    await ok(buy(acct, roc, '2022-07-01', 1, 10, ADJUSTED));

    const parent = await security();
    const child = await security();
    await ok(buy(acct, parent, '2020-01-10', 100, 10));
    await ok(post('/corporate-actions/spinoff', { source_security_uuid: parent, new_security_uuid: child, action_date: '2021-06-01', allocation_fraction: 0.2, share_ratio: 0.5 }));
    await refusedFor(buy(acct, parent, '2021-03-01', 10, 20, ADJUSTED), 'spinoff');

    const merged = await security();
    const acquirer = await security();
    await ok(buy(acct, merged, '2020-01-10', 100, 10));
    await ok(post('/corporate-actions/merger-stock', { security_uuid: merged, acquirer_security_uuid: acquirer, action_date: '2021-06-01', exchange_ratio: 2 }));
    await refusedFor(buy(acct, merged, '2021-06-01', 10, 20, ADJUSTED), 'merger_stock');
    await refusedFor(post('/lots/batch-import', { lots: [{ account_uuid: acct, security_uuid: merged, acquisition_date: '2021-01-01', shares: 5, total_cost_basis: 50, ...ADJUSTED }] }), 'merger_stock');

    // Unflagged before a split, the refusal says the flag exists.
    const plain = await security();
    await ok(buy(acct, plain, '2020-01-10', 100, 10));
    await ok(split(plain, '2021-06-01', 2, 1));
    // In people's words, naming the form's switch, not the API's field.
    const plainRefusal = (await refusedFor(buy(acct, plain, '2021-03-01', 10, 20), 'split')).message as string;
    expect(plainRefusal).toContain('record it with \u201cThe shares and price are already adjusted for later splits\u201d turned on');
    expect(plainRefusal).not.toContain('adjusted_for_splits');
    const reinvested = await refusedFor(post('/events/dividend', { account_uuid: acct, security_uuid: plain, event_date: '2021-03-01', total_amount: 50, reinvest: true, price_per_share: 25 }), 'split');
    expect(reinvested.message).toContain('\u201cThe reinvestment price is already adjusted for later splits\u201d');
    const imported = await refusedFor(post('/lots/batch-import', { lots: [{ account_uuid: acct, security_uuid: plain, acquisition_date: '2021-01-01', shares: 5, total_cost_basis: 50 }] }), 'split');
    expect(imported.message).toContain('mark the lot as adjusted for later splits');
    for (const message of [reinvested.message, imported.message]) expect(message).not.toContain('adjusted_for_splits');
  });
});
