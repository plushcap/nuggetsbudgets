/**
 * Tenant-context & authorization middleware.
 *
 * These compose with `authenticateToken` (which sets `req.user`) to resolve the
 * active tenant and enforce the access hierarchy:
 *
 *   Deployment Admin  ⊇  Org Admin (of the tenant's org)  ⊇  Tenant Admin  ⊇  Member
 *
 * Every tenant-scoped router is mounted behind `resolveTenant` + `requireTenantMember`
 * (routes.ts), and its handlers run their database work in that tenant's `withTenant`
 * transaction (tenantHandler), under RLS. Admin routes add `requireTenantAdmin`,
 * `requireOrgAdmin` or `requireDeploymentAdmin`.
 */

import { Response, NextFunction } from 'express';
import { db } from '../db.js';
import type { AuthenticatedRequest } from './auth.js';
import { runWithRequestContext } from '../context/requestContext.js';
import { createLogger } from '../utils/logger.js';
import { loadTenantAccess, userIsDeploymentAdmin } from '../services/MembershipService.js';

const logger = createLogger({ service: 'TenantMiddleware' });

/** Request augmented with the resolved tenant/organization context. */
export interface TenantRequest extends AuthenticatedRequest {
  /** Active tenant id resolved from session / claim / sole-membership (may be null). */
  activeTenantId?: number | null;
  /** Deployment admin (deployment_users.role = 'admin'). */
  isDeploymentAdmin?: boolean;
  /** Set once tenant access is verified by `requireTenantMember`. */
  tenant?: { id: number; isAdmin: boolean };
  /** Organization that owns the active tenant (set alongside `tenant`). */
  org?: { id: number; isAdmin: boolean };
}

// The deployment-admin check (`userIsDeploymentAdmin`) and the tenant access rule
// (`loadTenantAccess`) live in MembershipService so the per-request gate here and
// the management endpoints (e.g. the budget switcher in auth.ts) enforce the
// identical rule. `loadTenantAccess` also fails closed on suspended/deleted
// budgets and organizations. See the import above.

/**
 * Resolve the active tenant for the request (no enforcement): session's
 * `active_tenant_id`, else (Bearer/MCP JWT tenant claim — Phase 6), else the
 * user's sole tenant membership. Stashes `req.activeTenantId` and
 * `req.isDeploymentAdmin`.
 */
export const resolveTenant = async (req: TenantRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    const userId = req.user.userId;
    req.isDeploymentAdmin = await userIsDeploymentAdmin(userId);

    let tenantId: number | null = null;
    if (req.session?.id) {
      const session = await db
        .selectFrom('sessions')
        .select('active_tenant_id')
        .where('id', '=', req.session.id)
        .executeTakeFirst();
      tenantId = session?.active_tenant_id ?? null;
    }
    // Bearer/MCP tokens carry their ledger as a `tenantId` claim (Phase 6),
    // stashed on req by authenticateSession. Honor it for token-auth requests
    // (which have no browser session); requireTenantMember still re-validates.
    if (tenantId == null && req.tokenTenantId != null) {
      tenantId = req.tokenTenantId;
    }
    if (tenantId == null) {
      const memberships = await db
        .selectFrom('tenant_users')
        .select('tenant_id')
        .where('user_id', '=', userId)
        .limit(2)
        .execute();
      const [only, another] = memberships;
      if (only && !another) tenantId = only.tenant_id;
    }

    req.activeTenantId = tenantId;
    return next();
  } catch (err) {
    logger.error({ err }, 'resolveTenant failed');
    return res.status(500).json({ error: 'Tenant resolution failed', code: 'TENANT_RESOLVE_ERROR' });
  }
};

/**
 * Require that the user may access the active tenant, then enter the per-request
 * AsyncLocalStorage context for downstream handlers/DB helpers. Must run after
 * `resolveTenant`.
 */
export const requireTenantMember = async (req: TenantRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    const tenantId = req.activeTenantId ?? null;
    if (tenantId == null) {
      return res.status(400).json({ error: 'No active tenant selected', code: 'NO_ACTIVE_TENANT' });
    }

    const access = await loadTenantAccess(req.user.userId, tenantId, req.isDeploymentAdmin ?? false);
    if (!access || !access.hasAccess) {
      logger.warn({ userId: req.user.userId, tenantId }, 'Tenant access denied');
      // Self-heal a stale browser session: the active budget it points to is gone
      // (deleted/suspended) or access was revoked. Clear it so the next request
      // resolves to no active tenant (400 NO_ACTIVE_TENANT) and the client shows
      // the ledger picker instead of looping on 403s. Token auth has no session.
      if (req.session?.id) {
        await db
          .updateTable('sessions')
          .set({ active_tenant_id: null })
          .where('id', '=', req.session.id)
          .execute();
      }
      return res.status(403).json({ error: 'No access to this tenant', code: 'TENANT_FORBIDDEN' });
    }

    req.tenant = { id: tenantId, isAdmin: access.tenantIsAdmin };
    req.org = { id: access.orgId, isAdmin: access.orgIsAdmin };

    return runWithRequestContext(
      { userId: req.user.userId, tenantId, isDeploymentAdmin: req.isDeploymentAdmin ?? false },
      () => next()
    );
  } catch (err) {
    logger.error({ err }, 'requireTenantMember failed');
    return res.status(500).json({ error: 'Tenant authorization failed', code: 'TENANT_AUTH_ERROR' });
  }
};

/** Require tenant-admin on the active budget (tenant admin, org admin, or deployment admin). */
export const requireTenantAdmin = (req: TenantRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (!req.tenant) {
    return res.status(400).json({ error: 'No active tenant selected', code: 'NO_ACTIVE_TENANT' });
  }
  if (!req.tenant.isAdmin) {
    logger.warn({ userId: req.user.userId, tenantId: req.tenant.id }, 'Tenant admin access denied');
    return res.status(403).json({ error: 'Tenant admin required', code: 'TENANT_ADMIN_REQUIRED' });
  }
  return next();
};

/** Require org-admin of the active tenant's organization (or deployment admin). */
export const requireOrgAdmin = (req: TenantRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (!req.org) {
    return res.status(400).json({ error: 'No active organization', code: 'NO_ACTIVE_ORG' });
  }
  if (!req.org.isAdmin) {
    logger.warn({ userId: req.user.userId, orgId: req.org.id }, 'Org admin access denied');
    return res.status(403).json({ error: 'Organization admin required', code: 'ORG_ADMIN_REQUIRED' });
  }
  return next();
};

/**
 * Whether the signed-in user is a deployment admin: what `resolveTenant` found, else
 * deployment_users. The check {@link requireDeploymentAdmin} makes, for a route that needs
 * it for only part of what it does.
 */
export async function isDeploymentAdminRequest(req: TenantRequest): Promise<boolean> {
  if (!req.user) return false;
  return req.isDeploymentAdmin ?? (await userIsDeploymentAdmin(req.user.userId));
}

/** Require a deployment-admin role (deployment_users.role='admin'). */
export const requireDeploymentAdmin = async (req: TenantRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    const isAdmin = await isDeploymentAdminRequest(req);
    if (!isAdmin) {
      logger.warn({ userId: req.user.userId }, 'Deployment admin access denied');
      return res.status(403).json({ error: 'Deployment admin required', code: 'DEPLOYMENT_ADMIN_REQUIRED' });
    }
    req.isDeploymentAdmin = true;
    return next();
  } catch (err) {
    // To the error handler, which logs it and answers 500 INTERNAL_ERROR, as any failure.
    return next(err);
  }
};
