import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A buy, sale, reinvested dividend or imported lot dated before a recorded corporate action that
 * would have changed it. A sale of 150 shares dated before
 * a recorded 2:1 split went through with only 100 shares held then (the lot holds the split's 200
 * now), and a buy dated before it stayed unscaled. Each is refused (409
 * EVENT_BEFORE_RECORDED_CORPORATE_ACTION), as an action dated before a sale is: events are
 * recorded in date order, before the corporate actions that follow them.
 */
describe('An event dated before a recorded corporate action', () => {
  let app: Express;
  let tenant: TestTenant;
  let accountUuid: string;
  let n = 0;

  const security = async () =>
    (await request(app).post('/api/investments/securities').send({ ticker: `EB${Date.now() % 100000}${n++}`, name: 'Before Co', security_type: 'stock' }).expect(201)).body.uuid as string;
  const buy = (sec: string, date: string, shares: number, price: number, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: sec, event_date: date, shares, price_per_share: price, ...extra });
  const sell = (sec: string, date: string, shares: number, price: number, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/investments/events/sell').send({ account_uuid: accountUuid, security_uuid: sec, event_date: date, shares, price_per_share: price, method: 'fifo', ...extra });
  const dividend = (sec: string, date: string, extra: Record<string, unknown>) =>
    request(app).post('/api/investments/events/dividend').send({ account_uuid: accountUuid, security_uuid: sec, event_date: date, total_amount: 50, ...extra });
  const importLots = (sec: string, date: string, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/investments/lots/batch-import').send({
      lots: [
        { account_uuid: accountUuid, security_uuid: sec, acquisition_date: '2021-07-01', shares: 5, total_cost_basis: 100 },
        { account_uuid: accountUuid, security_uuid: sec, acquisition_date: date, shares: 5, total_cost_basis: 100 },
      ],
      ...extra,
    });
  const action = (kind: 'split' | 'return-of-capital' | 'spinoff' | 'merger-stock' | 'merger-cash', sec: string, date: string, other?: string) => {
    const body = {
      split: { security_uuid: sec, action_date: date, numerator: 2, denominator: 1 },
      'return-of-capital': { security_uuid: sec, action_date: date, amount_per_share: 1 },
      spinoff: { source_security_uuid: sec, new_security_uuid: other, action_date: date, allocation_fraction: 0.2, share_ratio: 0.5 },
      'merger-stock': { security_uuid: sec, acquirer_security_uuid: other, action_date: date, exchange_ratio: 2 },
      'merger-cash': { security_uuid: sec, action_date: date, cash_per_share: 20 },
    }[kind];
    return request(app).post(`/api/investments/corporate-actions/${kind}`).send(body);
  };
  const refused = (res: request.Response, actionType: string, actionDate: string) => {
    expect({ status: res.status, code: res.body.code, action_type: res.body.action_type, action_date: res.body.action_date }, JSON.stringify(res.body))
      .toEqual({ status: 409, code: 'EVENT_BEFORE_RECORDED_CORPORATE_ACTION', action_type: actionType, action_date: actionDate });
  };
  const accepted = (res: request.Response) => expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const lots = async (sec: string) =>
    (await tenant.pool.query(
      `SELECT tl.acquisition_date AS acquired, tl.shares_remaining::float8 AS shares, tl.total_cost_basis::float8 AS basis
         FROM tax_lots tl JOIN securities s ON s.id = tl.security_id WHERE s.uuid = $1 ORDER BY tl.acquisition_date, tl.id`, [sec])).rows;
  const events = async (sec: string) =>
    (await tenant.pool.query(`SELECT count(*)::int AS n FROM holding_events he JOIN securities s ON s.id = he.security_id WHERE s.uuid = $1`, [sec])).rows[0].n as number;

  beforeAll(async () => {
    tenant = await createTestTenant('Events before a corporate action');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    accountUuid = (await tenant.pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Before brokerage', 'investment', 'investments', 'Asset') RETURNING uuid`)).rows[0].uuid;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('refuses a buy, a sale, a reinvested dividend and an imported lot dated before a recorded split, and writes nothing', async () => {
    const sec = await security();
    accepted(await buy(sec, '2020-01-10', 100, 10));
    accepted(await action('split', sec, '2021-06-01'));
    const before = { lots: await lots(sec), events: await events(sec) };
    expect(before.lots).toEqual([{ acquired: '2020-01-10', shares: 200, basis: 1000 }]);

    refused(await buy(sec, '2021-03-01', 10, 20), 'split', '2021-06-01');
    refused(await buy(sec, '2021-03-01', 10, 20, { dry_run: true }), 'split', '2021-06-01');
    // 150 shares, where 100 were held then.
    refused(await sell(sec, '2021-04-01', 150, 25), 'split', '2021-06-01');
    refused(await sell(sec, '2021-04-01', 50, 25, { dry_run: true }), 'split', '2021-06-01');
    refused(await dividend(sec, '2021-05-01', { reinvest: true, price_per_share: 25 }), 'split', '2021-06-01');
    // A reinvested dividend's lot is acquired on its pay date.
    refused(await dividend(sec, '2021-07-01', { reinvest: true, price_per_share: 25, pay_date: '2021-05-15' }), 'split', '2021-06-01');
    // The whole import, its other row too, and its dry run.
    refused(await importLots(sec, '2021-02-01'), 'split', '2021-06-01');
    refused(await importLots(sec, '2021-02-01', { dry_run: true }), 'split', '2021-06-01');
    expect({ lots: await lots(sec), events: await events(sec) }).toEqual(before);

    // On the split's day and after, the shares are the split's: each is recorded.
    accepted(await buy(sec, '2021-06-01', 10, 5));
    accepted(await sell(sec, '2021-06-01', 150, 6));
    accepted(await dividend(sec, '2021-06-15', { reinvest: true, price_per_share: 25 }));
    accepted(await importLots(sec, '2021-06-01'));
    // A cash dividend opens no lot.
    accepted(await dividend(sec, '2021-04-01', {}));
    expect((await lots(sec)).map((l) => l.shares)).toEqual([50, 10, 5, 2, 5]);
  });

  it('refuses one dated before a return of capital or a spinoff of the security, or on a merger’s day', async () => {
    const roc = await security();
    accepted(await buy(roc, '2020-01-10', 100, 10));
    accepted(await action('return-of-capital', roc, '2021-06-01'));
    refused(await buy(roc, '2021-03-01', 10, 20), 'return_of_capital', '2021-06-01');

    const parent = await security();
    const child = await security();
    accepted(await buy(parent, '2020-01-10', 100, 10));
    accepted(await action('spinoff', parent, '2021-06-01', child));
    refused(await buy(parent, '2021-03-01', 10, 20), 'spinoff', '2021-06-01');
    // The new security's own lots aren't changed by the spinoff into it: a buy of it before is fine.
    accepted(await buy(child, '2021-03-01', 10, 20));

    const merged = await security();
    const acquirer = await security();
    accepted(await buy(merged, '2020-01-10', 100, 10));
    accepted(await action('merger-stock', merged, '2021-06-01', acquirer));
    // The merger converted the lots held on its day.
    refused(await buy(merged, '2021-06-01', 10, 20), 'merger_stock', '2021-06-01');
    accepted(await buy(acquirer, '2021-03-01', 10, 20));

    const cashed = await security();
    accepted(await buy(cashed, '2020-01-10', 100, 10));
    accepted(await action('merger-cash', cashed, '2021-06-01'));
    refused(await sell(cashed, '2021-06-01', 10, 20), 'merger_cash', '2021-06-01');
  });

  it('names the last recorded action when several follow the event', async () => {
    const sec = await security();
    accepted(await buy(sec, '2020-01-10', 100, 10));
    accepted(await action('split', sec, '2021-06-01'));
    accepted(await action('return-of-capital', sec, '2022-06-01'));
    refused(await buy(sec, '2021-03-01', 10, 20), 'return_of_capital', '2022-06-01');
  });
});
