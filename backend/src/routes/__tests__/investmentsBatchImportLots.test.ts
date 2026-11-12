import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// batch_import_lots acquisition_method validation (requires Postgres test DB).
// Regression for the reported bug: an unrecognized acquisition_method 500'd on
// the real write while dry-run reported "created". The field is now a schema
// enum, so validateBody rejects it with a 400 in BOTH modes (never reaching the
// tax_lots_acquisition_method_check constraint).
describe('Investments batch-import-lots acquisition_method validation', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountId: number;
  let accountUuid: string;
  let securityUuid: string;

  beforeAll(async () => {
    tenant = await createTestTenant('Investments batch-import-lots acquisition_method validation');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING id, uuid`, [`BIL Brokerage ${Date.now()}`]);
    accountId = acct.rows[0].id;
    accountUuid = acct.rows[0].uuid;
    const sec = await request(app).post('/api/investments/securities').send({ ticker: `BI${Date.now() % 100000}`, name: 'Import Co', security_type: 'stock', asset_class: 'equity' }).expect(201);
    securityUuid = sec.body.uuid;
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  const lot = (acquisition_method?: string) => ({
    account_uuid: accountUuid, security_uuid: securityUuid,
    acquisition_date: '2020-01-02', shares: 10, total_cost_basis: 500,
    ...(acquisition_method !== undefined ? { acquisition_method } : {}),
  });

  it('rejects an unrecognized acquisition_method with 400 on dry-run (no false "created")', async () => {
    const res = await request(app)
      .post('/api/investments/lots/batch-import')
      .send({ lots: [lot('teleportation')], dry_run: true })
      .expect(400);
    expect(JSON.stringify(res.body)).not.toMatch(/created/i);
  });

  it('rejects an unrecognized acquisition_method with 400 on the real write (no 500)', async () => {
    await request(app)
      .post('/api/investments/lots/batch-import')
      .send({ lots: [lot('teleportation')], dry_run: false })
      .expect(400);
  });

  it('accepts a valid acquisition_method: dry-run previews without persisting', async () => {
    const res = await request(app)
      .post('/api/investments/lots/batch-import')
      .send({ lots: [lot('transfer_in')], dry_run: true })
      .expect(200);
    expect(res.body).toMatchObject({ dry_run: true, created: 1 });
    const rows = await pool.query('SELECT COUNT(*)::int AS n FROM tax_lots WHERE account_id = $1', [accountId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('accepts a valid acquisition_method: real write persists the lot with that method', async () => {
    const res = await request(app)
      .post('/api/investments/lots/batch-import')
      .send({ lots: [lot('transfer_in')], dry_run: false })
      .expect(201);
    expect(res.body).toMatchObject({ dry_run: false, created: 1 });
    const row = await pool.query(
      'SELECT acquisition_method FROM tax_lots WHERE uuid = $1',
      [res.body.results[0].lot_uuid],
    );
    expect(row.rows[0].acquisition_method).toBe('transfer_in');
  });

  it('defaults a missing acquisition_method to purchase', async () => {
    const res = await request(app)
      .post('/api/investments/lots/batch-import')
      .send({ lots: [lot()], dry_run: false })
      .expect(201);
    const row = await pool.query(
      'SELECT acquisition_method FROM tax_lots WHERE uuid = $1',
      [res.body.results[0].lot_uuid],
    );
    expect(row.rows[0].acquisition_method).toBe('purchase');
  });
});
