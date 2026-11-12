import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import request from 'supertest';
import express, { type Express } from 'express';
import { createInvestmentsRoutes } from '../../routes/investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The lookup a holdings snapshot makes of its underlyings' tickers, under RLS. It
 * filtered on upper(ticker), which isn't leakproof, so Postgres ran it only above the tenant policy:
 * no index served it, and it read every security of the ledger. It is an = ANY on the stored
 * ticker_key now, which an index on (tenant_id, ticker_key) serves. The service's own statement is
 * caught as it is sent and explained as the app role, in the ledger, with sequential scans off (a
 * small table is read whole anyway).
 */
describe("A holdings snapshot's ticker lookup under RLS", () => {
  let tenant: TestTenant;
  let app: Express;

  beforeAll(async () => {
    tenant = await createTestTenant('Security ticker lookup plan');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await tenant?.cleanup();
  });

  it('looks the tickers up through the index, not by reading the ledger', async () => {
    // A ledger of a few thousand securities, its statistics read, as a planner sees a real one.
    await tenant.pool.query(`INSERT INTO securities (ticker, name) SELECT 'TLQ' || g, 'Plan filler' FROM generate_series(1, 3000) g`);
    const owner = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 1 });
    try {
      await owner.query('ANALYZE securities');
    } finally {
      await owner.end();
    }
    const fund = await request(app)
      .post('/api/investments/securities')
      .send({ ticker: `TLP${Date.now() % 100000}`, name: 'Plan Fund', security_type: 'etf', asset_class: 'equity', is_pass_through: true })
      .expect(201);
    const sent: Array<{ text: string; values: unknown[] }> = [];
    const query = pg.Client.prototype.query as (this: pg.Client, ...args: unknown[]) => unknown;
    vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const [text, values] = args;
      if (typeof text === 'string' && /from "securities"/i.test(text) && /= ANY\(/i.test(text)) sent.push({ text, values: (values as unknown[]) ?? [] });
      return query.apply(this, args);
    } as typeof pg.Client.prototype.query);
    await request(app)
      .post('/api/investments/underlying-holdings')
      .send({ security_uuid: fund.body.uuid, snapshot_date: '2026-06-25', holdings: [{ underlying_ticker: 'tlpx', weight_percentage: 1 }] })
      .expect(201);
    vi.restoreAllMocks();

    const lookup = sent[0];
    expect(lookup, 'the ticker lookup').toBeDefined();
    const client = await tenant.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${lookup!.text}`, lookup!.values);
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/Index Cond: .*ticker_key/);
      expect(plan).not.toMatch(/Filter: .*ticker/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
