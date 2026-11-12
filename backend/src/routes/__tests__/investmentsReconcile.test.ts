import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { ImportService } from '../../services/ImportService.js';
import globalPool from '../../db.js';

// The reconciliation test syncs from SimpleFin with its HTTP answers stubbed, as
// importSync.db.test.ts does: only the organization's stored credential is replaced.
vi.mock('../../services/OrganizationSimpleFinService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/OrganizationSimpleFinService.js')>();
  return { ...actual, getAccessUrlForTenant: vi.fn(async () => 'https://user:secret@bridge.simplefin.org/simplefin') };
});

// Reconciliation / needs-data / price-gaps / CSV integration (require Postgres test DB).
describe('Investments reconciliation + data tools', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountUuid: string;
  let securityUuid: string;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    tenant = await createTestTenant('Investments reconciliation + data tools');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING id, uuid`, [`Rec Brokerage ${Date.now()}`]);
    accountUuid = acct.rows[0].uuid;
    const sec = await request(app).post('/api/investments/securities').send({ ticker: `RC${Date.now() % 100000}`, name: 'Rec Co', security_type: 'stock', asset_class: 'equity' }).expect(201);
    securityUuid = sec.body.uuid;
    await request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2024-01-02', shares: 100, price_per_share: 50 }).expect(201);
    // Gappy price history.
    await request(app).post('/api/investments/prices').send({ security_uuid: securityUuid, price_date: '2025-01-01', close: 50 }).expect(201);
    await request(app).post('/api/investments/prices').send({ security_uuid: securityUuid, price_date: '2025-03-01', close: 50 }).expect(201);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await tenant.cleanup();
  });

  it('compares the balance the SimpleFin sync imports with holdings plus cash', async () => {
    const orgUrl = `https://broker-${stamp}.example`;
    await pool.query(`INSERT INTO account_institutions (name, import_domain) VALUES ('Test Broker', $1)`, [new URL(orgUrl).hostname]);
    // Investment accounts linked to SimpleFin, each holding 100 sh at $50: $5,000.
    const linked = async (label: string, rebalance: boolean) => {
      const importId = `SF-${label}-${stamp}`;
      const row = (await pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                               import_auto_assign_budget_period, import_auto_assign_budget_item, import_account_rebalance)
         VALUES ($1, 'investment', 'investments', 'Asset', $2, 'simplefin', true, false, false, $3) RETURNING uuid`,
        [`Rec ${label} ${stamp}`, importId, rebalance]
      )).rows[0];
      await request(app).post('/api/investments/events/buy').send({ account_uuid: row.uuid, security_uuid: securityUuid, event_date: '2024-01-02', shares: 100, price_per_share: 50 }).expect(201);
      return { uuid: row.uuid as string, importId };
    };
    const matched = await linked('matched', false);
    const off = await linked('off', false);
    const rebalanced = await linked('rebalanced', true);

    // The broker's cash side: $5,250 deposited, $5,000 spent on the shares, a pending $20 fee.
    // Posted cash $250; with the $5,000 of shares the account is worth $5,250.
    const now = Math.floor(Date.now() / 1000);
    const cash = (id: string) => [
      { id: `${id}-DEP`, amount: '5250.00', description: 'DEPOSIT', posted: now - 5 * 86_400 },
      { id: `${id}-BUY`, amount: '-5000.00', description: 'BUY REC', posted: now - 4 * 86_400 },
      { id: `${id}-FEE`, amount: '-20.00', description: 'FEE', posted: now - 86_400, pending: true },
    ];
    const account = (a: { importId: string }, balance: string) => ({
      id: a.importId, conn_id: `CONN-${stamp}`, name: `Broker ${a.importId}`, currency: 'USD', balance, 'balance-date': now, transactions: cash(a.importId),
    });
    const feed = {
      errlist: [],
      connections: [{ conn_id: `CONN-${stamp}`, name: 'Test Broker', org_id: `org-${stamp}`, org_url: orgUrl, sfin_url: 'https://bridge.simplefin.org/simplefin' }],
      accounts: [account(matched, '5250.00'), account(off, '6000.00'), account(rebalanced, '5250.00')],
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(feed), { status: 200, headers: { 'content-type': 'application/json' } })));
    await new ImportService(globalPool).runFullSync(tenant.tenantId, { syncType: 'manual', syncTrigger: 'user', userId: tenant.userId });
    vi.unstubAllGlobals();

    const res = await request(app).get('/api/investments/reports/reconciliation').expect(200);
    const row = (uuid: string) => res.body.accounts.find((a: { account_uuid: string }) => a.account_uuid === uuid);
    // $5,000 of shares + $250 posted cash = $5,250, as the broker says.
    expect(row(matched.uuid)).toMatchObject({ imported_balance: 5250, holdings_value: 5000, cash_value: 250, calculated_value: 5250, difference: 0, flagged: false, reason: null });
    // The broker says $6,000: $750 more than Nuggets knows of, beyond max($50, 1% = $60).
    expect(row(off.uuid)).toMatchObject({ imported_balance: 6000, calculated_value: 5250, difference: -750, threshold: 60, flagged: true });
    // Auto-rebalanced to the broker's $5,250: its balance isn't cash, so it isn't compared.
    expect(row(rebalanced.uuid)).toMatchObject({ imported_balance: 5250, holdings_value: 5000, cash_value: null, calculated_value: null, flagged: false });
    expect(row(rebalanced.uuid).reason).toMatch(/auto-rebalances/);
    // Not synced: nothing to compare.
    expect(row(accountUuid)).toMatchObject({ imported_balance: null, flagged: false });
  });

  it('answers the difference in exact cents, its percentage rounded half away from zero', async () => {
    // One share at $7.99, no cash, and a broker balance of $8.00: -$0.01, -0.125% of it. The
    // float arithmetic answered -0.12%.
    const row = (await pool.query(
      `INSERT INTO accounts (name, account_type, account_group, type, import_balance) VALUES ($1, 'investment', 'investments', 'Asset', 8.00) RETURNING uuid`,
      [`Rec cents ${stamp}`]
    )).rows[0];
    const sec = (await request(app).post('/api/investments/securities').send({ ticker: `RCC${Date.now() % 100000}`, name: 'Rec cents', security_type: 'stock' }).expect(201)).body.uuid;
    await request(app).post('/api/investments/events/buy').send({ account_uuid: row.uuid, security_uuid: sec, event_date: '2024-01-02', shares: '1', price_per_share: '7.99' }).expect(201);
    await request(app).post('/api/investments/prices').send({ security_uuid: sec, price_date: '2025-01-01', close: '7.99' }).expect(201);
    const res = await request(app).get('/api/investments/reports/reconciliation').expect(200);
    const account = res.body.accounts.find((a: { account_uuid: string }) => a.account_uuid === row.uuid);
    expect(account).toMatchObject({ imported_balance: 8, calculated_value: 7.99, difference: -0.01, absDifference: 0.01, pctDifference: -0.13, threshold: 50, flagged: false });
  });

  it('finds price-history gaps', async () => {
    const res = await request(app).get(`/api/investments/securities/${securityUuid}/price-gaps?threshold_days=5`).expect(200);
    expect(res.body.gaps.length).toBeGreaterThanOrEqual(1);
    expect(res.body.gaps[0].gap_days).toBeGreaterThan(5);
  });

  it('exports holdings as CSV', async () => {
    const res = await request(app).get(`/api/investments/export/holdings.csv?account=${accountUuid}`).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    // Named through contentDisposition, as every download is.
    expect(res.headers['content-disposition']).toBe(`attachment; filename="holdings.csv"; filename*=UTF-8''holdings.csv`);
    expect(res.text.split('\n')[0]).toContain('ticker');
    expect(res.text).toContain('market_value');
  });

  it('exports a name a spreadsheet would run as a formula as text', async () => {
    await pool.query(`UPDATE securities SET name = '=1+2' WHERE uuid = $1`, [securityUuid]);
    const res = await request(app).get(`/api/investments/export/holdings.csv?account=${accountUuid}`).expect(200);
    expect(res.text.split('\n')[1].split(',')[1]).toBe("'=1+2");
  });
});
