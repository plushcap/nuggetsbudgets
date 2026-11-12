import { sql } from 'kysely';
import type { Kysely, Transaction, UpdateObject } from 'kysely';
import type { DB } from '../db/schema.generated.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import { revokeAllUserCredentials, withUserCredentialLock } from './personalAccessTokens.js';

/** Global account flags that can be toggled from the member-management UIs. */
export interface UserAccountFlags {
  isLocked?: boolean;
  loginDisabled?: boolean;
}

/** Who is changing the flags, and from which organization's member list. */
export interface FlagsActor {
  userId: number;
  isDeploymentAdmin: boolean;
  /** The organization whose admin the actor is acting as (the org in the URL, or the active ledger's). */
  organizationId: number;
}

/**
 * Apply global account flags (is_locked / login_disabled) to a single user.
 * Shared by the org- and tenant-member management endpoints; the caller has
 * already checked that the actor administers `actor.organizationId` (or is a
 * deployment admin) and that the target is one of its members.
 *
 * - Refuses to lock or disable the actor's own account (self-lockout guard).
 * - Takes effect immediately: locking revokes the user's sessions and personal
 *   access tokens; disabling sign-in revokes their sessions only, since a
 *   service account works through its tokens.
 * - These flags live on the global `users` row, so they reach the person on
 *   every ledger and organization. An organization admin may only change them
 *   for someone the organization alone answers for: not a deployment admin, and
 *   with no organization or ledger membership anywhere else. Anyone else is a
 *   deployment admin's call (403), or an org admin of one family could lock
 *   out another family's members, or the deployment's own admins.
 */
export async function applyUserAccountFlags(
  targetUserId: number,
  flags: UserAccountFlags,
  actor: FlagsActor,
  opts: AccountFlagOptions = {}
): Promise<AccountFlagsRevocation | null> {
  return (await applyUserAccountFlagsAnd(targetUserId, flags, actor, opts)).revoked;
}

/**
 * {@link applyUserAccountFlags}, answering also what `opts.readBack` read: in the same
 * transaction, under the user's row lock, after the update and the revocation. So it reads
 * this change's own write: read after the commit, a change another admin made right after
 * it could show in its answer.
 */
export async function applyUserAccountFlagsAnd<T = undefined>(
  targetUserId: number,
  flags: UserAccountFlags,
  actor: FlagsActor,
  opts: AccountFlagOptions<T> = {}
): Promise<{ revoked: AccountFlagsRevocation | null; readBack: T | undefined }> {
  assertNotRestrictingSelf(targetUserId, flags, actor);

  // Under the user's row lock (FOR UPDATE): a membership insert checks its foreign key
  // with a share lock on this row, so none can land between the check below and the
  // update, and nothing created while this runs survives the revocation.
  return withUserCredentialLock(targetUserId, async (trx) => {
    await assertMayChangeAccountFlags(trx, targetUserId, actor);
    const prepared = opts.beforeWrite ? await opts.beforeWrite(trx) : undefined;
    await trx
      .updateTable('users')
      .set({ ...withoutFlagColumns({ ...opts.profile, ...prepared }), ...accountFlagUpdates(flags) })
      .where('id', '=', targetUserId)
      .execute();
    const revoked = await revokeForAccountFlags(trx, targetUserId, flags);
    return { revoked, readBack: opts.readBack ? await opts.readBack(trx) : undefined };
  });
}

/** Options for {@link applyUserAccountFlags}. */
export interface AccountFlagOptions<T = undefined> {
  /**
   * Other `users` columns to set in the same update (the deployment admin's Users page
   * edits the profile and the flags in one save).
   */
  profile?: ProfileUpdates;
  /**
   * Run under the user's row lock, before the update: a check that must see the rows as they
   * stand once locked (throw to refuse, rolling everything back), or writes that go with the
   * change (a new profile picture). Answers more profile columns to set.
   */
  beforeWrite?: (trx: Transaction<DB>) => Promise<ProfileUpdates | undefined>;
  /** What to read back under the lock, before the commit ({@link applyUserAccountFlagsAnd}). */
  readBack?: (trx: Transaction<DB>) => Promise<T>;
}

/** `users` columns other than the flags: those change through `flags`, which revokes. */
export type ProfileUpdates = Omit<UpdateObject<DB, 'users'>, 'is_locked' | 'login_disabled'>;

/** The profile columns without a flag column, should a caller slip one in past the type. */
function withoutFlagColumns(profile: ProfileUpdates | undefined): ProfileUpdates {
  const { is_locked: _locked, login_disabled: _disabled, ...rest } = (profile ?? {}) as UpdateObject<DB, 'users'>;
  return rest;
}

/** What a lock or a sign-in disable revoked. */
export interface AccountFlagsRevocation {
  reason: string;
  sessionsRevoked: number;
  tokensRevoked: number;
}

/** Refuse to lock or disable sign-in on the actor's own account (self-lockout guard). */
function assertNotRestrictingSelf(targetUserId: number, flags: UserAccountFlags, actor: Pick<FlagsActor, 'userId'>): void {
  if (targetUserId === actor.userId && (flags.isLocked === true || flags.loginDisabled === true)) {
    throw new ControlPlaneError(
      400,
      'CANNOT_RESTRICT_SELF',
      'You cannot lock or disable sign-in on your own account.'
    );
  }
}

/**
 * Refuse an organization admin a change to someone with access outside their
 * organization (a deployment admin decides those). Run under the user's row lock
 * (withUserCredentialLock), on its `trx`.
 */
async function assertMayChangeAccountFlags(trx: Kysely<DB>, targetUserId: number, actor: FlagsActor): Promise<void> {
  if (actor.isDeploymentAdmin) return;
  const outside = await sql<{ found: number }>`
    SELECT 1 AS found FROM deployment_users WHERE user_id = ${targetUserId}
    UNION ALL
    SELECT 1 FROM organization_users
     WHERE user_id = ${targetUserId} AND organization_id <> ${actor.organizationId}
    UNION ALL
    SELECT 1 FROM tenant_users tu JOIN tenants t ON t.id = tu.tenant_id
     WHERE tu.user_id = ${targetUserId} AND t.organization_id <> ${actor.organizationId}
    LIMIT 1
  `.execute(trx);
  if (outside.rows.length > 0) {
    throw new ControlPlaneError(
      403,
      'USER_OUTSIDE_ORG',
      'This person also has access outside this organization, so only a deployment admin can lock their account or change their sign-in.'
    );
  }
}

/** The `users` columns the flags set (only the ones given), and updated_at. */
function accountFlagUpdates(flags: UserAccountFlags): UpdateObject<DB, 'users'> {
  const updates: UpdateObject<DB, 'users'> = { updated_at: sql<Date>`NOW()` };
  if (flags.isLocked !== undefined) updates.is_locked = flags.isLocked;
  if (flags.loginDisabled !== undefined) updates.login_disabled = flags.loginDisabled;
  return updates;
}

/**
 * End the credentials the flags take away: locking revokes the user's sessions and
 * tokens, disabling sign-in their sessions only. Returns what it revoked, or null
 * when the flags take nothing away. Run under the user's row lock, after the update.
 */
async function revokeForAccountFlags(
  trx: Kysely<DB>,
  targetUserId: number,
  flags: UserAccountFlags
): Promise<AccountFlagsRevocation | null> {
  if (flags.isLocked !== true && flags.loginDisabled !== true) return null;
  const reason = flags.isLocked === true ? 'account_locked' : 'login_disabled';
  const revoked = await revokeAllUserCredentials(trx, targetUserId, reason, { keepTokens: flags.isLocked !== true });
  return { reason, ...revoked };
}
