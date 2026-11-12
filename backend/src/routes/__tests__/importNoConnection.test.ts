import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import pool from '../../db.js';
import { createImportRoutes } from '../import.js';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';
import type { TenantRequest } from '../../middleware/tenant.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { ImportService } from '../../services/ImportService.js';

const lifecycleStub = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async () => undefined) }) as unknown as ApplicationLifecycleService;

/**
 * An organization that hasn't connected SimpleFin is a setup step, not a server error:
 * the import routes that need the connection answer 404 NO_SIMPLEFIN_CONNECTION.
 */
describe('Import routes without a SimpleFin connection', () => {
  let tenant: TestTenant;
  let app: Express;

  beforeAll(async () => {
    tenant = await createTestTenant('Import without a connection');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use((req, _res, next) => {
      (req as TenantRequest).org = { id: tenant.organizationId, isAdmin: true };
      next();
    });
    app.use('/api/import', createImportRoutes({ lifecycleService: lifecycleStub, importService: new ImportService(pool) }));
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it.each([
    ['post', '/api/import/sync'],
    ['get', '/api/import/accounts'],
    ['post', '/api/import/test-sync'],
    ['get', '/api/import/simplefin-accounts'],
    ['get', '/api/import/simplefin-account-transactions?account_id=ACT-1'],
  ] as const)('%s %s answers 404', async (method, url) => {
    const res = await request(app)[method](url);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_SIMPLEFIN_CONNECTION');
  });
});
