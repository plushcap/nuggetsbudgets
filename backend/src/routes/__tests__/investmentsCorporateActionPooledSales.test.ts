import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A merger or spinoff dated before an average-cost sale that re-based the source's lots.
 * The sale closed one lot and spread the pool's remaining basis over the other (costBasis.ts
 * planSell): the action, dated before it, was accepted because the lot it changed had no shares
 * taken from it, and its new lot started from the post-sale pooled basis. It is refused, as an
 * action dated before a sale that took shares from the lot is (409
 * CORPORATE_ACTION_BEFORE_RECORDED_SALES). So is one before a sale by any method that closed a lot
 * held on its date. A sale of shares bought after the action, or an average-cost sale
 * recorded before a lot was entered, still lets it through.
 *
 * Two lots, 100 shares at $10 (2020-01-10) and 100 at $30 (2020-06-10): $4,000 for 200 shares. An
 * average-cost sale of 100 on 2021-06-01 takes them from the first at $20 each and leaves the
 * second 100 shares at $20 ($2,000, where it cost $3,000).
 */
describe('A merger or spinoff dated before an average-cost sale that re-based its lots', () => {
  let app: Express;
  let tenant: TestTenant;
  let accountUuid: string;
  let n = 0;

  const security = async () => {
    const r = await request(app).post('/api/investments/securities').send({ ticker: `PS${Date.now() % 100000}${n++}`, name: 'Pooled Co', security_type: 'stock' }).expect(201);
    return r.body.uuid as string;
  };
  const buy = async (sec: string, date: string, shares: number, price: number) =>
    (await request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: sec, event_date: date, shares, price_per_share: price }).expect(201)).body.lot_uuid as string;
  const sell = (sec: string, method: string) =>
    request(app).post('/api/investments/events/sell').send({ account_uuid: accountUuid, security_uuid: sec, event_date: '2021-06-01', shares: 100, price_per_share: 25, method }).expect(201);
  const lotBasis = async (sec: string, lotUuid: string) => {
    const res = await request(app).get(`/api/investments/holdings/${sec}/lots?account=${accountUuid}`).expect(200);
    const l = res.body.find((x: { uuid: string }) => x.uuid === lotUuid);
    return { shares: Number(l.shares_remaining), total: Number(l.total_cost_basis) };
  };
  /** The two lots and the 2021 sale of 100 shares by `method`; the second lot's uuid. */
  const soldFrom = async (sec: string, method: string, opts: { firstNoncovered?: boolean } = {}) => {
    const first = await buy(sec, '2020-01-10', 100, 10);
    const second = await buy(sec, '2020-06-10', 100, 30);
    if (opts.firstNoncovered) await tenant.pool.query('UPDATE tax_lots SET is_covered = false WHERE uuid = $1', [first]);
    await sell(sec, method);
    return second;
  };
  const spinoff = (src: string, child: string) =>
    request(app).post('/api/investments/corporate-actions/spinoff').send({
      source_security_uuid: src, new_security_uuid: child, action_date: '2021-01-01', allocation_fraction: 0.2, share_ratio: 0.5,
    });
  const merger = (src: string, acquirer: string) =>
    request(app).post('/api/investments/corporate-actions/merger-stock').send({
      security_uuid: src, acquirer_security_uuid: acquirer, action_date: '2021-01-01', exchange_ratio: 2,
    });

  beforeAll(async () => {
    tenant = await createTestTenant('Corporate actions before pooled sales');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const acct = await tenant.pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Pooled brokerage', 'investment', 'investments', 'Asset') RETURNING uuid`);
    accountUuid = acct.rows[0].uuid;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('refuses a spinoff dated before the sale, and leaves the lots as the sale left them', async () => {
    const src = await security();
    const child = await security();
    const second = await soldFrom(src, 'average_cost');
    expect(await lotBasis(src, second)).toEqual({ shares: 100, total: 2000 });
    const res = await spinoff(src, child).expect(409);
    expect(res.body.code).toBe('CORPORATE_ACTION_BEFORE_RECORDED_SALES');
    expect(await lotBasis(src, second)).toEqual({ shares: 100, total: 2000 });
    const childLots = await tenant.pool.query('SELECT count(*)::int AS n FROM tax_lots tl JOIN securities s ON s.id = tl.security_id WHERE s.uuid = $1', [child]);
    expect(childLots.rows[0].n).toBe(0);
  });

  it('refuses a stock merger dated before the sale', async () => {
    const src = await security();
    const acquirer = await security();
    const second = await soldFrom(src, 'average_cost');
    const res = await merger(src, acquirer).expect(409);
    expect(res.body.code).toBe('CORPORATE_ACTION_BEFORE_RECORDED_SALES');
    expect(await lotBasis(src, second)).toEqual({ shares: 100, total: 2000 });
  });

  it('counts a sale with no recorded method as an average-cost one', async () => {
    const src = await security();
    const acquirer = await security();
    await soldFrom(src, 'average_cost');
    await tenant.pool.query(
      `UPDATE holding_events SET metadata = metadata - 'method'
        WHERE event_type = 'sell' AND security_id = (SELECT id FROM securities WHERE uuid = $1)`, [src]
    );
    expect((await merger(src, acquirer).expect(409)).body.code).toBe('CORPORATE_ACTION_BEFORE_RECORDED_SALES');
  });

  // A sale by any method that took shares from a lot held on the action's date was
  // figured on that lot as it was before the action; the lot it closed isn't among the open lots
  // the action changes, so it went unseen.
  it('refuses an action dated before a FIFO sale, or an average-cost sale from the other pool, that closed a lot held then', async () => {
    const fifo = await security();
    const fifoChild = await security();
    const fifoSecond = await soldFrom(fifo, 'fifo');
    expect(await lotBasis(fifo, fifoSecond)).toEqual({ shares: 100, total: 3000 });
    expect((await spinoff(fifo, fifoChild).expect(409)).body.code).toBe('CORPORATE_ACTION_BEFORE_RECORDED_SALES');
    expect(await lotBasis(fifo, fifoSecond)).toEqual({ shares: 100, total: 3000 });

    // The sale's shares came from the noncovered lot, which it closed.
    const pooled = await security();
    const acquirer = await security();
    await soldFrom(pooled, 'average_cost', { firstNoncovered: true });
    expect((await merger(pooled, acquirer).expect(409)).body.code).toBe('CORPORATE_ACTION_BEFORE_RECORDED_SALES');
  });

  it('refuses a split dated before a FIFO sale that closed a lot, which doubled only the open one', async () => {
    const sec = await security();
    const second = await soldFrom(sec, 'fifo');
    const res = await request(app).post('/api/investments/corporate-actions/split').send({ security_uuid: sec, action_date: '2021-01-01', numerator: 2, denominator: 1 }).expect(409);
    expect(res.body.code).toBe('CORPORATE_ACTION_BEFORE_RECORDED_SALES');
    expect(await lotBasis(sec, second)).toEqual({ shares: 100, total: 3000 });
  });

  it('lets one through when the later sale took only shares bought after it', async () => {
    const sec = await security();
    const child = await security();
    const held = await buy(sec, '2020-01-10', 100, 10);
    const later = await buy(sec, '2021-03-01', 50, 20);
    await request(app).post('/api/investments/events/sell').send({
      account_uuid: accountUuid, security_uuid: sec, event_date: '2021-06-01', shares: 50, price_per_share: 25,
      method: 'specific_id', specific_lots: [{ lot_uuid: later, shares: 50 }],
    }).expect(201);
    await spinoff(sec, child).expect(201);
    // The 2020 lot keeps 80% of its $1,000; the new lot takes the rest.
    expect(await lotBasis(sec, held)).toEqual({ shares: 100, total: 800 });
  });

  // An average-cost sale pooled only the lots there when it was recorded: one entered after it,
  // dated before the action (a late-entered buy), wasn't re-based by it.
  it('lets one through when the average-cost sale was recorded before the lot it would have pooled', async () => {
    const sec = await security();
    const acquirer = await security();
    await buy(sec, '2021-03-01', 50, 20);
    await request(app).post('/api/investments/events/sell').send({
      account_uuid: accountUuid, security_uuid: sec, event_date: '2021-06-01', shares: 25, price_per_share: 25, method: 'average_cost',
    }).expect(201);
    const late = await buy(sec, '2020-01-10', 100, 10);
    await merger(sec, acquirer).expect(201);
    const converted = await tenant.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tax_lots WHERE parent_lot_id = (SELECT id FROM tax_lots WHERE uuid = $1)`, [late]
    );
    expect(converted.rows[0]!.n).toBe(1);
  });
});
