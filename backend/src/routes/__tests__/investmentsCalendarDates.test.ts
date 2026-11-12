import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * An investment write's dates are calendar days: one that isn't a real day
 * ('2025-02-30', 'nope', a timestamp) is a 400 before any service code reads it, for the
 * dry run as for the real call. Before, Postgres refused it with a 500, and a reinvested
 * dividend's dry run, which works out the wash-sale window from it, threw.
 */
describe('Investment writes refuse a date that is not a calendar day', () => {
  let app: Express;
  let tenant: TestTenant;
  let pool: Pool;
  let account: string;
  let sec: string;
  const post = (path: string, body: object) => request(app).post(`/api/investments${path}`).send(body);
  const written = async () =>
    (await pool.query<{ n: string }>(`SELECT (SELECT count(*) FROM holding_events) + (SELECT count(*) FROM tax_lots) + (SELECT count(*) FROM security_prices) + (SELECT count(*) FROM security_corporate_actions) AS n`)).rows[0].n;
  // The year range too: ±30 days from 0001-01-01 or 9999-12-31 (the wash-sale window) left
  // Postgres's date range, a 500.
  const BAD = ['2025-02-30', '2023-02-29', 'nope', '0000-01-01', '0001-01-01', '0001-01-20', '1799-12-31', '3000-01-01', '9999-12-31', '2026-11-04T00:00:00Z', '2026-1-4', ''];

  beforeAll(async () => {
    tenant = await createTestTenant('Investment calendar dates');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    account = (await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Brokerage', 'investment', 'investments', 'Asset') RETURNING uuid`)).rows[0].uuid;
    sec = (await post('/securities', { ticker: `CD${Date.now() % 1_000_000}`, name: 'Dates', security_type: 'stock' }).expect(201)).body.uuid;
    await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2024-02-29', shares: '10', price_per_share: '5' }).expect(201);
  });
  afterAll(async () => { await tenant.cleanup(); });

  const writes = (date: string): Array<[string, object]> => [
    ['/events/buy', { account_uuid: account, security_uuid: sec, event_date: date, shares: '1', price_per_share: '5' }],
    ['/events/sell', { account_uuid: account, security_uuid: sec, event_date: date, shares: '1', price_per_share: '5' }],
    ['/events/dividend', { account_uuid: account, security_uuid: sec, event_date: date, total_amount: '5', reinvest: true, price_per_share: '5' }],
    ['/events/dividend', { account_uuid: account, security_uuid: sec, event_date: '2024-03-01', pay_date: date, total_amount: '5' }],
    ['/corporate-actions/split', { security_uuid: sec, action_date: date, numerator: '2', denominator: '1' }],
    ['/lots/batch-import', { lots: [{ account_uuid: account, security_uuid: sec, acquisition_date: date, shares: '1', total_cost_basis: '5' }] }],
    ['/prices', { security_uuid: sec, price_date: date, close: '5' }],
  ];

  it('answers 400, dry run and real call alike, and writes nothing', async () => {
    const before = await written();
    for (const date of BAD) {
      for (const [path, body] of writes(date)) {
        for (const dryRun of [true, false]) {
          const res = await post(path, { ...body, dry_run: dryRun });
          expect(res.status, `${path} ${JSON.stringify(date)} dry_run ${dryRun}: ${JSON.stringify(res.body)}`).toBe(400);
        }
      }
    }
    expect(await written()).toBe(before);
  });

  it('bulk prices refuse a bad date for that record alone, by the same rule', async () => {
    const days = ['0001-01-01', '1799-12-31', '3000-01-01', '2025-02-30', '1800-01-01', '2999-12-31'];
    const res = await post('/prices/bulk', { prices: days.map((price_date) => ({ security_uuid: sec, price_date, close: '5' })) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.results.map((r: { ok: boolean }) => r.ok)).toEqual([false, false, false, false, true, true]);
  });

  it('takes a real day, a leap day and the ends of the range included', async () => {
    for (const day of ['2028-02-29', '1800-01-01', '2999-12-31']) {
      const res = await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: day, shares: '1', price_per_share: '5', dry_run: true });
      expect(res.status, `${day}: ${JSON.stringify(res.body)}`).toBe(200);
    }
  });
});
