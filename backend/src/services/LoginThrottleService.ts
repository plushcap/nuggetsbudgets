/**
 * Per-account throttling of password sign-in.
 *
 * The per-IP limiter (middleware/security.ts) stops one address; this stops many. Every
 * password sign-in for an email address is charged to that address before the password
 * is checked, and a correct password refunds that attempt (only that one: a member
 * signing in between someone's guesses doesn't wipe their count). The first
 * FREE_ATTEMPTS charges in a row cost nothing; after that each one locks the address for
 * twice as long as the last, from one second up to MAX_DELAY_MS (15 minutes). While it
 * is locked a sign-in is refused without looking at the password, so a guess made then
 * tells the guesser nothing. A day without a charge forgets them. Charging first, rather
 * than counting failures after bcrypt, keeps a burst of parallel guesses from all getting
 * through before the first failure lands.
 *
 * The key is the address as typed (normalized), whether or not an account has it, so the
 * answers are the same for an address with no account. It is an HMAC under the server
 * secret: the table holds no email addresses.
 *
 * This is a slowdown, not a lockout, and a stranger can't use it to keep a member out:
 * a browser that has signed in to the account with its password before carries a
 * trusted-device cookie (utils/loginDevice.ts), and its sign-ins are charged to that
 * device instead of to the address, so it isn't held up by guesses from anywhere else.
 * Its own failures are forgotten when it signs in. Passkey sign-in isn't
 * throttled here at all. A stolen device cookie only buys its holder that device's own,
 * equally throttled, attempts.
 *
 * Control plane: login_throttles has no tenant_id and no RLS.
 */
import { sql } from 'kysely';
import { db } from '../db.js';
import { serverHmac } from '../utils/serverHmac.js';

export const LOGIN_FREE_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
export const LOGIN_MAX_DELAY_MS = 15 * 60 * 1000;
/** A key with no charge for this long starts again from nothing. */
const FORGET_AFTER = sql`interval '24 hours'`;
const SWEEP_EVERY_MS = 60 * 1000;
let lastSweepAt = 0;

/** The throttle key for sign-ins to `email` from browsers without a trusted-device cookie. */
export const accountThrottleKey = (email: string): string =>
  serverHmac(`login-throttle:account:${email.trim().toLowerCase()}`).toString('hex');

/** The throttle key for sign-ins to `email` from the trusted device `deviceId`. */
export const deviceThrottleKey = (email: string, deviceId: string): string =>
  serverHmac(`login-throttle:device:${email.trim().toLowerCase()}:${deviceId}`).toString('hex');

export type LoginCharge = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Charge one sign-in attempt to `key`. Refused while the key is locked; otherwise counted,
 * and the key locked for the next attempt once it is past the free ones.
 */
export async function chargeLoginAttempt(key: string): Promise<LoginCharge> {
  // Delete keys nobody has used for a day (most are addresses with no account), at most
  // once a minute; until then the charge below treats such a key as new anyway.
  if (Date.now() - lastSweepAt > SWEEP_EVERY_MS) {
    lastSweepAt = Date.now();
    await sql`DELETE FROM login_throttles WHERE last_attempt_at < now() - ${FORGET_AFTER}`.execute(db);
  }

  // attempts after this charge: 1 for a new or forgotten key, else one more.
  const next = sql`CASE WHEN t.last_attempt_at < now() - ${FORGET_AFTER} THEN 1 ELSE t.attempts + 1 END`;
  const charged = await sql<{ attempts: number }>`
    INSERT INTO login_throttles AS t (throttle_key, attempts, locked_until, last_attempt_at)
    VALUES (${key}, 1, NULL, now())
    ON CONFLICT (throttle_key) DO UPDATE SET
      attempts = ${next},
      last_attempt_at = now(),
      locked_until = CASE
        WHEN ${next} > ${LOGIN_FREE_ATTEMPTS}
          THEN now() + make_interval(secs => LEAST(
            ${BASE_DELAY_MS}::float8 * power(2, ${next} - ${LOGIN_FREE_ATTEMPTS} - 1),
            ${LOGIN_MAX_DELAY_MS}::float8
          ) / 1000)
        ELSE NULL
      END
    WHERE t.locked_until IS NULL OR t.locked_until <= now()
    RETURNING t.attempts
  `.execute(db);
  if (charged.rows.length > 0) return { allowed: true };

  const locked = await sql<{ seconds: number | null }>`
    SELECT ceil(extract(epoch FROM locked_until - now()))::int AS seconds FROM login_throttles WHERE throttle_key = ${key}
  `.execute(db);
  return { allowed: false, retryAfterSeconds: Math.max(1, locked.rows[0]?.seconds ?? 1) };
}

/**
 * Refund the attempt just charged to `key`: its password was right. Only that one, so a
 * member signing in from a new browser between someone else's guesses doesn't wipe the
 * count those guesses built (it is forgotten a day after the last). Back within the free
 * attempts, the lock goes too.
 */
export async function refundLoginAttempt(key: string): Promise<void> {
  // Nothing left to remember: drop the row rather than keep a zero.
  await db.deleteFrom('login_throttles').where('throttle_key', '=', key).where('attempts', '<=', 1).execute();
  await sql`
    UPDATE login_throttles SET
      attempts = greatest(attempts - 1, 0),
      locked_until = CASE WHEN attempts - 1 <= ${LOGIN_FREE_ATTEMPTS} THEN NULL ELSE locked_until END
    WHERE throttle_key = ${key}
  `.execute(db);
}

/** Forget every attempt on `key`: a trusted device's own, after it signed in. */
export async function clearLoginAttempts(key: string): Promise<void> {
  await db.deleteFrom('login_throttles').where('throttle_key', '=', key).execute();
}
