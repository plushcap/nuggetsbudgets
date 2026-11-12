import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { PriceSyncInProgressError, PriceSyncService, STALE_RUN_MESSAGE } from '../../services/investments/PriceSyncService.js';
import { PriceIngestService } from '../../services/investments/PriceIngestService.js';
import type { PriceProviderClient } from '../../services/investments/PriceProviderClient.js';

// Price-sync orchestration + value-series read (requires Postgres test DB).
describe('Investment price sync + value series', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let userId: number;
  const seriesDates = ['2020-01-02', '2020-01-03'];

  beforeAll(async () => {
    tenant = await createTestTenant('Investment price sync + value series');
    pool = tenant.pool;
    userId = tenant.userId;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('returns the value series ascending by date', async () => {
    await pool.query(
      `INSERT INTO portfolio_value_snapshots (snapshot_date, total_value, cost_basis, holdings_count, priced_securities, stale_securities)
       VALUES ($1,'1000','900',1,1,0),($2,'1100','900',1,1,0)
       ON CONFLICT (tenant_id, snapshot_date) DO UPDATE SET total_value = EXCLUDED.total_value`,
      seriesDates
    );
    const res = await request(app).get('/api/investments/reports/value-series').expect(200);
    const mine = res.body.series.filter((p: { snapshot_date: string }) => seriesDates.includes(p.snapshot_date));
    expect(mine.map((p: { snapshot_date: string }) => p.snapshot_date)).toEqual(seriesDates); // ascending
    expect(mine[0].total_value).toBe(1000);
    expect(mine[1].total_value).toBe(1100);
  });

  describe('runForOrg orchestration', () => {
    // runForOrg walks every tenant of an org, so give it an org whose only tenant is this one.
    let syncTenant: TestTenant;
    let orgId: number;
    let tenantId: number;

    const fakeProvider: Pick<PriceProviderClient, 'fetchEodCloses'> = {
      fetchEodCloses: async (tickers: string[]) =>
        tickers.map((t) => ({ ticker: t, date: '2020-01-02', close: 123.45, volume: 1000 })),
    };
    const svc = new PriceSyncService(new PriceIngestService(fakeProvider as PriceProviderClient));

    beforeAll(async () => {
      syncTenant = await createTestTenant('PS Ledger');
      orgId = syncTenant.organizationId;
      tenantId = syncTenant.tenantId;
      await syncTenant.pool.query(
        `INSERT INTO securities (ticker, name, security_type) VALUES ($1,'PS Sec','stock')`,
        [`PSX${Date.now() % 100000}`]
      );
    });

    afterAll(async () => {
      await syncTenant.cleanup();
    });

    it('runs the org: writes prices, snapshots value, logs the run, and is idempotent per day', async () => {
      const res = await svc.runForOrg(orgId, { trigger: 'user', userId });
      expect(res.status).toBe('success');
      expect(res.snapshots_written).toBe(1);
      expect(res.prices_updated).toBeGreaterThanOrEqual(1);

      const runs = await syncTenant.pool.query('SELECT * FROM organization_price_sync_runs WHERE organization_id = $1', [orgId]);
      expect(runs.rows.length).toBe(1);
      expect(runs.rows[0].run_status).toBe('success');
      expect(runs.rows[0].run_trigger).toBe('user');

      const prices = await syncTenant.pool.query('SELECT * FROM security_prices WHERE security_id IN (SELECT id FROM securities WHERE tenant_id = $1)', [tenantId]);
      expect(prices.rows.length).toBeGreaterThanOrEqual(1);
      expect(Number(prices.rows[0].close)).toBeCloseTo(123.45, 2);

      const snaps = await syncTenant.pool.query('SELECT * FROM portfolio_value_snapshots WHERE tenant_id = $1', [tenantId]);
      expect(snaps.rows.length).toBe(1);

      // Re-run: a second run-log row, but still exactly one snapshot for the day.
      await svc.runForOrg(orgId, { trigger: 'scheduler' });
      const runs2 = await syncTenant.pool.query('SELECT * FROM organization_price_sync_runs WHERE organization_id = $1', [orgId]);
      expect(runs2.rows.length).toBe(2);
      const snaps2 = await syncTenant.pool.query('SELECT * FROM portfolio_value_snapshots WHERE tenant_id = $1', [tenantId]);
      expect(snaps2.rows.length).toBe(1);

      // last_run_at stamped on the settings row (created by the run).
      const settings = await syncTenant.pool.query('SELECT last_run_at FROM organization_price_sync_settings WHERE organization_id = $1', [orgId]);
      // settings row only exists if a prior upsert created it; runForOrg updates if present.
      if (settings.rows.length) expect(settings.rows[0].last_run_at).not.toBeNull();
    });

    // A run a crash left 'running' stayed so for ever, and a manual run and
    // a scheduled one of the same organization could overlap.
    it("marks the runs a stopped server left 'running' as failed, at the next run and at startup", async () => {
      const stale = async () =>
        (
          await syncTenant.pool.query(
            `INSERT INTO organization_price_sync_runs (organization_id, run_status, run_trigger, started_at)
             VALUES ($1, 'running', 'scheduler', NOW() - interval '2 days') RETURNING id`,
            [orgId]
          )
        ).rows[0].id as number;
      const statusOf = async (id: number) =>
        (await syncTenant.pool.query('SELECT run_status, error_message, completed_at FROM organization_price_sync_runs WHERE id = $1', [id])).rows[0];

      const leftByCrash = await stale();
      const res = await svc.runForOrg(orgId, { trigger: 'scheduler' });
      expect(res.status).toBe('success');
      expect(await statusOf(leftByCrash)).toMatchObject({ run_status: 'error', error_message: STALE_RUN_MESSAGE, completed_at: expect.any(Date) });
      expect(await statusOf(res.run_id)).toMatchObject({ run_status: 'success' });

      const leftByAnother = await stale();
      expect(await svc.failStaleRunsOfIdleOrgs()).toBeGreaterThanOrEqual(1);
      expect(await statusOf(leftByAnother)).toMatchObject({ run_status: 'error', error_message: STALE_RUN_MESSAGE });
    });

    it('runs an organization once at a time: a second run is refused, and records nothing', async () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const fetching = new Promise<void>((resolve) => (reached = resolve));
      const slow = new PriceSyncService(new PriceIngestService({
        fetchEodCloses: async (tickers: string[]) => {
          reached();
          await released;
          return fakeProvider.fetchEodCloses(tickers);
        },
      } as unknown as PriceProviderClient));
      const runCount = async () =>
        Number((await syncTenant.pool.query('SELECT count(*)::int AS n FROM organization_price_sync_runs WHERE organization_id = $1', [orgId])).rows[0].n);

      const before = await runCount();
      const first = slow.runForOrg(orgId, { trigger: 'scheduler' });
      await fetching;
      // A manual run meanwhile, from this service or another (a second server's).
      await expect(svc.runForOrg(orgId, { trigger: 'user', userId })).rejects.toBeInstanceOf(PriceSyncInProgressError);
      await expect(slow.runForOrg(orgId, { trigger: 'user', userId })).rejects.toMatchObject({ status: 409, code: 'PRICE_SYNC_IN_PROGRESS' });
      // The first run's own row, and nothing for the refused ones.
      expect(await runCount()).toBe(before + 1);
      release();
      expect((await first).status).toBe('success');
      // Once it's done, the next one runs.
      expect((await svc.runForOrg(orgId, { trigger: 'user', userId })).status).toBe('success');
      expect(await runCount()).toBe(before + 2);
    });

    // The run's error_message, which the org admin reads, kept the error's own text.
    it("logs a ledger that failed without the error's text", async () => {
      const failing = new PriceSyncService(new PriceIngestService({
        fetchEodCloses: async () => {
          throw new Error('relation "internal_secret_xyz" does not exist');
        },
      } as unknown as PriceProviderClient));
      const res = await failing.runForOrg(orgId, { trigger: 'user', userId });
      expect(res.status).toBe('error');
      const run = await syncTenant.pool.query(
        'SELECT error_message FROM organization_price_sync_runs WHERE id = $1',
        [res.run_id]
      );
      expect(run.rows[0].error_message).toMatch(/price sync failed; the server log has the details/);
      expect(run.rows[0].error_message).not.toContain('internal_secret_xyz');
    });
  });

  // A snapshot's total_value and cost_basis are NUMERIC(12,2). A ledger holding more than
  // $9,999,999,999.99 failed its insert, so its whole price sync counted as failed.
  describe('a portfolio too large to snapshot', () => {
    let largeTenant: TestTenant;
    let ticker: string;
    beforeAll(async () => {
      largeTenant = await createTestTenant('PS large ledger');
      ticker = `PSL${Date.now() % 100000}`;
      const tenantApp = express();
      tenantApp.use(express.json());
      tenantApp.use(largeTenant.context());
      tenantApp.use('/api/investments', createInvestmentsRoutes());
      const account = (await largeTenant.pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Big brokerage', 'investment', 'investments', 'Asset') RETURNING uuid`)).rows[0].uuid;
      const security = (await request(tenantApp).post('/api/investments/securities').send({ ticker, name: 'Large', security_type: 'stock' }).expect(201)).body.uuid;
      // 1,000,000,000 shares at $1: $1,000,000,000.00 of basis, which fits.
      await request(tenantApp).post('/api/investments/events/buy').send({ account_uuid: account, security_uuid: security, event_date: '2020-01-02', shares: '1000000000', price_per_share: '1' }).expect(201);
    });
    afterAll(async () => { await largeTenant.cleanup(); });

    it('skips the snapshot, and logs it, without failing the ledger', async () => {
      // At $20 a share they are worth $20,000,000,000.00.
      const provider: Pick<PriceProviderClient, 'fetchEodCloses'> = {
        fetchEodCloses: async (tickers: string[]) => tickers.map((t) => ({ ticker: t, date: '2020-01-03', close: 20, volume: 1 })),
      };
      const res = await new PriceSyncService(new PriceIngestService(provider as PriceProviderClient)).runForOrg(largeTenant.organizationId, { trigger: 'user', userId: largeTenant.userId });
      expect(res).toMatchObject({ status: 'success', tenants_synced: 1, prices_updated: 1, snapshots_written: 0 });
      const run = await largeTenant.pool.query('SELECT run_status, error_message FROM organization_price_sync_runs WHERE id = $1', [res.run_id]);
      expect(run.rows[0]).toEqual({ run_status: 'success', error_message: null });
      expect((await largeTenant.pool.query('SELECT count(*)::int AS n FROM portfolio_value_snapshots')).rows[0].n).toBe(0);
      // At $9.9999 a share ($9,999,900,000.00) it fits, and is written.
      const fits: Pick<PriceProviderClient, 'fetchEodCloses'> = {
        fetchEodCloses: async (tickers: string[]) => tickers.map((t) => ({ ticker: t, date: '2020-01-03', close: 9.9999, volume: 1 })),
      };
      const again = await new PriceSyncService(new PriceIngestService(fits as PriceProviderClient)).runForOrg(largeTenant.organizationId, { trigger: 'user', userId: largeTenant.userId });
      expect(again).toMatchObject({ status: 'success', snapshots_written: 1 });
      expect((await largeTenant.pool.query('SELECT total_value::text AS v FROM portfolio_value_snapshots')).rows).toEqual([{ v: '9999900000.00' }]);
    });
  });
});
