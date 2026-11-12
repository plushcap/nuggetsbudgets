import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Holding-events ledger integration test (requires Postgres test DB).
describe('Investments events ledger API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountUuid: string;
  let securityUuid: string;

  beforeAll(async () => {
    tenant = await createTestTenant('Investments events ledger API');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING id, uuid`, [`Ev Brokerage ${Date.now()}`]);
    accountUuid = acct.rows[0].uuid;
    const sec = await request(app).post('/api/investments/securities').send({ ticker: `EV${Date.now() % 100000}`, name: 'Event Co', security_type: 'stock', asset_class: 'equity' }).expect(201);
    securityUuid = sec.body.uuid;
    await request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2025-01-02', shares: 10, price_per_share: 50 }).expect(201);
    await request(app).post('/api/investments/events/fee').send({ account_uuid: accountUuid, fee_type: 'advisory', amount: 5, event_date: '2025-01-31' }).expect(201);
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('lists events with pagination metadata', async () => {
    const res = await request(app).get(`/api/investments/events?account=${accountUuid}`).expect(200);
    expect(res.body.pagination).toBeTruthy();
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    const types = res.body.data.map((e: { event_type: string }) => e.event_type);
    expect(types).toContain('buy');
    expect(types).toContain('fee');
  });

  it('filters by event_type', async () => {
    const res = await request(app).get(`/api/investments/events?account=${accountUuid}&event_type=fee`).expect(200);
    expect(res.body.data.every((e: { event_type: string }) => e.event_type === 'fee')).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });
});
