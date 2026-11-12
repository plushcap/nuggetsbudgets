import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Fee / cost-of-ownership integration test (requires Postgres test DB).
describe('Investments fees API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountUuid: string;
  let securityUuid: string;

  beforeAll(async () => {
    tenant = await createTestTenant('Investments fees API');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING id, uuid`, [`Fee Brokerage ${Date.now()}`]);
    accountUuid = acct.rows[0].uuid;
    const sec = await request(app).post('/api/investments/securities').send({ ticker: `FE${Date.now() % 100000}`, name: 'Fund', security_type: 'etf', asset_class: 'equity', is_pass_through: true, expense_ratio_percentage: 0.04 }).expect(201);
    securityUuid = sec.body.uuid;
    await request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2024-01-02', shares: 1000, price_per_share: 50 }).expect(201);
    await request(app).post('/api/investments/prices').send({ security_uuid: securityUuid, price_date: '2025-01-15', close: 50 }).expect(201);
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('records an advisory fee and aggregates it in the fees summary', async () => {
    await request(app).post('/api/investments/events/fee').send({ account_uuid: accountUuid, fee_type: 'advisory', amount: 125, event_date: '2025-01-31' }).expect(201);
    const summary = await request(app).get(`/api/investments/reports/fees?account=${accountUuid}`).expect(200);
    expect(summary.body.total).toBe(125);
    expect(summary.body.by_type.find((t: { fee_type: string }) => t.fee_type === 'advisory').total).toBe(125);
  });

  it('computes cost of ownership: explicit fees + imputed expense-ratio drag', async () => {
    const coo = await request(app).get(`/api/investments/reports/cost-of-ownership?account=${accountUuid}`).expect(200);
    // $50k position at 0.04% expense ratio = $20 imputed drag (estimated)
    const holding = coo.body.per_holding.find((h: { ticker: string }) => h.ticker.startsWith('FE'));
    expect(holding.imputedDrag).toBe(20);
    expect(holding.imputed_drag_is_estimated).toBe(true);
    expect(coo.body.account_level_fees).toBe(125);
    expect(coo.body.total_imputed_drag).toBe(20);
  });
});
