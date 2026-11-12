import { randomUUID } from 'crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { globalDb } from '../db/withTenant.js';
import type { DB } from '../db/schema.generated.js';
import { sessionService } from '../middleware/auth.js';
import { toTokenScope, type TokenLifetime, type TokenScope } from '../middleware/tokenAccess.js';
import { decodeTokenUnsafe, PAT_AUDIENCE, signPersonalAccessToken } from '../utils/jwt-helper.js';
import { createLogger } from '../utils/logger.js';
import { lockUserForAccessChange, lockUserForNewCredential } from './userCredentialLock.js';
import { AuthError } from './auth/authErrors.js';

const logger = createLogger({ service: 'PersonalAccessTokens' });

/**
 * Personal access tokens (MCP tokens) and ending a user's access.
 *
 * `personal_access_tokens` is a control-plane table without RLS, so every query here
 * names the user itself. Ending access and minting a token both take the user's row
 * lock (services/userCredentialLock.ts), so a token minted while the account changes
 * can't outlive the change. What a token may reach, and do there, is in
 * middleware/tokenAccess.ts.
 */

/**
 * Run `fn` in a transaction holding the user's row lock FOR UPDATE: make the account
 * change that ends access (lock, password, …) and revoke with revokeAllUserCredentials
 * inside it, on `trx`. Sign-ins, rotations and token mints in flight wait for it, or
 * finish first and are revoked by it.
 */
export function withUserCredentialLock<T>(userId: number, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return globalDb.transaction().execute(async (trx) => {
    await lockUserForAccessChange(trx, userId);
    return fn(trx);
  });
}

/** What Settings and the admin token list show about a token: metadata, never the token. */
export interface PersonalAccessTokenSummary {
  uuid: string;
  label: string;
  audience: string;
  scope: TokenScope;
  tenantUuid: string;
  tenantName: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
}

/** A user's tokens that still work (not revoked, not expired), newest first. */
export async function listActivePersonalAccessTokens(userId: number): Promise<PersonalAccessTokenSummary[]> {
  const rows = await globalDb
    .selectFrom('personal_access_tokens as pat')
    .innerJoin('tenants as t', 't.id', 'pat.tenant_id')
    .select([
      'pat.uuid', 'pat.label', 'pat.audience', 'pat.scope', 'pat.created_at', 'pat.expires_at', 'pat.last_used_at',
      't.uuid as tenantUuid', 't.name as tenantName',
    ])
    .where('pat.user_id', '=', userId)
    .where('pat.revoked_at', 'is', null)
    .where('pat.expires_at', '>', sql<Date>`NOW()`)
    .orderBy('pat.created_at', 'desc')
    .execute();
  return rows.map((r) => ({
    uuid: r.uuid,
    label: r.label,
    audience: r.audience,
    scope: toTokenScope(r.scope),
    tenantUuid: r.tenantUuid,
    tenantName: r.tenantName,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
  }));
}

/**
 * Revoke every token of a user that isn't revoked yet. Returns how many were revoked.
 * `trx` holds the user's row lock (withUserCredentialLock).
 */
export async function revokeAllPersonalAccessTokens(trx: Kysely<DB>, userId: number, reason: string): Promise<number> {
  const revoked = await trx
    .updateTable('personal_access_tokens')
    .set({ revoked_at: sql<Date>`NOW()`, revoked_reason: reason })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute();
  logger.info({ userId, reason, tokensRevoked: revoked.length }, 'Revoked all personal access tokens of a user');
  return revoked.length;
}

/**
 * End a user's access: revoke all their sessions and, unless `keepTokens`, all their
 * personal access tokens. Locking a user and any password change or reset revoke
 * both, so the change takes effect at once for every credential the user holds
 * (passkeys are a separate matter). Disabling sign-in passes
 * `keepTokens`: a service account signs in only with its tokens.
 *
 * Call it inside withUserCredentialLock, on its `trx`, after the account change.
 */
export async function revokeAllUserCredentials(
  trx: Kysely<DB>,
  userId: number,
  reason: string,
  opts: { keepTokens?: boolean } = {}
): Promise<{ sessionsRevoked: number; tokensRevoked: number }> {
  const sessionsRevoked = await sessionService.revokeAllUserSessions(userId, reason, trx);
  const tokensRevoked = opts.keepTokens ? 0 : await revokeAllPersonalAccessTokens(trx, userId, reason);
  return { sessionsRevoked, tokensRevoked };
}

/**
 * Remove every passkey of `userId`, in `trx` (inside withUserCredentialLock): an admin's
 * password reset, or a password change whose user asked for it. A
 * passkey survives a password change otherwise, and one someone else enrolled while they
 * held the session would keep them signing in. Returns how many were removed.
 */
export async function removeAllUserPasskeys(trx: Kysely<DB>, userId: number): Promise<number> {
  const result = await trx.deleteFrom('passkey_credentials').where('user_id', '=', userId).executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}

/** What the request minting a token authenticated with, re-checked before the insert. */
export interface MintingCredential {
  userId: number;
  /** The browser session, for a cookie-authenticated request (else absent or undefined). */
  sessionId?: number | undefined;
  /** The personal access token, for a token-authenticated request (else absent or undefined). */
  patId?: number | undefined;
}

/**
 * Insert a minted token's row, under the user's row lock and only if the account and
 * the credential the request came with still stand: a lock, password change or token
 * revocation that committed after the request was authenticated is seen here, and one
 * that hasn't run yet waits for this insert and revokes the token. Returns null when
 * the request's credential no longer stands.
 */
export async function insertPersonalAccessToken(
  credential: MintingCredential,
  values: { tenantId: number; jti: string; label: string; audience: string; scope: TokenScope; expiresAt: Date }
): Promise<{ uuid: string; created_at: Date; expires_at: Date } | null> {
  return globalDb.transaction().execute(async (trx) => {
    const user = await lockUserForNewCredential(trx, credential.userId);
    if (!user || user.is_locked) return null;
    if (credential.sessionId !== undefined && !(await sessionService.sessionStillStands(trx, credential.sessionId))) {
      return null;
    }
    if (credential.patId !== undefined) {
      const pat = await trx
        .selectFrom('personal_access_tokens')
        .select('revoked_at')
        .where('id', '=', credential.patId)
        .where('user_id', '=', credential.userId)
        .executeTakeFirst();
      if (!pat || pat.revoked_at) return null;
    }
    const row = await trx
      .insertInto('personal_access_tokens')
      .values({
        user_id: credential.userId,
        tenant_id: values.tenantId,
        jti: values.jti,
        label: values.label,
        audience: values.audience,
        scope: values.scope,
        expires_at: values.expiresAt,
      })
      .returning(['uuid', 'created_at', 'expires_at'])
      .executeTakeFirstOrThrow();
    return { uuid: row.uuid, created_at: row.created_at, expires_at: row.expires_at };
  });
}

/** A token just minted: the token itself (shown once, never stored) and its row's metadata. */
export interface MintedPersonalAccessToken {
  token: string;
  jti: string;
  uuid: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Mint an MCP personal access token for `credential`'s user, pinned to `tenantId` (one they
 * may open: the caller checked it), with `scope` and `expiresIn`. Only the token's `jti` and
 * metadata are stored (insertPersonalAccessToken, under the user's row lock): refused 401
 * INVALID_SESSION when the session or token the request came with no longer stands.
 */
export async function mintPersonalAccessToken(
  credential: MintingCredential & { email: string },
  values: { tenantId: number; label: string; scope: TokenScope; expiresIn: TokenLifetime }
): Promise<MintedPersonalAccessToken> {
  const jti = randomUUID();
  const token = signPersonalAccessToken(
    { userId: credential.userId, email: credential.email, tenantId: values.tenantId, scope: values.scope },
    { expiresIn: values.expiresIn, jwtid: jti }
  );

  // Decode our own just-signed token to read the absolute `exp` stamp so
  // the DB row stays consistent with the JWT without a second date parser.
  const decoded = decodeTokenUnsafe(token) as { exp?: number } | null;
  if (!decoded?.exp) {
    throw new Error('Minted token missing exp claim');
  }
  const expiresAt = new Date(decoded.exp * 1000);

  // Inserted under the user's row lock, and only if the session or token this request
  // came with still stands: a lock or password change that landed after the request
  // was authenticated must not leave a fresh token behind.
  const row = await insertPersonalAccessToken(
    { userId: credential.userId, sessionId: credential.sessionId, patId: credential.patId },
    { tenantId: values.tenantId, jti, label: values.label, audience: PAT_AUDIENCE, scope: values.scope, expiresAt }
  );
  if (!row) throw AuthError.sessionEnded();
  return { token, jti, uuid: row.uuid, createdAt: row.created_at, expiresAt: row.expires_at };
}

/**
 * Revoke one of `userId`'s own tokens that isn't revoked yet (Settings → MCP Access): 404
 * TOKEN_NOT_FOUND for any other uuid, another user's included. Answers its uuid and label.
 */
export async function revokeOwnPersonalAccessToken(userId: number, uuid: string): Promise<{ uuid: string; label: string }> {
  const revoked = await globalDb
    .updateTable('personal_access_tokens')
    .set({ revoked_at: sql<Date>`NOW()`, revoked_reason: 'user_revoked' })
    .where('uuid', '=', uuid)
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .returning(['uuid', 'label'])
    .executeTakeFirst();
  if (!revoked) throw AuthError.tokenNotFound();
  return revoked;
}
