import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { taxLotResponseSchema } from '@nuggets/shared';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * PATCH /api/investments/lots/:uuid corrects a lot's covered status: nothing
 * could, so a lot stored with the wrong one (a pre-2012 lot a broker reports covered, say)
 * stayed wrong, and average cost kept it out of the pool it belongs to. A change is recorded
 * as a lot_correction event. It is refused once an average-cost sale of the security in the
 * account, on or after the lot was acquired, pooled it by the flag as it was.
 */
describe('PATCH /api/investments/lots/:uuid', () => {
  let tenant: TestTenant;
  let app: Express;
  let accountUuid: string;
  let seq = 0;

  beforeAll(async () => {
    tenant = await createTestTenant('Lot covered status');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    accountUuid = (
      await tenant.pool.query<{ uuid: string }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Lots brokerage', 'investment', 'investments', 'Asset') RETURNING uuid`
      )
    ).rows[0]!.uuid;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const security = async () =>
    (await request(app).post('/api/investments/securities').send({ ticker: `LC${++seq}`, name: `Lot covered ${seq}`, security_type: 'mutual_fund' }).expect(201)).body.uuid as string;
  const buy = (securityUuid: string, day: string, price: number) =>
    request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: day, shares: 10, price_per_share: price }).expect(201);
  /** The security's lots, oldest first. */
  const lots = async (securityUuid: string) =>
    (await request(app).get(`/api/investments/holdings/${securityUuid}/lots`).expect(200)).body as Array<{ uuid: string; is_covered: boolean; acquisition_date: string }>;
  const sell = (securityUuid: string, day: string, method: string, dryRun: boolean) =>
    request(app).post('/api/investments/events/sell').send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: day, shares: 10, price_per_share: 30, method, dry_run: dryRun });
  const patch = (lotUuid: string, body: object) => request(app).patch(`/api/investments/lots/${lotUuid}`).send(body);
  const corrections = async () =>
    (await tenant.pool.query<{ user_id: number | null; metadata: unknown }>(`SELECT user_id, metadata FROM holding_events WHERE event_type = 'lot_correction' ORDER BY id`)).rows;

  it('corrects a pre-2012 lot to covered, so average cost pools it with the covered lots, and records it', async () => {
    const sec = await security();
    await buy(sec, '2010-06-01', 10); // noncovered by its date
    await buy(sec, '2015-06-01', 20);
    const [old] = await lots(sec);
    expect(old!.is_covered).toBe(false);

    // Apart, an average-cost sale of 10 shares takes the old lot's pool: $100.
    expect((await sell(sec, '2020-01-02', 'average_cost', true).expect(200)).body.plan.totalBasis).toBe(100);

    const before = (await corrections()).length;
    const res = await patch(old!.uuid, { is_covered: true }).expect(200);
    expect(taxLotResponseSchema.strict().parse(res.body)).toMatchObject({ uuid: old!.uuid, is_covered: true });
    expect((await lots(sec))[0]!.is_covered).toBe(true);
    const recorded = (await corrections()).slice(before);
    expect(recorded).toEqual([{ user_id: tenant.userId, metadata: { lot_uuid: old!.uuid, is_covered: { from: false, to: true } } }]);

    // One pool now: the sale takes its average, $15 a share.
    expect((await sell(sec, '2020-01-02', 'average_cost', true).expect(200)).body.plan.totalBasis).toBe(150);

    // The same value again changes nothing and records nothing.
    expect((await patch(old!.uuid, { is_covered: true }).expect(200)).body.is_covered).toBe(true);
    expect(await corrections()).toHaveLength(before + 1);
  });

  it('is refused once an average-cost sale on or after the lot was acquired pooled it', async () => {
    const sec = await security();
    await buy(sec, '2010-06-01', 10);
    await buy(sec, '2015-06-01', 20);
    await sell(sec, '2020-01-02', 'average_cost', false).expect(201);
    const [old, newer] = await lots(sec);
    const before = (await corrections()).length;
    const res = await patch(newer!.uuid, { is_covered: false }).expect(409);
    expect(res.body).toMatchObject({ code: 'LOT_POOLED' });
    expect(res.body.error).toMatch(/average cost/);
    expect((await lots(sec)).map((l) => l.is_covered)).toEqual([old!.is_covered, true]);
    expect(await corrections()).toHaveLength(before);

    // A lot acquired after that sale wasn't in its pool.
    await buy(sec, '2021-06-01', 25);
    const latest = (await lots(sec)).at(-1)!;
    expect(latest.acquisition_date).toBe('2021-06-01');
    expect((await patch(latest.uuid, { is_covered: false }).expect(200)).body.is_covered).toBe(false);
  });

  it('corrects a lot a FIFO sale took shares from: that sale took its own basis, which the flag does not enter', async () => {
    const sec = await security();
    await buy(sec, '2010-06-01', 10);
    await sell(sec, '2020-01-02', 'fifo', false).expect(201);
    const [sold] = await lots(sec);
    expect((await patch(sold!.uuid, { is_covered: true }).expect(200)).body.is_covered).toBe(true);
  });

  /** The lots of `securityUuid` made from lot `parentId` by a corporate action. */
  const childrenOf = async (securityUuid: string, parentId: number) =>
    ((await request(app).get(`/api/investments/holdings/${securityUuid}/lots`).expect(200)).body as Array<{ uuid: string; parent_lot_id: number | null; is_covered: boolean }>)
      .filter((l) => l.parent_lot_id === parentId);
  const corporateActionAnswer = (action: 'merger-stock' | 'spinoff', from: string, to: string, day: string) =>
    action === 'merger-stock'
      ? request(app).post('/api/investments/corporate-actions/merger-stock').send({ security_uuid: from, acquirer_security_uuid: to, action_date: day, exchange_ratio: 1 })
      : request(app).post('/api/investments/corporate-actions/spinoff').send({ source_security_uuid: from, new_security_uuid: to, action_date: day, allocation_fraction: 0.2, share_ratio: 1 });
  const corporateAction = (action: 'merger-stock' | 'spinoff', from: string, to: string, day: string) =>
    corporateActionAnswer(action, from, to, day).expect(201);
  const lotIds = async (securityUuid: string) =>
    ((await request(app).get(`/api/investments/holdings/${securityUuid}/lots`).expect(200)).body as Array<{ id: number; uuid: string }>);

  for (const action of ['merger-stock', 'spinoff'] as const) {
    it(`refuses a lot a ${action} made from a lot an average-cost sale pooled before it`, async () => {
      // A 2010 lot stored covered, pooled with a 2015 lot by an average-cost sale, then carried
      // into another security (its child is dated the action's day, with the parent's flag and
      // re-based basis). The child answered 200: only its own security's sales were looked at.
      const a = await security();
      const b = await security();
      await request(app).post('/api/investments/events/buy')
        .send({ account_uuid: accountUuid, security_uuid: a, event_date: '2010-06-01', shares: 10, price_per_share: 10, is_covered: true }).expect(201);
      await buy(a, '2015-06-01', 20);
      await request(app).post('/api/investments/events/sell')
        .send({ account_uuid: accountUuid, security_uuid: a, event_date: '2020-01-02', shares: 5, price_per_share: 30, method: 'average_cost' }).expect(201);
      const [old] = await lotIds(a);
      expect((await patch(old!.uuid, { is_covered: false })).status).toBe(409);
      await corporateAction(action, a, b, '2021-03-01');
      const [child] = await childrenOf(b, old!.id);
      expect(child!.is_covered).toBe(true);
      const res = await patch(child!.uuid, { is_covered: false }).expect(409);
      expect(res.body).toMatchObject({ code: 'LOT_POOLED' });
      expect((await childrenOf(b, old!.id))[0]!.is_covered).toBe(true);
    });
  }

  it('refuses a lot two mergers down from a lot an average-cost sale pooled', async () => {
    const [a, b, c] = [await security(), await security(), await security()];
    await buy(a, '2010-06-01', 10);
    await buy(a, '2015-06-01', 20);
    await request(app).post('/api/investments/events/sell')
      .send({ account_uuid: accountUuid, security_uuid: a, event_date: '2020-01-02', shares: 5, price_per_share: 30, method: 'average_cost' }).expect(201);
    const [, newer] = await lotIds(a);
    await corporateAction('merger-stock', a, b, '2021-03-01');
    const [child] = await childrenOf(b, newer!.id);
    await corporateAction('merger-stock', b, c, '2022-03-01');
    const childId = (await lotIds(b)).find((l) => l.uuid === child!.uuid)!.id;
    const [grandchild] = await childrenOf(c, childId);
    expect((await patch(grandchild!.uuid, { is_covered: false }).expect(409)).body).toMatchObject({ code: 'LOT_POOLED' });
  });

  it('answers a malformed lot uuid as not found', async () => {
    expect((await patch('not-a-uuid', { is_covered: false }).expect(404)).body).toMatchObject({ code: 'LOT_NOT_FOUND' });
  });

  it('corrects a lot a spinoff made before any average-cost sale pooled its source', async () => {
    // The sale pools the source lot after the spinoff: the child's basis was fixed by then.
    const a = await security();
    const b = await security();
    await buy(a, '2010-06-01', 10);
    await corporateAction('spinoff', a, b, '2021-03-01');
    await request(app).post('/api/investments/events/sell')
      .send({ account_uuid: accountUuid, security_uuid: a, event_date: '2022-01-03', shares: 5, price_per_share: 30, method: 'average_cost' }).expect(201);
    const [source] = await lotIds(a);
    expect((await patch(source!.uuid, { is_covered: true })).status).toBe(409);
    const [child] = await childrenOf(b, source!.id);
    expect((await patch(child!.uuid, { is_covered: true }).expect(200)).body.is_covered).toBe(true);
  });

  /** An average-cost sale of `shares` (no dry run): recorded now, whatever its date. */
  const averageCostSale = (securityUuid: string, day: string, shares: number) =>
    request(app).post('/api/investments/events/sell')
      .send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: day, shares, price_per_share: 30, method: 'average_cost' }).expect(201);
  /** Two covered lots, 2013 ($100) and 2015 ($200); answers the 2015 one. */
  const twoLots = async (securityUuid: string) => {
    await buy(securityUuid, '2013-06-01', 10);
    await buy(securityUuid, '2015-06-01', 20);
    return (await lots(securityUuid)).find((l) => l.acquisition_date === '2015-06-01')!;
  };
  const idOf = async (securityUuid: string, lotUuid: string) => (await lotIds(securityUuid)).find((l) => l.uuid === lotUuid)!.id;

  /**
   * `action` recorded as one was before the check that refuses it once an average-cost sale
   * dated on or after its day has re-based the source's lots: the source's sales are dated out
   * of its way while it is recorded, then put back.
   */
  const actionBeforeRebasingSalesWereRefused = async (action: 'merger-stock' | 'spinoff', from: string, to: string, day: string) => {
    const sales = `event_type = 'sell' AND security_id = (SELECT id FROM securities WHERE uuid = $1)`;
    await tenant.pool.query(`UPDATE holding_events SET event_date = event_date - 10000 WHERE ${sales}`, [from]);
    try {
      await corporateAction(action, from, to, day);
    } finally {
      await tenant.pool.query(`UPDATE holding_events SET event_date = event_date + 10000 WHERE ${sales}`, [from]);
    }
  };

  // A parent's sales count by the order they were recorded, not by their dates:
  // a corporate action could be recorded after a sale dated later than it, and its child
  // took the parent as that sale left it. Sales and corporate actions of a security lock it,
  // so an event's id is the order they took effect in. Such an action is refused now, but
  // its child may be in a ledger from before.
  for (const action of ['merger-stock', 'spinoff'] as const) {
    it(`refuses a lot a ${action} dated before an average-cost sale, but recorded after it, made from a lot the sale re-based`, async () => {
      const a = await security();
      const b = await security();
      const p2 = await twoLots(a);
      // Sells the 2013 lot's 10 shares: it closes, and the pool re-bases the 2015 lot from $200 to $150.
      await averageCostSale(a, '2018-06-01', 10);
      expect((await lots(a)).find((l) => l.uuid === p2.uuid)).toMatchObject({ total_cost_basis: '150.00' });
      expect((await corporateActionAnswer(action, a, b, '2017-01-01').expect(409)).body.code).toBe('CORPORATE_ACTION_BEFORE_RECORDED_SALES');
      await actionBeforeRebasingSalesWereRefused(action, a, b, '2017-01-01');
      const [child] = await childrenOf(b, await idOf(a, p2.uuid));
      // It answered 200: the sale is dated after the child was made.
      expect((await patch(child!.uuid, { is_covered: false }).expect(409)).body).toMatchObject({ code: 'LOT_POOLED' });
    });

    it(`refuses a lot a ${action} made from a lot an average-cost sale re-based on the action's day, recorded before it`, async () => {
      const a = await security();
      const b = await security();
      const p2 = await twoLots(a);
      await averageCostSale(a, '2017-01-01', 10);
      expect((await corporateActionAnswer(action, a, b, '2017-01-01').expect(409)).body.code).toBe('CORPORATE_ACTION_BEFORE_RECORDED_SALES');
      await actionBeforeRebasingSalesWereRefused(action, a, b, '2017-01-01');
      const [child] = await childrenOf(b, await idOf(a, p2.uuid));
      expect((await patch(child!.uuid, { is_covered: false }).expect(409)).body).toMatchObject({ code: 'LOT_POOLED' });
    });
  }

  it("corrects a lot a spinoff made when the source's average-cost sale on the same day was recorded after it", async () => {
    // The sale re-based the source after the spinoff had taken the child's basis from it.
    const a = await security();
    const b = await security();
    const p2 = await twoLots(a);
    await corporateAction('spinoff', a, b, '2017-01-01');
    await averageCostSale(a, '2017-01-01', 10);
    expect((await patch(p2.uuid, { is_covered: false })).status).toBe(409);
    const [child] = await childrenOf(b, await idOf(a, p2.uuid));
    expect((await patch(child!.uuid, { is_covered: false }).expect(200)).body.is_covered).toBe(false);
  });

  it('refuses a lot an average-cost sale dated before it, but recorded after it, may have pooled', async () => {
    // Before 73a263d1 a sale entered late, dated before a lot was bought, still pooled and
    // re-based that lot; one recorded after the lot is counted whatever its date.
    const a = await security();
    const p2 = await twoLots(a);
    const { account_id: accountId, security_id: securityId } = (
      await tenant.pool.query<{ account_id: number; security_id: number }>('SELECT account_id, security_id FROM tax_lots WHERE uuid = $1', [p2.uuid])
    ).rows[0]!;
    await tenant.pool.query(
      `INSERT INTO holding_events (account_id, security_id, event_type, event_date, shares, metadata) VALUES ($1, $2, 'sell', '2014-03-01', 5, '{"method":"average_cost"}')`,
      [accountId, securityId]
    );
    // It answered 200: the sale is dated before the lot was acquired.
    expect((await patch(p2.uuid, { is_covered: false }).expect(409)).body).toMatchObject({ code: 'LOT_POOLED' });

    // One recorded before the lot and dated before it didn't pool it: the lot is corrected.
    const c = await security();
    await buy(c, '2013-06-01', 10);
    await averageCostSale(c, '2014-03-01', 5);
    await buy(c, '2015-06-01', 20);
    const bought = (await lots(c)).find((l) => l.acquisition_date === '2015-06-01')!;
    expect((await patch(bought.uuid, { is_covered: false }).expect(200)).body.is_covered).toBe(false);
  });

  it('follows a chain of any length to a pooled lot, and stops at a loop', async () => {
    const a = await security();
    const p2 = await twoLots(a);
    await averageCostSale(a, '2016-01-04', 5);
    // 120 lots below it in another security, each made from the one above (written directly:
    // no app path makes a chain this long, or a loop).
    const deep = (await tenant.pool.query<{ id: number }>(`INSERT INTO securities (ticker, name) VALUES ('LCDEEP', 'Deep chain') RETURNING id`)).rows[0]!.id;
    const accountId = (await tenant.pool.query<{ id: number }>('SELECT id FROM accounts WHERE uuid = $1', [accountUuid])).rows[0]!.id;
    let parent = await idOf(a, p2.uuid);
    let last = '';
    for (let i = 0; i < 120; i++) {
      const event = (
        await tenant.pool.query<{ id: number }>(
          `INSERT INTO holding_events (account_id, security_id, event_type, event_date, shares, source) VALUES ($1, $2, 'merger_stock', '2017-01-02', 1, 'system_generated') RETURNING id`,
          [accountId, deep]
        )
      ).rows[0]!.id;
      const row = (
        await tenant.pool.query<{ id: number; uuid: string }>(
          `INSERT INTO tax_lots (account_id, security_id, acquisition_date, holding_period_start, shares_original, shares_remaining,
                                 cost_basis_per_share, total_cost_basis, created_by_event_id, parent_lot_id)
           VALUES ($1, $2, '2017-01-02', '2015-06-01', 1, 1, 10, 10, $3, $4) RETURNING id, uuid`,
          [accountId, deep, event, parent]
        )
      ).rows[0]!;
      parent = row.id;
      last = row.uuid;
    }
    // It answered 200: the chain was cut at 100 lots, short of the pooled one.
    expect((await patch(last, { is_covered: false }).expect(409)).body).toMatchObject({ code: 'LOT_POOLED' });

    // A loop (a lot made from its own child) ends, and with no pooling sale the lot is corrected.
    const x = await security();
    const y = await security();
    await buy(x, '2013-06-01', 10);
    await corporateAction('merger-stock', x, y, '2018-01-01');
    const [source] = await lotIds(x);
    const [merged] = await lotIds(y);
    await tenant.pool.query('UPDATE tax_lots SET parent_lot_id = $1 WHERE id = $2', [merged!.id, source!.id]);
    expect((await patch(merged!.uuid, { is_covered: false }).expect(200)).body.is_covered).toBe(false);
  });

  it('refuses another field, a value that is not a boolean, and a lot the ledger has not', async () => {
    const sec = await security();
    await buy(sec, '2015-06-01', 20);
    const [lot] = await lots(sec);
    expect((await patch(lot!.uuid, { is_covered: false, shares_remaining: 1 })).status).toBe(400);
    expect((await patch(lot!.uuid, { is_covered: 'no' })).status).toBe(400);
    expect((await patch(lot!.uuid, {})).status).toBe(400);
    const missing = await patch('00000000-0000-7000-8000-000000000000', { is_covered: false }).expect(404);
    expect(missing.body).toMatchObject({ code: 'LOT_NOT_FOUND' });
    expect((await lots(sec))[0]!.is_covered).toBe(true);
  });

  it("answers another ledger's lot as not found, and leaves it as it was", async () => {
    const other = await createTestTenant('Lot covered status, other ledger');
    try {
      const one = async (text: string, params: unknown[] = []) => (await other.pool.query<{ id: number; uuid: string }>(text, params)).rows[0]!;
      const account = await one(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Theirs', 'investment', 'investments', 'Asset') RETURNING id, uuid`);
      const sec = await one(`INSERT INTO securities (ticker, name) VALUES ('THEIRS', 'Theirs') RETURNING id, uuid`);
      const event = await one(
        `INSERT INTO holding_events (account_id, security_id, event_type, event_date, shares, price_per_share, total_amount)
         VALUES ($1, $2, 'buy', '2010-06-01', 1, 10, 10) RETURNING id, uuid`,
        [account.id, sec.id]
      );
      const lot = await one(
        `INSERT INTO tax_lots (account_id, security_id, acquisition_date, holding_period_start, shares_original, shares_remaining,
                               cost_basis_per_share, total_cost_basis, created_by_event_id, is_covered)
         VALUES ($1, $2, '2010-06-01', '2010-06-01', 1, 1, 10, 10, $3, false) RETURNING id, uuid`,
        [account.id, sec.id, event.id]
      );
      expect((await patch(lot.uuid, { is_covered: true }).expect(404)).body).toMatchObject({ code: 'LOT_NOT_FOUND' });
      expect((await other.pool.query('SELECT is_covered FROM tax_lots WHERE id = $1', [lot.id])).rows).toEqual([{ is_covered: false }]);
    } finally {
      await other.cleanup();
    }
  });
});
