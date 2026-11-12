import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Response, NextFunction } from 'express';

// Chainable Kysely stub draining a per-test results queue (one entry per
// executeTakeFirst, in call order). execute() returns [] unless overridden.
const { takeFirstQueue, builder } = vi.hoisted(() => {
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
  return { takeFirstQueue, builder };
});

vi.mock('../db.js', () => ({ default: {}, db: { selectFrom: () => builder } }));
// resolveTenant calls userIsDeploymentAdmin (globalDb) up front; stub it so the
// test exercises only the tenant-resolution branches.
vi.mock('../services/MembershipService.js', () => ({
  userIsDeploymentAdmin: vi.fn().mockResolvedValue(false),
}));

import { resolveTenant, type TenantRequest } from '../middleware/tenant.js';

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
});

describe('resolveTenant — Bearer/MCP tenant claim (Phase 6)', () => {
  it('uses the token tenant claim when there is no browser session', async () => {
    const req = { user: { userId: 1 }, tokenTenantId: 7 } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await resolveTenant(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.activeTenantId).toBe(7);
  });

  it('prefers the browser session active tenant over a token claim', async () => {
    takeFirstQueue.push({ active_tenant_id: 5 }); // sessions lookup
    const req = { user: { userId: 1 }, session: { id: 99 }, tokenTenantId: 7 } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await resolveTenant(req, res, next);
    expect(req.activeTenantId).toBe(5);
  });

  it('leaves activeTenantId null with no session, no claim, and no sole membership', async () => {
    const req = { user: { userId: 1 } } as unknown as TenantRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await resolveTenant(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.activeTenantId).toBeNull();
  });
});
