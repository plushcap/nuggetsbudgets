import { globalDb } from '../db/withTenant.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import type {
  MembershipSummary,
  MemberRole,
  OrganizationStatus,
  OrganizationSummary,
  TenantStatus,
  TenantSummary,
} from '@nuggets/shared';
import { organizationStatus, tenantStatus } from '@nuggets/shared';

/**
 * Shared read-side of the control plane. All queries run on
 * {@link globalDb} — the organization/tenant/membership tables are global (no
 * RLS), so these work with no active budget selected.
 *
 * `loadTenantAccess` + `userIsDeploymentAdmin` are the canonical access rules:
 * the tenant middleware imports them so the per-request gate and the management
 * endpoints (e.g. the budget switcher) agree byte-for-byte.
 */

/** True if the user holds a deployment-admin role (deployment_users.role='admin'). */
export async function userIsDeploymentAdmin(userId: number): Promise<boolean> {
  const row = await globalDb
    .selectFrom('deployment_users')
    .select('id')
    .where('user_id', '=', userId)
    .where('role', '=', 'admin')
    .limit(1)
    .executeTakeFirst();
  return !!row;
}

export interface TenantAccess {
  /** May the user read/write this budget at all? */
  hasAccess: boolean;
  /** Is the user an admin of this budget (tenant admin, org admin, or deployment admin)? */
  tenantIsAdmin: boolean;
  /** Organization that owns the tenant. */
  orgId: number;
  /** Is the user an admin of that organization (org admin or deployment admin)? */
  orgIsAdmin: boolean;
}

/**
 * Resolve a user's access to a budget: access requires a
 * `tenant_users` row, OR org-admin of the budget's organization, OR deployment
 * admin. (A plain org member without a tenant_users row gets no budget access.)
 *
 * Fails closed (returns null) when the budget does not exist OR the budget/org
 * is not `active` (suspended or soft-deleted) — so a suspended org's budgets
 * become inaccessible to everyone.
 */
export async function loadTenantAccess(
  userId: number,
  tenantId: number,
  isDeploymentAdmin: boolean
): Promise<TenantAccess | null> {
  const tenant = await globalDb
    .selectFrom('tenants as t')
    .innerJoin('organizations as o', 'o.id', 't.organization_id')
    .select(['t.organization_id as orgId', 't.status as tenantStatus', 'o.status as orgStatus'])
    .where('t.id', '=', tenantId)
    .executeTakeFirst();
  if (!tenant) return null;
  if (tenant.tenantStatus !== tenantStatus.enum.active || tenant.orgStatus !== organizationStatus.enum.active) return null;

  const orgId = tenant.orgId;
  const [tenantMembership, orgMembership] = await Promise.all([
    globalDb
      .selectFrom('tenant_users')
      .select('is_admin')
      .where('user_id', '=', userId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst(),
    globalDb
      .selectFrom('organization_users')
      .select('is_admin')
      .where('user_id', '=', userId)
      .where('organization_id', '=', orgId)
      .executeTakeFirst(),
  ]);

  const orgIsAdmin = isDeploymentAdmin || !!orgMembership?.is_admin;
  const tenantIsAdmin = orgIsAdmin || !!tenantMembership?.is_admin;
  const hasAccess = orgIsAdmin || !!tenantMembership;
  return { hasAccess, tenantIsAdmin, orgId, orgIsAdmin };
}

/**
 * Can this user open the ledger? The same rule as {@link loadTenantAccess}: a
 * `tenant_users` row, or admin of its organization or of the deployment. Used to
 * check who may be assigned to the ledger's transactions.
 */
export async function userCanAccessTenant(userId: number, tenantId: number): Promise<boolean> {
  const access = await loadTenantAccess(userId, tenantId, await userIsDeploymentAdmin(userId));
  return access?.hasAccess ?? false;
}

/**
 * Is `value` a user id that may be assigned to the ledger's transactions? Any other
 * user would show up by name in the ledger, whichever organization they belong to.
 */
export async function isAssignableUser(value: unknown, tenantId: number | null | undefined): Promise<boolean> {
  const userId = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  // users.id is an integer column: a larger id can't exist, and comparing one fails.
  if (!Number.isSafeInteger(userId) || userId <= 0 || userId > 2147483647 || tenantId == null) return false;
  return userCanAccessTenant(userId, tenantId);
}

/** A ledger, by its uuid, that a person may open (loadTenantAccess's rule). */
export interface AccessibleTenant {
  id: number;
  uuid: string;
  name: string;
  organizationId: number;
}

/**
 * The ledger `tenantUuid` names, if `userId` may open it: else 404 TENANT_NOT_FOUND, or 403
 * TENANT_FORBIDDEN with `forbiddenMessage` (a suspended or deleted one included). For the
 * ledger switcher and the ledger an MCP token is pinned to.
 */
export async function accessibleTenantByUuid(
  userId: number,
  tenantUuid: string,
  forbiddenMessage: string
): Promise<AccessibleTenant> {
  const tenant = await globalDb
    .selectFrom('tenants')
    .select(['id', 'uuid', 'name', 'organization_id'])
    .where('uuid', '=', tenantUuid)
    .executeTakeFirst();
  if (!tenant) throw new ControlPlaneError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
  const access = await loadTenantAccess(userId, tenant.id, await userIsDeploymentAdmin(userId));
  if (!access || !access.hasAccess) throw new ControlPlaneError(403, 'TENANT_FORBIDDEN', forbiddenMessage);
  return { id: tenant.id, uuid: tenant.uuid, name: tenant.name, organizationId: tenant.organization_id };
}

/** The active ledger, as the ledger switcher answers it. */
export interface ActiveTenantSummary {
  uuid: string;
  name: string;
  organizationUuid: string;
  organizationName: string;
}

/**
 * Switch a browser session's active ledger (the ledger switcher) to one `userId` may open,
 * by the same rule as the per-request gate, and remember it as the one they last used, so
 * their next sign-in opens it. Refused as {@link accessibleTenantByUuid} refuses.
 *
 * The two writes are one transaction: apart, a failure of the second left the first,
 * the session in one ledger and the next sign-in opening another. The user's row is written
 * before the session's, the order a revocation of their credentials (users FOR UPDATE, then
 * the sessions) and membershipLocks.ts take them in, so the two can't deadlock.
 */
export async function switchActiveTenant(userId: number, sessionId: number, tenantUuid: string): Promise<ActiveTenantSummary> {
  const tenant = await accessibleTenantByUuid(userId, tenantUuid, 'No access to this tenant');
  await globalDb.transaction().execute(async (trx) => {
    await trx.updateTable('users').set({ last_tenant_id: tenant.id }).where('id', '=', userId).execute();
    await trx.updateTable('sessions').set({ active_tenant_id: tenant.id }).where('id', '=', sessionId).execute();
  });
  const org = await globalDb
    .selectFrom('organizations')
    .select(['uuid', 'name'])
    .where('id', '=', tenant.organizationId)
    .executeTakeFirst();
  return {
    uuid: tenant.uuid,
    name: tenant.name,
    organizationUuid: org?.uuid ?? '',
    organizationName: org?.name ?? '',
  };
}

/**
 * The caller's full membership picture: deployment-admin flag, the budgets they
 * can access (with effective role), the organizations they belong to, and the
 * role context of the currently-active budget. Backs both GET /api/auth/me and
 * GET /api/auth/tenants.
 */
export async function getMembershipSummary(
  userId: number,
  activeTenantId: number | null
): Promise<MembershipSummary> {
  const isDeploymentAdmin = await userIsDeploymentAdmin(userId);

  // Accessible budgets + the user's tenant/org membership flags, in one pass.
  const budgetRows = await globalDb
    .selectFrom('tenants as t')
    .innerJoin('organizations as o', 'o.id', 't.organization_id')
    .leftJoin('tenant_users as tu', (join) =>
      join.onRef('tu.tenant_id', '=', 't.id').on('tu.user_id', '=', userId)
    )
    .leftJoin('organization_users as ou', (join) =>
      join.onRef('ou.organization_id', '=', 'o.id').on('ou.user_id', '=', userId)
    )
    .where('t.status', '=', 'active')
    .where('o.status', '=', 'active')
    // Deployment admins see every active budget; everyone else sees budgets they
    // belong to (or whose org they administer).
    .$if(!isDeploymentAdmin, (qb) =>
      qb.where((eb) =>
        eb.or([eb('tu.user_id', 'is not', null), eb('ou.is_admin', '=', true)])
      )
    )
    .select([
      't.id as tenantId',
      't.uuid as tenantUuid',
      't.name as tenantName',
      't.status as tenantStatus',
      'o.uuid as orgUuid',
      'o.name as orgName',
      'tu.is_admin as tenantIsAdmin',
      'ou.is_admin as orgIsAdmin',
    ])
    .orderBy('o.name')
    .orderBy('t.name')
    .execute();

  const roleFor = (tenantIsAdmin: boolean | null, orgIsAdmin: boolean | null): MemberRole =>
    isDeploymentAdmin || !!orgIsAdmin || !!tenantIsAdmin ? 'admin' : 'member';

  const tenants: TenantSummary[] = budgetRows.map((r) => ({
    uuid: r.tenantUuid,
    name: r.tenantName,
    status: r.tenantStatus as TenantStatus,
    organizationUuid: r.orgUuid,
    organizationName: r.orgName,
    role: roleFor(r.tenantIsAdmin, r.orgIsAdmin),
    isActiveTenant: r.tenantId === activeTenantId,
  }));

  // Organizations the user explicitly belongs to (drives org-admin page gating).
  const orgRows = await globalDb
    .selectFrom('organizations as o')
    .innerJoin('organization_users as ou', 'ou.organization_id', 'o.id')
    .where('ou.user_id', '=', userId)
    .where('o.status', '=', 'active')
    .select(['o.uuid', 'o.name', 'o.status', 'ou.is_admin as isAdmin'])
    .orderBy('o.name')
    .execute();

  const organizations: OrganizationSummary[] = orgRows.map((o) => ({
    uuid: o.uuid,
    name: o.name,
    status: o.status as OrganizationStatus,
    role: isDeploymentAdmin || o.isAdmin ? 'admin' : 'member',
  }));

  const active =
    activeTenantId != null ? budgetRows.find((r) => r.tenantId === activeTenantId) : undefined;

  return {
    isDeploymentAdmin,
    activeTenant: active
      ? {
          uuid: active.tenantUuid,
          name: active.tenantName,
          organizationUuid: active.orgUuid,
          organizationName: active.orgName,
        }
      : null,
    tenantRole: active ? roleFor(active.tenantIsAdmin, active.orgIsAdmin) : null,
    orgRole: active ? (isDeploymentAdmin || !!active.orgIsAdmin ? 'admin' : 'member') : null,
    tenants,
    organizations,
  };
}
