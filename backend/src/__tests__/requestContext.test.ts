import { describe, it, expect } from 'vitest';
import {
  runWithRequestContext,
  getRequestContext,
  getCurrentUserId,
  getCurrentTenantId,
  isDeploymentAdminContext,
} from '../context/requestContext.js';

describe('requestContext (AsyncLocalStorage)', () => {
  it('exposes the context and accessors inside runWithRequestContext', () => {
    const out = runWithRequestContext(
      { userId: 7, tenantId: 3, isDeploymentAdmin: false },
      () => ({
        ctx: getRequestContext(),
        userId: getCurrentUserId(),
        tenantId: getCurrentTenantId(),
        deploy: isDeploymentAdminContext(),
      })
    );
    expect(out.ctx).toEqual({ userId: 7, tenantId: 3, isDeploymentAdmin: false });
    expect(out.userId).toBe(7);
    expect(out.tenantId).toBe(3);
    expect(out.deploy).toBe(false);
  });

  it('returns undefined / defaults outside any context', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(getCurrentUserId()).toBeUndefined();
    expect(getCurrentTenantId()).toBeUndefined();
    expect(isDeploymentAdminContext()).toBe(false);
  });

  it('distinguishes "no budget selected" (null) from "no context" (undefined)', () => {
    const tid = runWithRequestContext(
      { userId: 1, tenantId: null, isDeploymentAdmin: true },
      () => getCurrentTenantId()
    );
    expect(tid).toBeNull();
    expect(getCurrentTenantId()).toBeUndefined();
  });

  it('isolates concurrent async contexts (no bleed across requests)', async () => {
    const run = (userId: number, tenantId: number, delay: number) =>
      runWithRequestContext({ userId, tenantId, isDeploymentAdmin: false }, async () => {
        await new Promise((r) => setTimeout(r, delay));
        return getRequestContext();
      });

    const [a, b] = await Promise.all([run(1, 10, 20), run(2, 20, 5)]);
    expect(a).toEqual({ userId: 1, tenantId: 10, isDeploymentAdmin: false });
    expect(b).toEqual({ userId: 2, tenantId: 20, isDeploymentAdmin: false });
    expect(getRequestContext()).toBeUndefined();
  });
});
