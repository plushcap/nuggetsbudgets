import { sql, type Transaction } from 'kysely';
import { globalDb } from '../db/withTenant.js';
import type { DB } from '../db/schema.generated.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import { assertMayAddTenant } from '../db/servingRole.js';

/**
 * Deployment-admin management + first-run bootstrap.
 *
 * "Deployment admin" = a `deployment_users` row with role='admin' (the
 * replacement for the retired `users.is_admin`). These functions are the only
 * place that role is granted/revoked. The serving role can only read
 * deployment_users: it changes it through the SECURITY DEFINER functions
 * grant_deployment_admin / revoke_deployment_admin, and the checks of who
 * may do that stay here and in the routes.
 */

/** The singleton deployment row's id (seeded with the schema). */
async function deploymentId(db: Transaction<DB> | typeof globalDb): Promise<number> {
  const row = await db.selectFrom('deployment').select('id').orderBy('id').limit(1).executeTakeFirstOrThrow();
  return row.id;
}

/**
 * First-run bootstrap: make `userId` a deployment admin and ensure they own an
 * organization + ledger (adopting a seeded one if present — idempotent). Returns
 * the ledger (tenant) id so the caller can set `sessions.active_tenant_id`.
 * Runs inside the caller's transaction (the one that created the user).
 */
export async function bootstrapFirstAdmin(
  trx: Transaction<DB>,
  userId: number
): Promise<{ tenantId: number }> {
  await grantDeploymentAdmin(trx, userId, userId);

  // Adopt the first existing organization (e.g. a seeded one), else create it.
  let org = await trx.selectFrom('organizations').select('id').orderBy('id').limit(1).executeTakeFirst();
  if (!org) {
    org = await trx
      .insertInto('organizations')
      .values({ name: 'Home' })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  await trx
    .insertInto('organization_users')
    .values({ user_id: userId, organization_id: org.id, is_admin: true, created_by: userId })
    .onConflict((oc) => oc.columns(['user_id', 'organization_id']).doUpdateSet({ is_admin: true }))
    .execute();

  // Adopt the org's first ledger, else create one.
  let tenant = await trx
    .selectFrom('tenants')
    .select('id')
    .where('organization_id', '=', org.id)
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  if (!tenant) {
    await assertMayAddTenant(trx);
    tenant = await trx
      .insertInto('tenants')
      .values({ organization_id: org.id, name: 'My Ledger' })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  await trx
    .insertInto('tenant_users')
    .values({ user_id: userId, tenant_id: tenant.id, is_admin: true, created_by: userId })
    .onConflict((oc) => oc.columns(['user_id', 'tenant_id']).doUpdateSet({ is_admin: true }))
    .execute();

  return { tenantId: tenant.id };
}

/** How many deployment admins exist (for the last-admin guard). */
export async function countDeploymentAdmins(): Promise<number> {
  const depId = await deploymentId(globalDb);
  const rows = await globalDb
    .selectFrom('deployment_users')
    .select('id')
    .where('deployment_id', '=', depId)
    .where('role', '=', 'admin')
    .execute();
  return rows.length;
}

const lastDeploymentAdmin = () =>
  new ControlPlaneError(409, 'LAST_DEPLOYMENT_ADMIN', 'The deployment must keep at least one admin.');
const deploymentAdminRequired = () => new ControlPlaneError(403, 'DEPLOYMENT_ADMIN_REQUIRED', 'Deployment admin required');

/**
 * Make `userId` a deployment admin (an existing row keeps its created_by). The function
 * checks, under its lock of the two accounts' deployment rows, that `grantedBy` still is
 * one: the route checked it as the request began, and a removal of their role since
 * then let the grant through. First-run setup grants the first user to themselves, while
 * the deployment has no admin.
 */
async function grantDeploymentAdmin(db: Transaction<DB> | typeof globalDb, userId: number, grantedBy: number): Promise<void> {
  try {
    await sql`SELECT grant_deployment_admin(${userId}, ${grantedBy})`.execute(db);
  } catch (err) {
    // An account deleted since its uuid was looked up (the user), or since the request was
    // authorized (the admin granting it): the foreign key answered a 500.
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23503' && e.constraint === 'deployment_users_user_id_fkey') {
      throw new ControlPlaneError(404, 'USER_NOT_FOUND', 'User not found');
    }
    if (e.code === '23503' && e.constraint === 'deployment_users_created_by_fkey') throw deploymentAdminRequired();
    // The granter's role was removed since the request was authorized.
    if (e.code === '42501' && e.constraint === 'deployment_admin_required') throw deploymentAdminRequired();
    throw err;
  }
}

/**
 * Remove `userId`'s deployment role. The function locks the admins' rows and refuses
 * (check_violation on deployment_keeps_an_admin) to remove the only one, which the count
 * in setUserDeploymentAdmin can't promise when two removals run at once.
 */
async function revokeDeploymentAdmin(db: Transaction<DB> | typeof globalDb, userId: number): Promise<void> {
  try {
    await sql`SELECT revoke_deployment_admin(${userId})`.execute(db);
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23514' && e.constraint === 'deployment_keeps_an_admin') throw lastDeploymentAdmin();
    throw err;
  }
}

/**
 * Grant or revoke deployment-admin for a user. Guards against demoting the last
 * admin or an admin removing their own access (self-lockout).
 *
 * The acting admin's own role is checked again under the lock the change takes, as
 * deleting a user does (lock_deployment_users_of): the route checked it as the request
 * began, and a removal of it that committed since let the change through. A removal of it
 * still under way is waited for. Either way the change is refused 403
 * DEPLOYMENT_ADMIN_REQUIRED, with nothing changed.
 */
export async function setUserDeploymentAdmin(
  targetUserId: number,
  makeAdmin: boolean,
  actorUserId: number
): Promise<void> {
  if (!makeAdmin) {
    if (targetUserId === actorUserId) {
      throw new ControlPlaneError(400, 'CANNOT_DEMOTE_SELF', 'You cannot remove your own deployment-admin access.');
    }
    if ((await countDeploymentAdmins()) <= 1) throw lastDeploymentAdmin();
    await globalDb.transaction().execute(async (trx) => {
      // Locks every admin's row, in id order, in one statement: the actor's too while they
      // are one. So their role, read after it, can't be removed before this commits; one
      // removed meanwhile (or not theirs any more) rolls the removal back.
      await revokeDeploymentAdmin(trx, targetUserId);
      const actor = await trx
        .selectFrom('deployment_users')
        .select('id')
        .where('user_id', '=', actorUserId)
        .where('role', '=', 'admin')
        .where('deployment_id', '=', await deploymentId(trx))
        .executeTakeFirst();
      if (!actor) throw deploymentAdminRequired();
    });
    return;
  }

  // The function checks the actor's role under its lock.
  await grantDeploymentAdmin(globalDb, targetUserId, actorUserId);
}
