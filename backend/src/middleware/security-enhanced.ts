
import { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { getSessionFromCookies } from '../utils/session-cookie-config.js';
import { anonymousCsrfToken, csrfCookieName, csrfTokenFor, isCsrfTokenOf, setCsrfCookie } from '../utils/csrfToken.js';
import { createLogger, maskEmailsIn, pathOnly } from '../utils/logger.js';

const logger = createLogger({ service: 'SecurityEnhanced' });

export interface SecurityEvent {
  type: 'authentication' | 'authorization' | 'rate_limit' | 'validation_error' | 'suspicious_activity';
  level: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  /** Unknown (undefined) before sign-in. */
  userId?: number | undefined;
  ipAddress: string;
  userAgent: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

// Security event storage (in production, use proper logging service)
const securityEvents: SecurityEvent[] = [];
const MAX_EVENTS = 1000;

/**
 * Enhanced security event logging. The log line and the event /api/health/security shows
 * carry the user's id, not their address: an email address in the message or in a string
 * of the metadata (an event's `details`) is masked (`j…@example.com`).
 */
export function logEnhancedSecurityEvent(event: Omit<SecurityEvent, 'timestamp'>): void {
  const fullEvent: SecurityEvent = {
    ...event,
    message: maskEmailsIn(event.message),
    ...(event.metadata && {
      metadata: Object.fromEntries(
        Object.entries(event.metadata).map(([key, value]) => [key, typeof value === 'string' ? maskEmailsIn(value) : value])
      ),
    }),
    timestamp: new Date()
  };

  securityEvents.unshift(fullEvent);
  
  // Keep only the most recent events
  if (securityEvents.length > MAX_EVENTS) {
    securityEvents.splice(MAX_EVENTS);
  }

  // Log to structured logger with appropriate level
  const logData = {
    type: fullEvent.type,
    userId: fullEvent.userId,
    ip: fullEvent.ipAddress,
    userAgent: fullEvent.userAgent,
    metadata: fullEvent.metadata
  };

  switch (fullEvent.level) {
    case 'critical':
    case 'error':
      logger.error(logData, `[SECURITY] ${fullEvent.message}`);
      break;
    case 'warning':
      logger.warn(logData, `[SECURITY] ${fullEvent.message}`);
      break;
    case 'info':
    default:
      logger.info(logData, `[SECURITY] ${fullEvent.message}`);
      break;
  }
}

/**
 * Get recent security events (for monitoring endpoint)
 */
export function getRecentSecurityEvents(limit: number = 50): SecurityEvent[] {
  return securityEvents.slice(0, limit);
}

/**
 * CSRF Protection: a session-bound token (utils/csrfToken.ts)
 *
 * A non-httpOnly CSRF cookie is issued to every client; the SPA echoes its value
 * in an `X-CSRF-Token` header on state-changing requests. For a signed-in browser
 * the value is HMAC(csrf_secret, its session token), and the header must be that:
 * a cross-site attacker can neither read the cookie nor compute the token, nor set
 * the custom header, so a forged request cannot carry it.
 *
 * Verification is enforced ONLY for cookie-authenticated, state-changing
 * requests. Bearer/PAT clients (e.g. the MCP server) carry no ambient cookie
 * and are inherently CSRF-immune, so they are exempt (a malformed Bearer header
 * is refused by authenticateSession, never taken for a cookie); requests
 * with no session cookie have no session to abuse, so they are exempt as well.
 */

// Pre-authentication endpoints establish a session from credentials/assertions;
// they don't act on an *ambient* session, so the CSRF check (which guards
// against abuse of an existing session) doesn't apply to them. Exempting them
// also prevents a stale/leftover session cookie — or a csrf cookie not yet issued
// to a freshly-loaded/cached SPA — from locking a user out of signing in.
//
// They take JSON only: an HTML form on another site can post
// urlencoded, multipart or text/plain to them without the browser asking this
// server first, and would sign the victim's browser in to the attacker's
// account (login CSRF). A JSON body needs a CORS preflight, which only the app's
// own origin passes. Their handlers refuse anything else too (requireJsonBody), so
// a path this list misses still can't take a form.
const CSRF_EXEMPT_PATHS = new Set<string>([
  '/api/auth/login',
  '/api/auth/setup-admin',
  '/api/passkeys/auth/options',
  '/api/passkeys/auth/verify',
]);

/**
 * The path Express routes a request by, to compare with a route's own path: the mount
 * path and the rest (`req.baseUrl + req.path`, from the parsed URL, so an absolute-form
 * target `http://host/api/…` and a query string give the same), lowercased, without a
 * trailing slash. Express matches routes ignoring case and one trailing slash, so
 * `/API/Auth/Login/` reaches the sign-in handler; compared as written, it missed the
 * exempt list above, and a form could sign a browser in.
 */
export function routedPath(req: Pick<Request, 'baseUrl' | 'path'>): string {
  return withoutTrailingSlashes(`${req.baseUrl ?? ''}${req.path ?? ''}`.toLowerCase()) || '/';
}

/**
 * `path` without the slashes it ends with. A loop: `replace(/\/+$/, '')` is quadratic in a
 * run of slashes, and anyone can send a path of thousands of them.
 */
export function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end -= 1;
  return path.slice(0, end);
}

/** Whether the request's body is declared JSON (`application/json`, any parameters). */
export function isJsonRequest(req: Pick<Request, 'headers'>): boolean {
  const type = (String(req.headers['content-type'] ?? '').split(';', 1)[0] ?? '').trim().toLowerCase();
  return type === 'application/json';
}

/** The answer to a sign-in or setup request whose body isn't JSON. */
function answerJsonRequired(res: Response): void {
  res.status(415).json({ error: 'Send the request as JSON', code: 'JSON_REQUIRED' });
}

/**
 * Route middleware for the pre-authentication endpoints (sign-in, first-run setup, passkey
 * sign-in): 415 JSON_REQUIRED unless the body is JSON, which a cross-site form can't send.
 * CSRFProtection.verify checks the same for the paths it knows; this keeps the handlers
 * safe whatever path reached them.
 */
export function requireJsonBody(req: Request, res: Response, next: NextFunction): void {
  if (isJsonRequest(req)) {
    next();
    return;
  }
  answerJsonRequired(res);
}

export class CSRFProtection {
  /**
   * Give every client a CSRF cookie: the session's token when it has a session
   * cookie (set again when it doesn't match, after an upgrade say), else a random one.
   */
  static cookieSetter() {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const existing: string | undefined = req.cookies?.[csrfCookieName()];
      const session = getSessionFromCookies(req);
      const wanted = session ? csrfTokenFor(session) : existing || anonymousCsrfToken();
      if (existing !== wanted) {
        setCsrfCookie(res, wanted);
      }
      req.csrfToken = wanted;
      next();
    };
  }

  /** Enforce the double-submit match for cookie-authenticated mutations. */
  static verify() {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
      }

      // Bearer/PAT clients are CSRF-immune (no ambient cookie credential).
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        return next();
      }

      // Pre-auth endpoints (login, passkey assertion) are exempt — a stale
      // session cookie or a not-yet-issued csrf cookie must never block sign-in —
      // but only for a JSON body, which a cross-site form can't send.
      if (CSRF_EXEMPT_PATHS.has(routedPath(req))) {
        if (isJsonRequest(req)) return next();
        return answerJsonRequired(res);
      }

      // No session cookie => unauthenticated (e.g. login). Nothing to abuse.
      const session = getSessionFromCookies(req);
      if (!session) {
        return next();
      }

      const headerToken = req.get('X-CSRF-Token');

      if (!isCsrfTokenOf(headerToken, session)) {
        logEnhancedSecurityEvent({
          type: 'authorization',
          level: 'warning',
          message: 'CSRF token validation failed',
          userId: req.user?.userId,
          ipAddress: req.ip || 'unknown',
          userAgent: req.get('User-Agent') || 'unknown',
          metadata: { endpoint: pathOnly(req.path), method: req.method, hasHeader: !!headerToken },
        });

        return res.status(403).json({
          error: 'CSRF token validation failed',
          code: 'CSRF_TOKEN_INVALID',
        });
      }

      return next();
    };
  }

  /** Endpoint that returns the caller's CSRF token (cookieSetter has set its cookie). */
  static generateEndpoint() {
    return (req: AuthenticatedRequest, res: Response) => {
      const session = getSessionFromCookies(req);
      let token = session ? csrfTokenFor(session) : req.csrfToken || req.cookies?.[csrfCookieName()];
      if (!token) {
        token = anonymousCsrfToken();
        setCsrfCookie(res, token);
      }
      res.json({ csrfToken: token });
    };
  }
}

/**
 * Authentication event logging. `userId` names who signed in where the request has no
 * signed-in user yet (a sign-in); `details` says what happened, never who (no address).
 */
export const logAuthenticationEvent = (
  req: AuthenticatedRequest,
  event: 'success' | 'failure' | 'blocked',
  details?: string,
  userId?: number
) => {
  const level = event === 'success' ? 'info' : event === 'blocked' ? 'warning' : 'error';

  logEnhancedSecurityEvent({
    type: 'authentication',
    level,
    message: `Authentication ${event}${details ? `: ${details}` : ''}`,
    userId: userId ?? req.user?.userId,
    ipAddress: req.ip || 'unknown',
    userAgent: req.get('User-Agent') || 'unknown',
    metadata: {
      endpoint: pathOnly(req.path),
      method: req.method,
      event,
      details
    }
  });
};
