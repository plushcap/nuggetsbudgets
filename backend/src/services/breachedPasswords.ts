/**
 * Optional check of a new password against known breaches, with Have I
 * Been Pwned's Pwned Passwords range API. Off unless PASSWORD_BREACH_CHECK=true, since it
 * makes a request to api.pwnedpasswords.com whenever someone sets a password.
 *
 * k-anonymity: only the first 5 hex digits of the password's SHA-1 leave the server, the
 * answer lists every suffix with that prefix (padded with decoys, `Add-Padding`), and the
 * match is made here. If the service can't be reached in time the check is skipped and
 * logged: a breach list being down mustn't stop anyone setting a password.
 */
import { createHash } from 'crypto';
import { createLogger } from '../utils/logger.js';
import { config } from '../config.js';

const logger = createLogger({ service: 'BreachedPasswords' });

const RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 3000;

export const breachCheckEnabled = (): boolean => config().PASSWORD_BREACH_CHECK;

/** True when the password is in a known breach; false when it isn't, or the check is off or failed. */
export async function isBreachedPassword(password: string): Promise<boolean> {
  if (!breachCheckEnabled()) return false;
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const response = await fetch(`${RANGE_URL}${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'Nuggets-password-check' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Pwned Passwords answered ${response.status}`);
    const body = await response.text();
    for (const line of body.split('\n')) {
      const [candidate, count] = line.trim().split(':');
      // Padding entries have a count of 0.
      if (candidate === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch (err) {
    logger.warn({ err }, 'Could not check the new password against known breaches; skipping the check');
    return false;
  }
}
