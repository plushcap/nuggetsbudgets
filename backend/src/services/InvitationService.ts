import { createHash, randomBytes } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { globalDb } from '../db/withTenant.js';
import type { DB } from '../db/schema.generated.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import type {
  AcceptedInvitationDto,
  CreateInvitationInput,
  CreatedInvitationDto,
  InvitationDto,
  InvitationPreviewDto,
} from '@nuggets/shared';

/**
 * Invitations to join an organization. An organization's admins can't add
 * people themselves: they invite an email address, and a signed-in user with that
 * address joins by accepting with the link's one-time token.
 *
 * `organization_invitations` is a control-plane table (no tenant_id, no RLS), so
 * every query here is scoped to one organization, or to one token, in code.
 *
 * Nothing here tells an admin whether a user with the invited address exists or
 * is already a member: creating an invitation never looks at users. Nothing tells
 * the person holding a token why it doesn't work either: every refusal is
 * {@link invitationInvalid}.
 */

export const INVITATION_TTL_DAYS = 7;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SHA-256 (hex) of a token: what the table stores in place of the token. */
export const hashInvitationToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** The single answer for an invitation that doesn't exist, has ended, or is someone else's. */
const invitationInvalid = () =>
  new ControlPlaneError(
    404,
    'INVITATION_INVALID',
    "This invitation can't be used. It may have expired, been withdrawn or already been used, " +
      "or it was sent to another email address than the one you're signed in with."
  );

type Db = Kysely<DB> | Transaction<DB>;

interface InvitationRow {
  uuid: string;
  email: string;
  is_admin: boolean;
  created_at: Date | string;
  expires_at: Date | string;
  expired: boolean;
  inviterId: number | null;
  inviterFirstName: string | null;
  inviterLastName: string | null;
}

const iso = (value: Date | string) => new Date(value).toISOString();

function toInvitationDto(r: InvitationRow): InvitationDto {
  return {
    uuid: r.uuid,
    email: r.email,
    isAdmin: r.is_admin,
    status: r.expired ? 'expired' : 'pending',
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    invitedBy: r.inviterId == null ? null : { firstName: r.inviterFirstName, lastName: r.inviterLastName },
  };
}

/** Invitations of one organization that haven't been accepted or revoked (expired ones too). */
function openInvitations(db: Db, orgId: number) {
  return db
    .selectFrom('organization_invitations as i')
    .leftJoin('users as inviter', 'inviter.id', 'i.invited_by')
    .select([
      'i.uuid',
      'i.email',
      'i.is_admin',
      'i.created_at',
      'i.expires_at',
      'inviter.id as inviterId',
      'inviter.first_name as inviterFirstName',
      'inviter.last_name as inviterLastName',
    ])
    .select(sql<boolean>`i.expires_at <= NOW()`.as('expired'))
    .where('i.organization_id', '=', orgId)
    .where('i.accepted_at', 'is', null)
    .where('i.revoked_at', 'is', null);
}

/**
 * Invite `email` to the organization. Answers the same whatever the address: it
 * doesn't look at users at all. An open invitation to the same address is
 * superseded (revoked), so its link stops working. The token is returned once,
 * for the admin to share, and only its hash is kept.
 */
export async function createInvitation(
  orgId: number,
  input: CreateInvitationInput,
  actorUserId: number
): Promise<CreatedInvitationDto> {
  const token = randomBytes(32).toString('base64url');
  const email = input.email.trim().toLowerCase();
  const invitation = await globalDb.transaction().execute(async (trx) => {
    // One invitation to this organization at a time, so a concurrent invite to the
    // same address supersedes this one instead of failing the open-invitation index.
    await trx.selectFrom('organizations').select('id').where('id', '=', orgId).forNoKeyUpdate().executeTakeFirstOrThrow();
    await revokeOpenInvitationsTo(trx, orgId, email);
    const inserted = await trx
      .insertInto('organization_invitations')
      .values({
        organization_id: orgId,
        email,
        is_admin: input.isAdmin ?? false,
        token_hash: hashInvitationToken(token),
        invited_by: actorUserId,
        expires_at: sql<Date>`NOW() + make_interval(days => ${INVITATION_TTL_DAYS})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return openInvitations(trx, orgId).where('i.id', '=', inserted.id).executeTakeFirstOrThrow();
  });
  return { invitation: toInvitationDto(invitation), token };
}

/** The organization's open invitations, newest first. */
export async function listInvitations(orgId: number): Promise<InvitationDto[]> {
  const rows = await openInvitations(globalDb, orgId).orderBy('i.created_at', 'desc').orderBy('i.id', 'desc').execute();
  return rows.map(toInvitationDto);
}

/** Withdraw an open invitation of this organization; its link stops working. */
export async function revokeInvitation(orgId: number, invitationUuid: string): Promise<void> {
  const notFound = () =>
    new ControlPlaneError(404, 'INVITATION_NOT_FOUND', 'No open invitation with that id in this organization.');
  if (!UUID_RE.test(invitationUuid)) throw notFound();
  const result = await globalDb
    .updateTable('organization_invitations')
    .set({ revoked_at: sql<Date>`NOW()` })
    .where('uuid', '=', invitationUuid)
    .where('organization_id', '=', orgId)
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) throw notFound();
}

/**
 * The invitation `token` names, if `userId` may accept it now: it is open and
 * unexpired, its organization is active, it was sent to the user's email
 * (compared case-insensitively), and the person who sent it may still invite: an
 * admin of the organization, or a deployment admin. An invitation is the inviter's
 * authority, so it ends with it; otherwise an admin who was demoted or removed could
 * still bring people in, and an admin invitation they had sent themselves would make
 * them an admin again. Otherwise {@link invitationInvalid}, whatever the reason.
 * With `lock`, the invitation row is locked for the transaction.
 */
async function usableInvitation(db: Db, token: string, userId: number, lock: boolean) {
  const invitation = await db
    .selectFrom('organization_invitations as i')
    .innerJoin('organizations as o', 'o.id', 'i.organization_id')
    .leftJoin('users as inviter', 'inviter.id', 'i.invited_by')
    .select([
      'i.id',
      'i.email',
      'i.is_admin',
      'i.expires_at',
      'i.invited_by',
      'o.id as orgId',
      'o.uuid as orgUuid',
      'o.name as orgName',
      'inviter.id as inviterId',
      'inviter.first_name as inviterFirstName',
      'inviter.last_name as inviterLastName',
    ])
    .where('i.token_hash', '=', hashInvitationToken(token))
    .where('i.accepted_at', 'is', null)
    .where('i.revoked_at', 'is', null)
    .where(sql<boolean>`i.expires_at > NOW()`)
    .where('o.status', '=', 'active')
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom('organization_users as ou')
            .select('ou.id')
            .whereRef('ou.organization_id', '=', 'i.organization_id')
            .whereRef('ou.user_id', '=', 'i.invited_by')
            .where('ou.is_admin', '=', true)
        ),
        eb.exists(
          eb
            .selectFrom('deployment_users as du')
            .select('du.id')
            .whereRef('du.user_id', '=', 'i.invited_by')
            .where('du.role', '=', 'admin')
        ),
      ])
    )
    .$if(lock, (qb) => qb.forUpdate('i'))
    .executeTakeFirst();
  if (!invitation) throw invitationInvalid();
  if (lock && !(await lockForAccept(db, invitation.orgId, userId, invitation.invited_by))) throw invitationInvalid();
  const user = await db.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirst();
  if (!user || user.email.trim().toLowerCase() !== invitation.email) throw invitationInvalid();
  return invitation;
}

/**
 * For the accepting transaction, after the invitation's lock: lock what accepting changes
 * and counts on, in the lock order (membershipLocks.ts), and re-check the sender under
 * it. Answers whether the sender may still invite (and the person accepting still has an
 * account).
 *
 * - The accepter's and sender's `users` rows, FOR KEY SHARE (what the membership's foreign
 *   keys take), in id order: a delete of either waits for this, or this for it.
 * - Their memberships of the organization, in id order in one statement: the upsert
 *   updates the accepter's, and the sender's must stay an admin's. Locking the sender's
 *   first and the accepter's in the upsert (by role, not id) deadlocked with a demotion,
 *   a removal or a user's delete that locked the organization's admins in id order.
 * - When the sender isn't an admin of it, their deployment_users row (FOR SHARE, through
 *   lock_deployment_admin).
 *
 * The check in the query above doesn't lock: a demotion that committed between it and the
 * upsert would otherwise lose to the upsert (`is_admin OR excluded.is_admin`), and a
 * demoted admin's own admin invitation would make them an admin again. A demotion holding
 * the row waits for this, or this waits for it and finds the row no longer an admin's.
 */
async function lockForAccept(db: Db, orgId: number, userId: number, senderId: number | null): Promise<boolean> {
  if (senderId == null) return false;
  const people = await db.selectFrom('users').select('id').where('id', 'in', [userId, senderId]).orderBy('id').forKeyShare().execute();
  // Deleted since the invitation was read.
  if (!people.some((p) => p.id === userId)) return false;
  const memberships = await db
    .selectFrom('organization_users')
    .select(['user_id', 'is_admin'])
    .where('organization_id', '=', orgId)
    .where('user_id', 'in', [userId, senderId])
    .orderBy('id')
    .forUpdate()
    .execute();
  if (memberships.some((m) => m.user_id === senderId && m.is_admin)) return true;
  // FOR SHARE through the function: the serving role has no UPDATE on deployment_users,
  // which a row lock needs.
  const deploymentAdmin = await sql<{ held: boolean }>`SELECT lock_deployment_admin(${senderId}) AS held`.execute(db);
  return deploymentAdmin.rows[0]?.held === true;
}

/** What accepting `token` would do, for the invited person only. */
export async function inspectInvitation(token: string, userId: number): Promise<InvitationPreviewDto> {
  const invitation = await usableInvitation(globalDb, token, userId, false);
  const membership = await globalDb
    .selectFrom('organization_users')
    .select('id')
    .where('organization_id', '=', invitation.orgId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return {
    organization: { uuid: invitation.orgUuid, name: invitation.orgName },
    email: invitation.email,
    isAdmin: invitation.is_admin,
    expiresAt: iso(invitation.expires_at),
    invitedBy:
      invitation.inviterId == null
        ? null
        : { firstName: invitation.inviterFirstName, lastName: invitation.inviterLastName },
    alreadyMember: !!membership,
  };
}

/**
 * Accept `token` as `userId`: in one transaction, make them a member of the
 * organization (an admin if the invitation says so; someone already a member
 * keeps their membership, and is never demoted) and mark the invitation used.
 */
export async function acceptInvitation(token: string, userId: number): Promise<AcceptedInvitationDto> {
  return globalDb.transaction().execute(async (trx) => {
    const invitation = await usableInvitation(trx, token, userId, true);
    const membership = await trx
      .insertInto('organization_users')
      .values({
        user_id: userId,
        organization_id: invitation.orgId,
        is_admin: invitation.is_admin,
        created_by: invitation.invited_by,
      })
      .onConflict((oc) =>
        oc.columns(['user_id', 'organization_id']).doUpdateSet({
          is_admin: sql<boolean>`organization_users.is_admin OR excluded.is_admin`,
        })
      )
      .returning('is_admin')
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('organization_invitations')
      .set({ accepted_at: sql<Date>`NOW()`, accepted_by: userId })
      .where('id', '=', invitation.id)
      .execute();
    return { organization: { uuid: invitation.orgUuid, name: invitation.orgName }, isAdmin: membership.is_admin };
  });
}

/**
 * Revoke the open invitations of one organization to `email`, in the caller's
 * transaction (used when someone is removed from the organization, so an older
 * invitation can't bring them back).
 */
export async function revokeOpenInvitationsTo(trx: Transaction<DB>, orgId: number, email: string): Promise<void> {
  await trx
    .updateTable('organization_invitations')
    .set({ revoked_at: sql<Date>`NOW()` })
    .where('organization_id', '=', orgId)
    .where('email', '=', email.trim().toLowerCase())
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .execute();
}
