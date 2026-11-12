import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { CookieOptions, Response } from 'express';
import { envSecret, readDockerSecret } from './docker-secrets.js';
import { cookiesAreSecure } from './cookieSecurity.js';
import { config } from '../config.js';

/**
 * The CSRF token.
 *
 * The SPA reads the token from the `csrf_token` cookie and echoes it in `X-CSRF-Token`
 * on every write. A signed-in browser's token is HMAC-SHA256(csrf_secret, its session
 * token): bound to that session, so a token set by anyone else (a sibling subdomain
 * writing cookies, say) doesn't pass, and the secret the stack requires is what keys it.
 * The cookie is set again with every session cookie (sign-in, rotation, each request's
 * sliding refresh), so it always matches the session the browser has. Before sign-in
 * the cookie holds a random token, which nothing checks: a request without a session
 * cookie has no session to forge.
 *
 * When cookies are Secure (always in production; cookieSecurity.ts) both cookies have
 * the `__Host-` prefix: the browser takes them only from this host, over HTTPS, for path
 * `/`, so no other host under the same parent domain can set or shadow them.
 */

const isProduction = (): boolean => config().NODE_ENV === 'production';

/** The CSRF cookie's name: `__Host-csrf_token` when cookies are Secure, `csrf_token` otherwise. */
export function csrfCookieName(): string {
  return cookiesAreSecure() ? '__Host-csrf_token' : 'csrf_token';
}

let cachedSecret: string | undefined;

/**
 * The csrf_secret (a Docker secret file in production, which index.ts also copies to
 * CSRF_SECRET). Outside production a constant stands in when there is none, as for
 * serverHmac.ts.
 */
function csrfSecret(): string {
  if (cachedSecret) return cachedSecret;
  const secret = envSecret('CSRF_SECRET') || readDockerSecret('csrf_secret', 'CSRF_SECRET');
  if (!secret && isProduction()) throw new Error('No csrf_secret to sign CSRF tokens with');
  cachedSecret = secret || 'nuggets-csrf-development';
  return cachedSecret;
}

/** The CSRF token of the session whose cookie holds `sessionToken`. */
export function csrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', csrfSecret()).update(`nuggets-csrf-v1:${sessionToken}`).digest('base64url');
}

/** A token for a browser with no session yet (nothing checks it). */
export function anonymousCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/** Whether `header` is the CSRF token of the session `sessionToken`, compared in constant time. */
export function isCsrfTokenOf(header: unknown, sessionToken: string): boolean {
  if (typeof header !== 'string' || !header) return false;
  const expected = Buffer.from(csrfTokenFor(sessionToken));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function csrfCookieOptions(): CookieOptions {
  // As the session cookie's (baseCookieOptions): the two go together.
  const secure = cookiesAreSecure();
  return {
    httpOnly: false, // readable by the SPA so it can echo it in the header
    secure,
    sameSite: secure ? 'strict' : 'lax',
    path: '/',
    // Outlasts the session; it is set again with the session cookie anyway.
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

export function setCsrfCookie(res: Response, token: string): void {
  res.cookie(csrfCookieName(), token, csrfCookieOptions());
}
