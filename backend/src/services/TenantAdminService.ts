import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import type { DB } from '../db/schema.generated.js';
import { globalDb, withTenant, getDb } from '../db/withTenant.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import { assertMayAddTenant } from '../db/servingRole.js';
import { toMemberDto } from './memberMapper.js';
import { applyUserAccountFlags, type FlagsActor, type UserAccountFlags } from './userFlagsService.js';
import type { TenantDetail, MemberCandidateDto, MemberDto } from '@nuggets/shared';

/**
 * Tenant-admin operations on a single tenant (the active one). All on
 * {@link globalDb}: `tenants`/`tenant_users` are global control-plane tables.
 */

export async function getCurrentTenant(tenantId: number): Promise<TenantDetail> {
  const t = await globalDb
    .selectFrom('tenants as t')
    .innerJoin('organizations as o', 'o.id', 't.organization_id')
    .select([
      't.uuid',
      't.name',
      't.status',
      't.balance_adjustment_merchant_id as balanceAdjustmentMerchantId',
      'o.uuid as orgUuid',
      'o.name as orgName',
    ])
    .where('t.id', '=', tenantId)
    .executeTakeFirstOrThrow();
  const count = await globalDb
    .selectFrom('tenant_users')
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();

  // The balance-adjustment merchant lives on `tenants` (control plane) but its
  // name/uuid come from the tenant-scoped `merchants` table, so resolve it under
  // the tenant's RLS context.
  let balanceAdjustmentMerchant: TenantDetail['balanceAdjustmentMerchant'] = null;
  if (t.balanceAdjustmentMerchantId != null) {
    const merchant = await withTenant(tenantId, () =>
      getDb()
        .selectFrom('merchants')
        .select(['uuid', 'name'])
        .where('id', '=', t.balanceAdjustmentMerchantId!)
        .executeTakeFirst()
    );
    if (merchant) balanceAdjustmentMerchant = { uuid: merchant.uuid, name: merchant.name };
  }

  return {
    uuid: t.uuid,
    name: t.name,
    status: t.status as TenantDetail['status'],
    organization: { uuid: t.orgUuid, name: t.orgName },
    memberCount: Number(count?.c ?? 0),
    balanceAdjustmentMerchant,
  };
}

/**
 * Set (or clear, with `merchantUuid === null`) the ledger's balance-adjustment
 * merchant. The merchant uuid is resolved under the tenant's RLS context so a
 * ledger can only point at its own merchants; the resolved id is then written to
 * the control-plane `tenants` row.
 */
export async function setBalanceAdjustmentMerchant(
  tenantId: number,
  merchantUuid: string | null
): Promise<TenantDetail> {
  let merchantId: number | null = null;
  if (merchantUuid != null) {
    const merchant = await withTenant(tenantId, () =>
      getDb()
        .selectFrom('merchants')
        .select('id')
        .where('uuid', '=', merchantUuid)
        .executeTakeFirst()
    );
    if (!merchant) {
      throw new ControlPlaneError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found in this tenant.');
    }
    merchantId = merchant.id;
  }
  await globalDb
    .updateTable('tenants')
    .set({ balance_adjustment_merchant_id: merchantId, updated_at: sql<Date>`NOW()` })
    .where('id', '=', tenantId)
    .execute();
  return getCurrentTenant(tenantId);
}

export async function renameTenant(tenantId: number, name: string): Promise<TenantDetail> {
  await globalDb
    .updateTable('tenants')
    .set({ name, updated_at: sql<Date>`NOW()` })
    .where('id', '=', tenantId)
    .execute();
  return getCurrentTenant(tenantId);
}

export async function listTenantMembers(tenantId: number): Promise<MemberDto[]> {
  const rows = await globalDb
    .selectFrom('tenant_users as tu')
    .innerJoin('users as u', 'u.id', 'tu.user_id')
    .select([
      'tu.uuid',
      'tu.is_admin',
      'tu.created_at',
      'u.uuid as userUuid',
      'u.email',
      'u.first_name',
      'u.last_name',
      'u.profile_image',
      'u.is_locked',
      'u.login_disabled',
    ])
    .where('tu.tenant_id', '=', tenantId)
    .orderBy('tu.is_admin', 'desc')
    .orderBy('u.first_name')
    .orderBy('u.last_name')
    .execute();
  return rows.map(toMemberDto);
}

/**
 * Members of the ledger's organization who aren't in the ledger yet: the people a
 * tenant admin may add (see {@link addTenantMember}).
 */
export async function listTenantMemberCandidates(tenantId: number, orgId: number): Promise<MemberCandidateDto[]> {
  const rows = await globalDb
    .selectFrom('organization_users as ou')
    .innerJoin('users as u', 'u.id', 'ou.user_id')
    .select(['u.uuid', 'u.email', 'u.first_name', 'u.last_name'])
    .where('ou.organization_id', '=', orgId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('tenant_users as tu')
            .select('tu.id')
            .whereRef('tu.user_id', '=', 'ou.user_id')
            .where('tu.tenant_id', '=', tenantId)
        )
      )
    )
    .orderBy('u.first_name')
    .orderBy('u.last_name')
    .orderBy('u.email')
    .execute();
  return rows.map((r) => ({ userUuid: r.uuid, email: r.email, firstName: r.first_name, lastName: r.last_name }));
}

/**
 * Add someone to the ledger. Only a member of the ledger's organization can be
 * added: people join the organization by accepting an invitation, so a
 * tenant admin can't pull in a user from another family. An address with no
 * account and one whose account isn't in the organization get the same answer.
 */
export async function addTenantMember(
  tenantId: number,
  orgId: number,
  email: string,
  isAdmin: boolean,
  actorUserId: number
): Promise<MemberDto> {
  return globalDb.transaction().execute(async (trx) => {
    // In the lock order (membershipLocks.ts). First the `users` rows the insert's foreign
    // keys share-lock, FOR KEY SHARE in id order: the adder's and those of the
    // organization's members with the address. Deleting a user takes that row first and
    // their memberships after, so taking the membership first and the row in the insert
    // deadlocked with it. A delete of the person either finishes first (and they
    // aren't found below) or waits for this insert.
    const normalized = email.trim().toLowerCase();
    const people = await trx
      .selectFrom('users as u')
      .select('u.id')
      .where((eb) =>
        eb.or([
          eb('u.id', '=', actorUserId),
          eb.and([
            eb(sql<string>`lower(u.email)`, '=', normalized),
            eb.exists(
              eb.selectFrom('organization_users as ou').select('ou.id').whereRef('ou.user_id', '=', 'u.id').where('ou.organization_id', '=', orgId)
            ),
          ]),
        ])
      )
      .orderBy('u.id')
      .forKeyShare()
      .execute();

    // Then share-lock the organization membership. Removal from the organization locks
    // it for update before deleting the person's ledger memberships, so it either
    // finishes first (and they aren't found here) or waits for this insert and
    // deletes it along with the rest.
    //
    // Whatever the case the address was stored in, as the organization routes find people:
    // one stored exactly as asked wins; two or more that differ only in case, none
    // exact, are refused rather than one picked. Only the organization's members are looked
    // at, so an account outside it changes no answer. Only the people locked above:
    // one who joined the organization since is as if they joined after this add.
    const locked = people.map((p) => p.id);
    const matches =
      locked.length === 0
        ? []
        : await trx
            .selectFrom('users as u')
            .innerJoin('organization_users as ou', (join) =>
              join.onRef('ou.user_id', '=', 'u.id').on('ou.organization_id', '=', orgId)
            )
            .select(['u.id', 'u.uuid', 'u.email', 'u.first_name', 'u.last_name', 'u.profile_image', 'u.is_locked', 'u.login_disabled'])
            .where(sql<string>`lower(u.email)`, '=', normalized)
            .where('u.id', 'in', locked)
            .orderBy('u.id')
            .forShare('ou')
            .execute();
    const user = matches.find((u) => u.email === email.trim()) ?? (matches.length === 1 ? matches[0] : undefined);
    if (!user && matches.length > 1) {
      throw new ControlPlaneError(
        409,
        'EMAIL_AMBIGUOUS',
        `More than one member of this tenant's organization has the email ${email.trim()}, written with different capital letters, so which one is meant can't be told: a deployment admin needs to sort out the duplicate accounts first.`
      );
    }
    if (!user) {
      throw new ControlPlaneError(
        404,
        'NOT_ORG_MEMBER',
        "No member of this tenant's organization has that email. Invite them to the organization first."
      );
    }
    const row = await trx
      .insertInto('tenant_users')
      .values({ user_id: user.id, tenant_id: tenantId, is_admin: isAdmin, created_by: actorUserId })
      .onConflict((oc) => oc.columns(['user_id', 'tenant_id']).doNothing())
      .returning(['uuid', 'is_admin', 'created_at'])
      .executeTakeFirst();
    if (!row) {
      throw new ControlPlaneError(409, 'ALREADY_MEMBER', 'That person is already a member of this tenant.');
    }
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
  });
}

/**
 * Lock the member's row and, with `withAdmins`, the tenant's admin memberships, in id order
 * in one statement, and answer them as they then stand: the member (undefined when the
 * tenant has none by that uuid) and the admins' ids, the member among them if they're one.
 *
 * A change that could leave the tenant without an admin takes the admins: two that
 * each locked their own row first and then the rest (in no order) deadlocked, demoting or
 * removing both admins of a two-admin tenant at once. And it takes them with the member,
 * deciding under the lock: choosing from an unlocked read whether the member was an
 * admin, a demotion that read it before their promotion committed locked the member alone,
 * then the admins after them, out of id order. Deleting a user locks the same rows in the
 * same order (UserService). A row changed while the statement waited is read as it then
 * is; someone else's promotion committed meanwhile isn't counted, so at worst a change is
 * refused (LAST_ADMIN) that a retry would make.
 */
async function lockMember(
  trx: Transaction<DB>,
  tenantId: number,
  memberUuid: string,
  withAdmins: boolean
): Promise<{ member: { id: number; is_admin: boolean } | undefined; admins: number[] }> {
  const rows = await trx
    .selectFrom('tenant_users')
    .select(['id', 'uuid', 'is_admin'])
    .where('tenant_id', '=', tenantId)
    .where((eb) => (withAdmins ? eb.or([eb('uuid', '=', memberUuid), eb('is_admin', '=', true)]) : eb('uuid', '=', memberUuid)))
    .orderBy('id')
    .forUpdate()
    .execute();
  return { member: rows.find((r) => r.uuid === memberUuid), admins: rows.filter((r) => r.is_admin).map((r) => r.id) };
}

export async function setTenantMemberAdmin(
  tenantId: number,
  memberUuid: string,
  isAdmin: boolean
): Promise<void> {
  await globalDb.transaction().execute(async (trx) => {
    // A demotion takes the admins with the member (lockMember); a promotion, the member.
    const { member: target, admins } = await lockMember(trx, tenantId, memberUuid, !isAdmin);
    if (!target) throw new ControlPlaneError(404, 'MEMBER_NOT_FOUND', 'Member not found in this tenant.');
    // Demoting the last admin would orphan the tenant.
    if (target.is_admin && !isAdmin && admins.length <= 1) {
      throw new ControlPlaneError(409, 'LAST_ADMIN', 'This tenant must keep at least one admin.');
    }
    await trx
      .updateTable('tenant_users')
      .set({ is_admin: isAdmin, updated_at: sql<Date>`NOW()` })
      .where('id', '=', target.id)
      .execute();
  });
}

export async function removeTenantMember(tenantId: number, memberUuid: string): Promise<void> {
  await globalDb.transaction().execute(async (trx) => {
    // The member and the admins, in id order in one statement (lockMember).
    const { member: target, admins } = await lockMember(trx, tenantId, memberUuid, true);
    if (!target) throw new ControlPlaneError(404, 'MEMBER_NOT_FOUND', 'Member not found in this tenant.');
    if (target.is_admin && admins.length <= 1) {
      throw new ControlPlaneError(
        409,
        'LAST_ADMIN',
        'This tenant must keep at least one admin. Promote another member first.'
      );
    }
    await trx.deleteFrom('tenant_users').where('id', '=', target.id).execute();
  });
}

/**
 * Create a new tenant in an organization and make the creator its admin. A new
 * tenant starts empty (no accounts/categories/periods) — exactly like a fresh
 * install; the owner sets it up through the normal UI.
 */
export async function createTenant(
  orgId: number,
  name: string,
  actorUserId: number
): Promise<{ uuid: string }> {
  return globalDb.transaction().execute(async (trx) => {
    await assertMayAddTenant(trx);
    const tenant = await trx
      .insertInto('tenants')
      .values({ organization_id: orgId, name })
      .returning(['id', 'uuid'])
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('tenant_users')
      .values({ user_id: actorUserId, tenant_id: tenant.id, is_admin: true, created_by: actorUserId })
      .execute();
    return { uuid: tenant.uuid };
  });
}

/**
 * Set global account flags (is_locked / login_disabled) on a tenant member's
 * user. Authorized for org admins and deployment admins (see the route guard,
 * which uses `requireOrgAdmin` — tenant-only admins cannot change these); an org
 * admin only for someone the ledger's organization alone answers for
 * (applyUserAccountFlags).
 */
export async function setTenantMemberFlags(
  tenantId: number,
  memberUuid: string,
  flags: UserAccountFlags,
  actor: FlagsActor
): Promise<void> {
  const target = await globalDb
    .selectFrom('tenant_users as tu')
    .innerJoin('users as u', 'u.id', 'tu.user_id')
    .select('u.id as userId')
    .where('tu.uuid', '=', memberUuid)
    .where('tu.tenant_id', '=', tenantId)
    .executeTakeFirst();
  if (!target) throw new ControlPlaneError(404, 'MEMBER_NOT_FOUND', 'Member not found in this tenant.');
  await applyUserAccountFlags(target.userId, flags, actor);
}
