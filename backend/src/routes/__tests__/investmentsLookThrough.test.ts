import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Integration tests for fund composition + look-through (require Postgres test DB).
describe('Investments look-through API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountUuid: string;
  let stockUuid: string;
  let fundUuid: string;

  const buy = (security_uuid: string, shares: number, price: number) =>
    request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid, event_date: '2024-01-02', shares, price_per_share: price }).expect(201);
  const price = (security_uuid: string, close: number) =>
    request(app).post('/api/investments/prices').send({ security_uuid, price_date: '2025-01-15', close }).expect(201);

  beforeAll(async () => {
    tenant = await createTestTenant('Investments look-through API');
    pool = tenant.pool;

    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());

    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING id, uuid`, [`LT Brokerage ${Date.now()}`]);
    accountUuid = acct.rows[0].uuid;

    const stock = await request(app).post('/api/investments/securities').send({ ticker: `ACM${Date.now() % 100000}`, name: 'Acme Corp', security_type: 'stock', asset_class: 'equity', sector: 'technology' }).expect(201);
    stockUuid = stock.body.uuid;
    const fund = await request(app).post('/api/investments/securities').send({ ticker: `IDX${Date.now() % 100000}`, name: 'Total Market ETF', security_type: 'etf', asset_class: 'equity', is_pass_through: true }).expect(201);
    fundUuid = fund.body.uuid;

    // stock is a plain holding: classification now lives in fund_compositions
    // (one row per dimension), not a direct securities.sector column.
    await request(app)
      .post('/api/investments/compositions')
      .send({ security_uuid: stockUuid, snapshot_date: '2025-01-01', dimensions: { sector: [{ dimension_value: 'technology', weight_percentage: 100 }] } })
      .expect(201);

    await buy(stockUuid, 100, 100); // $10k direct
    await buy(fundUuid, 100, 100); // $10k fund
    await price(stockUuid, 100);
    await price(fundUuid, 100);
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('rejects a composition snapshot whose weights fall outside tolerance', async () => {
    const res = await request(app)
      .post('/api/investments/compositions')
      .send({ security_uuid: fundUuid, snapshot_date: '2025-01-01', dimensions: { sector: [{ dimension_value: 'technology', weight_percentage: 30 }] } });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('accepts a valid composition and stamps freshness', async () => {
    await request(app)
      .post('/api/investments/compositions')
      .send({ security_uuid: fundUuid, snapshot_date: '2025-01-01', dimensions: { sector: [{ dimension_value: 'technology', weight_percentage: 30 }, { dimension_value: 'other', weight_percentage: 70 }] } })
      .expect(201);
    const sec = await request(app).get(`/api/investments/securities/${fundUuid}`).expect(200);
    expect(sec.body.last_composition_update_at).toBeTruthy();
  });

  it('computes look-through sector exposure combining direct + fund', async () => {
    const res = await request(app).get(`/api/investments/reports/lookthrough?dimension=sector&account=${accountUuid}`).expect(200);
    // tech = $10k of the stock direct + 30% of the $10k fund = $13k of $20k = 65%
    const tech = res.body.buckets.find((b: { dimensionValue: string }) => b.dimensionValue === 'technology');
    expect(tech.amount).toBe(13000);
    expect(tech.percentage).toBe(65);
  });
});
