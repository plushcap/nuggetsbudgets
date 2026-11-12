import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Spinoff / merger / batch-import integration tests (require Postgres test DB).
describe('Investments corporate actions II + batch import', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountUuid: string;
  const secUuids: string[] = [];

  const createSec = async (prefix: string) => {
    const r = await request(app).post('/api/investments/securities').send({ ticker: `${prefix}${Date.now() % 100000}${secUuids.length}`, name: `${prefix} Co`, security_type: 'stock', asset_class: 'equity' }).expect(201);
    secUuids.push(r.body.uuid);
    return r.body.uuid as string;
  };
  const buy = (security: string, shares: number, price: number, date = '2020-01-15') =>
    request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: security, event_date: date, shares, price_per_share: price }).expect(201);
  const lots = (security: string) => request(app).get(`/api/investments/holdings/${security}/lots?account=${accountUuid}`).expect(200);

  beforeAll(async () => {
    tenant = await createTestTenant('Investments corporate actions II + batch import');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING id, uuid`, [`CA2 Brokerage ${Date.now()}`]);
    accountUuid = acct.rows[0].uuid;
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('batch-imports lots and is idempotent on external_reference', async () => {
    const sec = await createSec('BI');
    const payload = { lots: [
      { account_uuid: accountUuid, security_uuid: sec, acquisition_date: '2015-03-01', shares: 100, total_cost_basis: 1000, external_reference: 'HIST-1', data_quality: 'imputed_date' },
      { account_uuid: accountUuid, security_uuid: sec, acquisition_date: '2016-06-01', shares: 50, total_cost_basis: 800, external_reference: 'HIST-2' },
    ] };
    const first = await request(app).post('/api/investments/lots/batch-import').send(payload).expect(201);
    expect(first.body.created).toBe(2);
    const second = await request(app).post('/api/investments/lots/batch-import').send(payload).expect(201);
    expect(second.body.created).toBe(0);
    expect(second.body.skipped).toBe(2);
    const l = await lots(sec);
    expect(l.body.length).toBe(2);
  });

  it('applies a spinoff: reduces source basis, creates new-security lots with inherited holding period', async () => {
    const src = await createSec('SP');
    const child = await createSec('CH');
    await buy(src, 100, 50, '2020-01-15'); // $5000 basis
    await request(app).post('/api/investments/corporate-actions/spinoff').send({ source_security_uuid: src, new_security_uuid: child, action_date: '2021-01-01', allocation_fraction: 0.2, share_ratio: 0.5 }).expect(201);
    const srcLots = await lots(src);
    expect(Number(srcLots.body[0].cost_basis_per_share)).toBeCloseTo(40, 4); // $4000 / 100
    const childLots = await lots(child);
    expect(Number(childLots.body[0].shares_remaining)).toBe(50);
    expect(Number(childLots.body[0].cost_basis_per_share)).toBeCloseTo(20, 4); // $1000 / 50
    expect(String(childLots.body[0].holding_period_start).slice(0, 10)).toBe('2020-01-15');
  });

  it('applies a stock merger: converts source lots into the acquirer, closes source', async () => {
    const from = await createSec('MF');
    const acq = await createSec('AQ');
    await buy(from, 100, 30, '2020-01-15');
    await request(app).post('/api/investments/corporate-actions/merger-stock').send({ security_uuid: from, acquirer_security_uuid: acq, action_date: '2025-01-01', exchange_ratio: 1.5 }).expect(201);
    const fromLots = await lots(from);
    expect(fromLots.body.every((l: { is_open: boolean }) => !l.is_open)).toBe(true);
    const acqLots = await lots(acq);
    expect(Number(acqLots.body[0].shares_remaining)).toBe(150);
    expect(Number(acqLots.body[0].total_cost_basis)).toBe(3000);
    expect(acqLots.body[0].acquisition_method).toBe('merger');
  });

  it('applies a cash merger: closes lots with realized gain', async () => {
    const sec = await createSec('CM');
    await buy(sec, 100, 30, '2020-01-15');
    const res = await request(app).post('/api/investments/corporate-actions/merger-cash').send({ security_uuid: sec, action_date: '2025-01-01', cash_per_share: 50 }).expect(201);
    expect(res.body.total_realized).toBe(2000); // 100*(50-30)
    const secLots = await lots(sec);
    expect(secLots.body.every((l: { is_open: boolean }) => !l.is_open)).toBe(true);
  });

  it('refuses a spinoff or stock merger that would give a lot no new shares, dry run too, and writes nothing', async () => {
    // 0.4 shares × 0.000001 rounds to 0 new shares. The spinoff moved $20 of the lot's $40 to
    // no lot; the merger closed the lot into none.
    const src = await createSec('TS');
    const other = await createSec('TO');
    const lot = (await request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: src, event_date: '2020-01-15', shares: '0.4', price_per_share: '100' }).expect(201)).body.lot_uuid;
    const accountName = (await pool.query('SELECT name FROM accounts WHERE uuid = $1', [accountUuid])).rows[0].name;
    // Which lot, in which account, and what to do, as the split's refusal says.
    const which = `The lot of 0.4 shares acquired 2020-01-15 in the account "${accountName}" (lot ${lot})`;
    const state = async () => JSON.stringify((await pool.query(
      `SELECT (SELECT json_agg(tl ORDER BY tl.id) FROM tax_lots tl WHERE tl.security_id IN (SELECT id FROM securities WHERE uuid = ANY($1))) AS lots,
              (SELECT count(*) FROM holding_events) + (SELECT count(*) FROM security_corporate_actions) AS n`,
      [[src, other]]
    )).rows[0]);
    const before = await state();
    const actions: Array<[string, object, string]> = [
      ['spinoff', { source_security_uuid: src, new_security_uuid: other, action_date: '2021-01-04', allocation_fraction: '0.5', share_ratio: '0.000001' },
        `${which} gets no shares of the new security at this share ratio (less than 0.000001), so the basis the spinoff moves to it would be lost. Record a sale of those shares (the cash in lieu) first, then apply the spinoff.`],
      ['merger-stock', { security_uuid: src, acquirer_security_uuid: other, action_date: '2021-01-04', exchange_ratio: '0.000001' },
        `${which} converts to no shares of the acquirer at this exchange ratio (less than 0.000001), so its shares and basis would be lost. Record a sale of those shares (the cash in lieu) first, then apply the merger.`],
    ];
    for (const [path, body, error] of actions) {
      for (const dryRun of [true, false]) {
        const res = await request(app).post(`/api/investments/corporate-actions/${path}`).send({ ...body, dry_run: dryRun });
        expect(res.status, `${path} dry_run ${dryRun}: ${JSON.stringify(res.body)}`).toBe(400);
        expect(res.body).toMatchObject({ code: 'INVALID_REQUEST', error });
      }
    }
    expect(await state()).toBe(before);
  });

  it('refuses a reverse split that would leave a lot with no shares, dry run too, and writes nothing', async () => {
    // 0.000004 shares in a 1:10 reverse split is 0.0000004, which rounds to 0: the lot stayed
    // open with no shares and its basis. The other lot (1 share) would split fine; nothing is.
    const sec = await createSec('RS');
    await request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: sec, event_date: '2020-01-15', shares: '1', price_per_share: '10' }).expect(201);
    const sliver = (await request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: sec, event_date: '2020-01-16', shares: '0.000004', price_per_share: '2500' }).expect(201)).body.lot_uuid;
    const accountName = (await pool.query('SELECT name FROM accounts WHERE uuid = $1', [accountUuid])).rows[0].name;
    const state = async () => JSON.stringify((await pool.query(
      `SELECT (SELECT json_agg(tl ORDER BY tl.id) FROM tax_lots tl WHERE tl.security_id = (SELECT id FROM securities WHERE uuid = $1)) AS lots,
              (SELECT count(*) FROM holding_events) + (SELECT count(*) FROM security_corporate_actions) AS n`,
      [sec]
    )).rows[0]);
    const before = await state();
    for (const dryRun of [true, false]) {
      const res = await request(app).post('/api/investments/corporate-actions/split')
        .send({ security_uuid: sec, action_date: '2021-01-04', numerator: '1', denominator: '10', reverse: true, dry_run: dryRun });
      expect(res.status, `dry_run ${dryRun}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body).toMatchObject({
        code: 'INVALID_REQUEST',
        // Which lot, in which account, and what to do (a sliver can be in any account).
        error: `The lot of 0.000004 shares acquired 2020-01-16 in the account "${accountName}" (lot ${sliver}) would have no shares after this split (less than 0.000001). Record a sale of those shares (the cash in lieu) first, then apply the split.`,
      });
    }
    expect(await state()).toBe(before);
    // A ratio that leaves it a share (1:4, 0.000001) is applied.
    await request(app).post('/api/investments/corporate-actions/split').send({ security_uuid: sec, action_date: '2021-01-04', numerator: '1', denominator: '4', reverse: true }).expect(201);
    expect((await lots(sec)).body.map((l: { shares_remaining: string }) => Number(l.shares_remaining))).toEqual([0.25, 0.000001]);
  });
});
