import { z } from 'zod';
import { LOGIN_PASSWORD_MAX_LENGTH } from './passwordPolicy.js';
import { PERSONAL_ACCESS_TOKEN_SCOPES } from './vocabulary.js';

/**
 * POST /auth/login body. Replaces the express-validator chain on the login
 * route. Email is canonicalised to trimmed + lowercased (matching how signup
 * stores it via toLowerCase — NOT provider-specific normalizeEmail, which
 * stripped Gmail dots and could mismatch the stored address).
 *
 * The password is only bounded, never checked against the password policy: a
 * password set under an older or a different policy (MIN_PASSWORD_LENGTH,
 * REQUIRE_PASSWORD_COMPLEXITY) must still sign in, and a failed sign-in mustn't
 * say what the policy is. The policy applies where a password is set
 * (passwordPolicy.ts).
 */
export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: 'Must be a valid email address' })),
  password: z
    .string({ error: 'Password is required' })
    .min(1, 'Password is required')
    .max(LOGIN_PASSWORD_MAX_LENGTH, 'Password is too long'),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * A passkey's name as its owner gives it (passkey_credentials.device_name is
 * varchar(255)), trimmed.
 */
const passkeyDeviceName = z
  .string({ error: 'Device name is required' })
  .trim()
  .max(255, 'Device name must be at most 255 characters');

/**
 * A WebAuthn response as the browser hands it over (@simplewebauthn's
 * AuthenticationResponseJSON / RegistrationResponseJSON): an object with the credential's
 * id, its other fields kept as they are. The ceremony checks the rest.
 */
const webAuthnResponse = (message: string) => z.looseObject({ id: z.string({ error: message }) }, { error: message });

/**
 * POST /api/passkeys/auth/verify and /api/passkeys/reauthenticate/verify: the passkey's
 * answer to the challenge. Anything else in the body (an email, from an older page) is
 * dropped.
 */
export const passkeyAssertionSchema = z.object({ response: webAuthnResponse('A passkey response is required') });
export type PasskeyAssertionInput = z.infer<typeof passkeyAssertionSchema>;

/** POST /api/passkeys/register/verify: the new passkey's answer, and a name for it if given. */
export const passkeyRegistrationSchema = z.object({
  response: webAuthnResponse('Registration response is required'),
  deviceName: passkeyDeviceName.nullish(),
});
export type PasskeyRegistrationInput = z.infer<typeof passkeyRegistrationSchema>;

/** PUT /api/passkeys/:credentialId: the passkey's new name. */
export const passkeyRenameSchema = z.object({ deviceName: passkeyDeviceName.min(1, 'Device name is required') });
export type PasskeyRenameInput = z.infer<typeof passkeyRenameSchema>;

/**
 * DELETE /api/passkeys/:credentialId's answer: the passkey is gone. `rpId` is the relying party,
 * which the page hands the browser's `PublicKeyCredential.signalUnknownCredential` with the
 * deleted passkey's id, so the browser stops offering that one and no other.
 */
export const passkeyDeletedResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  rpId: z.string().min(1),
});
export type PasskeyDeletedResponse = z.infer<typeof passkeyDeletedResponseSchema>;

// ---- The signed-in person's own account (bodies checked before the handler runs) ----------

const PASSWORDS_REQUIRED = 'Current password and new password are required';

/**
 * PUT /api/auth/change-password body. The new password's policy is the server's
 * (`checkNewPassword`), checked after the current password, so it isn't here.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string({ error: PASSWORDS_REQUIRED }).min(1, PASSWORDS_REQUIRED),
  newPassword: z.string({ error: PASSWORDS_REQUIRED }).min(1, PASSWORDS_REQUIRED),
  /** Also remove every passkey of the account. */
  removePasskeys: z.boolean({ error: 'removePasskeys must be true or false' }).default(false),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

const PASSWORD_NEEDED = 'Your password is required';

/** POST /api/auth/reauthenticate body: the password, bounded as sign-in bounds it. */
export const reauthenticateSchema = z.object({
  password: z.string({ error: PASSWORD_NEEDED }).min(1, PASSWORD_NEEDED).max(LOGIN_PASSWORD_MAX_LENGTH, PASSWORD_NEEDED),
});
export type ReauthenticateInput = z.infer<typeof reauthenticateSchema>;

/** The lifetimes and scopes a personal access token may be minted with. */
export const PERSONAL_ACCESS_TOKEN_LIFETIMES = ['30d', '90d', '365d'] as const;
export const PERSONAL_ACCESS_TOKEN_DEFAULT_LIFETIME = '365d' satisfies (typeof PERSONAL_ACCESS_TOKEN_LIFETIMES)[number];
const TENANT_NEEDED = 'A tenant is required for the token';

/**
 * POST /api/auth/mcp-token body: a label (trimmed, at most 100 characters; 'mcp' when there
 * is none), a lifetime (365 days when not given), a scope (`read` when not given) and the
 * ledger the token is pinned to, by uuid.
 */
export const mcpTokenCreateSchema = z.object({
  label: z.unknown().optional().transform((label) => (typeof label === 'string' && label.trim() ? label.trim().slice(0, 100) : 'mcp')),
  expiresIn: z
    .enum(PERSONAL_ACCESS_TOKEN_LIFETIMES, { error: `expiresIn must be one of ${PERSONAL_ACCESS_TOKEN_LIFETIMES.join(', ')}` })
    .nullish()
    .transform((lifetime) => lifetime ?? PERSONAL_ACCESS_TOKEN_DEFAULT_LIFETIME),
  scope: z
    .enum(PERSONAL_ACCESS_TOKEN_SCOPES, { error: `scope must be one of ${PERSONAL_ACCESS_TOKEN_SCOPES.join(', ')}` })
    .nullish()
    .transform((scope) => scope ?? 'read'),
  tenantUuid: z
    .string({ error: TENANT_NEEDED })
    .trim()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, TENANT_NEEDED),
});
export type McpTokenCreateInput = z.infer<typeof mcpTokenCreateSchema>;

/**
 * PUT /api/auth/profile body (multipart: the picture is the file, these are its text fields).
 * A field left out is kept. Each is bounded by its column, which refused a longer one with a
 * 500: names and the icon at most 100 characters, the colour at most 7 ('#RRGGBB').
 */
export const ownProfileUpdateSchema = z.object({
  first_name: z.string({ error: 'first_name must be text' }).max(100, 'Keep the first name to 100 characters').optional(),
  last_name: z.string({ error: 'last_name must be text' }).max(100, 'Keep the last name to 100 characters').optional(),
  default_color: z.string({ error: 'default_color must be text' }).max(7, 'Give the colour as #RRGGBB').optional(),
  icon: z.string({ error: 'icon must be text' }).max(100, 'Keep the icon name to 100 characters').optional(),
  /** 'true' removes the picture (a FormData field is text). */
  remove_profile_image: z.enum(['true', 'false'], { error: 'remove_profile_image must be true or false' }).optional(),
});
export type OwnProfileUpdateInput = z.infer<typeof ownProfileUpdateSchema>;
