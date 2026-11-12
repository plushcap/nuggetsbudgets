import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Integration tests — require the Postgres test DB (CI provides it). They
// exercise the full buy/sell/dividend round-trip through the routes + service +
// pure cost-basis engine, plus dry-run and external_reference idempotency.
describe('Investments API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountUuid: string;
  let securityUuid: string;

  beforeAll(async () => {
    tenant = await createTestTenant('Investments API');
    pool = tenant.pool;

    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());

    const acct = await pool.query(
      `INSERT INTO accounts (name, account_type, account_group, type)
       VALUES ($1, 'investment', 'investments', 'Asset') RETURNING id, uuid`,
      [`Test Brokerage ${Date.now()}`]
    );
    accountUuid = acct.rows[0].uuid;
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('creates a security', async () => {
    const res = await request(app)
      .post('/api/investments/securities')
      .send({ ticker: `TST${Date.now() % 100000}`, name: 'Test Co', security_type: 'stock', asset_class: 'equity' })
      .expect(201);
    expect(res.body.uuid).toBeTruthy();
    securityUuid = res.body.uuid;
  });

  it('searches + paginates the securities catalog', async () => {
    const res = await request(app)
      .get('/api/investments/securities/paginated?search=Test&page=1&limit=10')
      .expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 10 });
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(1); // 'Test Co' created above
  });

  it('previews the unused pass-through cleanup set (shape only; tenant-wide DELETE not run here)', async () => {
    const res = await request(app)
      .get('/api/investments/securities/cleanup/pass-through-unused')
      .expect(200);
    expect(typeof res.body.count).toBe('number');
    expect(Array.isArray(res.body.samples)).toBe(true);
  });

  it('rejects a dimension that cannot apply to the security type', async () => {
    // securityUuid is a `stock` — credit_quality is a bond-sleeve dimension.
    const res = await request(app)
      .post('/api/investments/compositions')
      .send({ security_uuid: securityUuid, snapshot_date: '2025-01-01', dimensions: { credit_quality: [{ dimension_value: 'High', weight_percentage: 100 }] } });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('deletes an unused security (single) and 404s afterward', async () => {
    const tmp = await request(app)
      .post('/api/investments/securities')
      .send({ ticker: `DEL${Date.now() % 100000}`, name: 'Throwaway', security_type: 'stock' })
      .expect(201);
    await request(app).delete(`/api/investments/securities/${tmp.body.uuid}`).expect(200);
    await request(app).get(`/api/investments/securities/${tmp.body.uuid}`).expect(404);
  });

  it('records two buys creating two lots', async () => {
    await request(app)
      .post('/api/investments/events/buy')
      .send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2020-01-15', shares: 100, price_per_share: 10, fees: 0 })
      .expect(201);
    const r2 = await request(app)
      .post('/api/investments/events/buy')
      .send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2024-03-10', shares: 50, price_per_share: 25, fees: 0 })
      .expect(201);
    expect(r2.body.lot_uuid).toBeTruthy();

    const lots = await request(app).get(`/api/investments/holdings/${securityUuid}/lots?account=${accountUuid}`).expect(200);
    expect(lots.body).toHaveLength(2);
  });

  it('bulk-delete removes unused, skips held + missing (securityUuid is now held)', async () => {
    const tmp = await request(app)
      .post('/api/investments/securities')
      .send({ ticker: `BLK${Date.now() % 100000}`, name: 'Throwaway 2', security_type: 'stock' })
      .expect(201);
    const fake = '00000000-0000-7000-8000-000000000000';
    const res = await request(app)
      .post('/api/investments/securities/bulk-delete')
      .send({ uuids: [tmp.body.uuid, securityUuid, fake] })
      .expect(200);
    expect(res.body.deletedUuids).toContain(tmp.body.uuid);
    expect(res.body.deletedUuids).not.toContain(securityUuid); // held → preserved for later tests
    const reasons = Object.fromEntries(res.body.skipped.map((s: { uuid: string; reason: string }) => [s.uuid, s.reason]));
    expect(reasons[securityUuid]).toMatch(/held/i);
    expect(reasons[fake]).toMatch(/not found/i);
  });

  it('stores a price and computes holdings (compute-on-read)', async () => {
    await request(app)
      .post('/api/investments/prices')
      .send({ security_uuid: securityUuid, price_date: '2025-01-15', close: 50 })
      .expect(201);

    const res = await request(app).get(`/api/investments/holdings?account=${accountUuid}`).expect(200);
    const h = res.body.find((x: { security_uuid: string }) => x.security_uuid === securityUuid);
    expect(h.total_shares).toBe(150);
    expect(h.total_cost_basis).toBe(2250); // 100*10 + 50*25
    expect(h.market_value).toBe(7500); // 150*50
    expect(h.unrealized_gain_loss).toBe(5250);
  });

  it('dry-run sell returns a plan without persisting', async () => {
    const before = await request(app).get(`/api/investments/holdings?account=${accountUuid}`).expect(200);
    const beforeShares = before.body.find((x: { security_uuid: string }) => x.security_uuid === securityUuid).total_shares;

    const res = await request(app)
      .post('/api/investments/events/sell')
      .send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2025-06-01', shares: 60, price_per_share: 50, method: 'fifo', dry_run: true })
      .expect(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.plan.totalRealized).toBe(2400); // 60*(50-10)

    const after = await request(app).get(`/api/investments/holdings?account=${accountUuid}`).expect(200);
    expect(after.body.find((x: { security_uuid: string }) => x.security_uuid === securityUuid).total_shares).toBe(beforeShares);
  });

  it('records a FIFO sell with correct realized gain and lot decrement', async () => {
    const res = await request(app)
      .post('/api/investments/events/sell')
      .send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2025-06-01', shares: 60, price_per_share: 50, method: 'fifo' })
      .expect(201);
    expect(res.body.plan.totalRealized).toBe(2400);
    expect(res.body.plan.consumptions[0].isLongTerm).toBe(true);

    const holdings = await request(app).get(`/api/investments/holdings?account=${accountUuid}`).expect(200);
    expect(holdings.body.find((x: { security_uuid: string }) => x.security_uuid === securityUuid).total_shares).toBe(90);

    const realized = await request(app).get(`/api/investments/reports/realized-gain-loss?account=${accountUuid}`).expect(200);
    expect(realized.body[0].realized_gain_loss).toBe(2400);
    expect(realized.body[0].is_long_term).toBe(true);
  });

  it('records a reinvested dividend creating a new lot', async () => {
    const res = await request(app)
      .post('/api/investments/events/dividend')
      .send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2025-07-01', total_amount: 100, reinvest: true, price_per_share: 50 })
      .expect(201);
    expect(res.body.reinvest).toBe(true);
    expect(res.body.lot_uuid).toBeTruthy();
  });

  it('enforces external_reference idempotency (duplicate rejected)', async () => {
    const payload = { account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2025-08-01', shares: 5, price_per_share: 60, external_reference: 'CONF-12345' };
    await request(app).post('/api/investments/events/buy').send(payload).expect(201);
    const dup = await request(app).post('/api/investments/events/buy').send(payload);
    expect(dup.status).toBeGreaterThanOrEqual(400); // unique index rejects the duplicate
  });
});
