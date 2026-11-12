import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import { db as globalDb } from '../db.js';
import type { DB } from '../db/schema.generated.js';
import { LOGIN_PASSWORD_MAX_LENGTH } from '@nuggets/shared';
import { validateEmail } from '../utils/validation.js';
import { checkNewPassword, hashPassword } from '../utils/passwords.js';
import { createLogger } from '../utils/logger.js';
import { DomainError } from './domainErrors.js';
import { storeProfileImage, deleteProfileImage, imageUrl } from './ImageService.js';
import {
  listActivePersonalAccessTokens,
  revokeAllPersonalAccessTokens,
  revokeAllUserCredentials,
  removeAllUserPasskeys,
  withUserCredentialLock,
} from './personalAccessTokens.js';
import { applyUserAccountFlagsAnd, type ProfileUpdates, type UserAccountFlags } from './userFlagsService.js';
import { describePlaces, soleAdminOf } from './membershipLocks.js';
import { bootstrapFirstAdmin } from './DeploymentAdminService.js';
import { clearSetupToken, deploymentHasUsers, lockFirstRunSetup, setupTokenMatches } from './SetupTokenService.js';
import { sessionService } from '../middleware/auth.js';
import { AuthError, PasskeyError } from './auth/authErrors.js';
import { isStorableCredentialId, passkeyService } from './PasskeyService.js';

const logger = createLogger({ service: 'UserService' });

/**
 * People's accounts: creating one, the deployment admin's Users page (list, edit,
 * delete, password reset, tokens), and the people a ledger can assign work to.
 *
 * `users` and the membership tables are control-plane tables without RLS, so these run
 * on globalDb, and a query meant for one ledger's or organization's people joins through
 * `tenant_users` / `organization_users` itself.
 *
 * The rules every path that creates or changes an account keeps:
 * - a new password is checked with `checkNewPassword` and hashed with `hashPassword`;
 * - the `is_locked` / `login_disabled` flags change only through `applyUserAccountFlags`;
 * - ending access ends every credential: a password reset, a lock or a disabled sign-in
 *   revokes under the user's row lock (`withUserCredentialLock`, `revokeAllUserCredentials`);
 * - creating an account gives it no membership: people join an organization by accepting
 *   an invitation or by a deployment admin adding them, and a ledger takes only members of
 *   its organization. The first-run setup is the one exception, through
 *   `bootstrapFirstAdmin`.
 *
 * And a person's own account (/api/auth): who they are, their profile, changing
 * their password, and what a password sign-in and a re-authentication read.
 *
 * A refusal the caller can act on is a {@link UserError}, which the route wrapper answers
 * `{ error, code, message }` and any details it carries.
 */

/** A refusal with a status, a code and a message for people. */
export class UserError extends DomainError {}

const USER_NOT_FOUND = () => new UserError(404, 'USER_NOT_FOUND', 'User not found');
/** The signed-in user's own row is gone (deleted while the request ran): the code it has always had. */
const OWN_ACCOUNT_GONE = () => new UserError(404, 'NOT_FOUND', 'User not found');

/**
 * A short text field (a name, an icon) as given, trimmed; '' for anything but text. Not a
 * security control: the pages never render these as HTML.
 */
const trimmedText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
/** A user the uuid named isn't there a moment later: an internal failure (a 500), not a refusal. */
const DATA_INCONSISTENCY = () => new Error('Database inconsistency - user UUID found but user record missing');

/** The user's numeric id, or a 404 for a uuid no user has. */
export async function userIdByUuid(uuid: string): Promise<number> {
  // kept as raw sql (DB-function call)
  const result = await sql<{ user_id: number | null }>`SELECT get_user_id_by_uuid(${uuid}) as user_id`.execute(globalDb);
  const userId = result.rows[0]?.user_id;
  if (!userId) throw USER_NOT_FOUND();
  return userId;
}

// ---------------------------------------------------------------------------
// Creating an account
// ---------------------------------------------------------------------------

/** A new account's details as a sign-up form sends them. */
export interface NewUserInput {
  email?: unknown;
  password?: unknown;
  first_name?: unknown;
  last_name?: unknown;
}

/** A new account's details, checked and trimmed, with the password not yet hashed. */
export interface CheckedNewUser {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

/**
 * Check a new account's details: an email, a password and a first name are required,
 * the email must look like one, and the password must meet the policy. Returns
 * them trimmed, the email lower-cased.
 */
export async function checkNewUser(input: NewUserInput): Promise<CheckedNewUser> {
  const { email, password, first_name, last_name } = input;
  if (!email || !password || !first_name) {
    throw new UserError(400, 'MISSING_FIELDS', 'Email, password, and first name are required');
  }
  if (!validateEmail(email as string)) {
    throw new UserError(400, 'INVALID_EMAIL', 'Please provide a valid email address');
  }
  const passwordProblem = await checkNewPassword(password as string, { email: email as string });
  if (passwordProblem) throw new UserError(400, 'WEAK_PASSWORD', passwordProblem);

  return {
    // validateEmail refused whitespace, so there is none to trim.
    email: (email as string).toLowerCase(),
    password: password as string,
    firstName: trimmedText(first_name),
    lastName: trimmedText(last_name),
  };
}

/** What a create answers with. */
export interface CreatedUser {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  created_at: Date | null;
}

/**
 * Insert a checked account, its password hashed with hashPassword, on `executor`
 * (the caller's transaction, or globalDb). `mustChangePassword` is for a password someone
 * else chose: its user replaces it at their first sign-in. The account has no membership.
 */
export async function insertUser(
  executor: Kysely<DB>,
  user: CheckedNewUser & { passwordHash: string },
  opts: { mustChangePassword: boolean }
): Promise<CreatedUser> {
  return executor
    .insertInto('users')
    .values({
      email: user.email,
      password_hash: user.passwordHash,
      must_change_password: opts.mustChangePassword,
      first_name: user.firstName,
      last_name: user.lastName,
      password_changed_at: sql<Date>`NOW()`,
      created_at: sql<Date>`NOW()`,
      updated_at: sql<Date>`NOW()`,
    })
    .returning(['id', 'email', 'first_name', 'last_name', 'created_at'])
    .executeTakeFirstOrThrow();
}

/**
 * A deployment admin creates an account. The admin chose the password, so its user
 * replaces it when they first sign in: until then their session reaches little
 * but change-password. Membership is a separate step (an invitation, or the admin adding
 * them to an organization).
 */
export async function createUserByAdmin(input: NewUserInput): Promise<CreatedUser> {
  const user = await checkNewUser(input);
  const existing = await globalDb.selectFrom('users').select('id').where('email', '=', user.email).executeTakeFirst();
  if (existing) throw new UserError(400, 'USER_EXISTS', 'User already exists with this email');
  return insertUser(globalDb, { ...user, passwordHash: await hashPassword(user.password) }, { mustChangePassword: true });
}

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

/** Whether the deployment has an account yet: first-run setup runs only while it has none. */
export const deploymentHasAccounts = (): Promise<boolean> => deploymentHasUsers(globalDb);

const usersExist = () => new UserError(403, 'USERS_EXIST', 'Users already exist in system');
const invalidSetupToken = () =>
  new UserError(403, 'INVALID_SETUP_TOKEN', 'A valid setup token is required. The server log shows it; enter the newest one.');

/** First-run setup's body: the first admin's details and the one-time setup token. */
export interface FirstAdminInput extends NewUserInput {
  setup_token?: unknown;
}

/**
 * First-run setup: the first account, made the deployment admin and its
 * organization's, with an organization and a ledger (bootstrapFirstAdmin, which adopts
 * seeded ones). Only while the deployment has no account (else 403 USERS_EXIST), and only
 * with the one-time setup token the server logged (else 403 INVALID_SETUP_TOKEN), which it
 * spends; both checked before the rest of the body, then again under the setup lock, so of
 * two setups at once only one creates an admin. The ledger is the admin's last used, so the
 * session they are signed in with next opens in it. `requester` is for the log.
 */
export async function createFirstAdmin(input: FirstAdminInput, requester: { ip?: string | undefined }): Promise<CreatedUser> {
  if (await deploymentHasUsers(globalDb)) throw usersExist();
  if (!(await setupTokenMatches(globalDb, input.setup_token))) {
    logger.warn({ ip: requester.ip }, 'First-run admin setup refused: missing or wrong setup token');
    throw invalidSetupToken();
  }

  // The same checks as any new account: the fields, the email, the password policy.
  const checked = await checkNewUser(input);
  const passwordHash = await hashPassword(checked.password);

  // Create the first user and fully bootstrap the role hierarchy (deployment admin +
  // organization + ledger + memberships) in one transaction.
  const user = await globalDb.transaction().execute(async (trx) => {
    // The checks above ran outside any lock, so two setups at once could both pass them.
    // Take the setup lock and check again: a setup that waited for it sees the admin the
    // first one committed and is refused, and so is a token consumed or replaced meanwhile.
    await lockFirstRunSetup(trx);
    if (await deploymentHasUsers(trx)) throw usersExist();
    if (!(await setupTokenMatches(trx, input.setup_token))) throw invalidSetupToken();

    // They chose this password themselves. The one account created with memberships:
    // bootstrapFirstAdmin makes it the deployment admin and its organization's.
    const created = await insertUser(trx, { ...checked, passwordHash }, { mustChangePassword: false });
    const { tenantId } = await bootstrapFirstAdmin(trx, created.id);
    // A new session opens in the user's last-used ledger (SessionService.createSession), so
    // the new admin can load the ledger's data at once (no NO_ACTIVE_TENANT).
    await trx.updateTable('users').set({ last_tenant_id: tenantId }).where('id', '=', created.id).execute();
    // One-time: the token is spent with the admin it created.
    await clearSetupToken(trx);
    return created;
  });
  logger.info({ userId: user.id }, 'First admin created by first-run setup; setup token spent');
  return user;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The people who can open a ledger, for assignment pickers: its members and its
 * organization's admins.
 */
export function listTenantUsers(tenantId: number, organizationId: number) {
  return globalDb
    .selectFrom('users as u')
    .select(['u.id', 'u.uuid', 'u.first_name', 'u.last_name', 'u.profile_image', 'u.default_color', 'u.icon'])
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom('tenant_users as tu')
            .select('tu.id')
            .whereRef('tu.user_id', '=', 'u.id')
            .where('tu.tenant_id', '=', tenantId)
        ),
        eb.exists(
          eb
            .selectFrom('organization_users as ou')
            .select('ou.id')
            .whereRef('ou.user_id', '=', 'u.id')
            .where('ou.organization_id', '=', organizationId)
            .where('ou.is_admin', '=', true)
        ),
      ])
    )
    .orderBy('u.first_name')
    .orderBy('u.last_name')
    .execute();
}

/** Every account in the deployment, newest first, for the deployment admin's Users page. */
export function listAllUsers() {
  return globalDb
    .selectFrom('users as u')
    .leftJoin('deployment_users as du', (join) => join.onRef('du.user_id', '=', 'u.id').on('du.role', '=', 'admin'))
    .select([
      'u.id', 'u.uuid', 'u.email', 'u.first_name', 'u.last_name', 'u.profile_image', 'u.default_color', 'u.icon', 'u.is_locked', 'u.login_disabled', 'u.created_at',
    ])
    .select((eb) => eb('du.id', 'is not', null).as('is_deployment_admin'))
    .orderBy('u.created_at', 'desc')
    .execute();
}

// ---------------------------------------------------------------------------
// The deployment admin's edits
// ---------------------------------------------------------------------------

/** What the Users page's edit form sends. Each field changes only when it is sent (and valid). */
export interface AdminUserUpdate {
  first_name?: unknown;
  last_name?: unknown;
  is_locked?: unknown;
  login_disabled?: unknown;
  default_color?: unknown;
  icon?: unknown;
  remove_profile_image?: unknown;
}

/** An uploaded profile picture: its bytes and the type the client claimed. */
export interface ProfileImageUpload {
  mimeType: string;
  data: Buffer;
}

const USER_COLUMNS = [
  'id', 'uuid', 'email', 'first_name', 'last_name', 'profile_image', 'default_color', 'icon', 'is_locked', 'login_disabled', 'created_at',
] as const;

/**
 * A deployment admin edits an account: the profile, a new or removed picture, and the
 * flags. The flags go through applyUserAccountFlags with the profile, in one update under
 * the user's row lock: locking ends the user's sessions and tokens, disabling sign-in
 * their sessions (a service account works through its tokens).
 *
 * The admin can't lock their own account or disable their own sign-in.
 */
export async function updateUserByAdmin(uuid: string, fields: AdminUserUpdate, image: ProfileImageUpload | undefined, adminId: number) {
  const { first_name, last_name, is_locked, login_disabled, default_color, icon, remove_profile_image } = fields;
  const userId = await userIdByUuid(uuid);

  if (userId === adminId && is_locked === true) {
    throw new UserError(400, 'CANNOT_LOCK_OWN_ACCOUNT', 'Cannot lock your own account');
  }
  if (userId === adminId && login_disabled === true) {
    throw new UserError(400, 'CANNOT_DISABLE_OWN_LOGIN', 'Cannot disable login on your own account');
  }
  if (!(await globalDb.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst())) {
    throw DATA_INCONSISTENCY();
  }

  const profile: ProfileUpdates = {};
  const flags: UserAccountFlags = {};

  if (first_name) profile.first_name = trimmedText(first_name);
  if (last_name !== undefined) profile.last_name = trimmedText(last_name);

  // No import-user check: each ledger has its own import user (tenant_settings),
  // and the import uses one only while it is unlocked and has access to the ledger.
  if (typeof is_locked === 'boolean') flags.isLocked = is_locked;
  if (typeof login_disabled === 'boolean') flags.loginDisabled = login_disabled;

  // Profile pictures are user_profile_images rows, keyed by the user they belong to.
  const removeImage = remove_profile_image === 'true' || remove_profile_image === true;

  if (default_color && /^#[0-9A-F]{6}$/i.test(default_color as string)) profile.default_color = default_color as string;
  if (icon && typeof icon === 'string') profile.icon = icon.trim();

  if (Object.keys(profile).length === 0 && Object.keys(flags).length === 0 && !removeImage && !image) {
    throw new UserError(400, 'NO_FIELDS_PROVIDED', 'No valid fields provided for update');
  }
  profile.updated_at = sql<Date>`NOW()`;

  // A deployment admin may change anyone's flags; the self-lockout refusals ran above.
  // (organizationId only scopes an organization admin's change: a deployment admin's isn't.)
  // The answer is read in the same transaction, under the user's row lock: read after the
  // commit, another admin's edit of the same account right after this one could show in it.
  const { revoked, readBack: user } = await applyUserAccountFlagsAnd(
    userId,
    flags,
    { userId: adminId, isDeploymentAdmin: true, organizationId: 0 },
    {
      profile,
      beforeWrite: async (trx) => {
        // The acting admin's role, as it stands under the lock, as granting and
        // removing the role check it (DeploymentAdminService): the route checked it as the
        // request began, and a removal of it that committed since let the edit through
        // (locking someone out included). The function share-locks their deployment_users row
        // (step 5 of the lock order, after the user's row: membershipLocks.ts), so a removal
        // under way is waited for, and one that starts now waits for this edit. The admin's
        // own users row isn't locked: two admins editing each other at once would each hold
        // the other's (FOR UPDATE, the account edited) and wait for it.
        const held = await sql<{ held: boolean }>`SELECT lock_deployment_admin(${adminId}) AS held`.execute(trx);
        if (!held.rows[0]?.held) throw new UserError(403, 'DEPLOYMENT_ADMIN_REQUIRED', 'Deployment admin required');
        // The picture in the same transaction: written before it, it stayed when the
        // edit was then refused or failed.
        if (removeImage) {
          await deleteProfileImage(trx, userId);
          return { profile_image: null };
        }
        if (image) {
          // Replaces any previous one; its type is taken from its bytes.
          const imgUuid = await storeProfileImage(trx, userId, { mimeType: image.mimeType, data: image.data, createdByUserId: adminId });
          return { profile_image: imageUrl(imgUuid) };
        }
        return undefined;
      },
      readBack: (trx) => trx.selectFrom('users').select(USER_COLUMNS).where('id', '=', userId).executeTakeFirst(),
    }
  );
  if (revoked) logger.info({ adminId, targetUserId: userId, ...revoked }, 'Revoked user credentials');

  return user;
}

/**
 * The organizations and tenants `userId` is the only admin of, which deleting the user
 * would leave with none: removing or demoting a member refuses that (LAST_ADMIN), so this
 * does too. A deleted organization or tenant needs none.
 *
 * Locks, in the deleting transaction, every membership row the delete touches, and the
 * admins it counts: of each organization and tenant the user is in, the admin memberships,
 * the user's own, and the ones they created (the delete clears `created_by`): steps 3 and 4
 * of the lock order (membershipLocks.ts), after the user's row. So two deletes of an
 * organization's last two admins can't each count the other as the one who stays, and a
 * delete waits in turn with a demotion or removal of the same people rather than
 * deadlocking with it.
 */
async function placesLeftWithoutAdmin(trx: Transaction<DB>, userId: number) {
  const theirOrgs = trx.selectFrom('organization_users').select('organization_id').where('user_id', '=', userId);
  const orgRows = await trx
    .selectFrom('organization_users as ou')
    .innerJoin('organizations as o', 'o.id', 'ou.organization_id')
    .select(['ou.organization_id as placeId', 'ou.user_id', 'ou.is_admin', 'o.uuid', 'o.name', 'o.status'])
    .where((eb) =>
      eb.or([
        eb('ou.user_id', '=', userId),
        eb('ou.created_by', '=', userId),
        eb.and([eb('ou.is_admin', '=', true), eb('ou.organization_id', 'in', theirOrgs)]),
      ])
    )
    .orderBy('ou.id')
    .forUpdate('ou')
    .execute();
  const theirTenants = trx.selectFrom('tenant_users').select('tenant_id').where('user_id', '=', userId);
  const tenantRows = await trx
    .selectFrom('tenant_users as tu')
    .innerJoin('tenants as t', 't.id', 'tu.tenant_id')
    .innerJoin('organizations as o', 'o.id', 't.organization_id')
    .select(['tu.tenant_id as placeId', 'tu.user_id', 'tu.is_admin', 't.uuid', 't.name', 't.status', 'o.status as orgStatus'])
    .where((eb) =>
      eb.or([
        eb('tu.user_id', '=', userId),
        eb('tu.created_by', '=', userId),
        eb.and([eb('tu.is_admin', '=', true), eb('tu.tenant_id', 'in', theirTenants)]),
      ])
    )
    .orderBy('tu.id')
    .forUpdate('tu')
    .execute();
  // Counted: the admins of a place that isn't deleted.
  return {
    organizations: soleAdminOf(orgRows.filter((r) => r.is_admin && r.status !== 'deleted'), userId),
    tenants: soleAdminOf(tenantRows.filter((r) => r.is_admin && r.status !== 'deleted' && r.orgStatus !== 'deleted'), userId),
  };
}

/**
 * A deployment admin deletes an account (never their own). Answers what was deleted.
 * Refused (409 LAST_ADMIN, naming them) while the user is the only admin of an
 * organization or tenant, checked and deleted in one transaction.
 */
export async function deleteUserByAdmin(uuid: string, adminId: number): Promise<{ id: number; email: string }> {
  const userId = await userIdByUuid(uuid);
  if (userId === adminId) throw new UserError(400, 'CANNOT_DELETE_OWN_ACCOUNT', 'Cannot delete your own account');

  return globalDb.transaction().execute(async (trx) => {
    // The lock order (membershipLocks.ts): the invitations the delete changes (it clears
    // their invited_by / accepted_by), then the user's row, so no membership of theirs is
    // added meanwhile, then their memberships and the admins around them.
    await trx
      .selectFrom('organization_invitations')
      .select('id')
      .where((eb) => eb.or([eb('invited_by', '=', userId), eb('accepted_by', '=', userId)]))
      .orderBy('id')
      .forUpdate()
      .execute();
    // The user's row and the acting admin's, in id order: two admins deleting each other at
    // once each held the other's row and deleted it, and the deployment could be left with
    // no admin. Now the second waits, then finds its admin gone (or no longer one) and is
    // refused, so the one who acted first stays.
    const rows = await trx
      .selectFrom('users')
      .select(['id', 'email'])
      .where('id', 'in', [userId, adminId])
      .orderBy('id')
      .forUpdate()
      .execute();
    const user = rows.find((row) => row.id === userId);
    // Deleted since its uuid was looked up.
    if (!user) throw USER_NOT_FOUND();
    const adminRequired = () => new UserError(403, 'DEPLOYMENT_ADMIN_REQUIRED', 'Deployment admin required');
    // An early answer for an admin removed since the request began. It reads unlocked, so
    // it doesn't decide: the check under the deployment_users lock below does.
    const stillAdmin = await trx
      .selectFrom('deployment_users')
      .select('user_id')
      .where('user_id', '=', adminId)
      .where('role', '=', 'admin')
      .executeTakeFirst();
    if (!rows.some((row) => row.id === adminId) || !stillAdmin) throw adminRequired();

    const left = await placesLeftWithoutAdmin(trx, userId);
    if (left.organizations.length > 0 || left.tenants.length > 0) {
      throw new UserError(
        409,
        'LAST_ADMIN',
        `This user is the only admin of ${describePlaces(left)}. Make someone else an admin of each first.`,
        left
      );
    }

    // Last in the lock order, the deployment_users rows the delete changes (theirs, and the
    // ones they created: it clears created_by), which accepting a deployment admin's
    // invitation share-locks after the memberships, and the acting admin's, all in one
    // statement in id order, as removing an admin's role locks them. Then whether the
    // acting admin still is one, as their row stands once locked: a removal of their role
    // that committed after the check above still counted this user as the admin who stays,
    // and deleting them would leave neither. Through the function: the serving role has no
    // UPDATE on deployment_users, which a row lock needs.
    const locked = await sql<{ actor_is_admin: boolean }>`SELECT lock_deployment_users_of(${userId}, ${adminId}) AS actor_is_admin`.execute(trx);
    if (!locked.rows[0]?.actor_is_admin) throw adminRequired();
    await trx.deleteFrom('users').where('id', '=', userId).execute();
    return user;
  });
}

// ---------------------------------------------------------------------------
// Signing in, and a person's own account
// ---------------------------------------------------------------------------

/** What a password sign-in reads of the account an address names. */
export interface SignInAccount {
  id: number;
  uuid: string;
  email: string;
  default_color: string | null;
  icon: string | null;
  profile_image: string | null;
  password_hash: string;
  password_changed_at: Date | null;
  first_name: string | null;
  last_name: string | null;
  is_locked: boolean;
  login_disabled: boolean;
  must_change_password: boolean;
  created_at: Date | null;
}

/** The account with this (lower-cased) email, for a password sign-in; undefined when none has it. */
export function findAccountForSignIn(email: string): Promise<SignInAccount | undefined> {
  return globalDb
    .selectFrom('users')
    .select([
      'id', 'uuid', 'email', 'password_hash', 'password_changed_at', 'first_name', 'last_name', 'is_locked', 'login_disabled',
      'must_change_password', 'created_at', 'default_color', 'icon', 'profile_image',
    ])
    .where('email', '=', email)
    .executeTakeFirst();
}

/**
 * A hash made at another bcrypt cost than BCRYPT_ROUNDS, made again from the password a
 * sign-in just checked, so every account converges on the cost an unknown address is
 * compared at. Not a password change: password_changed_at and the sessions stand.
 * Only if the hash is still `checkedHash`; a failure is logged, and doesn't fail the sign-in.
 */
export async function rehashCheckedPassword(userId: number, checkedHash: string, password: string): Promise<void> {
  try {
    await globalDb
      .updateTable('users')
      .set({ password_hash: await hashPassword(password) })
      .where('id', '=', userId)
      .where('password_hash', '=', checkedHash)
      .execute();
  } catch (err) {
    logger.warn({ err, userId }, 'Could not rehash the password at the current bcrypt cost');
  }
}

/** Whether `password` is the account's (a re-authentication); false when the account is gone. */
export async function passwordIsCorrect(userId: number, password: string): Promise<boolean> {
  const user = await globalDb.selectFrom('users').select('password_hash').where('id', '=', userId).executeTakeFirst();
  return user !== undefined && (await bcrypt.compare(password, user.password_hash));
}

/** The signed-in person's own account, as GET /api/auth/me shows it. */
export async function getOwnAccount(userId: number) {
  const user = await globalDb
    .selectFrom('users')
    .select([
      'id', 'uuid', 'email', 'first_name', 'last_name', 'default_color', 'icon', 'profile_image', 'created_at',
      'must_change_password',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw OWN_ACCOUNT_GONE();
  return user;
}

/** What the profile form sends: each field is written as sent (one left out is kept). */
export interface OwnProfileUpdate {
  first_name?: unknown;
  last_name?: unknown;
  default_color?: unknown;
  icon?: unknown;
  remove_profile_image?: unknown;
}

/**
 * The signed-in person changes their own profile: names, colour, icon, and a new or removed
 * picture (a user_profile_images row of theirs: `users` is a control-plane table, written on
 * globalDb). Answers the account as it now stands.
 *
 * One transaction, as an admin's edit is: the picture is a row (bytea), not a
 * file, so written apart from the profile it stayed when the update then failed, a new picture
 * no profile named or a removed one the profile still named. The user's row is locked first,
 * as an admin's edit locks it before the picture, so the two wait for each other in turn.
 */
export async function updateOwnProfile(userId: number, fields: OwnProfileUpdate, image: ProfileImageUpload | undefined) {
  const { first_name, last_name, default_color, icon, remove_profile_image } = fields;
  return globalDb.transaction().execute(async (trx) => {
    const user = await trx.selectFrom('users').select('profile_image').where('id', '=', userId).forNoKeyUpdate().executeTakeFirst();
    if (!user) throw OWN_ACCOUNT_GONE();

    let profileImagePath = user.profile_image;
    if (remove_profile_image === 'true' && user.profile_image) {
      await deleteProfileImage(trx, userId);
      profileImagePath = null;
    }
    // A new picture replaces any previous one; its type is taken from its bytes.
    if (image) {
      const imgUuid = await storeProfileImage(trx, userId, { mimeType: image.mimeType, data: image.data, createdByUserId: userId });
      profileImagePath = imageUrl(imgUuid);
    }

    // A field that isn't sent is undefined, which Kysely leaves out of the update.
    return trx
      .updateTable('users')
      .set({
        first_name: first_name as string | undefined,
        last_name: last_name as string | undefined,
        default_color: default_color as string | undefined,
        icon: icon as string | undefined,
        profile_image: profileImagePath,
        updated_at: sql<Date>`NOW()`,
      })
      .where('id', '=', userId)
      .returning(['id', 'uuid', 'email', 'first_name', 'last_name', 'default_color', 'icon', 'profile_image', 'created_at'])
      .executeTakeFirst();
  });
}

/**
 * The signed-in person changes their own password, proving the current one. It ends every
 * session and personal access token they hold (forcing a new sign-in everywhere, and new
 * MCP tokens), and their passkeys too when they ask, under their row lock,
 * and it is no longer a password an admin set.
 *
 * Refused: 403 CURRENT_PASSWORD_INCORRECT for a wrong current password (checked first, so a
 * guess learns nothing of the policy and costs no breach-list lookup; 403, not 401: the
 * session still stands, and the app answers a 401 by signing out); 400 WEAK_PASSWORD for
 * the same password or one the policy refuses; 401 INVALID_SESSION when, during the check,
 * an admin reset the password or this session ended.
 */
export async function changeOwnPassword(
  account: { userId: number; email: string; sessionId: number | undefined },
  change: { currentPassword: string; newPassword: string; removePasskeys: boolean }
): Promise<{ sessionsRevoked: number; tokensRevoked: number; passkeysRemoved: number }> {
  const { userId } = account;
  const { currentPassword, newPassword } = change;
  const currentIncorrect = () => new UserError(403, 'CURRENT_PASSWORD_INCORRECT', 'Current password is incorrect');
  // Longer than any password sign-in takes: not the current one, and not worth bcrypt's time.
  if (currentPassword.length > LOGIN_PASSWORD_MAX_LENGTH) throw currentIncorrect();

  const user = await globalDb.selectFrom('users').select('password_hash').where('id', '=', userId).executeTakeFirst();
  if (!user) throw OWN_ACCOUNT_GONE();
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    logger.warn({ userId }, 'Invalid current password attempt');
    throw currentIncorrect();
  }

  if (newPassword === currentPassword) {
    throw new UserError(400, 'WEAK_PASSWORD', 'Choose a password different from your current one');
  }
  const passwordProblem = await checkNewPassword(newPassword, { email: account.email });
  if (passwordProblem) throw new UserError(400, 'WEAK_PASSWORD', passwordProblem);
  const hashedPassword = await hashPassword(newPassword);

  const revoked = await withUserCredentialLock(userId, async (trx) => {
    // The password was checked before the lock, during bcrypt. If an admin reset it, or this
    // session was signed out, since then, this change no longer has the authority it was
    // checked with: it would replace the admin's new password.
    const current = await trx.selectFrom('users').select('password_hash').where('id', '=', userId).executeTakeFirst();
    const sessionStands = account.sessionId !== undefined ? await sessionService.sessionStillStands(trx, account.sessionId) : false;
    if (current?.password_hash !== user.password_hash || !sessionStands) return null;
    // The user chose this one: no longer one an admin set.
    await writeNewPassword(trx, userId, hashedPassword, { mustChangePassword: false });
    const credentials = await revokeAllUserCredentials(trx, userId, 'password_changed');
    // Passkeys stay unless the user asks: someone changing a password
    // they think was seen may also suspect a passkey they didn't add.
    return { ...credentials, passkeysRemoved: change.removePasskeys ? await removeAllUserPasskeys(trx, userId) : 0 };
  });
  if (!revoked) {
    logger.warn({ userId }, 'Password change refused: the password or session changed while it ran');
    throw AuthError.sessionEnded();
  }
  return revoked;
}

/**
 * Write a new password (already checked and hashed) and record the change, so a session
 * from before it is refused. `mustChangePassword` is for a password someone else chose.
 * Run under the user's row lock, then revoke their credentials.
 */
export async function writeNewPassword(
  trx: Kysely<DB>,
  userId: number,
  passwordHash: string,
  opts: { mustChangePassword: boolean }
): Promise<void> {
  await trx
    .updateTable('users')
    .set({
      password_hash: passwordHash,
      password_changed_at: sql<Date>`NOW()`,
      must_change_password: opts.mustChangePassword,
      updated_at: sql<Date>`NOW()`,
    })
    .where('id', '=', userId)
    .execute();
}

/**
 * A deployment admin sets a new password for an account. It ends every session and
 * personal access token the user had (the admin's own, when it is their own password),
 * and removes their passkeys (one someone else enrolled would otherwise
 * keep them signing in after the reset meant to lock them out), under the user's row lock. A password set for someone else is replaced at their next
 * sign-in; one an admin sets for themselves is their own.
 */
export async function resetPasswordByAdmin(uuid: string, newPassword: unknown, adminId: number) {
  const userId = await userIdByUuid(uuid);
  if (!newPassword) throw new UserError(400, 'PASSWORD_REQUIRED', 'New password is required');

  const user = await globalDb.selectFrom('users').select(['id', 'email']).where('id', '=', userId).executeTakeFirst();
  if (!user) throw DATA_INCONSISTENCY();

  const passwordProblem = await checkNewPassword(newPassword as string, { email: user.email });
  if (passwordProblem) throw new UserError(400, 'WEAK_PASSWORD', passwordProblem);
  const passwordHash = await hashPassword(newPassword as string);

  const revoked = await withUserCredentialLock(userId, async (trx) => {
    await writeNewPassword(trx, userId, passwordHash, { mustChangePassword: userId !== adminId });
    const credentials = await revokeAllUserCredentials(trx, userId, 'admin_password_reset');
    return { ...credentials, passkeysRemoved: await removeAllUserPasskeys(trx, userId) };
  });
  logger.info({ adminId, targetUserId: userId, ...revoked }, 'Admin reset a user password');
  return revoked;
}

/** The account's personal access tokens that still work (metadata only). */
export async function listUserTokens(uuid: string) {
  return listActivePersonalAccessTokens(await userIdByUuid(uuid));
}

/** The account's passkeys, as the deployment admin's user page lists them (never a key). */
export async function listUserPasskeys(uuid: string) {
  return passkeyService.listPasskeys(await userIdByUuid(uuid));
}

/**
 * A deployment admin removes one of the account's passkeys (a lost device): 404
 * USER_NOT_FOUND for a uuid no user has, 404 PASSKEY_NOT_FOUND for a credential id that
 * isn't theirs, or can't be any passkey's (a NUL byte: checked before any query).
 */
export async function removeUserPasskey(uuid: string, credentialId: string, adminId: number): Promise<void> {
  if (!isStorableCredentialId(credentialId)) throw PasskeyError.notFound();
  const userId = await userIdByUuid(uuid);
  await passkeyService.removePasskey(userId, credentialId);
  logger.info({ adminUserId: adminId, targetUserId: userId, credentialId }, 'Admin deleted user passkey');
}

/** Revoke all of the account's personal access tokens, under the user's row lock. */
export async function revokeUserTokens(uuid: string, adminId: number): Promise<number> {
  const userId = await userIdByUuid(uuid);
  // Under the user's row lock, so a token being minted meanwhile is revoked too.
  const revokedCount = await withUserCredentialLock(userId, (trx) => revokeAllPersonalAccessTokens(trx, userId, 'admin_revoked'));
  logger.info({ adminId, targetUserId: userId, revokedCount }, 'Admin revoked a user\'s tokens');
  return revokedCount;
}
