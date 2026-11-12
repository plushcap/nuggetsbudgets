/**
 * Server-side passkey ceremony challenges, each for the browser that asked for it.
 *
 * The browser holds a random id in an httpOnly cookie that only /api/passkeys sees and that
 * lasts as long as a ceremony may (CEREMONY_TTL_MS). Starting a ceremony (registration,
 * sign-in or re-authentication) stores its challenge in webauthn_challenges under the
 * SHA-256 of that id. Finishing it deletes, as it reads it, the row for that browser and
 * the challenge the response signed (its clientDataJSON): a challenge works once, only for
 * the browser that asked for it, for the same kind of ceremony, before it expires and, for
 * registration and re-authentication, for the user who started it. Nobody else's request
 * can touch another browser's ceremonies, two started by one browser don't get in each
 * other's way (MAX_OPEN per kind), and the challenges survive a restart and work across
 * instances.
 *
 * Control plane: webauthn_challenges has no tenant_id and no RLS.
 */
import type { CookieOptions, Request, Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import { sql } from 'kysely';
import { db } from '../db.js';
import { baseCookieOptions } from '../utils/session-cookie-config.js';
import { webauthnChallengePurpose } from '@nuggets/shared';

export type CeremonyPurpose = 'registration' | 'authentication' | 'reauthentication';

/** As long as the browser is told the ceremony may take (the options' timeout). */
export const CEREMONY_TTL_MS = 5 * 60 * 1000;
/** Ceremonies of one kind a browser may have open at once; starting another ends the oldest. */
const MAX_OPEN = 3;
const SWEEP_EVERY_MS = 60 * 1000;
let lastSweepAt = 0;

export const CEREMONY_COOKIE_NAME = 'nuggets_webauthn';
const COOKIE_PATH = '/api/passkeys';
const BROWSER_ID_RE = /^[A-Za-z0-9_-]{43}$/;

const hashBrowserId = (id: string): string => createHash('sha256').update(id).digest('hex');
const cookieOptions = (): CookieOptions => ({ ...baseCookieOptions(), path: COOKIE_PATH });

function presentedBrowserId(req: Request): string | null {
  const raw: unknown = req.cookies?.[CEREMONY_COOKIE_NAME];
  return typeof raw === 'string' && BROWSER_ID_RE.test(raw) ? raw : null;
}

/** The challenge a WebAuthn response signed, from its clientDataJSON. */
function signedChallenge(response: unknown): string | null {
  const encoded = (response as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON;
  if (typeof encoded !== 'string' || encoded.length > 4096) return null;
  try {
    const challenge: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')).challenge;
    return typeof challenge === 'string' && challenge.length > 0 && challenge.length <= 256 ? challenge : null;
  } catch {
    return null;
  }
}

/** Store `challenge` for a new ceremony of this browser's, and (re)set its cookie. */
export async function startCeremony(
  req: Request,
  res: Response,
  ceremony: { purpose: CeremonyPurpose; userId: number | null; challenge: string }
): Promise<void> {
  if (Date.now() - lastSweepAt > SWEEP_EVERY_MS) {
    lastSweepAt = Date.now();
    await db.deleteFrom('webauthn_challenges').where('expires_at', '<=', sql<Date>`now()`).execute();
  }

  const browserId = presentedBrowserId(req) ?? randomBytes(32).toString('base64url');
  const browserHash = hashBrowserId(browserId);
  await db
    .insertInto('webauthn_challenges')
    .values({
      browser_hash: browserHash,
      purpose: ceremony.purpose,
      user_id: ceremony.purpose === webauthnChallengePurpose.enum.authentication ? null : ceremony.userId,
      challenge: ceremony.challenge,
      expires_at: sql<Date>`now() + make_interval(secs => ${CEREMONY_TTL_MS / 1000})`,
    })
    .execute();
  // Keep the newest few of this kind for this browser.
  await db
    .deleteFrom('webauthn_challenges')
    .where('browser_hash', '=', browserHash)
    .where('purpose', '=', ceremony.purpose)
    .where('id', 'not in', (eb) =>
      eb
        .selectFrom('webauthn_challenges')
        .select('id')
        .where('browser_hash', '=', browserHash)
        .where('purpose', '=', ceremony.purpose)
        .orderBy('id', 'desc')
        .limit(MAX_OPEN)
    )
    .execute();
  res.cookie(CEREMONY_COOKIE_NAME, browserId, { ...cookieOptions(), maxAge: CEREMONY_TTL_MS });
}

/**
 * The challenge `response` signed, if this browser was given it for a ceremony of
 * `purpose` (and, with `userId`, by that user) that hasn't expired. Used up by reading it,
 * whatever the answer. Null otherwise.
 */
export async function takeCeremonyChallenge(
  req: Request,
  ceremony: { purpose: CeremonyPurpose; userId?: number; response: unknown }
): Promise<string | null> {
  const browserId = presentedBrowserId(req);
  const challenge = signedChallenge(ceremony.response);
  if (!browserId || !challenge) return null;

  const row = await db
    .deleteFrom('webauthn_challenges')
    .where('browser_hash', '=', hashBrowserId(browserId))
    .where('challenge', '=', challenge)
    .returning(['purpose', 'user_id', 'challenge', sql<boolean>`expires_at > now()`.as('live')])
    .executeTakeFirst();
  if (!row || !row.live || row.purpose !== ceremony.purpose) return null;
  if (ceremony.userId !== undefined && row.user_id !== ceremony.userId) return null;
  return row.challenge;
}
