import { z } from 'zod';
import { instant, nullableInstant } from './responses.js';
import { membershipSummarySchema } from './organizations.js';
import { personalAccessTokenScope } from './vocabulary.js';
import {
  DEFAULT_PASSWORD_POLICY,
  createNewPasswordSchema,
  passwordProblem,
  type PasswordPolicy,
} from './passwordPolicy.js';

/** POST /api/admin/users body under a password policy (the server's, from
 * GET /api/auth/password-policy): first/last name required, valid email
 * (lowercased like signup), and a password the policy accepts, for that email
 * too. Loose so any extra fields pass through. */
export const createUserCreateSchema = (policy: PasswordPolicy) =>
  z
    .looseObject({
      first_name: z.string({ error: 'First name is required' }).trim().min(1, 'First name is required'),
      last_name: z.string({ error: 'Last name is required' }).trim().min(1, 'Last name is required'),
      email: z
        .string()
        .trim()
        .toLowerCase()
        .pipe(z.email({ error: 'Valid email is required' })),
      password: createNewPasswordSchema(policy),
    })
    // The checks that need the email too (a password may not contain it).
    .superRefine((value, ctx) => {
      const problem = passwordProblem(value.password, policy, { email: value.email });
      if (problem) ctx.addIssue({ code: 'custom', path: ['password'], message: problem });
    });

/** The create-user body under the default password policy. */
export const userCreateSchema = createUserCreateSchema(DEFAULT_PASSWORD_POLICY);
export type UserCreateInput = z.infer<typeof userCreateSchema>;

/** PUT /api/admin/users/:uuid body (profile edit). Email is immutable and the
 * password is changed through a separate endpoint, so only first_name is
 * required here. Loose so last_name, icon/color, and the notification
 * preference fields pass through. */
export const userUpdateSchema = z.looseObject({
  first_name: z.string({ error: 'First name is required' }).trim().min(1, 'First name is required'),
});
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;

// ---- Answers ----------------------------------------------------------------

/**
 * The signed-in person's own account, as `GET /api/auth/me` answers it (`user`). A name may be
 * null: `users.first_name` and `last_name` are nullable, as the admin and member answers say.
 */
export const ownAccountResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  email: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  default_color: z.string().nullable(),
  icon: z.string().nullable(),
  profile_image: z.string().nullable(),
  created_at: instant,
  must_change_password: z.boolean(),
});
export type OwnAccount = z.infer<typeof ownAccountResponseSchema>;

/** The ledgers and organizations the person can see, and their roles (`membership`; `MembershipSummary`). */
export const membershipSummaryResponseSchema = membershipSummarySchema;

/** GET /api/auth/me. */
export const authMeResponseSchema = z.object({
  user: ownAccountResponseSchema,
  membership: membershipSummaryResponseSchema,
});
export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;

/**
 * One of the people who can open the active ledger (`GET /api/tenants/current/users`): its
 * members and its organization's admins, for the pickers that assign one. No email. A name
 * may be null (`users.first_name` and `last_name` are nullable).
 */
export const tenantUserResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  profile_image: z.string().nullable(),
  default_color: z.string().nullable(),
  icon: z.string().nullable(),
});
export type TenantUser = z.infer<typeof tenantUserResponseSchema>;
export const tenantUserListResponseSchema = z.array(tenantUserResponseSchema);

// ---- A deployment admin's people (/api/admin/users) ----------------------------------

/** An account as a deployment admin's Users page edits it (an edit's answer). */
export const adminUserResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  email: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  profile_image: z.string().nullable(),
  default_color: z.string().nullable(),
  icon: z.string().nullable(),
  is_locked: z.boolean(),
  login_disabled: z.boolean(),
  created_at: instant,
});
export type AdminUserResponse = z.infer<typeof adminUserResponseSchema>;

/** An account as GET /api/admin/users lists it: also whether it is a deployment admin. */
export const adminUserListItemResponseSchema = adminUserResponseSchema.extend({ is_deployment_admin: z.boolean() });
export type User = z.infer<typeof adminUserListItemResponseSchema>;
export const adminUserListResponseSchema = z.object({ users: z.array(adminUserListItemResponseSchema) });

/** A new account, as POST /api/admin/users (201) and first-run setup (POST /api/auth/setup-admin, 201) answer it. */
export const createdUserResponseSchema = z.object({
  message: z.string(),
  user: z.object({
    id: z.number().int(),
    email: z.string(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    created_at: instant,
  }),
});
export type CreatedUserResponse = z.infer<typeof createdUserResponseSchema>;

/** PUT /api/admin/users/:uuid: the account as saved. */
export const adminUserUpdatedResponseSchema = z.object({ message: z.string(), user: adminUserResponseSchema });

/** PATCH /api/admin/users/:uuid/deployment-admin: whether the account is a deployment admin now. */
export const deploymentAdminChangedResponseSchema = z.object({ success: z.literal(true), is_deployment_admin: z.boolean() });

/** DELETE /api/admin/users/:uuid: the account deleted. */
export const userDeletedResponseSchema = z.object({
  message: z.string(),
  deletedUser: z.object({ id: z.number().int(), email: z.string() }),
});

/** A password set, by its owner or a deployment admin: what it ended (every session and token, and passkeys if asked). */
const credentialsEnded = {
  sessionsRevoked: z.number().int(),
  tokensRevoked: z.number().int(),
  passkeysRemoved: z.number().int(),
};
/** PUT /api/admin/users/:uuid/change-password. */
export const adminPasswordResetResponseSchema = z.object({ message: z.string(), ...credentialsEnded });
/** PUT /api/auth/change-password: the session has ended too; sign in again. */
export const passwordChangedResponseSchema = z.object({ success: z.literal(true), message: z.string(), ...credentialsEnded });
export type PasswordChangedResponse = z.infer<typeof passwordChangedResponseSchema>;

/** DELETE /api/admin/users/:uuid/tokens: how many of the account's tokens it revoked. */
export const userTokensRevokedResponseSchema = z.object({ message: z.string(), revokedCount: z.number().int() });

// ---- The signed-in person's own account (/api/auth) ----------------------------------

/**
 * POST /api/auth/login: signed in (the session is the cookie), and the account as GET
 * /api/auth/me answers it, which the page keeps as the signed-in person.
 * `must_change_password`: an admin set the password, which must be replaced first.
 */
export const loginResponseSchema = z.object({
  message: z.string(),
  user: ownAccountResponseSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** GET /api/auth/setup-status: whether the first account has been made. */
export const setupStatusResponseSchema = z.object({ setupComplete: z.boolean(), requiresSetup: z.boolean() });
export type SetupStatus = z.infer<typeof setupStatusResponseSchema>;

/** PUT /api/auth/profile: the account as saved (GET /me's fields, but must_change_password). */
export const ownProfileResponseSchema = ownAccountResponseSchema.omit({ must_change_password: true });
export type OwnProfile = z.infer<typeof ownProfileResponseSchema>;

/** A write about one's own sign-in that answers only what to say: signing out, ending a session. */
export const authMessageResponseSchema = z.object({ message: z.string() });

/** One of the signed-in person's sessions that still work (GET /api/auth/sessions); the request's own is `isCurrent`. */
export const ownSessionResponseSchema = z.object({
  uuid: z.uuid(),
  createdAt: instant,
  lastActivityAt: nullableInstant,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  isCurrent: z.boolean(),
});
export type OwnSession = z.infer<typeof ownSessionResponseSchema>;
export const ownSessionsResponseSchema = z.object({ sessions: z.array(ownSessionResponseSchema) });

/** POST /api/auth/reauthenticate and /api/passkeys/reauthenticate/verify: confirmed, for this long. */
export const reauthenticatedResponseSchema = z.object({ reauthenticated: z.literal(true), validForSeconds: z.number().int() });
export type ReauthResult = z.infer<typeof reauthenticatedResponseSchema>;

/** A personal access token that still works, as its owner (or a deployment admin) lists it: never the token. */
export const personalAccessTokenResponseSchema = z.object({
  uuid: z.uuid(),
  label: z.string(),
  audience: z.string(),
  scope: personalAccessTokenScope,
  tenantUuid: z.uuid(),
  tenantName: z.string(),
  createdAt: instant,
  expiresAt: instant,
  lastUsedAt: nullableInstant,
});
export type PersonalAccessTokenSummary = z.infer<typeof personalAccessTokenResponseSchema>;
export const personalAccessTokenListResponseSchema = z.array(personalAccessTokenResponseSchema);

/** POST /api/auth/mcp-token (201): the new token, shown only here. */
export const personalAccessTokenMintedResponseSchema = z.object({
  token: z.string(),
  uuid: z.uuid(),
  jti: z.string(),
  label: z.string(),
  audience: z.literal('mcp'),
  scope: personalAccessTokenScope,
  tenantUuid: z.uuid(),
  createdAt: instant,
  expiresAt: instant,
});
export type PersonalAccessTokenMinted = z.infer<typeof personalAccessTokenMintedResponseSchema>;

/** DELETE /api/auth/mcp-tokens/:uuid: the token revoked. */
export const personalAccessTokenRevokedResponseSchema = z.object({ message: z.string(), uuid: z.uuid() });

// ---- Passkeys (/api/passkeys) -----------------------------------------------------------

/**
 * The options a passkey ceremony starts with (@simplewebauthn's PublicKeyCredentialCreation-
 * or RequestOptionsJSON), handed to the browser's WebAuthn call as they came: the challenge is
 * checked, and the rest is WebAuthn's own.
 */
export const webAuthnOptionsResponseSchema = z.looseObject({ challenge: z.string().min(1) });

/** POST /api/passkeys/auth/verify: signed in with the passkey (the session is the cookie). */
export const passkeySignInResponseSchema = z.object({
  user: z.object({ id: z.number().int(), email: z.string() }),
});
export type PasskeySignInResponse = z.infer<typeof passkeySignInResponseSchema>;

/** POST /api/passkeys/register/verify: the new passkey saved. */
export const passkeyRegisteredResponseSchema = z.object({
  verified: z.literal(true),
  credentialId: z.string(),
  message: z.string(),
});
export type PasskeyRegistered = z.infer<typeof passkeyRegisteredResponseSchema>;

/**
 * A passkey as its owner's list (GET /api/passkeys) and a deployment admin's
 * (GET /api/admin/users/:uuid/passkeys) show it: never its key or counter. `discoverable`:
 * whether it signs in without an email, null when not known (some passkeys added before
 * email-free passkey sign-in).
 */
export const passkeySummaryResponseSchema = z.object({
  id: z.string(),
  deviceName: z.string().optional(),
  deviceType: z.string().optional(),
  backedUp: z.boolean().optional(),
  lastUsed: instant.optional(),
  createdAt: instant,
  discoverable: z.boolean().nullable(),
});
export type PasskeySummary = z.infer<typeof passkeySummaryResponseSchema>;
export const passkeyListResponseSchema = z.array(passkeySummaryResponseSchema);

/** PUT /api/passkeys/:credentialId, and a deployment admin's DELETE of one: done. */
export const passkeyChangedResponseSchema = z.object({ success: z.literal(true), message: z.string() });
