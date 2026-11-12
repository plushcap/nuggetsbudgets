import { sql } from 'kysely';
import type { Kysely, Transaction, UpdateObject } from 'kysely';
import { globalDb } from '../db/withTenant.js';
import type { DB } from '../db/schema.generated.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import { toMemberDto } from './memberMapper.js';
import { applyUserAccountFlags, type FlagsActor, type UserAccountFlags } from './userFlagsService.js';
import { revokeOpenInvitationsTo } from './InvitationService.js';
import { describePlaces, soleAdminOf } from './membershipLocks.js';
import type {
  MemberDto,
  OrganizationDetail,
  OrganizationListItem,
  OrgTenantSummary,
} from '@nuggets/shared';
import { organizationStatus } from '@nuggets/shared';

/**
 * Organization-admin + deployment-admin operations. All on {@link globalDb}:
 * `organizations`/`organization_users`/`tenants` are global control-plane tables.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authorize org-admin access to the org with `orgUuid` and return its id.
 * Deployment admins pass unconditionally. Throws ControlPlaneError on missing
 * org (404, also for a string that isn't a uuid) or insufficient rights (403).
 * An org a deployment admin suspended or deleted is closed to its own admins
 * (403), as its ledgers are to their members.
 */
export async function assertOrgAdmin(
  userId: number,
  orgUuid: string,
  isDeploymentAdmin: boolean
): Promise<number> {
  if (!UUID_RE.test(orgUuid)) throw new ControlPlaneError(404, 'ORG_NOT_FOUND', 'Organization not found.');
  const org = await globalDb
    .selectFrom('organizations')
    .select(['id', 'status'])
    .where('uuid', '=', orgUuid)
    .executeTakeFirst();
  if (!org) throw new ControlPlaneError(404, 'ORG_NOT_FOUND', 'Organization not found.');
  if (isDeploymentAdmin) return org.id;
  const membership = await globalDb
    .selectFrom('organization_users')
    .select('is_admin')
    .where('organization_id', '=', org.id)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!membership || !membership.is_admin) {
    throw new ControlPlaneError(403, 'ORG_ADMIN_REQUIRED', 'Organization admin required.');
  }
  if (org.status !== organizationStatus.enum.active) {
    throw new ControlPlaneError(403, 'ORG_NOT_ACTIVE', 'This organization is not active.');
  }
  return org.id;
}

export async function getOrganizationDetail(orgId: number): Promise<OrganizationDetail> {
  const org = await globalDb
    .selectFrom('organizations')
    .select(['uuid', 'name', 'status'])
    .where('id', '=', orgId)
    .executeTakeFirstOrThrow();

  const tenants = await globalDb
    .selectFrom('tenants as t')
    .leftJoin('tenant_users as tu', 'tu.tenant_id', 't.id')
    .select(['t.uuid', 't.name', 't.status'])
    .select((eb) => eb.fn.count<string>('tu.id').as('memberCount'))
    .where('t.organization_id', '=', orgId)
    .where('t.status', '!=', 'deleted')
    .groupBy(['t.id', 't.uuid', 't.name', 't.status'])
    .orderBy('t.name')
    .execute();

  const memberCount = await globalDb
    .selectFrom('organization_users')
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .where('organization_id', '=', orgId)
    .executeTakeFirst();

  return {
    uuid: org.uuid,
    name: org.name,
    status: org.status as OrganizationDetail['status'],
    tenants: tenants.map(
      (t): OrgTenantSummary => ({
        uuid: t.uuid,
        name: t.name,
        status: t.status as OrgTenantSummary['status'],
        memberCount: Number(t.memberCount),
      })
    ),
    memberCount: Number(memberCount?.c ?? 0),
  };
}

/** Deployment-wide list of every (non-deleted) organization with counts. */
export async function listOrganizations(): Promise<OrganizationListItem[]> {
  const result = await sql<{
    uuid: string;
    name: string;
    status: string;
    tenant_count: number;
    member_count: number;
  }>`
    SELECT o.uuid, o.name, o.status,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status <> 'deleted')::int AS tenant_count,
      COUNT(DISTINCT ou.id)::int AS member_count
    FROM organizations o
    LEFT JOIN tenants t ON t.organization_id = o.id
    LEFT JOIN organization_users ou ON ou.organization_id = o.id
    WHERE o.status <> 'deleted'
    GROUP BY o.id, o.uuid, o.name, o.status
    ORDER BY o.name ASC
  `.execute(globalDb);
  return result.rows.map((r) => ({
    uuid: r.uuid,
    name: r.name,
    status: r.status as OrganizationListItem['status'],
    tenantCount: r.tenant_count,
    memberCount: r.member_count,
  }));
}

/**
 * The account with `email`, whatever the case it was stored in. The routes' schema
 * lowercases the address (emailField), and an account created before sign-up lowercased
 * them may have capitals, so an exact compare answered 404 for it. An account stored
 * exactly as asked wins; two or more that differ only in case, none of them exact, are
 * refused rather than one picked. Undefined when no account has it. Deployment admins only
 * (the routes check), so it may say whether an address has an account.
 */
async function userIdByEmail(db: Kysely<DB>, email: string): Promise<number | undefined> {
  const matches = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where(sql<string>`lower(email)`, '=', sql<string>`lower(${email})`)
    .orderBy('id')
    .execute();
  const exact = matches.find((u) => u.email === email);
  if (exact) return exact.id;
  if (matches.length > 1) {
    throw new ControlPlaneError(
      409,
      'EMAIL_AMBIGUOUS',
      `More than one user has the email ${email}, written with different capital letters, so which one is meant can't be told: the duplicate accounts need sorting out first.`
    );
  }
  return matches[0]?.id;
}

export async function createOrganization(
  name: string,
  adminEmail: string | undefined,
  actorUserId: number
): Promise<OrganizationDetail> {
  const orgId = await globalDb.transaction().execute(async (trx) => {
    const org = await trx
      .insertInto('organizations')
      .values({ name })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    let adminUserId = actorUserId;
    if (adminEmail) {
      const found = await userIdByEmail(trx, adminEmail);
      if (found === undefined) {
        throw new ControlPlaneError(
          404,
          'USER_NOT_FOUND',
          `No user with email ${adminEmail}. Create the user first, then make them an organization admin.`
        );
      }
      adminUserId = found;
    }
    await trx
      .insertInto('organization_users')
      .values({ user_id: adminUserId, organization_id: org.id, is_admin: true, created_by: actorUserId })
      .execute();
    return org.id;
  });
  return getOrganizationDetail(orgId);
}

export async function updateOrganization(
  orgId: number,
  body: { name?: string; status?: OrganizationDetail['status'] }
): Promise<OrganizationDetail> {
  const set: UpdateObject<DB, 'organizations'> = { updated_at: sql<Date>`NOW()` };
  if (body.name !== undefined) set.name = body.name;
  if (body.status !== undefined) set.status = body.status;
  await globalDb.updateTable('organizations').set(set).where('id', '=', orgId).execute();
  return getOrganizationDetail(orgId);
}

export async function listOrgMembers(orgId: number): Promise<MemberDto[]> {
  const rows = await globalDb
    .selectFrom('organization_users as ou')
    .innerJoin('users as u', 'u.id', 'ou.user_id')
    .select([
      'ou.uuid',
      'ou.is_admin',
      'ou.created_at',
      'u.uuid as userUuid',
      'u.email',
      'u.first_name',
      'u.last_name',
      'u.profile_image',
      'u.is_locked',
      'u.login_disabled',
    ])
    .where('ou.organization_id', '=', orgId)
    .orderBy('ou.is_admin', 'desc')
    .orderBy('u.first_name')
    .orderBy('u.last_name')
    .execute();
  return rows.map(toMemberDto);
}

/**
 * Add an existing user to the organization directly, by email. Deployment admins
 * only (the route checks): an organization's own admins invite instead
 * (InvitationService), so that joining takes the person's consent and the answer
 * doesn't reveal whether an address has an account.
 */
export async function addOrgMember(
  orgId: number,
  email: string,
  isAdmin: boolean,
  actorUserId: number
): Promise<MemberDto> {
  return globalDb.transaction().execute(async (trx) => {
    // In the lock order (membershipLocks.ts): first the `users` rows the insert's foreign
    // keys share-lock, the person's and the adder's, FOR KEY SHARE in id order. The insert
    // took them only as it checked its foreign keys, so a delete of the person in between
    // went through and the insert failed its foreign key (a 500). A delete now either
    // finishes first (and the person isn't found) or waits for this insert, and counts it.
    const userId = await userIdByEmail(trx, email);
    const people =
      userId === undefined
        ? []
        : await trx
            .selectFrom('users')
            .select(['id', 'uuid', 'email', 'first_name', 'last_name', 'profile_image', 'is_locked', 'login_disabled'])
            .where('id', 'in', [userId, actorUserId])
            .orderBy('id')
            .forKeyShare()
            .execute();
    const user = people.find((p) => p.id === userId);
    if (!user) {
      throw new ControlPlaneError(
        404,
        'USER_NOT_FOUND',
        `No user with email ${email}. Create the user first, then add them to the organization.`
      );
    }
    try {
      const row = await trx
        .insertInto('organization_users')
        .values({ user_id: user.id, organization_id: orgId, is_admin: isAdmin, created_by: actorUserId })
        .returning(['uuid', 'is_admin', 'created_at'])
        .executeTakeFirstOrThrow();
      return toMemberDto({
        uuid: row.uuid,
        is_admin: row.is_admin,
        created_at: row.created_at,
        userUuid: user.uuid,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        profile_image: user.profile_image,
        is_locked: user.is_locked,
        login_disabled: user.login_disabled,
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ControlPlaneError(409, 'ALREADY_MEMBER', 'That person is already a member of this organization.');
      }
      throw err;
    }
  });
}

/**
 * Lock the member's row and, with `withAdmins`, the organization's admin memberships, in id
 * order in one statement, and answer them as they then stand: the member (undefined when
 * the organization has none by that uuid) and the admins' ids, the member among them if
 * they're one.
 *
 * A change that could leave the organization without an admin takes the admins: two that
 * each locked their own row first and then the rest (in no order) deadlocked, removing or
 * demoting both admins of a two-admin organization at once. And it takes them with the
 * member, deciding under the lock: choosing from an unlocked read whether the member
 * was an admin, a demotion that read it before their promotion committed locked the member
 * alone, then the admins after them, out of id order. A row changed while the statement
 * waited is read as it then is; someone else's promotion committed meanwhile isn't
 * counted, so at worst a change is refused (LAST_ADMIN) that a retry would make.
 */
async function lockMember(
  trx: Transaction<DB>,
  orgId: number,
  memberUuid: string,
  withAdmins: boolean
): Promise<{ member: { id: number; is_admin: boolean; user_id: number } | undefined; admins: number[] }> {
  const rows = await trx
    .selectFrom('organization_users')
    .select(['id', 'uuid', 'is_admin', 'user_id'])
    .where('organization_id', '=', orgId)
    .where((eb) => (withAdmins ? eb.or([eb('uuid', '=', memberUuid), eb('is_admin', '=', true)]) : eb('uuid', '=', memberUuid)))
    .orderBy('id')
    .forUpdate()
    .execute();
  return { member: rows.find((r) => r.uuid === memberUuid), admins: rows.filter((r) => r.is_admin).map((r) => r.id) };
}

export async function setOrgMemberAdmin(
  orgId: number,
  memberUuid: string,
  isAdmin: boolean
): Promise<void> {
  await globalDb.transaction().execute(async (trx) => {
    // A demotion takes the admins with the member (lockMember); a promotion, the member.
    const { member: target, admins } = await lockMember(trx, orgId, memberUuid, !isAdmin);
    if (!target) throw new ControlPlaneError(404, 'MEMBER_NOT_FOUND', 'Member not found in this organization.');
    if (target.is_admin && !isAdmin && admins.length <= 1) {
      throw new ControlPlaneError(409, 'LAST_ADMIN', 'This organization must keep at least one admin.');
    }
    await trx
      .updateTable('organization_users')
      .set({ is_admin: isAdmin, updated_at: sql<Date>`NOW()` })
      .where('id', '=', target.id)
      .execute();
  });
}

/**
 * Remove someone from the organization, and in the same transaction everything
 * that membership let them keep: their memberships of the organization's
 * ledgers, their personal access tokens for those ledgers (revoked), and open
 * invitations of the organization to their email. Sessions are left alone:
 * every request re-checks ledger access (requireTenantMember), which also clears
 * a session's active ledger once it is refused.
 *
 * Refused (409 LAST_ADMIN) while they're the organization's only admin, or the only
 * admin of one of its tenants (naming those).
 */
export async function removeOrgMember(orgId: number, memberUuid: string): Promise<void> {
  await globalDb.transaction().execute(async (trx) => {
    // In the lock order (membershipLocks.ts). Revoke the open invitations to them first:
    // accepting an invitation locks the invitation, then the membership, so taking the
    // membership first deadlocked with an accept in flight. A refusal below rolls this back.
    const member = await trx
      .selectFrom('organization_users as ou')
      .innerJoin('users as u', 'u.id', 'ou.user_id')
      .select('u.email')
      .where('ou.uuid', '=', memberUuid)
      .where('ou.organization_id', '=', orgId)
      .executeTakeFirst();
    if (member) await revokeOpenInvitationsTo(trx, orgId, member.email);
    // Then the member and the admins, in id order in one statement (lockMember).
    const { member: target, admins } = await lockMember(trx, orgId, memberUuid, true);
    if (!target) throw new ControlPlaneError(404, 'MEMBER_NOT_FOUND', 'Member not found in this organization.');
    if (target.is_admin && admins.length <= 1) {
      throw new ControlPlaneError(
        409,
        'LAST_ADMIN',
        'This organization must keep at least one admin. Promote another member first.'
      );
    }
    // Then their memberships of the organization's tenants and the admins of those, in id
    // order in one statement, after the organization's rows, as deleting a user takes them.
    // Deleting the memberships would leave a tenant they're the only admin of with none:
    // removing or demoting its last admin is refused (LAST_ADMIN), so this is too. A
    // deleted tenant, or one of a deleted organization, needs none.
    const orgTenants = trx.selectFrom('tenants').select('id').where('organization_id', '=', orgId);
    const theirTenants = trx
      .selectFrom('tenant_users')
      .select('tenant_id')
      .where('user_id', '=', target.user_id)
      .where('tenant_id', 'in', orgTenants);
    const tenantRows = await trx
      .selectFrom('tenant_users as tu')
      .innerJoin('tenants as t', 't.id', 'tu.tenant_id')
      .innerJoin('organizations as o', 'o.id', 't.organization_id')
      .select(['tu.tenant_id as placeId', 'tu.user_id', 'tu.is_admin', 't.uuid', 't.name', 't.status', 'o.status as orgStatus'])
      .where('tu.tenant_id', 'in', theirTenants)
      .where((eb) => eb.or([eb('tu.user_id', '=', target.user_id), eb('tu.is_admin', '=', true)]))
      .orderBy('tu.id')
      .forUpdate('tu')
      .execute();
    const tenants = soleAdminOf(
      tenantRows.filter((r) => r.is_admin && r.status !== 'deleted' && r.orgStatus !== 'deleted'),
      target.user_id
    );
    if (tenants.length > 0) {
      throw new ControlPlaneError(
        409,
        'LAST_ADMIN',
        `This member is the only admin of ${describePlaces({ organizations: [], tenants })} in this organization. Make someone else an admin of ${tenants.length === 1 ? 'it' : 'each'} first.`,
        { tenants }
      );
    }
    await trx
      .deleteFrom('tenant_users')
      .where('user_id', '=', target.user_id)
      .where('tenant_id', 'in', orgTenants)
      .execute();
    await trx
      .updateTable('personal_access_tokens')
      .set({ revoked_at: sql<Date>`NOW()`, revoked_reason: 'removed_from_organization' })
      .where('user_id', '=', target.user_id)
      .where('tenant_id', 'in', orgTenants)
      .where('revoked_at', 'is', null)
      .execute();
    await trx.deleteFrom('organization_users').where('id', '=', target.id).execute();
  });
}

/**
 * Set global account flags (is_locked / login_disabled) on an org member's user.
 * Authorized for org admins and deployment admins (see the route guard); an org
 * admin only for someone the organization alone answers for (applyUserAccountFlags).
 */
export async function setOrgMemberFlags(
  orgId: number,
  memberUuid: string,
  flags: UserAccountFlags,
  actor: Omit<FlagsActor, 'organizationId'>
): Promise<void> {
  const target = await globalDb
    .selectFrom('organization_users as ou')
    .innerJoin('users as u', 'u.id', 'ou.user_id')
    .select('u.id as userId')
    .where('ou.uuid', '=', memberUuid)
    .where('ou.organization_id', '=', orgId)
    .executeTakeFirst();
  if (!target) throw new ControlPlaneError(404, 'MEMBER_NOT_FOUND', 'Member not found in this organization.');
  await applyUserAccountFlags(target.userId, flags, { ...actor, organizationId: orgId });
}
