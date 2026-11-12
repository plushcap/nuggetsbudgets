import type { Request, Response, NextFunction } from 'express';
import { runWithRequestContext } from '../context/requestContext.js';

/**
 * Test-only middleware that fakes `authenticateToken` + the tenant middleware:
 * sets `req.user` and enters the per-request tenant context so handlers wrapped
 * in `tenantHandler` (and `getDb()`) work under test.
 *
 * Route tests mount routers directly (bypassing routes.ts), so they need this to
 * stand in for `resolveTenant`/`requireTenantMember`. RLS scopes every query to
 * `tenantId`, so pass the test file's own tenant (see `createTestTenant`) rather
 * than a tenant other files also write to.
 */
export function testTenantContext(opts: { userId: number; tenantId: number; isAdmin?: boolean | undefined }) {
  const { userId, tenantId } = opts;
  const isDeploymentAdmin = opts.isAdmin ?? false;
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: unknown }).user = {
      userId,
      email: 'test@example.com',
    };
    runWithRequestContext({ userId, tenantId, isDeploymentAdmin }, () => next());
  };
}
