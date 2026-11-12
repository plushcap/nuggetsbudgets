/**
 * Session Cookie Configuration
 *
 * Provides secure cookie settings for session tokens
 * with environment-specific configurations.
 *
 * Security features:
 * - httpOnly: Prevents JavaScript access (XSS protection)
 * - secure: HTTPS-only in production, or as COOKIE_SECURE / DOMAIN_URL say (cookieSecurity.ts)
 * - sameSite: 'strict' with Secure, which prevents CSRF attacks
 * - expires after the session idle timeout, re-set on each request (sliding window)
 */

import { CookieOptions, Request, Response } from 'express';
import { sessionIdleMs } from './session-lifetime.js';
import { csrfCookieName, csrfCookieOptions, csrfTokenFor, setCsrfCookie } from './csrfToken.js';
import { cookiesAreSecure } from './cookieSecurity.js';

/** The session cookie's name outside production (development, tests). */
export const SESSION_COOKIE_NAME = 'nuggets_session';

/**
 * The session cookie's name: `__Host-nuggets_session` when cookies are Secure (always in
 * production; cookieSecurity.ts), so the browser takes it only from
 * this host, over HTTPS, for path `/`: no other site under the same parent domain can set
 * one for it (and so fix someone's session).
 */
export function sessionCookieName(): string {
  return cookiesAreSecure() ? `__Host-${SESSION_COOKIE_NAME}` : SESSION_COOKIE_NAME;
}

/**
 * What every httpOnly cookie the backend sets shares: the session, the trusted-device
 * cookie (loginDevice.ts) and the passkey ceremony cookie (WebAuthnChallengeStore.ts).
 * Each adds its own path and lifetime.
 */
export function baseCookieOptions(): Pick<CookieOptions, 'httpOnly' | 'secure' | 'sameSite'> {
  // Secure in production, and wherever COOKIE_SECURE or an https DOMAIN_URL says
  // (cookieSecurity.ts), not on NODE_ENV alone.
  const secure = cookiesAreSecure();
  return {
    httpOnly: true, // Cannot be accessed by JavaScript
    secure,
    // 'strict' with Secure, for CSRF protection; 'lax' for the plain-http development
    // stack (localhost:3000 -> localhost:5000)
    sameSite: secure ? 'strict' : 'lax',
  };
}

/**
 * Get secure cookie options for session tokens
 *
 * Security features:
 * - httpOnly: Prevents JavaScript access (XSS protection)
 * - secure: HTTPS-only (cookieSecurity.ts)
 * - sameSite: 'strict' with Secure, which prevents CSRF attacks
 * - maxAge: the session idle timeout (SESSION_IDLE_HOURS); the server also enforces
 *   the absolute lifetime, which the cookie doesn't need to know
 */
export function getSessionCookieOptions(): CookieOptions {
  return {
    ...baseCookieOptions(),
    maxAge: sessionIdleMs(),
    path: '/', // Available across entire domain
  };
}

/**
 * Get cookie options for clearing/deleting a cookie
 */
export function getClearSessionCookieOptions(): CookieOptions {
  return {
    ...baseCookieOptions(),
    path: '/',
    maxAge: 0, // Immediate expiration
  };
}

/**
 * Set session cookie on response, and the CSRF cookie bound to it (utils/csrfToken.ts),
 * so the token the SPA sends is always this session's.
 */
export function setSessionCookie(res: Response, token: string): void {
  res.cookie(sessionCookieName(), token, getSessionCookieOptions());
  setCsrfCookie(res, csrfTokenFor(token));
}

/** Take any Set-Cookie for `names` this response already has off it. */
function dropSetCookies(res: Response, names: string[]): void {
  const current = res.getHeader('Set-Cookie');
  if (current === undefined) return;
  const kept = [current].flat().map(String).filter((c) => !names.some((name) => c.startsWith(`${name}=`)));
  if (kept.length === 0) res.removeHeader('Set-Cookie');
  else res.setHeader('Set-Cookie', kept);
}

/**
 * Clear the session cookie and the CSRF cookie bound to it. A request's sliding refresh
 * (authenticateToken) has already set both on the response by the time a sign-out, a
 * password change or a refused session clears them, so those Set-Cookie lines are taken off:
 * the browser kept the revoked session's CSRF token otherwise. The next
 * request gets a fresh anonymous one (CSRFProtection.cookieSetter).
 */
export function clearSessionCookie(res: Response): void {
  dropSetCookies(res, [sessionCookieName(), csrfCookieName()]);
  res.clearCookie(sessionCookieName(), getClearSessionCookieOptions());
  res.clearCookie(csrfCookieName(), { ...csrfCookieOptions(), maxAge: 0 });
}

/**
 * Extract session token from request cookies
 */
export function getSessionFromCookies(req: Request): string | undefined {
  // req.cookies is cookie-parser's (app.ts); absent when it hasn't run.
  return req.cookies?.[sessionCookieName()];
}
