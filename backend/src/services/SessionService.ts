/**
 * Session Management Service
 *
 * Handles server-side session lifecycle for session-based authentication:
 * - Session creation with max concurrent-session enforcement
 * - Session validation with a sliding idle timeout and an absolute lifetime from
 *   sign-in (both configurable, see utils/session-lifetime.ts)
 * - Session rotation (new session ID every hour for security), single-winner
 *   with a short grace window so concurrent requests aren't logged out
 * - Session revocation (single, all user sessions, on password change)
 *
 * Security features:
 * - 256-bit cryptographically secure random tokens
 * - SHA-256 hashed before database storage
 * - Sliding expiration extends on each request, up to the absolute lifetime
 * - Session rotation prevents session fixation attacks
 * - Password change invalidates all sessions, including ones from before the
 *   first recorded change
 */

import crypto from 'crypto';
import { sql, type Kysely } from 'kysely';
import { db as globalDb } from '../db.js';
import type { DB } from '../db/schema.generated.js';
import { createLogger } from '../utils/logger.js';
import { sessionAbsoluteMs, sessionExpiryFrom, sessionIdleMs } from '../utils/session-lifetime.js';
import { lockUserForNewCredential } from './userCredentialLock.js';
import { AuthError } from './auth/authErrors.js';

const logger = createLogger({ service: 'SessionService' });

// Session configuration. The idle timeout and absolute lifetime are settings
// (SESSION_IDLE_HOURS / SESSION_ABSOLUTE_DAYS), read in utils/session-lifetime.ts.
const SESSION_ROTATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
// After a token rotates, the old token stays valid for this long so in-flight
// requests carrying the previous cookie don't spuriously 401 before they pick up
// the new cookie. Short enough to bound a stolen old token's usefulness.
const SESSION_ROTATION_GRACE_MS = 60 * 1000; // 1 minute
const MAX_SESSIONS_PER_USER = 4;
/**
 * A request slides the session's expiry forward and records its activity, but at most
 * once per this long: writing the session row on every request made each
 * request a write to one hot row (and, with expires_at indexed, a non-HOT update). The
 * idle expiry lags by at most this much. Capped at half the idle timeout, so a session in
 * use never expires between two writes however short SESSION_IDLE_HOURS is.
 */
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** How long after its last recorded activity a session in use is written again. */
export function sessionTouchIntervalMs(): number {
  return Math.min(SESSION_TOUCH_INTERVAL_MS, sessionIdleMs() / 2);
}
/**
 * How recently the user must have proved their password or passkey in a session to mint
 * a personal access token or enroll a passkey. Signing in counts.
 */
export const REAUTH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export interface SessionData {
  userId: number;
  /** Unknown (undefined) when the request didn't say. */
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  deviceInfo?: Record<string, unknown>;
  /**
   * The user's password_changed_at as the sign-in read it when it checked the password
   * (or passkey). createSession refuses the session if it has changed since, so a
   * sign-in with the old password that finishes after a reset gets no session.
   */
  passwordChangedAt?: Date | null;
}

/** Why createSession refused to create a session. */
export type SessionRefusal = 'USER_NOT_FOUND' | 'ACCOUNT_LOCKED' | 'LOGIN_DISABLED' | 'PASSWORD_CHANGED';

/**
 * createSession found, under the user's row lock, that the account no longer allows the
 * sign-in it was asked to complete: it was locked, had sign-in disabled, or had its
 * password changed while the sign-in was in flight.
 */
export class SessionRefusedError extends Error {
  constructor(readonly code: SessionRefusal) {
    super(`Session refused: ${code}`);
    this.name = 'SessionRefusedError';
  }
}

/** The session and user columns judgeSession reads. */
const SESSION_CHECK_COLUMNS = [
  's.id', 's.user_id', 's.expires_at', 's.is_revoked', 's.last_rotated_at',
  's.revocation_reason', 's.revoked_at', 's.original_created_at',
  's.created_after_password_change_at', 'u.password_changed_at', 'u.is_locked', 'u.login_disabled',
] as const;

interface SessionCheckRow {
  expires_at: Date;
  is_revoked: boolean;
  revocation_reason: string | null;
  revoked_at: Date | null;
  original_created_at: Date;
  created_after_password_change_at: Date | null;
  password_changed_at: Date | null;
  is_locked: boolean | null;
  login_disabled: boolean;
}

type SessionVerdict =
  | { ok: true; grace: boolean }
  | { ok: false; why: string; revoke?: string };

/**
 * Whether a session still stands. `grace` marks a cookie retired by rotation that is
 * still inside its grace window. `revoke` names the reason to record on a session
 * that is not revoked yet but is over.
 */
function judgeSession(s: SessionCheckRow, now: number = Date.now()): SessionVerdict {
  if (s.is_locked) return { ok: false, why: 'Account is locked' };

  // Service accounts (automation-only) can't hold an interactive session.
  if (s.login_disabled) return { ok: false, why: 'Interactive login disabled for account' };

  // Absolute lifetime: however often it is used, a session ends this long after
  // the user signed in (rotation keeps original_created_at).
  if (now >= new Date(s.original_created_at).getTime() + sessionAbsoluteMs()) {
    return { ok: false, why: 'Session reached its absolute lifetime', revoke: 'absolute_lifetime_reached' };
  }

  // A session from before the latest password change is over. A session keeps
  // the password_changed_at it was created under; when the user has one and the
  // session has none, the session began while the user had no recorded change
  // (the column is nullable), so it predates this one: fail closed. Checked
  // before the rotation grace below, so a cookie retired by rotation doesn't
  // outlive a password change either.
  if (s.password_changed_at) {
    const snapshot = s.created_after_password_change_at ? new Date(s.created_after_password_change_at) : null;
    if (!snapshot || new Date(s.password_changed_at) > snapshot) {
      return { ok: false, why: 'Session invalidated due to password change', revoke: 'password_changed' };
    }
  }

  // A session revoked specifically for ROTATION stays valid for a short grace
  // window, so concurrent in-flight requests still carrying the previous cookie
  // don't spuriously 401 (they'll pick up the new cookie from the rotating
  // response). Hard revokes — logout, password change, max-sessions — carry other
  // reasons and are rejected immediately.
  if (s.is_revoked) {
    const rotatedWithinGrace =
      s.revocation_reason === 'rotated' &&
      s.revoked_at != null &&
      now - new Date(s.revoked_at).getTime() <= SESSION_ROTATION_GRACE_MS;
    return rotatedWithinGrace ? { ok: true, grace: true } : { ok: false, why: 'Attempted use of revoked session' };
  }

  if (new Date(s.expires_at).getTime() < now) return { ok: false, why: 'Attempted use of expired session' };

  return { ok: true, grace: false };
}

const sameInstant = (a: Date | null, b: Date | null) =>
  (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

export interface SessionRecord {
  id: number;
  uuid: string;
  userId: number;
  expiresAt: Date;
  createdAt: Date;
  lastActivityAt: Date | null;
  lastRotatedAt: Date | null;
  isRevoked: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  deviceInfo: Record<string, unknown> | null;
}

/** A session as its user's Sessions page shows it. */
export interface OwnSession {
  uuid: string;
  createdAt: Date;
  lastActivityAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
  isCurrent: boolean;
}

export interface ValidatedSession {
  sessionId: number;
  userId: number;
  needsRotation: boolean;
  /** True when accepted under the post-rotation grace window (don't slide/rotate). */
  graceRotated?: boolean;
}

export class SessionService {
  private db: Kysely<DB>;

  // Sessions are a control-plane table: the shared globalDb. `db` is a seam for tests.
  constructor(db: Kysely<DB> = globalDb) {
    this.db = db;
  }

  /**
   * Generate a cryptographically secure session token
   * 32 bytes (256 bits) in base64url format
   */
  generateSessionToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Hash session token using SHA-256
   * Tokens are hashed before storage to prevent theft if database is compromised
   */
  hashSessionToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Create a new session, enforcing max 2 sessions per user
   * If user has 2 sessions already, the oldest session is automatically revoked
   *
   * Refuses (SessionRefusedError) when, under the user's row lock, the account is
   * locked or has sign-in disabled, or its password changed since `passwordChangedAt`:
   * a lock or password change that landed while the sign-in was in flight wins.
   *
   * @returns The plain-text token (to be sent in cookie) and session ID
   */
  async createSession(data: SessionData): Promise<{ token: string; sessionId: number }> {
    const token = this.generateSessionToken();
    const tokenHash = this.hashSessionToken(token);
    const signedInAt = new Date();
    const expiresAt = sessionExpiryFrom(signedInAt, signedInAt.getTime());

    try {
      // Enforce max concurrent sessions - revoke oldest if needed
      await this.enforceMaxSessions(data.userId);

      const sessionId = await this.db.transaction().execute(async (trx) => {
        // Check and insert under the user's row lock (services/userCredentialLock.ts):
        // a lock, sign-in disable or password change either committed before this
        // and is seen here, or runs after it and revokes this session.
        const user = await lockUserForNewCredential(trx, data.userId);
        if (!user) throw new SessionRefusedError('USER_NOT_FOUND');
        if (user.is_locked) throw new SessionRefusedError('ACCOUNT_LOCKED');
        if (user.login_disabled) throw new SessionRefusedError('LOGIN_DISABLED');
        if (data.passwordChangedAt !== undefined && !sameInstant(data.passwordChangedAt, user.password_changed_at)) {
          throw new SessionRefusedError('PASSWORD_CHANGED');
        }

        const inserted = await trx
          .insertInto('sessions')
          .values({
            user_id: data.userId,
            session_token_hash: tokenHash,
            expires_at: expiresAt,
            ip_address: data.ipAddress || null,
            user_agent: data.userAgent || null,
            device_info: data.deviceInfo ? JSON.stringify(data.deviceInfo) : null,
            // Restore the user's durable last-used ledger (issue: the chosen ledger
            // had to be re-picked after every re-login). Null → ledger picker.
            active_tenant_id: user.last_tenant_id ?? null,
            // The user's own value, not the Date read above: a Date keeps milliseconds of the
            // column's microseconds, so the two compared exactly only in JS, never in SQL.
            // The row lock holds it as checked: a change takes the row FOR UPDATE.
            created_after_password_change_at: (eb) =>
              eb.selectFrom('users').select('password_changed_at').where('id', '=', data.userId),
            original_created_at: signedInAt,
            // Signing in proves the password or passkey, so it counts as re-authenticating.
            reauthenticated_at: signedInAt,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return inserted.id;
      });

      logger.info(
        { userId: data.userId, sessionId, expiresAt },
        'Session created successfully'
      );

      return { token, sessionId };
    } catch (error) {
      if (error instanceof SessionRefusedError) {
        logger.warn({ userId: data.userId, code: error.code }, 'Session refused: the account changed during sign-in');
        throw error;
      }
      logger.error({ err: error, userId: data.userId }, 'Failed to create session');
      throw new Error('Failed to create session', { cause: error });
    }
  }

  /**
   * Enforce maximum sessions per user by revoking oldest sessions
   * Called before creating a new session
   */
  private async enforceMaxSessions(userId: number): Promise<void> {
    try {
      const countRow = await this.db
        .selectFrom('sessions')
        .select((eb) => eb.fn.countAll().as('count'))
        .where('user_id', '=', userId)
        .where('is_revoked', '=', false)
        .where('expires_at', '>', sql<Date>`CURRENT_TIMESTAMP`)
        .executeTakeFirst();

      const activeCount = Number(countRow?.count ?? 0);

      if (activeCount >= MAX_SESSIONS_PER_USER) {
        // Revoke oldest sessions to make room for new one
        const sessionsToRevoke = activeCount - MAX_SESSIONS_PER_USER + 1;

        // Correlated UPDATE…WHERE id IN (SELECT…ORDER BY…LIMIT) — kept as raw sql.
        const result = await sql<{ id: number }>`
          UPDATE sessions
          SET is_revoked = TRUE,
              revoked_at = CURRENT_TIMESTAMP,
              revocation_reason = 'max_sessions_exceeded'
          WHERE id IN (
            SELECT id FROM sessions
            WHERE user_id = ${userId} AND is_revoked = FALSE AND expires_at > CURRENT_TIMESTAMP
            ORDER BY last_activity_at ASC
            LIMIT ${sessionsToRevoke}
          )
          RETURNING id
        `.execute(this.db);

        logger.info(
          { userId, sessionsRevoked: result.rows.length },
          'Revoked oldest sessions due to max sessions limit'
        );
      }
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to enforce max sessions');
      // Don't throw - session creation should still proceed
    }
  }

  /**
   * Validate a session token and extend expiration (sliding window)
   *
   * @returns Session info if valid, null if invalid/expired/revoked
   */
  async validateSession(token: string): Promise<ValidatedSession | null> {
    const tokenHash = this.hashSessionToken(token);

    try {
      const session = await this.db
        .selectFrom('sessions as s')
        .innerJoin('users as u', 'u.id', 's.user_id')
        .select([...SESSION_CHECK_COLUMNS, 's.last_activity_at'])
        .where('s.session_token_hash', '=', tokenHash)
        .executeTakeFirst();

      if (!session) {
        logger.debug('Session not found');
        return null;
      }

      const verdict = judgeSession(session);
      if (!verdict.ok) {
        logger.warn({ sessionId: session.id, userId: session.user_id }, verdict.why);
        if (verdict.revoke && !session.is_revoked) await this.revokeSession(session.id, verdict.revoke);
        return null;
      }
      if (verdict.grace) {
        // Accepted under grace: valid for now, but do not rotate again or slide it.
        return { sessionId: session.id, userId: session.user_id, needsRotation: false, graceRotated: true };
      }

      // Extend session expiration (sliding window), never past the absolute lifetime, at
      // most once per touch interval: a request soon after the last write leaves the
      // row alone, and of concurrent requests past it one writes. A stored expiry later than
      // the absolute lifetime now allows (SESSION_ABSOLUTE_DAYS lowered) is written at once.
      const touchMs = sessionTouchIntervalMs();
      const lastActivity = session.last_activity_at ? new Date(session.last_activity_at).getTime() : 0;
      const signedInAt = new Date(session.original_created_at);
      const cap = new Date(signedInAt.getTime() + sessionAbsoluteMs());
      const pastCap = new Date(session.expires_at).getTime() > cap.getTime();
      if (pastCap || Date.now() - lastActivity >= touchMs) {
        await this.db
          .updateTable('sessions')
          .set({ expires_at: sessionExpiryFrom(signedInAt), last_activity_at: sql<Date>`CURRENT_TIMESTAMP` })
          .where('id', '=', session.id)
          .where((eb) => eb.or([
            eb('last_activity_at', 'is', null),
            eb('last_activity_at', '<=', sql<Date>`CURRENT_TIMESTAMP - make_interval(secs => ${touchMs / 1000})`),
            eb('expires_at', '>', cap),
          ]))
          .execute();
      }

      // Check if rotation is needed (token older than 1 hour)
      // A session never rotated counts from the epoch (as `new Date(null)` did), so it rotates now.
      const lastRotatedAt = new Date(session.last_rotated_at ?? 0);
      const needsRotation = Date.now() - lastRotatedAt.getTime() > SESSION_ROTATION_INTERVAL_MS;

      logger.debug(
        { sessionId: session.id, userId: session.user_id, needsRotation },
        'Session validated successfully'
      );

      return {
        sessionId: session.id,
        userId: session.user_id,
        needsRotation,
      };
    } catch (error) {
      logger.error({ err: error }, 'Failed to validate session');
      return null;
    }
  }

  /**
   * Whether a session still stands, judged as validateSession judges it but without
   * its side effects. For re-checking, under the user's row lock, the session a
   * request came with before creating a credential from it.
   */
  async sessionStillStands(executor: Kysely<DB>, sessionId: number): Promise<boolean> {
    const session = await executor
      .selectFrom('sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .select(SESSION_CHECK_COLUMNS)
      .where('s.id', '=', sessionId)
      .executeTakeFirst();
    return session !== undefined && judgeSession(session).ok;
  }

  /**
   * Rotate a session: atomically retire the old session and mint a new one,
   * carrying the active ledger forward. Prevents session fixation.
   *
   * **Single-winner:** the old session is retired with a CONDITIONAL update
   * (`WHERE is_revoked = false`), so when several concurrent requests all see
   * "needs rotation" only the first wins; the others get `null` and keep using
   * the current cookie (still valid within the rotation grace window). This
   * avoids minting duplicate sessions and the spurious 401s the old
   * revoke-immediately behavior caused.
   *
   * The claim and the insert run in one transaction under the user's row lock
   * (services/userCredentialLock.ts), so a revocation (lock, sign-in disable,
   * password change) can't run between them and miss the replacement: it either
   * runs first, and the claim then finds the old session revoked, or after, and
   * revokes the replacement.
   *
   * @returns New token + session id, or `null` if another request already rotated
   *   (or the session was revoked meanwhile).
   */
  async rotateSession(
    oldSessionId: number,
    data: SessionData
  ): Promise<{ token: string; sessionId: number } | null> {
    const token = this.generateSessionToken();
    const tokenHash = this.hashSessionToken(token);

    try {
      const newSessionId = await this.db.transaction().execute(async (trx) => {
        await lockUserForNewCredential(trx, data.userId);

        // Atomically claim the rotation AND read what carries over, in one statement.
        // Only one concurrent caller flips is_revoked false→true.
        const claim = await trx
          .updateTable('sessions')
          .set({ is_revoked: true, revoked_at: sql<Date>`CURRENT_TIMESTAMP`, revocation_reason: 'rotated' })
          .where('id', '=', oldSessionId)
          .where('is_revoked', '=', false)
          .returning(['active_tenant_id', 'original_created_at', 'created_after_password_change_at', 'reauthenticated_at'])
          .executeTakeFirst();
        if (!claim) return null;

        // The replacement continues the same sign-in: it keeps the sign-in time (so
        // rotation never extends the absolute lifetime) and the password-change
        // snapshot (so it is no more valid than the session it replaces).
        const signedInAt = new Date(claim.original_created_at);
        const inserted = await trx
          .insertInto('sessions')
          .values({
            user_id: data.userId,
            session_token_hash: tokenHash,
            expires_at: sessionExpiryFrom(signedInAt),
            ip_address: data.ipAddress || null,
            user_agent: data.userAgent || null,
            device_info: data.deviceInfo ? JSON.stringify(data.deviceInfo) : null,
            rotated_from_session_id: oldSessionId,
            // Carry the active ledger forward so rotation never drops the user's
            // selected ledger (issue: ledger reset on hourly rotation).
            active_tenant_id: claim.active_tenant_id ?? null,
            // Copied in SQL, as createSession writes it: through a Date it would lose its
            // microseconds.
            created_after_password_change_at: (eb) =>
              eb.selectFrom('sessions').select('created_after_password_change_at').where('id', '=', oldSessionId),
            original_created_at: signedInAt,
            // A re-authentication a moment ago still counts after the hourly rotation.
            reauthenticated_at: claim.reauthenticated_at ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return inserted.id;
      });

      if (newSessionId === null) {
        // A concurrent request already rotated this session; don't mint a duplicate.
        logger.debug({ oldSessionId }, 'Session rotation skipped (already rotated by a concurrent request)');
        return null;
      }
      logger.info(
        { userId: data.userId, oldSessionId, newSessionId },
        'Session rotated successfully'
      );
      return { token, sessionId: newSessionId };
    } catch (error) {
      // The transaction rolled back, claim included, so the old session still stands
      // and the user isn't stranded without a valid session.
      logger.error({ err: error, oldSessionId, userId: data.userId }, 'Failed to rotate session');
      throw new Error('Failed to rotate session', { cause: error });
    }
  }

  /**
   * Record that the user just proved their password or passkey in this session.
   * Only a live session takes it.
   */
  async markReauthenticated(sessionId: number): Promise<boolean> {
    const updated = await this.db
      .updateTable('sessions')
      .set({ reauthenticated_at: sql<Date>`CURRENT_TIMESTAMP` })
      .where('id', '=', sessionId)
      .where('is_revoked', '=', false)
      .returning('id')
      .executeTakeFirst();
    return updated !== undefined;
  }

  /**
   * {@link markReauthenticated}, refused (403 REAUTH_REQUIRED) when the session ended
   * between the check and this: signed out, or revoked by a password change or a lock.
   */
  async recordReauthentication(sessionId: number): Promise<void> {
    if (!(await this.markReauthenticated(sessionId))) throw AuthError.reauthenticationLost();
  }

  /** Whether the user proved their password or passkey in this session within REAUTH_WINDOW_MS. */
  async isRecentlyReauthenticated(sessionId: number): Promise<boolean> {
    const seconds = REAUTH_WINDOW_MS / 1000;
    const row = await this.db
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', sessionId)
      .where('reauthenticated_at', '>', sql<Date>`CURRENT_TIMESTAMP - make_interval(secs => ${seconds})`)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Revoke a single session by ID
   */
  async revokeSession(sessionId: number, reason: string): Promise<void> {
    try {
      await this.db
        .updateTable('sessions')
        .set({ is_revoked: true, revoked_at: sql<Date>`CURRENT_TIMESTAMP`, revocation_reason: reason })
        .where('id', '=', sessionId)
        .execute();

      logger.info({ sessionId, reason }, 'Session revoked');
    } catch (error) {
      logger.error({ err: error, sessionId }, 'Failed to revoke session');
      throw new Error('Failed to revoke session', { cause: error });
    }
  }

  /**
   * Revoke a session by its plain-text token value
   */
  async revokeSessionByToken(token: string, reason: string): Promise<void> {
    const tokenHash = this.hashSessionToken(token);

    try {
      await this.db
        .updateTable('sessions')
        .set({ is_revoked: true, revoked_at: sql<Date>`CURRENT_TIMESTAMP`, revocation_reason: reason })
        .where('session_token_hash', '=', tokenHash)
        .execute();

      logger.info({ reason }, 'Session revoked by token');
    } catch (error) {
      logger.error({ err: error }, 'Failed to revoke session by token');
      throw new Error('Failed to revoke session', { cause: error });
    }
  }

  /**
   * Revoke all sessions for a user
   * Used for password changes, and locking or disabling an account.
   * Also ends cookies retired by rotation that are still inside their grace
   * window, which would otherwise keep working for up to a minute.
   *
   * `executor` is the transaction holding the user's row lock, when the caller
   * ends the user's access (see services/userCredentialLock.ts).
   */
  async revokeAllUserSessions(userId: number, reason: string, executor: Kysely<DB> = this.db): Promise<number> {
    try {
      const graceStart = new Date(Date.now() - SESSION_ROTATION_GRACE_MS);
      const result = await executor
        .updateTable('sessions')
        .set({ is_revoked: true, revoked_at: sql<Date>`CURRENT_TIMESTAMP`, revocation_reason: reason })
        .where('user_id', '=', userId)
        .where((eb) => eb.or([
          eb('is_revoked', '=', false),
          eb.and([eb('revocation_reason', '=', 'rotated'), eb('revoked_at', '>=', graceStart)]),
        ]))
        .returning('id')
        .execute();

      const revokedCount = result.length;
      logger.info({ userId, revokedCount, reason }, 'All user sessions revoked');

      return revokedCount;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to revoke all user sessions');
      throw new Error('Failed to revoke user sessions', { cause: error });
    }
  }

  /**
   * Get active sessions for a user (for session management UI)
   */
  async getUserActiveSessions(userId: number): Promise<SessionRecord[]> {
    try {
      const rows = await this.db
        .selectFrom('sessions')
        .select([
          'id', 'uuid', 'user_id', 'expires_at', 'created_at', 'last_activity_at',
          'last_rotated_at', 'is_revoked', 'ip_address', 'user_agent', 'device_info',
        ])
        .where('user_id', '=', userId)
        .where('is_revoked', '=', false)
        .where('expires_at', '>', sql<Date>`CURRENT_TIMESTAMP`)
        .orderBy('last_activity_at', 'desc')
        .execute();

      return rows.map((row) => ({
        id: row.id,
        uuid: row.uuid,
        userId: row.user_id,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at,
        lastRotatedAt: row.last_rotated_at,
        isRevoked: row.is_revoked,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        deviceInfo: row.device_info as Record<string, unknown> | null,
      }));
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to get active sessions');
      return [];
    }
  }

  /**
   * The user's sessions that still work, as Settings → Sessions lists them, the request's own
   * marked current: `currentSessionId`, the session authenticateToken checked (after a
   * rotation, the new one). Before, the cookie was checked again here (validateSession),
   * a second slide of the session for a read, and on the request that rotated it the cookie
   * named the retired session, so none was marked current.
   */
  async listOwnSessions(userId: number, currentSessionId: number | undefined): Promise<OwnSession[]> {
    const sessions = await this.getUserActiveSessions(userId);
    return sessions.map((session) => ({
      uuid: session.uuid,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      isCurrent: session.id === currentSessionId,
    }));
  }

  /** End one of the user's own sessions: 404 SESSION_NOT_FOUND unless it is theirs and still stands. */
  async revokeOwnSession(uuid: string, userId: number): Promise<void> {
    if (!(await this.revokeSessionByUuid(uuid, userId, 'user_revoked'))) throw AuthError.sessionNotFound();
  }

  /**
   * Revoke a specific session by UUID (for user session management)
   */
  async revokeSessionByUuid(uuid: string, userId: number, reason: string): Promise<boolean> {
    try {
      const result = await this.db
        .updateTable('sessions')
        .set({ is_revoked: true, revoked_at: sql<Date>`CURRENT_TIMESTAMP`, revocation_reason: reason })
        .where('uuid', '=', uuid)
        .where('user_id', '=', userId)
        .where('is_revoked', '=', false)
        .returning('id')
        .execute();

      if (result.length === 0) {
        return false;
      }

      logger.info({ uuid, userId, reason }, 'Session revoked by UUID');
      return true;
    } catch (error) {
      logger.error({ err: error, uuid, userId }, 'Failed to revoke session by UUID');
      throw new Error('Failed to revoke session', { cause: error });
    }
  }
}
