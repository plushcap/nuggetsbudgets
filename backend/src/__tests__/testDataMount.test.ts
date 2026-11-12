import { describe, it, expect, afterEach, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { config } from '../config.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';

// Without a database: a request with this header is a signed-in deployment admin, any
// other is refused as the real guard refuses it. The test-data routes sit under /api/admin,
// whose other routes need a deployment admin, so "not there" is what that admin gets: a
// 404, where the mounted routes would go on to resolve the ledger (here a 418 marker).
const ADMIN_HEADER = 'x-test-deployment-admin';
vi.mock('../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.js')>();
  const signIn = (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers[ADMIN_HEADER]) {
      res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      return;
    }
    req.user = { userId: 1, email: 'admin@test.local' };
    next();
  };
  return { ...actual, authenticateToken: signIn, authenticateSession: signIn };
});
vi.mock('../middleware/tenant.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/tenant.js')>()),
  requireDeploymentAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  resolveTenant: (_req: Request, res: Response) => {
    res.status(418).json({ code: 'REACHED_A_LEDGER_ROUTE' });
  },
}));

const lifecycleStub = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async () => undefined) }) as unknown as ApplicationLifecycleService;

// The OneDrive routes need a key to construct; CI has no data-encryption secret.
process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);

const appFor = (settings?: Partial<ReturnType<typeof config>>) => {
  const app = createApp();
  mountRoutes(app, { lifecycleService: lifecycleStub, ...(settings ? { config: { ...config(), ...settings } } : {}) });
  return app;
};
const clearAll = (app: ReturnType<typeof appFor>) => request(app).delete('/api/admin/test-data/clear-all');
const asAdmin = async (app: ReturnType<typeof appFor>) => (await clearAll(app).set(ADMIN_HEADER, '1')).status;
const MOUNTED = 418;

/**
 * The test-data generator's clear-all deletes every account, transaction and budget in
 * the active ledger, so a production server doesn't mount it unless asked.
 */
describe('The test-data routes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('are not there in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(await asAdmin(appFor())).toBe(404);
    // Anyone else is refused first.
    expect((await clearAll(appFor())).status).toBe(401);
  });

  it('are there in production with ENABLE_TEST_DATA=true, and outside production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_TEST_DATA', 'true');
    expect(await asAdmin(appFor())).toBe(MOUNTED);
    expect((await clearAll(appFor())).status).toBe(401);
    vi.unstubAllEnvs();
    expect(await asAdmin(appFor())).toBe(MOUNTED);
    expect((await clearAll(appFor())).status).toBe(401);
  });

  it('follow the settings mountRoutes is given, over the environment', async () => {
    expect(await asAdmin(appFor({ NODE_ENV: 'production', ENABLE_TEST_DATA: false }))).toBe(404);
    vi.stubEnv('NODE_ENV', 'production');
    expect(await asAdmin(appFor({ NODE_ENV: 'production', ENABLE_TEST_DATA: true }))).toBe(MOUNTED);
    expect(await asAdmin(appFor({ NODE_ENV: 'development' }))).toBe(MOUNTED);
  });
});
