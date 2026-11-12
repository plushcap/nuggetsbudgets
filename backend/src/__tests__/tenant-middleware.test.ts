import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Response, NextFunction } from 'express';

// Chainable Kysely stub draining a per-test results queue (one entry per
// executeTakeFirst, in call order). execute() returns [] unless queued.
const { takeFirstQueue, builder, updateTableSpy } = vi.hoisted(() => {
  const takeFirstQueue: unknown[] = [];
  const builder: object = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'executeTakeFirst') return () => Promise.resolve(takeFirstQueue.shift());
        if (prop === 'execute') return () => Promise.resolve([]);
        return () => builder;
      },
    }
  );
  const updateTableSpy = vi.fn(() => builder);
  return { takeFirstQueue, builder, updateTableSpy };
});

vi.mock('../db.js', () => ({
  default: {},
  db: { selectFrom: () => builder, updateTable: updateTableSpy },
}));

import {
  requireTenantMember,
  requireTenantAdmin,
  requireDeploymentAdmin,
  type TenantRequest,
} from '../middleware/tenant.js';

/** The error body the middleware answers with. */
type ErrorBody = { error?: string; code?: string };

function mockRes() {
  const res = {} as Response & { statusCode?: number; body?: ErrorBody };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: ErrorBody) => {
    res.body = body;
    return res;
  });
  return res;
}

beforeEach(() => {
  takeFirstQueue.length = 0;
  updateTableSpy.mockClear();
});

describe('requireTenantAdmin (pure)', () => {
  it('allows a budget admin', () => {
    const req = { user: { userId: 1 }, tenant: { id: 5, isAdmin: true } } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    requireTenantAdmin(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it('rejects a non-admin with 403', () => {
    const req = { user: { userId: 1 }, tenant: { id: 5, isAdmin: false } } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    requireTenantAdmin(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('TENANT_ADMIN_REQUIRED');
  });

  it('400 when no active budget is set', () => {
    const req = { user: { userId: 1 } } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    requireTenantAdmin(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res.body?.code).toBe('NO_ACTIVE_TENANT');
  });
});

describe('requireDeploymentAdmin', () => {
  it('allows when a deployment_users admin row exists', async () => {
    takeFirstQueue.push({ id: 1 });
    const req = { user: { userId: 1 } } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await requireDeploymentAdmin(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.isDeploymentAdmin).toBe(true);
  });

  it('rejects with 403 when there is no admin row', async () => {
    takeFirstQueue.push(undefined);
    const req = { user: { userId: 1 } } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await requireDeploymentAdmin(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('DEPLOYMENT_ADMIN_REQUIRED');
  });

  it('short-circuits the query when req.isDeploymentAdmin is already true', async () => {
    const req = { user: { userId: 1 }, isDeploymentAdmin: true } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await requireDeploymentAdmin(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('requireTenantMember', () => {
  // loadTenantAccess query order: tenants⋈organizations (selects orgId +
  // tenantStatus + orgStatus), then [tenant_users, organization_users].
  it('grants a plain budget member access and enters context', async () => {
    takeFirstQueue.push({ orgId: 9, tenantStatus: 'active', orgStatus: 'active' }); // tenants
    takeFirstQueue.push({ is_admin: false }); // tenant_users (member)
    takeFirstQueue.push(undefined); // organization_users (none)
    const req = { user: { userId: 1 }, activeTenantId: 5, isDeploymentAdmin: false } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await requireTenantMember(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.tenant).toEqual({ id: 5, isAdmin: false });
    expect(req.org).toEqual({ id: 9, isAdmin: false });
  });

  it('marks the member as budget admin when tenant_users.is_admin', async () => {
    takeFirstQueue.push({ orgId: 9, tenantStatus: 'active', orgStatus: 'active' });
    takeFirstQueue.push({ is_admin: true });
    takeFirstQueue.push(undefined);
    const req = { user: { userId: 1 }, activeTenantId: 5, isDeploymentAdmin: false } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await requireTenantMember(req, res, next);
    expect(req.tenant).toEqual({ id: 5, isAdmin: true });
  });

  it('grants org admins access to any budget in their org (no tenant_users row needed)', async () => {
    takeFirstQueue.push({ orgId: 9, tenantStatus: 'active', orgStatus: 'active' });
    takeFirstQueue.push(undefined); // no tenant membership
    takeFirstQueue.push({ is_admin: true }); // org admin
    const req = { user: { userId: 1 }, activeTenantId: 5, isDeploymentAdmin: false } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await requireTenantMember(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.tenant).toEqual({ id: 5, isAdmin: true });
    expect(req.org).toEqual({ id: 9, isAdmin: true });
  });

  it('403 when the user has no access to the budget', async () => {
    takeFirstQueue.push({ orgId: 9, tenantStatus: 'active', orgStatus: 'active' });
    takeFirstQueue.push(undefined);
    takeFirstQueue.push(undefined);
    const req = { user: { userId: 1 }, activeTenantId: 5, isDeploymentAdmin: false } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await requireTenantMember(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('TENANT_FORBIDDEN');
  });

  it('clears a stale active_tenant_id from the browser session on denial', async () => {
    takeFirstQueue.push({ orgId: 9, tenantStatus: 'active', orgStatus: 'active' });
    takeFirstQueue.push(undefined); // no tenant membership
    takeFirstQueue.push(undefined); // no org admin → access denied
    const req = {
      user: { userId: 1 },
      activeTenantId: 5,
      isDeploymentAdmin: false,
      session: { id: 'sess-1' },
    } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await requireTenantMember(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('TENANT_FORBIDDEN');
    // Stale session pointer cleared so the next request falls through to the picker.
    expect(updateTableSpy).toHaveBeenCalledWith('sessions');
  });

  it('does not touch the session on denial for token auth (no session)', async () => {
    takeFirstQueue.push({ orgId: 9, tenantStatus: 'active', orgStatus: 'active' });
    takeFirstQueue.push(undefined);
    takeFirstQueue.push(undefined);
    const req = { user: { userId: 1 }, activeTenantId: 5, isDeploymentAdmin: false } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await requireTenantMember(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(updateTableSpy).not.toHaveBeenCalled();
  });

  it('fails closed (403) when the budget is suspended', async () => {
    // Only the tenants⋈organizations row is consumed; the status gate returns
    // before the membership lookups.
    takeFirstQueue.push({ orgId: 9, tenantStatus: 'suspended', orgStatus: 'active' });
    const req = { user: { userId: 1 }, activeTenantId: 5, isDeploymentAdmin: true } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await requireTenantMember(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('TENANT_FORBIDDEN');
  });

  it('400 when no active tenant was resolved', async () => {
    const req = { user: { userId: 1 }, activeTenantId: null } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await requireTenantMember(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res.body?.code).toBe('NO_ACTIVE_TENANT');
  });
});
