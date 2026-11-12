/**
 * Trusted-device cookies for password sign-in.
 *
 * After a successful password sign-in, the browser gets an httpOnly cookie naming a random device
 * id for that account, with an HMAC under the server secret that binds the id to the
 * account's email address. A later sign-in to the same address from that browser is
 * throttled on its own key (services/LoginThrottleService.ts), so guesses from elsewhere,
 * which lock the address's shared key, don't keep the account's own browsers out. A family
 * computer can be trusted for several accounts, so the cookie holds up to MAX_ENTRIES of
 * them, newest first. Nothing is stored server-side; the cookie is only ever sent to the
 * sign-in route.
 */
import type { CookieOptions, Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { serverHmac } from './serverHmac.js';
import { baseCookieOptions } from './session-cookie-config.js';

export const LOGIN_DEVICE_COOKIE_NAME = 'nuggets_login_device';
const COOKIE_PATH = '/api/auth/login';
const MAX_ENTRIES = 5;
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAC_RE = /^[A-Za-z0-9_-]{22}$/;

interface Entry {
  id: string;
  mac: string;
}

const macFor = (email: string, id: string): string =>
  serverHmac(`login-device:v1:${email.trim().toLowerCase()}:${id}`).subarray(0, 16).toString('base64url');

const sameMac = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function readEntries(req: Request): Entry[] {
  const raw: unknown = req.cookies?.[LOGIN_DEVICE_COOKIE_NAME];
  if (typeof raw !== 'string' || raw.length > 512) return [];
  return raw
    .split('~')
    .map((part) => {
      const [id, mac] = part.split('.');
      return { id, mac };
    })
    .filter((e): e is Entry => typeof e.id === 'string' && ID_RE.test(e.id) && typeof e.mac === 'string' && MAC_RE.test(e.mac))
    .slice(0, MAX_ENTRIES);
}

/** The id of this browser's trusted device for `email`, if it carries a valid one. */
export function trustedDeviceId(req: Request, email: string): string | null {
  const entry = readEntries(req).find((e) => sameMac(e.mac, macFor(email, e.id)));
  return entry?.id ?? null;
}

const cookieOptions = (): CookieOptions => ({ ...baseCookieOptions(), path: COOKIE_PATH, maxAge: MAX_AGE_MS });

/** Trust this browser for `email` from now on (a sign-in to it just succeeded). */
export function trustThisDevice(req: Request, res: Response, email: string): void {
  const others = readEntries(req).filter((e) => !sameMac(e.mac, macFor(email, e.id)));
  const id = randomBytes(16).toString('base64url');
  const entries = [{ id, mac: macFor(email, id) }, ...others].slice(0, MAX_ENTRIES);
  res.cookie(LOGIN_DEVICE_COOKIE_NAME, entries.map((e) => `${e.id}.${e.mac}`).join('~'), cookieOptions());
}
