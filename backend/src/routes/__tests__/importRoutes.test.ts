import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import pool from '../../db.js';
import { createImportRoutes } from '../import.js';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';
import type { TenantRequest } from '../../middleware/tenant.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { ImportService } from '../../services/ImportService.js';
import type { SimplefinAccountSet } from '../../services/import/types.js';

const lifecycleStub = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async () => undefined) }) as unknown as ApplicationLifecycleService;

/**
 * The bank-import routes whose database work moved to services/import/tenantImport.ts:
 * the sync log, the import user's check and list, a single-account sync's account
 * check, and the SimpleFin accounts page. What each answers, another ledger's rows left out;
 * a refusal is the route wrapper's answer, and a failure its 500 (the two SimpleFin routes
 * answered `{ success: false, … }` 500s of their own).
 */
describe('Import routes (services/import)', () => {
  let tenant: TestTenant;
  let other: TestTenant;
  let app: Express;
  const importService = new ImportService(pool);
  let linked: { uuid: string; importId: string };
  let unlinked: string;

  beforeAll(async () => {
    tenant = await createTestTenant('Import routes');
    other = await createTestTenant('Import routes, other ledger');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use((req, _res, next) => {
      (req as TenantRequest).org = { id: tenant.organizationId, isAdmin: true };
      next();
    });
    app.use('/api/import', createImportRoutes({ lifecycleService: lifecycleStub, importService }));

    const importId = `ACT-${Date.now()}`;
    const account = (
      await tenant.pool.query<{ uuid: string }>(
        `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled)
         VALUES ('Linked checking', 'checking', 'cash', 'Asset', $1, 'simplefin', true) RETURNING uuid`,
        [importId]
      )
    ).rows[0];
    linked = { uuid: account.uuid, importId };
    unlinked = (
      await tenant.pool.query<{ uuid: string }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Cash', 'checking', 'cash', 'Asset') RETURNING uuid`
      )
    ).rows[0].uuid;
    for (const [who, status] of [[tenant, 'success'], [tenant, 'failed'], [other, 'success']] as const) {
      await who.pool.query(
        `INSERT INTO import_sync_log (sync_type, sync_status, sync_trigger, import_provider, sync_start_time)
         VALUES ('manual', $1, 'user', 'simplefin', now())`,
        [status]
      );
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await other?.cleanup();
  });

  it("pages the ledger's sync log, as offsetParams read the page", async () => {
    const res = await request(app).get('/api/import/sync-log?limit=abc&offset=-3').expect(200);
    expect(res.body).toMatchObject({ success: true, pagination: { limit: 50, offset: 0, total: 2 } });
    expect(res.body.syncLogs.map((row: { sync_status: string }) => row.sync_status).sort()).toEqual(['failed', 'success']);
    const page = await request(app).get('/api/import/sync-log?limit=1&offset=1').expect(200);
    expect(page.body.pagination).toEqual({ limit: 1, offset: 1, total: 2 });
    expect(page.body.syncLogs).toHaveLength(1);
  });

  it("lists the ledger's people as import user candidates, and refuses anyone else", async () => {
    const users = await request(app).get('/api/import/users').expect(200);
    expect(users.body.users.map((u: { id: number }) => u.id)).toContain(tenant.userId);
    expect(users.body.users.map((u: { id: number }) => u.id)).not.toContain(other.userId);

    const refused = await request(app).post('/api/import/settings').send({ settings: { import_user_id: String(other.userId) } }).expect(400);
    expect(refused.body).toMatchObject({ code: 'VALIDATION_ERROR', error: 'import_user_id must be someone with access to this tenant' });
    await request(app).post('/api/import/settings').send({ settings: { import_user_id: String(tenant.userId) } }).expect(200);
  });

  it('refuses a single-account sync of an account not linked to the bank, or not the ledger’s', async () => {
    const sync = vi.spyOn(importService, 'runSingleAccountSync');
    for (const uuid of [unlinked, '00000000-0000-0000-0000-000000000000']) {
      const res = await request(app).post(`/api/import/sync/${uuid}`).expect(404);
      expect(res.body).toEqual({
        error: 'Account not found or not linked to bank import',
        code: 'NOT_FOUND',
        message: 'Account not found or not linked to bank import',
      });
    }
    expect(sync).not.toHaveBeenCalled();
  });

  const accountSet = (): SimplefinAccountSet =>
    ({
      errlist: [],
      connections: [{ conn_id: 'CON-1', name: 'Bank', org_name: 'First Bank' }],
      accounts: [
        {
          id: linked.importId,
          name: 'Bank checking',
          conn_id: 'CON-1',
          currency: 'USD',
          balance: '10.00',
          'balance-date': Math.floor(Date.now() / 1000) - 3600,
          transactions: [{ id: 't1', posted: 1_700_000_000, amount: '1.00', description: 'x' }],
        },
        { id: 'ACT-unlinked', name: 'Old savings', currency: 'USD', balance: '5.00', 'balance-date': Math.floor(Date.now() / 1000) - 20 * 86_400 },
      ],
    }) as unknown as SimplefinAccountSet;

  it('lists the SimpleFin accounts with the ledger account linked to each, and how fresh each is', async () => {
    vi.spyOn(importService, 'fetchAccounts').mockResolvedValue(accountSet());
    const res = await request(app).get('/api/import/simplefin-accounts').expect(200);
    expect(res.body.accounts).toEqual([
      expect.objectContaining({
        simplefin_account_id: linked.importId,
        simplefin_org: 'First Bank',
        nuggets_account_name: 'Linked checking',
        status: 'Connected',
        last_transaction_date: new Date(1_700_000_000 * 1000).toISOString(),
      }),
      expect.objectContaining({ simplefin_account_id: 'ACT-unlinked', nuggets_account_name: null, status: 'Disconnected', last_transaction_date: null }),
    ]);
  });

  // An account a bridge answered without a connection, naming its institution in
  // protocol v1's per-account org, is named by it; one with a connection, by the connection.
  it("names a v1 account's institution from its org, and a connection's ahead of it", async () => {
    vi.spyOn(importService, 'fetchAccounts').mockResolvedValue({
      errlist: [],
      connections: [{ conn_id: 'CON-1', name: 'Bank', org_id: 'O-1', sfin_url: 'https://bridge.example' }],
      accounts: [
        { id: 'ACT-v1', name: 'v1 checking', currency: 'USD', balance: '1.00', 'balance-date': Math.floor(Date.now() / 1000), org: { domain: 'oldbank.example', name: 'Old Bank', 'sfin-url': 'https://bridge.example' } },
        { id: 'ACT-both', name: 'Both', conn_id: 'CON-1', currency: 'USD', balance: '2.00', 'balance-date': Math.floor(Date.now() / 1000), org: { name: 'Org name' } },
        { id: 'ACT-none', name: 'Neither', currency: 'USD', balance: '3.00', 'balance-date': Math.floor(Date.now() / 1000) },
      ],
    } as unknown as SimplefinAccountSet);
    const res = await request(app).get('/api/import/simplefin-accounts').expect(200);
    expect(res.body.accounts.map((a: { simplefin_account_id: string; simplefin_org: string | null }) => [a.simplefin_account_id, a.simplefin_org])).toEqual([
      ['ACT-v1', 'Old Bank'],
      ['ACT-both', 'Bank'],
      ['ACT-none', null],
    ]);
  });

  it("answers a SimpleFin accounts failure as the route wrapper's 500, without its text", async () => {
    vi.spyOn(importService, 'fetchAccounts').mockRejectedValue(new Error('socket hang up at bridge.simplefin.secret'));
    for (const url of ['/api/import/simplefin-accounts', `/api/import/simplefin-account-transactions?account_id=${linked.importId}`]) {
      const res = await request(app).get(url).expect(500);
      expect(res.body).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  it("checks the drill-down's query, and answers an account SimpleFin didn't send 404", async () => {
    const fetch = vi.spyOn(importService, 'fetchAccounts').mockResolvedValue(accountSet());
    const missing = await request(app).get('/api/import/simplefin-account-transactions').expect(400);
    expect(missing.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'account_id is required' });
    expect(fetch).not.toHaveBeenCalled();

    const gone = await request(app).get('/api/import/simplefin-account-transactions?account_id=ACT-gone').expect(404);
    expect(gone.body).toMatchObject({ code: 'NOT_FOUND', error: 'Account not found in SimpleFin response', accountId: 'ACT-gone' });

    const found = await request(app).get(`/api/import/simplefin-account-transactions?account_id=${linked.importId}&days=500`).expect(200);
    expect(found.body).toMatchObject({ success: true, days: 365, account: { id: linked.importId, org: 'First Bank' } });
    expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: linked.importId, includePending: true }));
  });
});
