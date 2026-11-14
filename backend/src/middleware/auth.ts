/**
 * Session-based Authentication and Authorization Middleware
 *
 * Authenticates requests using server-side sessions stored in httpOnly cookies.
 * Sessions have a sliding idle timeout (extended on each request) and an absolute
 * lifetime from sign-in; see utils/session-lifetime.ts.
 *
 * Non-browser clients (the MCP server and its clients) send a personal access token
 * as `Authorization: Bearer`. A token is accepted only when everything about it checks
 * out against its personal_access_tokens row, and it reaches only the routes
 * tokenAccess.ts lists.
 *
 * Security features:
 * - Session tokens stored in httpOnly cookies (XSS protection)
 * - Session rotation every hour (session fixation prevention)
 * - Automatic session extension (sliding expiration)
 * - Account lock detection, for sessions and Bearer tokens alike
 * - Password change invalidation
 * - Personal access tokens: strict verification, an allowlist of routes, and scopes
 */

import { Request, Response, NextFunction } from 'express';
import { sql } from 'kysely';
import { db } from '../db.js';
import { SessionService } from '../services/SessionService.js';
import {
  getSessionFromCookies,
  setSessionCookie,
  clearSessionCookie,
} from '../utils/session-cookie-config.js';
import {
  verifyPersonalAccessToken,
  extractTokenFromHeader,
  PAT_AUDIENCE,
} from '../utils/jwt-helper.js';
import { toTokenScope, tokenRefusal, type TokenScope } from './tokenAccess.js';
import { withoutTrailingSlashes } from './security-enhanced.js';
import { createLogger, pathOnly } from '../utils/logger.js';
import { noteRequestUser } from '../context/requestContext.js';

const logger = createLogger({ service: 'Auth' });
const sessionService = new SessionService();

/**
 * What a session whose password an admin set may still do: see who it is, change the
 * password, and sign out, which also takes the browser's push subscription off the account
 * so the next person on the device doesn't get its alerts. Everything else answers
 * 403 PASSWORD_CHANGE_REQUIRED.
 */
const BEFORE_PASSWORD_CHANGE = new Set([
  'GET /api/auth/me',
  'GET /api/auth/tenants',
  'PUT /api/auth/change-password',
  'POST /api/auth/logout',
  'POST /api/push/subscriptions/remove',
]);
const mayUseBeforePasswordChange = (req: Request): boolean => {
  const path = withoutTrailingSlashes((req.originalUrl || req.url || '').split('?')[0] ?? '');
  return BEFORE_PASSWORD_CHANGE.has(`${req.method} ${path}`);
};

/** The signed-in user, as authenticateToken sets it on the request. */
export interface RequestUser {
  userId: number;
  email: string;
}

declare global {
  // What middleware adds to every request, declared where Express looks for it: code
  // that sees a plain Request (a rate limiter's key generator, an error handler) reads
  // req.user without casting it to a type that claims more.
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's extension point is a namespace
  namespace Express {
    interface Request {
      /**
       * Set by authenticateToken. Absent before it runs, on a public route, and when it
       * refused the request, so it is optional: the route wrappers (utils/routeHandler.ts)
       * type it as set for the handlers they run behind authenticateToken.
       */
      user?: RequestUser;
    }
  }
}

/**
 * The request as this server's middleware extends it: the session and token (set here;
 * `user` is on every Express request, above), and the CSRF token
 * (middleware/security-enhanced.ts).
 */
export interface AuthenticatedRequest extends Request {
  /** The ledger a Bearer/MCP token is pinned to (its row's tenant_id); read by resolveTenant. */
  tokenTenantId?: number | null;
  /** The personal_access_tokens row a Bearer/MCP request authenticated with, and its scope. */
  patId?: number;
  patScope?: TokenScope;
  session?: {
    id: number;
    needsRotation: boolean;
  };
  /** The CSRF token CSRFProtection.cookieSetter gave the client; GET /api/csrf-token answers it. */
  csrfToken?: string;
}

/**
 * Session-based authentication middleware
 *
 * 1. Reads session token from httpOnly cookie
 * 2. Validates session (checks expiration, revocation, password change)
 * 3. Extends session expiration (sliding window)
 * 4. Rotates session token if needed (every hour)
 * 5. Attaches user to request
 */
export const authenticateSession = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    // Bearer-JWT fast path: used by non-browser clients (e.g. the MCP server).
    // If a token is present we skip the session/cookie logic entirely: a `Bearer `
    // header is never ignored in favour of a cookie (CSRF verification skips any
    // request that carries one).
    const authorization = req.headers['authorization'];
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      try {
        const bearer = extractTokenFromHeader(authorization);
        if (!bearer) {
          throw new Error('Malformed Authorization header');
        }
        // HS256 only, an `aud` of 'mcp', and no `iss` but ours.
        const decoded = verifyPersonalAccessToken(bearer);
        const aud = decoded.aud;
        const jti = decoded.jti;

        // Every bearer token must be a personal access token: `aud` exactly 'mcp' and
        // a `jti` naming a live row in personal_access_tokens. This is what makes the
        // Settings “revoke” action actually lock the token out.
        if (aud !== PAT_AUDIENCE || typeof jti !== 'string' || !jti) {
          logger.warn({ ip: req.ip, url: pathOnly(req.originalUrl), hasJti: !!jti }, 'Bearer token refused: not a personal access token');
          return res.status(401).json({ error: 'Not a personal access token', code: 'INVALID_TOKEN' });
        }
        const pat = await db
          .selectFrom('personal_access_tokens')
          .select(['id', 'user_id', 'tenant_id', 'scope', 'revoked_at', 'expires_at'])
          .where('jti', '=', jti)
          .limit(1)
          .executeTakeFirst();
        if (!pat) {
          return res.status(401).json({ error: 'Token has been revoked', code: 'TOKEN_REVOKED' });
        }
        if (pat.revoked_at) {
          return res.status(401).json({ error: 'Token has been revoked', code: 'TOKEN_REVOKED' });
        }
        // Through `new Date`: pg reads an 'infinity'/'-infinity' timestamptz as the number
        // Infinity/-Infinity, not a Date, and either must answer as expired here.
        if (!(new Date(pat.expires_at).getTime() > Date.now())) {
          return res.status(401).json({ error: 'Token has expired', code: 'TOKEN_EXPIRED' });
        }
        if (pat.user_id !== decoded.userId || pat.tenant_id !== decoded.tenantId) {
          // The token's user and ledger claims must match its row.
          logger.warn(
            { jti, jwtUserId: decoded.userId, patUserId: pat.user_id, jwtTenantId: decoded.tenantId, patTenantId: pat.tenant_id },
            'PAT claims do not match its row'
          );
          return res.status(401).json({ error: 'Token does not match its record', code: 'TOKEN_INVALID' });
        }
        const patId = pat.id;

        const user = await db
          .selectFrom('users')
          .select(['id', 'email', 'is_locked'])
          .where('id', '=', pat.user_id)
          .executeTakeFirst();
        if (!user) {
          return res.status(401).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
        }
        // A locked account can't use its tokens either (locking revokes them too;
        // this covers any minted or restored since). login_disabled is not checked
        // here: a service account signs in only with tokens, by design.
        if (user.is_locked) {
          logger.warn({ userId: user.id, aud, url: pathOnly(req.originalUrl) }, 'Bearer auth refused: account is locked');
          return res.status(401).json({ error: 'Account is locked', code: 'ACCOUNT_LOCKED' });
        }
        // Best-effort; don’t fail auth if the bump fails. Bumped for a request
        // refused below too, so the owner sees the token being used.
        db.updateTable('personal_access_tokens')
          .set({ last_used_at: sql<Date>`NOW()` })
          .where('id', '=', patId)
          .execute()
          .catch((err) => logger.warn({ err, jti }, 'Failed to update PAT last_used_at'));

        // A token reaches only the MCP endpoint and the ledger routes its tools call, and
        // a read token may only read them (tokenAccess.ts). The row's scope is what counts.
        const scope = toTokenScope(pat.scope);
        const refusal = tokenRefusal(req.method, req.originalUrl, scope);
        if (refusal) {
          logger.warn(
            { userId: user.id, patId, scope, method: req.method, url: pathOnly(req.originalUrl), code: refusal.code },
            'Personal access token refused on this route'
          );
          return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
        }

        req.user = {
          userId: user.id,
          email: user.email,
        };
        noteRequestUser(user.id);
        req.tokenTenantId = pat.tenant_id;
        req.patId = patId;
        req.patScope = scope;
        logger.debug({ userId: user.id, scope, url: pathOnly(req.originalUrl) }, 'Bearer JWT auth successful');
        return next();
      } catch (jwtError) {
        logger.warn({
          err: jwtError,
          ip: req.ip,
          url: pathOnly(req.originalUrl),
        }, 'Bearer JWT authentication failed');
        return res.status(401).json({
          error: 'Invalid or expired token',
          code: 'INVALID_TOKEN',
        });
      }
    }

    const sessionToken = getSessionFromCookies(req);

    if (!sessionToken) {
      logger.warn({
        ip: req.ip,
        url: pathOnly(req.originalUrl),
        method: req.method,
      }, 'Authentication failed: Missing session');
      return res.status(401).json({
        error: 'Session required',
        code: 'MISSING_SESSION',
      });
    }

    // Validate session (also extends expiration)
    const validatedSession = await sessionService.validateSession(sessionToken);

    if (!validatedSession) {
      clearSessionCookie(res);
      logger.warn({
        ip: req.ip,
        url: pathOnly(req.originalUrl),
      }, 'Authentication failed: Invalid or expired session');
      return res.status(401).json({
        error: 'Session invalid or expired',
        code: 'INVALID_SESSION',
      });
    }

    // Get user details
    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'must_change_password'])
      .where('id', '=', validatedSession.userId)
      .executeTakeFirst();

    if (!user) {
      clearSessionCookie(res);
      return res.status(401).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND',
      });
    }

    // A password an admin set (a new account, or a reset) is replaced before the session
    // reaches anything else. Checked before rotation, so a refused request doesn't
    // rotate the token (validation has slid the idle timeout, as for any request; the
    // absolute lifetime still ends the session).
    if (user.must_change_password && !mayUseBeforePasswordChange(req)) {
      return res.status(403).json({
        error: 'Choose a new password before continuing',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }

    // Which session id should downstream session writes (e.g. active-ledger) hit.
    let effectiveSessionId = validatedSession.sessionId;

    // Handle session rotation if needed (token older than the rotation interval).
    if (validatedSession.needsRotation) {
      try {
        const rotated = await sessionService.rotateSession(validatedSession.sessionId, {
          userId: user.id,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        });
        if (rotated) {
          setSessionCookie(res, rotated.token);
          effectiveSessionId = rotated.sessionId; // downstream writes hit the live session
          logger.info({ userId: user.id }, 'Session rotated during request');
        }
        // rotated === null → a concurrent request already rotated; keep the
        // current cookie (still valid within the rotation grace window).
      } catch (rotationError) {
        // Log but don't fail the request if rotation fails
        logger.error({ err: rotationError, userId: user.id }, 'Session rotation failed');
      }
    } else if (!validatedSession.graceRotated) {
      // Sliding window: refresh the cookie's maxAge to track the server-side
      // sliding expiry. Skipped for grace-accepted old tokens (being retired)
      // and right after a rotation (which already set the new cookie).
      setSessionCookie(res, sessionToken);
    }

    // Attach user and session info to request
    req.user = {
      userId: user.id,
      email: user.email,
    };
    noteRequestUser(user.id);

    req.session = {
      id: effectiveSessionId,
      needsRotation: validatedSession.needsRotation,
    };

    logger.debug({
      userId: user.id,
      url: pathOnly(req.originalUrl),
    }, 'Authentication successful');

    return next();
  } catch (error) {
    logger.error({ err: error }, 'Session validation error');
    return res.status(500).json({
      error: 'Authentication error',
      code: 'AUTH_ERROR',
    });
  }
};

/**
 * The authentication guard every protected route mounts (CLAUDE.md, "Security"): a
 * browser session, or a personal access token where tokenAccess.ts allows one.
 */
export const authenticateToken = authenticateSession;

/**
 * Require a signed-in browser session (never a personal access token). Mount after
 * authenticateToken. Tokens are already refused outside the routes tokenAccess.ts lists;
 * this keeps routes that must never take one closed even if that list grows.
 */
export const requireInteractiveSession = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (req.patId !== undefined || !req.session?.id) {
    return res.status(403).json({
      error: 'This needs a signed-in browser session, not a personal access token',
      code: 'INTERACTIVE_SESSION_REQUIRED',
    });
  }
  return next();
};

/**
 * Step-up: require a signed-in browser session whose user proved their password or
 * passkey in the last few minutes (signing in counts; see SessionService.REAUTH_WINDOW_MS).
 * Without it, 403 REAUTH_REQUIRED, so the UI can ask and retry. Used before minting a
 * personal access token, enrolling a passkey, adding or removing a backup key, downloading
 * the old backup key, and restoring a backup.
 */
export const requireRecentReauth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (req.patId !== undefined || !req.session?.id) {
    return res.status(403).json({
      error: 'This needs a signed-in browser session, not a personal access token',
      code: 'INTERACTIVE_SESSION_REQUIRED',
    });
  }
  try {
    if (!(await sessionService.isRecentlyReauthenticated(req.session.id))) {
      logger.info({ userId: req.user.userId, url: pathOnly(req.originalUrl) }, 'Step-up required: no recent re-authentication');
      return res.status(403).json({
        error: 'Confirm your password or passkey to continue',
        code: 'REAUTH_REQUIRED',
      });
    }
    return next();
  } catch (err) {
    // To the error handler, which logs it and answers 500 INTERNAL_ERROR, as any failure.
    return next(err);
  }
};

// Export the session service for use in routes
export { sessionService };
