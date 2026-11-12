/**
 * Hashing and checking passwords.
 *
 * - hashPassword: bcrypt at BCRYPT_ROUNDS (default 12; 10 to 15, at least 12 in
 *   production), the one place a password is hashed.
 * - compareWithoutAccount: spends the time a comparison at the current cost takes, for a
 *   sign-in to an address with no account, so the two take the same time. A stored hash
 *   at another cost is made again when its user signs in (hashNeedsRehash), so after a
 *   change to BCRYPT_ROUNDS only accounts nobody has signed in to since still differ.
 * - checkNewPassword: whether a password may be set: the policy (passwordProblem from
 *   @nuggets/shared, the same code the pages that set one run, under this server's settings,
 *   getPasswordPolicy), then, when PASSWORD_BREACH_CHECK=true, known breaches.
 */
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { createLogger } from './logger.js';
import { getPasswordPolicy } from './validation.js';
import { isBreachedPassword } from '../services/breachedPasswords.js';
import { passwordCharacterCount, passwordProblem, type PasswordContext } from '@nuggets/shared';
import { config } from '../config.js';

const logger = createLogger({ service: 'Passwords' });

export const BCRYPT_ROUNDS_DEFAULT = 12;
const BCRYPT_ROUNDS_MAX = 15;
// Never below 12 in production, where sign-in would otherwise rehash every account down.
const bcryptRoundsMin = () => (config().NODE_ENV === 'production' ? 12 : 10);

let warnedRounds: string | undefined;

/** The bcrypt cost new hashes use: BCRYPT_ROUNDS, or 12 when it's unset or out of range. */
export function bcryptRounds(raw: string | undefined = config().BCRYPT_ROUNDS): number {
  if (raw === undefined || raw.trim() === '') return BCRYPT_ROUNDS_DEFAULT;
  const rounds = Number(raw);
  const min = bcryptRoundsMin();
  if (Number.isInteger(rounds) && rounds >= min && rounds <= BCRYPT_ROUNDS_MAX) return rounds;
  if (warnedRounds !== raw) {
    warnedRounds = raw;
    logger.warn(
      { BCRYPT_ROUNDS: raw, using: BCRYPT_ROUNDS_DEFAULT },
      `BCRYPT_ROUNDS must be a whole number from ${min} to ${BCRYPT_ROUNDS_MAX}; using the default`
    );
  }
  return BCRYPT_ROUNDS_DEFAULT;
}

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, bcryptRounds());

/** The cost a bcrypt hash was made at, or null for something that isn't one. */
export function bcryptCost(hash: string): number | null {
  const match = /^\$2[abxy]?\$(\d{2})\$/.exec(hash);
  return match ? Number(match[1]) : null;
}

/**
 * Whether a stored hash should be made again at the current cost: sign-in redoes it with
 * the password it just checked, so hashes converge on BCRYPT_ROUNDS and an address with
 * no account, compared at that cost (compareWithoutAccount), takes as long as one with.
 */
export const hashNeedsRehash = (hash: string): boolean => {
  const cost = bcryptCost(hash);
  return cost !== null && cost !== bcryptRounds();
};

// A hash of a random password at the current cost, made once per cost.
const dummyHashes = new Map<number, Promise<string>>();
function dummyHash(rounds: number): Promise<string> {
  let hash = dummyHashes.get(rounds);
  if (!hash) {
    hash = bcrypt.hash(randomBytes(32).toString('base64url'), rounds);
    dummyHashes.set(rounds, hash);
  }
  return hash;
}
/** Make the dummy hash ahead of the first sign-in to an unknown address (index.ts, at startup). */
export const warmPasswordHashing = (): Promise<string> => dummyHash(bcryptRounds());

/**
 * Compare `password` against a hash no password matches, taking as long as a real
 * comparison at the current cost. Always false.
 */
export async function compareWithoutAccount(password: string): Promise<false> {
  await bcrypt.compare(password, await dummyHash(bcryptRounds()));
  return false;
}

/**
 * Why `password` may not be set (for the account `context` describes), or null when it
 * may. The message is fit to show the user. Never used at sign-in, which takes a password
 * set under any earlier policy.
 */
export async function checkNewPassword(password: unknown, context: PasswordContext = {}): Promise<string | null> {
  if (typeof password !== 'string' || !password) return 'A new password is required';
  const policy = getPasswordPolicy();
  const problem = passwordProblem(password, policy, context);
  if (problem) {
    logger.info({ passwordLength: passwordCharacterCount(password), minLength: policy.minLength }, 'New password refused by the policy');
    return problem;
  }
  if (await isBreachedPassword(password)) {
    return 'That password has appeared in a data breach, so attackers try it. Choose a different one.';
  }
  return null;
}
