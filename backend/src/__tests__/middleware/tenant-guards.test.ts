import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Response, NextFunction } from 'express';
import type { TenantRequest } from '../../middleware/tenant.js';

/**
 * The tenant guards' refusals the other tests don't reach (tenant-middleware.test.ts and
 * resolveTenant.test.ts cover the access rules): a request without a user, the
 * organization-admin guard, and a lookup that fails, which answers a generic 500 without
 * the error's text. The database and the membership rules are stubbed.
 */

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  failDb: false,
  isDeploymentAdmin: null as unknown as Mock,
  loadTenantAccess: null as unknown as Mock,
}));

vi.mock('../../db.js', () => {
  const builder: object = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'executeTakeFirst' || prop === 'execute') {
          return () => (state.failDb ? Promise.reject(new Error('relation "sessions" is locked (internal detail)')) : Promise.resolve(state.rows.shift()));
        }
        return () => builder;
      },
    }
  );
  return { default: {}, db: { selectFrom: () => builder, updateTable: () => builder } };
});

vi.mock('../../services/MembershipService.js', () => ({
  userIsDeploymentAdmin: (...args: unknown[]) => state.isDeploymentAdmin(...args),
  loadTenantAccess: (...args: unknown[]) => state.loadTenantAccess(...args),
}));

const tenant = await import('../../middleware/tenant.js');

type Body = { error?: string; code?: string };
function mockRes() {
  const res = {} as Response & { statusCode?: number; body?: Body };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: Body) => {
    res.body = body;
    return res;
  });
  return res;
}

async function run(guard: (req: TenantRequest, res: Response, next: NextFunction) => unknown, fields: Partial<TenantRequest> = {}) {
  const req = { headers: {}, ...fields } as TenantRequest;
  const res = mockRes();
  const next = vi.fn() as NextFunction;
  await guard(req, res, next);
  return { req, res, next };
}

const member = { user: { userId: 42, email: 'member@example.com' } };

beforeEach(() => {
  state.rows = [];
  state.failDb = false;
  state.isDeploymentAdmin = vi.fn(async () => false);
  state.loadTenantAccess = vi.fn(async () => ({ hasAccess: true, tenantIsAdmin: false, orgId: 3, orgIsAdmin: false }));
});

describe('a request without a signed-in user', () => {
  it.each([
    ['resolveTenant', tenant.resolveTenant],
    ['requireTenantMember', tenant.requireTenantMember],
    ['requireTenantAdmin', tenant.requireTenantAdmin],
    ['requireOrgAdmin', tenant.requireOrgAdmin],
    ['requireDeploymentAdmin', tenant.requireDeploymentAdmin],
  ] as const)('%s answers 401 AUTH_REQUIRED and goes no further', async (_name, guard) => {
    const { res, next } = await run(guard);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    expect(next).not.toHaveBeenCalled();
    expect(state.isDeploymentAdmin).not.toHaveBeenCalled();
    expect(state.loadTenantAccess).not.toHaveBeenCalled();
  });

  it('is no deployment admin', async () => {
    expect(await tenant.isDeploymentAdminRequest({ headers: {} } as TenantRequest)).toBe(false);
    expect(state.isDeploymentAdmin).not.toHaveBeenCalled();
  });
});

describe('requireOrgAdmin', () => {
  it('400 without an organization, 403 for a member, and lets an organization admin through', async () => {
    let { res, next } = await run(tenant.requireOrgAdmin, member);
    expect(res.statusCode).toBe(400);
    expect(res.body?.code).toBe('NO_ACTIVE_ORG');
    expect(next).not.toHaveBeenCalled();

    ({ res, next } = await run(tenant.requireOrgAdmin, { ...member, org: { id: 3, isAdmin: false } }));
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('ORG_ADMIN_REQUIRED');
    expect(next).not.toHaveBeenCalled();

    ({ res, next } = await run(tenant.requireOrgAdmin, { ...member, org: { id: 3, isAdmin: true } }));
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });
});

describe('isDeploymentAdminRequest', () => {
  it("takes resolveTenant's answer when it has one, and looks it up otherwise", async () => {
    expect(await tenant.isDeploymentAdminRequest({ ...member, isDeploymentAdmin: false } as TenantRequest)).toBe(false);
    expect(state.isDeploymentAdmin).not.toHaveBeenCalled();
    state.isDeploymentAdmin = vi.fn(async () => true);
    expect(await tenant.isDeploymentAdminRequest({ ...member } as TenantRequest)).toBe(true);
    expect(state.isDeploymentAdmin).toHaveBeenCalledWith(42);
  });
});

describe('a lookup that fails', () => {
  it('resolveTenant answers 500 TENANT_RESOLVE_ERROR, without the error', async () => {
    state.failDb = true;
    const { res, next } = await run(tenant.resolveTenant, { ...member, session: { id: 10, needsRotation: false } });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Tenant resolution failed', code: 'TENANT_RESOLVE_ERROR' });
  });

  it('requireTenantMember answers 500 TENANT_AUTH_ERROR, without the error', async () => {
    state.loadTenantAccess = vi.fn(async () => {
      throw new Error('organizations row locked (internal detail)');
    });
    const { res, next } = await run(tenant.requireTenantMember, { ...member, activeTenantId: 7 });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Tenant authorization failed', code: 'TENANT_AUTH_ERROR' });
  });

  // It answered a 500 AUTH_CHECK_ERROR of its own; the error handler answers it now.
  it('requireDeploymentAdmin passes the error on to the error handler, answering nothing itself', async () => {
    const failure = new Error('deployment_users unreadable (internal detail)');
    state.isDeploymentAdmin = vi.fn(async () => {
      throw failure;
    });
    const { res, next } = await run(tenant.requireDeploymentAdmin, member);
    expect(next).toHaveBeenCalledExactlyOnceWith(failure);
    expect(res.statusCode).toBeUndefined();
  });
});

describe('resolveTenant', () => {
  it('takes the sole ledger of a user with one and no session ledger, and records whether they are a deployment admin', async () => {
    state.isDeploymentAdmin = vi.fn(async () => true);
    // The session row has no active ledger; the user's memberships: one.
    state.rows = [{ active_tenant_id: null }, [{ tenant_id: 9 }]];
    const { req, next } = await run(tenant.resolveTenant, { ...member, session: { id: 10, needsRotation: false } });
    expect(next).toHaveBeenCalledOnce();
    expect(req.activeTenantId).toBe(9);
    expect(req.isDeploymentAdmin).toBe(true);
  });
});
