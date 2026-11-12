import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const { fakeDb, bootstrapFirstAdmin } = vi.hoisted(() => {
  // A query builder whose every call chains on and whose execute* resolves to `result`.
  const chain = (result: unknown): unknown =>
    new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === 'then'
            ? undefined
            : prop === 'executeTakeFirst' || prop === 'executeTakeFirstOrThrow'
              ? async () => result
              : () => chain(result),
      }
    );
  const user = { id: 1, email: 'first@example.com', first_name: 'First', last_name: '', created_at: new Date() };
  return {
    // No users yet, so setup-admin goes on to create the first one.
    fakeDb: {
      selectFrom: () => chain({ count: '0' }),
      transaction: () => ({ execute: async (fn: (trx: unknown) => unknown) => fn({ insertInto: () => chain(user) }) }),
    },
    bootstrapFirstAdmin: vi.fn(),
  };
});
vi.mock('../../db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db.js')>()),
  db: fakeDb,
}));
vi.mock('../../services/DeploymentAdminService.js', () => ({ bootstrapFirstAdmin }));
// The setup token and its lock are covered by setupAdminToken.test.ts; here the token is right.
vi.mock('../../services/SetupTokenService.js', () => ({
  deploymentHasUsers: async () => false,
  setupTokenMatches: async () => true,
  lockFirstRunSetup: async () => undefined,
  clearSetupToken: async () => undefined,
}));

import { createAuthPublicRoutes } from '../auth.js';
import { ControlPlaneError } from '../../services/controlPlaneErrors.js';

/**
 * The first-run bootstrap refuses to create a tenant under ALLOW_RLS_BYPASS_ROLE when one
 * already exists (servingRole.test.ts covers the refusal itself); setup-admin keeps that
 * 409 rather than reporting a server error.
 */
describe('POST /api/auth/setup-admin with a refused bootstrap', () => {
  let app: Express;
  const body = {
    email: 'first@example.com',
    password: 'Very-Strong-Passw0rd!x',
    first_name: 'First',
    setup_token: 'the-token',
  };

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthPublicRoutes());
  });

  afterEach(() => bootstrapFirstAdmin.mockReset());

  it('answers with the refusal', async () => {
    bootstrapFirstAdmin.mockRejectedValue(
      new ControlPlaneError(409, 'TENANT_LIMIT_RLS_BYPASS', 'This deployment runs with ALLOW_RLS_BYPASS_ROLE=true')
    );
    const res = await request(app).post('/api/auth/setup-admin').send(body).expect(409);
    expect(res.body).toMatchObject({ code: 'TENANT_LIMIT_RLS_BYPASS' });
    expect(bootstrapFirstAdmin).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('still reports other failures as a server error', async () => {
    bootstrapFirstAdmin.mockRejectedValue(new Error('connection lost'));
    const res = await request(app).post('/api/auth/setup-admin').send(body).expect(500);
    // The route wrapper's answer for any failure that isn't a refusal (was ADMIN_SETUP_ERROR).
    expect(res.body).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });
});
