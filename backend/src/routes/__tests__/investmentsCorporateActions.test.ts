import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Integration tests for corporate actions (split / return of capital) — require
// the Postgres test DB (CI provides it).
describe('Investments corporate actions API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountUuid: string;
  let securityUuid: string;

  beforeAll(async () => {
    tenant = await createTestTenant('Investments corporate actions API');
    pool = tenant.pool;

    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());

    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING id, uuid`, [`CA Brokerage ${Date.now()}`]);
    accountUuid = acct.rows[0].uuid;

    const sec = await request(app).post('/api/investments/securities').send({ ticker: `CA${Date.now() % 100000}`, name: 'CA Co', security_type: 'stock', asset_class: 'equity' }).expect(201);
    securityUuid = sec.body.uuid;
    await request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2020-01-15', shares: 100, price_per_share: 40, fees: 0 }).expect(201);
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('applies a 2:1 split: doubles shares, halves basis, preserves total', async () => {
    await request(app).post('/api/investments/corporate-actions/split').send({ security_uuid: securityUuid, action_date: '2021-08-31', numerator: 2, denominator: 1 }).expect(201);
    const lots = await request(app).get(`/api/investments/holdings/${securityUuid}/lots?account=${accountUuid}`).expect(200);
    expect(Number(lots.body[0].shares_remaining)).toBe(200);
    expect(Number(lots.body[0].cost_basis_per_share)).toBeCloseTo(20, 4);
  });

  it('applies return of capital: reduces per-share basis', async () => {
    await request(app).post('/api/investments/corporate-actions/return-of-capital').send({ security_uuid: securityUuid, action_date: '2022-01-01', amount_per_share: 5 }).expect(201);
    const lots = await request(app).get(`/api/investments/holdings/${securityUuid}/lots?account=${accountUuid}`).expect(200);
    expect(Number(lots.body[0].cost_basis_per_share)).toBeCloseTo(15, 4); // 20 - 5
  });

  it('dry-run split does not persist', async () => {
    const before = await request(app).get(`/api/investments/holdings/${securityUuid}/lots?account=${accountUuid}`).expect(200);
    const beforeShares = Number(before.body[0].shares_remaining);
    const res = await request(app).post('/api/investments/corporate-actions/split').send({ security_uuid: securityUuid, action_date: '2023-01-01', numerator: 3, denominator: 1, dry_run: true }).expect(200);
    expect(res.body.dry_run).toBe(true);
    const after = await request(app).get(`/api/investments/holdings/${securityUuid}/lots?account=${accountUuid}`).expect(200);
    expect(Number(after.body[0].shares_remaining)).toBe(beforeShares);
  });
});
