/**
 * How long a browser session lasts.
 *
 * - Idle timeout (`SESSION_IDLE_HOURS`, default 72): a session not used for this long
 *   ends. Each request slides it forward, and the cookie's max-age matches it.
 * - Absolute lifetime (`SESSION_ABSOLUTE_DAYS`, default 30): a session ends this long
 *   after the user signed in, however often it is used. Rotation keeps the sign-in time
 *   (`sessions.original_created_at`), so it doesn't restart the clock.
 *
 * Read on every call, so a changed setting applies to existing sessions too. A value that
 * isn't a positive number within the cap is ignored (with one warning) for the default.
 */

import { createLogger } from './logger.js';
import { config } from '../config.js';

const logger = createLogger({ service: 'SessionLifetime' });

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_SESSION_IDLE_HOURS = 72;
export const DEFAULT_SESSION_ABSOLUTE_DAYS = 30;
// Keeps the computed expiry a valid date; nobody needs a session for longer.
const MAX_DAYS = 3650;

const warned = new Set<string>();

function positiveSetting(name: 'SESSION_IDLE_HOURS' | 'SESSION_ABSOLUTE_DAYS', fallback: number, maxValue: number): number {
  const raw = config()[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0 && value <= maxValue) return value;
  const key = `${name}=${raw}`;
  if (!warned.has(key)) {
    warned.add(key);
    logger.warn({ setting: name, value: raw, fallback }, 'Ignoring invalid session lifetime setting');
  }
  return fallback;
}

/** Idle timeout in milliseconds. */
export function sessionIdleMs(): number {
  return positiveSetting('SESSION_IDLE_HOURS', DEFAULT_SESSION_IDLE_HOURS, MAX_DAYS * 24) * HOUR_MS;
}

/** Absolute lifetime in milliseconds, counted from sign-in. */
export function sessionAbsoluteMs(): number {
  return positiveSetting('SESSION_ABSOLUTE_DAYS', DEFAULT_SESSION_ABSOLUTE_DAYS, MAX_DAYS) * DAY_MS;
}

/**
 * When a session used now should expire: the idle timeout from now, but never past the
 * absolute lifetime from sign-in.
 */
export function sessionExpiryFrom(signedInAt: Date, now: number = Date.now()): Date {
  return new Date(Math.min(now + sessionIdleMs(), signedInAt.getTime() + sessionAbsoluteMs()));
}
