import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Data-freshness integration test (requires Postgres test DB).
describe('Investments data freshness API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountUuid: string;
  let fundUuid: string;

  beforeAll(async () => {
    tenant = await createTestTenant('Investments data freshness API');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING id, uuid`, [`Fr Brokerage ${Date.now()}`]);
    accountUuid = acct.rows[0].uuid;
    // Pass-through fund, held, with NO price, NO composition, NO expense ratio.
    const fund = await request(app).post('/api/investments/securities').send({ ticker: `FR${Date.now() % 100000}`, name: 'Stale Fund', security_type: 'etf', asset_class: 'equity', is_pass_through: true }).expect(201);
    fundUuid = fund.body.uuid;
    await request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: fundUuid, event_date: '2024-01-02', shares: 10, price_per_share: 100 }).expect(201);
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('surfaces a held pass-through fund missing price, composition, and expense ratio', async () => {
    const res = await request(app).get('/api/investments/reports/data-freshness').expect(200);
    expect(res.body.stale_prices.some((p: { security_uuid: string; never_recorded: boolean }) => p.security_uuid === fundUuid && p.never_recorded)).toBe(true);
    expect(res.body.stale_compositions.some((c: { security_uuid: string }) => c.security_uuid === fundUuid)).toBe(true);
    expect(res.body.missing_expense_ratios.some((e: { security_uuid: string }) => e.security_uuid === fundUuid)).toBe(true);
  });
});
