import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Covers the agent-driven event enhancements (requires Postgres test DB):
//  - buy events persist a data_quality provenance flag on the created lot
//  - fee events round-trip external_reference and are idempotent on re-send
//  - dividends can reinvest into a DIFFERENT security than the payer
describe('Investments event enhancements API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountId: number;
  let accountUuid: string;
  let payerUuid: string;
  let targetUuid: string;

  beforeAll(async () => {
    tenant = await createTestTenant('Investments event enhancements API');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING id, uuid`, [`Enh Brokerage ${Date.now()}`]);
    accountId = acct.rows[0].id;
    accountUuid = acct.rows[0].uuid;
    const payer = await request(app).post('/api/investments/securities').send({ ticker: `PY${Date.now() % 100000}`, name: 'Payer ETF', security_type: 'etf', asset_class: 'equity' }).expect(201);
    payerUuid = payer.body.uuid;
    const target = await request(app).post('/api/investments/securities').send({ ticker: `TG${Date.now() % 100000}`, name: 'Target Bond ETF', security_type: 'etf', asset_class: 'fixed_income' }).expect(201);
    targetUuid = target.body.uuid;
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('persists data_quality on the tax lot created by a buy event', async () => {
    const res = await request(app).post('/api/investments/events/buy').send({
      account_uuid: accountUuid, security_uuid: payerUuid, event_date: '2025-02-03',
      shares: 10, price_per_share: 50, data_quality: 'imputed_basis',
    }).expect(201);
    const lot = await pool.query(
      `SELECT data_quality FROM tax_lots WHERE created_by_event_id = (SELECT id FROM holding_events WHERE uuid = $1)`,
      [res.body.event_uuid],
    );
    expect(lot.rows[0].data_quality).toBe('imputed_basis');
  });

  it('defaults data_quality to complete when omitted', async () => {
    const res = await request(app).post('/api/investments/events/buy').send({
      account_uuid: accountUuid, security_uuid: payerUuid, event_date: '2025-02-04',
      shares: 5, price_per_share: 51,
    }).expect(201);
    const lot = await pool.query(
      `SELECT data_quality FROM tax_lots WHERE created_by_event_id = (SELECT id FROM holding_events WHERE uuid = $1)`,
      [res.body.event_uuid],
    );
    expect(lot.rows[0].data_quality).toBe('complete');
  });

  it('round-trips external_reference on a fee and is idempotent on re-send', async () => {
    const ref = `advisor:fee:${Date.now()}`;
    const first = await request(app).post('/api/investments/events/fee').send({
      account_uuid: accountUuid, fee_type: 'advisory', amount: 0.03, event_date: '2025-03-31', external_reference: ref,
    }).expect(201);
    expect(first.body.status).toBe('created');

    const second = await request(app).post('/api/investments/events/fee').send({
      account_uuid: accountUuid, fee_type: 'advisory', amount: 0.03, event_date: '2025-03-31', external_reference: ref,
    }).expect(201);
    expect(second.body.status).toBe('skipped');
    expect(second.body.event_uuid).toBe(first.body.event_uuid);

    const rows = await pool.query(
      `SELECT external_reference FROM holding_events WHERE account_id = $1 AND event_type = 'fee' AND external_reference = $2`,
      [accountId, ref],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].external_reference).toBe(ref);
  });

  it('reinvests a dividend into a different security than the payer', async () => {
    // Hold the payer so the dividend has something to pay on.
    await request(app).post('/api/investments/events/buy').send({
      account_uuid: accountUuid, security_uuid: payerUuid, event_date: '2025-04-01', shares: 100, price_per_share: 60,
    }).expect(201);

    const res = await request(app).post('/api/investments/events/dividend').send({
      account_uuid: accountUuid, security_uuid: payerUuid, event_date: '2025-04-15',
      total_amount: 20, reinvest: true, price_per_share: 40,
      reinvest_into_security_uuid: targetUuid,
    }).expect(201);
    expect(res.body.reinvest).toBe(true);
    expect(res.body.reinvested_into_security_uuid).toBe(targetUuid);
    expect(res.body.lot_uuid).toBeTruthy();

    // The reinvestment lot must be opened in the TARGET security, not the payer.
    const lot = await pool.query(
      `SELECT tl.shares_original, tl.acquisition_method, s.uuid AS security_uuid
         FROM tax_lots tl JOIN securities s ON s.id = tl.security_id
        WHERE tl.uuid = $1`,
      [res.body.lot_uuid],
    );
    expect(lot.rows[0].security_uuid).toBe(targetUuid);
    expect(lot.rows[0].acquisition_method).toBe('dividend_reinvest');
    // 20 dollars / 40 per share = 0.5 shares in the target.
    expect(Number(lot.rows[0].shares_original)).toBeCloseTo(0.5, 6);

    // The dividend itself is still recorded against the payer, with the link stamped.
    const div = await pool.query(
      `SELECT he.metadata, s.uuid AS security_uuid
         FROM holding_events he JOIN securities s ON s.id = he.security_id
        WHERE he.uuid = $1`,
      [res.body.event_uuid],
    );
    expect(div.rows[0].security_uuid).toBe(payerUuid);
    expect(div.rows[0].metadata?.reinvested_into_security_uuid).toBe(targetUuid);
  });

  it('rejects a cross-security reinvest without reinvest=true', async () => {
    await request(app).post('/api/investments/events/dividend').send({
      account_uuid: accountUuid, security_uuid: payerUuid, event_date: '2025-05-15',
      total_amount: 10, reinvest: false, price_per_share: 40,
      reinvest_into_security_uuid: targetUuid,
    }).expect(400);
  });
});
