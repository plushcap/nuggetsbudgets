import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A corporate action dated before a recorded event that closed, moved or re-based the lots it
 * should change. A split or a return of capital dated before a recorded stock merger
 * was accepted, and changed nothing: the merger had closed the source lots. Likewise an action
 * dated before a recorded split, return of capital or spinoff of the security, which was figured on
 * the lots without it, or before a wash sale's loss that adjusted one of its lots. Each is refused
 * as an action dated before a sale is (409 CORPORATE_ACTION_BEFORE_RECORDED_SALES); actions on one
 * day apply in the order they're recorded.
 *
 * Also: a spinoff or stock merger wasn't checked against the security it adds lots to,
 * so one dated before the acquirer's or new security's recorded split, merger or sale went through
 * and added lots those never counted. And two entries that change nothing a later event used were
 * refused: a split dated the day a lot later sold was bought (that lot already has the new shares),
 * and a 2015 split of a security first bought in 2022, for its recorded 2022 split.
 */
describe('A corporate action dated before a recorded one, or before a wash sale', () => {
  let app: Express;
  let tenant: TestTenant;
  let accountUuid: string;
  let otherAccountUuid: string;
  let n = 0;

  const security = async () =>
    (await request(app).post('/api/investments/securities').send({ ticker: `CO${Date.now() % 100000}${n++}`, name: 'Order Co', security_type: 'stock' }).expect(201)).body.uuid as string;
  const buy = async (sec: string, date: string, shares: number, price: number, account = accountUuid) =>
    (await request(app).post('/api/investments/events/buy').send({ account_uuid: account, security_uuid: sec, event_date: date, shares, price_per_share: price }).expect(201)).body.lot_uuid as string;
  const sell = (sec: string, date: string, shares: number, price: number, extra: Record<string, unknown>, account = accountUuid) =>
    request(app).post('/api/investments/events/sell').send({ account_uuid: account, security_uuid: sec, event_date: date, shares, price_per_share: price, ...extra });
  const action = (kind: 'split' | 'return-of-capital' | 'spinoff' | 'merger-stock', sec: string, date: string, other?: string) => {
    const body = {
      split: { security_uuid: sec, action_date: date, numerator: 2, denominator: 1 },
      'return-of-capital': { security_uuid: sec, action_date: date, amount_per_share: 1 },
      spinoff: { source_security_uuid: sec, new_security_uuid: other, action_date: date, allocation_fraction: 0.2, share_ratio: 0.5 },
      'merger-stock': { security_uuid: sec, acquirer_security_uuid: other, action_date: date, exchange_ratio: 2 },
    }[kind];
    return request(app).post(`/api/investments/corporate-actions/${kind}`).send(body);
  };
  const refused = async (res: request.Response) => {
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('CORPORATE_ACTION_BEFORE_RECORDED_SALES');
  };
  const accepted = async (res: request.Response) => {
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  };
  const lotShares = async (sec: string, account = accountUuid) =>
    ((await request(app).get(`/api/investments/holdings/${sec}/lots?account=${account}`).expect(200)).body as Array<{ shares_remaining: string; total_cost_basis: string; is_open: boolean }>)
      .map((l) => ({ shares: Number(l.shares_remaining), basis: Number(l.total_cost_basis), open: l.is_open }));
  /** The security's lots in every account, as stored, oldest first. */
  const allLots = async (sec: string) =>
    (await tenant.pool.query(
      `SELECT tl.acquisition_date AS acquired, tl.shares_remaining::float8 AS shares, tl.total_cost_basis::float8 AS basis, tl.acquisition_method AS how
         FROM tax_lots tl JOIN securities s ON s.id = tl.security_id WHERE s.uuid = $1 ORDER BY tl.acquisition_date, tl.id`, [sec])).rows;

  beforeAll(async () => {
    tenant = await createTestTenant('Corporate action order');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    accountUuid = (await tenant.pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Order brokerage', 'investment', 'investments', 'Asset') RETURNING uuid`)).rows[0].uuid;
    otherAccountUuid = (await tenant.pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Order IRA', 'investment', 'investments', 'Asset') RETURNING uuid`)).rows[0].uuid;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('refuses a split or a return of capital dated before a recorded stock merger, which closed the lots', async () => {
    const sec = await security();
    const acquirer = await security();
    await buy(sec, '2020-01-10', 100, 10);
    await action('merger-stock', sec, '2021-06-01', acquirer).expect(201);
    await refused(await action('split', sec, '2021-01-01'));
    await refused(await action('return-of-capital', sec, '2021-01-01'));
    // On the merger's own day too: it converted the lots held that day.
    await refused(await action('split', sec, '2021-06-01'));
  });

  it('refuses an action dated before a recorded split, return of capital or spinoff of the security', async () => {
    const sec = await security();
    const child = await security();
    await buy(sec, '2020-01-10', 100, 10);
    await action('split', sec, '2021-06-01').expect(201);
    await refused(await action('return-of-capital', sec, '2021-01-01'));
    const other = await security();
    await buy(other, '2020-01-10', 100, 10);
    await action('spinoff', other, '2021-06-01', child).expect(201);
    await refused(await action('split', other, '2021-01-01'));
    // A split after them is fine, and actions on one day apply as recorded.
    await action('split', sec, '2022-01-01').expect(201);
    await action('return-of-capital', sec, '2022-01-01').expect(201);
    expect(await lotShares(sec)).toEqual([{ shares: 400, basis: 600, open: true }]);
  });

  it("refuses an action dated before a wash sale's loss that adjusted one of its lots", async () => {
    const sec = await security();
    // L, held on the action's day, replaces K's loss (sold 26 days after L was bought).
    await buy(sec, '2021-03-25', 100, 40);
    const k = await buy(sec, '2021-04-10', 50, 50);
    await request(app).post('/api/investments/events/sell').send({
      account_uuid: accountUuid, security_uuid: sec, event_date: '2021-04-20', shares: 50, price_per_share: 30,
      method: 'specific_id', specific_lots: [{ lot_uuid: k, shares: 50 }],
    }).expect(201);
    const washed = await tenant.pool.query('SELECT count(*)::int AS n FROM wash_sale_records w JOIN tax_lots l ON l.id = w.replacement_lot_id JOIN securities s ON s.id = l.security_id WHERE s.uuid = $1', [sec]);
    expect(washed.rows[0].n).toBe(1);
    // K was bought after the action's day, so the sale took no lot it changes; the wash did.
    await refused(await action('return-of-capital', sec, '2021-04-01'));
    await refused(await action('split', sec, '2021-04-01'));
  });

  // Each of these was accepted before; it is refused now.
  it('refuses a stock merger or spinoff dated before a recorded split or merger of the security it adds lots to', async () => {
    const src = await security();
    const acquirer = await security();
    await buy(src, '2020-01-10', 100, 10);
    await buy(acquirer, '2020-01-10', 10, 50);
    await action('split', acquirer, '2021-09-01').expect(201);
    await refused(await action('merger-stock', src, '2021-06-01', acquirer));

    const parent = await security();
    const child = await security();
    await buy(parent, '2020-01-10', 100, 10);
    await buy(child, '2021-07-01', 10, 5);
    await action('split', child, '2021-09-01').expect(201);
    await refused(await action('spinoff', parent, '2021-06-01', child));

    const merged = await security();
    const buyer = await security();
    await action('merger-stock', merged, '2021-09-01', buyer).expect(201);
    await refused(await action('spinoff', parent, '2021-06-01', merged));
    // Nothing was written: the source lots are as they were, the targets have no new lot.
    expect(await lotShares(src)).toEqual([{ shares: 100, basis: 1000, open: true }]);
    expect((await allLots(acquirer)).map((l) => l.how)).toEqual(['purchase']);
    expect((await allLots(child)).map((l) => l.how)).toEqual(['purchase']);
    expect(await allLots(merged)).toEqual([]);

    // A split of the target on the action's own day changes only lots acquired before it.
    const sameDay = await security();
    await action('split', sameDay, '2021-06-01').expect(201);
    await action('merger-stock', src, '2021-06-01', sameDay).expect(201);
    expect(await allLots(sameDay)).toEqual([{ acquired: '2021-06-01', shares: 200, basis: 1000, how: 'merger' }]);
  });

  it("refuses one dated before a recorded sale of the target its lots would have come before or joined, but not one they wouldn't", async () => {
    const answer = async (method: string, bought: string, sale: string) => {
      const src = await security();
      const acquirer = await security();
      await buy(src, '2020-01-10', 100, 10);
      const lot = await buy(acquirer, bought, 10, 50);
      const extra = method === 'specific_id' ? { method, specific_lots: [{ lot_uuid: lot, shares: 10 }] } : { method };
      await sell(acquirer, sale, 10, 60, extra).expect(201);
      return action('merger-stock', src, '2021-06-01', acquirer);
    };
    // FIFO: the merger's lot (2021-06-01) would have been sold before a lot bought after it (P10).
    await refused(await answer('fifo', '2021-07-01', '2021-08-01'));
    // LIFO: it would have been sold before a lot bought before it.
    await refused(await answer('lifo', '2020-05-01', '2021-08-01'));
    // Average cost: it would have joined the pool the sale sold from.
    await refused(await answer('average_cost', '2020-05-01', '2021-08-01'));
    await refused(await answer('hifo', '2020-05-01', '2021-08-01'));
    // A sale it wouldn't have changed: FIFO of a lot bought before it, LIFO of one bought after
    // it, a sale that named its lot, one dated before the merger.
    await accepted(await answer('fifo', '2020-05-01', '2021-08-01'));
    await accepted(await answer('lifo', '2021-07-01', '2021-08-01'));
    await accepted(await answer('specific_id', '2021-07-01', '2021-08-01'));
    await accepted(await answer('fifo', '2020-05-01', '2021-05-01'));
  });

  it('checks only the accounts the action adds lots to, and adds none when the source has no lot', async () => {
    const src = await security();
    const acquirer = await security();
    await buy(src, '2020-01-10', 100, 10);
    // A FIFO sale of the acquirer, in an account that holds none of the source.
    await buy(acquirer, '2021-07-01', 10, 50, otherAccountUuid);
    await sell(acquirer, '2021-08-01', 10, 60, { method: 'fifo' }, otherAccountUuid).expect(201);
    await action('merger-stock', src, '2021-06-01', acquirer).expect(201);

    const empty = await security();
    const child = await security();
    await buy(child, '2021-07-01', 10, 5);
    await action('split', child, '2021-09-01').expect(201);
    await action('spinoff', empty, '2021-06-01', child).expect(201);
  });

  // Each of these was refused before; it is accepted now.
  it('accepts a split dated the day the lot a later sale took was bought', async () => {
    const sec = await security();
    await buy(sec, '2020-01-10', 100, 10);
    const onDay = await buy(sec, '2021-01-04', 10, 5);
    await sell(sec, '2021-02-01', 10, 6, { method: 'specific_id', specific_lots: [{ lot_uuid: onDay, shares: 10 }] }).expect(201);
    await action('split', sec, '2021-01-04').expect(201);
    expect(await allLots(sec)).toEqual([
      { acquired: '2020-01-10', shares: 200, basis: 1000, how: 'purchase' },
      { acquired: '2021-01-04', shares: 0, basis: 0, how: 'purchase' },
    ]);
    // The same in another account, sold by FIFO.
    const other = await security();
    await buy(other, '2020-01-10', 100, 10);
    await buy(other, '2021-01-04', 10, 5, otherAccountUuid);
    await sell(other, '2021-02-01', 10, 6, { method: 'fifo' }, otherAccountUuid).expect(201);
    await action('split', other, '2021-01-04').expect(201);
    expect(await lotShares(other)).toEqual([{ shares: 200, basis: 1000, open: true }]);
    // A merger on that day converts the lots held then, the one bought that day too.
    const merged = await security();
    const acquirer = await security();
    await buy(merged, '2020-01-10', 100, 10);
    const mergedOnDay = await buy(merged, '2021-01-04', 10, 5);
    await sell(merged, '2021-02-01', 10, 6, { method: 'specific_id', specific_lots: [{ lot_uuid: mergedOnDay, shares: 10 }] }).expect(201);
    await refused(await action('merger-stock', merged, '2021-01-04', acquirer));
  });

  it('accepts an action that changes no lot, dated before a recorded one, and refuses one that changes a lot', async () => {
    const sec = await security();
    await buy(sec, '2022-01-10', 100, 10);
    await action('split', sec, '2022-06-01').expect(201);
    await action('split', sec, '2015-06-01').expect(201);
    await action('return-of-capital', sec, '2015-07-01').expect(201);
    expect(await lotShares(sec)).toEqual([{ shares: 200, basis: 1000, open: true }]);
    // One that changes the 2022 lot is refused for the later split.
    await refused(await action('return-of-capital', sec, '2022-03-01'));
  });
});
