import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import globalPool from '../db.js';
import * as importServiceModule from '../services/ImportService.js';

// Read from the module when used, so this file also runs (and fails) against code without them.
const SYNC_FAILED_REASON = () => importServiceModule.SYNC_FAILED_REASON;
import { createImportRoutes } from '../routes/import.js';
import { AccountSyncer } from '../services/import/AccountSyncer.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import type { TenantRequest } from '../middleware/tenant.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { ImportService } from '../services/ImportService.js';

/**
 * The bank import answered, and kept in the sync log every member can read, the text of
 * whatever failed: a database error's included. What SimpleFin did (refused the
 * token, timed out, answered garbage) is written for people and kept; anything else is a
 * generic reason, with the details in the server log. The SimpleFin failures are a 5xx
 * of their own (502/503/504), not a 500.
 *
 * SimpleFin's HTTP answers are stubbed at `fetch`, as in importSync.test.ts.
 */

vi.mock('../services/OrganizationSimpleFinService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/OrganizationSimpleFinService.js')>();
  return {
    ...actual,
    getAccessUrlForTenant: vi.fn(async () => 'https://user:secret@bridge.simplefin.org/simplefin'),
  };
});

const lifecycleStub = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async () => undefined) }) as unknown as ApplicationLifecycleService;
const SECRET = 'internal_secret_xyz'; // gitleaks:allow (made-up)
const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('Bank import failures, answered and logged without internal text', () => {
  let tenant: TestTenant;
  let app: Express;
  let account: { id: number; uuid: string; importId: string };

  const lastSyncLog = async () =>
    (await tenant.pool.query('SELECT sync_status, error_message FROM import_sync_log ORDER BY id DESC LIMIT 1')).rows[0];

  beforeAll(async () => {
    tenant = await createTestTenant('Import error text');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use((req, _res, next) => {
      (req as TenantRequest).org = { id: tenant.organizationId, isAdmin: true };
      next();
    });
    app.use('/api/import', createImportRoutes({ lifecycleService: lifecycleStub, importService: new ImportService(globalPool) }));

    const importId = `SF-errors-${stamp}`;
    const row = (
      await tenant.pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                               import_auto_assign_budget_period, import_auto_assign_budget_item)
         VALUES ('Errors checking', 'checking', 'cash', 'Asset', $1, 'simplefin', true, false, false) RETURNING id, uuid`,
        [importId]
      )
    ).rows[0];
    account = { id: row.id, uuid: row.uuid, importId };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const simplefinAnswers = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));

  it('answers a database error in a single-account sync with a generic reason, and logs that', async () => {
    simplefinAnswers(200, {
      errlist: [],
      connections: [],
      accounts: [{ id: account.importId, name: 'Bank account', currency: 'USD', balance: '0.00', 'balance-date': Math.floor(Date.now() / 1000), transactions: [] }],
    });
    vi.spyOn(AccountSyncer.prototype, 'syncAccount').mockRejectedValueOnce(
      Object.assign(new Error(`duplicate key value violates unique constraint "${SECRET}"`), { code: '23505' })
    );
    const res = await request(app).post(`/api/import/sync/${account.uuid}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: false, error: SYNC_FAILED_REASON() });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(await lastSyncLog()).toEqual({ sync_status: 'failed', error_message: SYNC_FAILED_REASON() });
  });

  it("answers SimpleFin's refusal as a 502 that says so, not the 500 with the error's text", async () => {
    simplefinAnswers(403, { error: 'forbidden' });
    const res = await request(app).get('/api/import/simplefin-accounts');
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      code: 'SIMPLEFIN_ACCESS_DENIED',
      error: 'Access denied. SimpleFin token may have been revoked or expired.',
    });
  });

  it("keeps SimpleFin's own failure, in words for people, in a full sync's log", async () => {
    simplefinAnswers(500, { error: 'upstream' });
    const res = await request(app).post('/api/import/sync');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SIMPLEFIN_ERROR');
    expect(await lastSyncLog()).toEqual({ sync_status: 'failed', error_message: 'SimpleFin answered HTTP 500' });
  });

  it('types the SimpleFin failures', () => {
    const err = new importServiceModule.SimpleFinUpstreamError(504, 'SIMPLEFIN_TIMEOUT', 'Connection timeout', { cause: new Error('inner') });
    expect(err).toMatchObject({ status: 504, code: 'SIMPLEFIN_TIMEOUT', message: 'Connection timeout' });
    expect((err.cause as Error).message).toBe('inner');
  });
});
