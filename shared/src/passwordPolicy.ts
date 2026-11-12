import { z } from 'zod';

/**
 * The password policy, shared by the server (which enforces it) and the pages that set a
 * password (which show it and check it before sending), so the two can't drift.
 *
 * It follows NIST SP 800-63B: a minimum length (12 by default; MIN_PASSWORD_LENGTH on the
 * server), no composition rules unless the operator opts in (REQUIRE_PASSWORD_COMPLEXITY),
 * any character allowed (spaces and every symbol included), and a check against passwords
 * that are easy to guess from context: the email address, one character repeated, a
 * keyboard or alphabet run, a handful of the most common words. The server can also check
 * a new password against known breaches (PASSWORD_BREACH_CHECK); that isn't here, since it
 * needs the network.
 *
 * Length is counted in characters (Unicode code points, so an emoji is one). The upper
 * limit is in bytes: bcrypt reads only the first 72 bytes of its input, so a longer
 * password would be cut short without a word.
 *
 * Signing in checks none of this: a password set under an older or different policy must
 * keep working (loginSchema only bounds its size).
 */

export const PASSWORD_MIN_LENGTH_DEFAULT = 12;
/** The lowest MIN_PASSWORD_LENGTH the server accepts (NIST's floor); lower values are raised to it. */
export const PASSWORD_MIN_LENGTH_FLOOR = 8;
/** The highest MIN_PASSWORD_LENGTH the server accepts, so a minimum can always fit under the byte limit. */
export const PASSWORD_MIN_LENGTH_CEILING = 64;
/** bcrypt's input limit. */
export const PASSWORD_MAX_BYTES = 72;
/** What a sign-in or re-authentication accepts as a password, at most. */
export const LOGIN_PASSWORD_MAX_LENGTH = 1024;

export const passwordPolicySchema = z.object({
  minLength: z.number().int().min(1),
  maxBytes: z.number().int().min(1),
  requireComplexity: z.boolean(),
});
export type PasswordPolicy = z.infer<typeof passwordPolicySchema>;

/** The policy with no server settings: what a page assumes until it has the server's. */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: PASSWORD_MIN_LENGTH_DEFAULT,
  maxBytes: PASSWORD_MAX_BYTES,
  requireComplexity: false,
};

/** Characters, counted as Unicode code points. */
export const passwordCharacterCount = (password: string): number => Array.from(password).length;

/** The UTF-8 length of the password, which is what bcrypt reads. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// Runs a password may not be a piece of, either way round.
const RUNS = ['01234567890123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm', 'qwertzuiopasdfghjklyxcvbnm', 'azertyuiopqsdfghjklmwxcvbn'];
// Words a password may not be built on alone, with only digits and symbols added.
const COMMON_WORDS = new Set([
  'password', 'passw', 'pass', 'passwort', 'nuggets', 'nugget', 'qwerty', 'qwertyuiop', 'asdf', 'letmein',
  'welcome', 'iloveyou', 'admin', 'administrator', 'changeme', 'secret', 'login', 'abc', 'abcdef', 'abcdefgh',
  'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'master', 'shadow', 'trustno', 'money',
]);

export interface PasswordContext {
  /** The account's email address; a password may not contain it. */
  email?: string | null;
}

/**
 * Why a new password isn't acceptable under the policy, or null when it is. The messages
 * are the ones the server answers with, and the pages show.
 */
export function passwordProblem(password: string, policy: PasswordPolicy, context: PasswordContext = {}): string | null {
  if (passwordCharacterCount(password) < policy.minLength) {
    return `Password must be at least ${policy.minLength} characters long`;
  }
  if (utf8ByteLength(password) > policy.maxBytes) {
    return `Password must be at most ${policy.maxBytes} bytes long (most characters take one byte; accented letters and emoji take two to four)`;
  }
  if (policy.requireComplexity) {
    const ok =
      /\p{Ll}/u.test(password) && /\p{Lu}/u.test(password) && /\p{N}/u.test(password) && /[^\p{L}\p{N}]/u.test(password);
    if (!ok) {
      return 'Password must contain a lowercase letter, an uppercase letter, a number and a symbol (a space counts as a symbol)';
    }
  }

  const lower = password.toLowerCase();
  if (new Set(Array.from(lower)).size === 1) {
    return 'Password must not be one character repeated';
  }
  const email = context.email?.trim().toLowerCase();
  if (email) {
    const local = email.split('@')[0] ?? '';
    if (lower.includes(email) || (local.length >= 4 && lower.includes(local))) {
      return 'Password must not contain your email address';
    }
  }
  const compact = lower.replace(/\s+/g, '');
  const letters = lower.replace(/[^\p{L}]/gu, '');
  const isRun = RUNS.some((run) => run.includes(compact) || [...run].reverse().join('').includes(compact));
  if (isRun || COMMON_WORDS.has(letters)) {
    return 'That password is too easy to guess. A few unrelated words make a strong one.';
  }
  return null;
}

/** One line describing the policy, for the hint under a new-password field. */
export function describePasswordPolicy(policy: PasswordPolicy): string {
  const base = `At least ${policy.minLength} characters.`;
  if (policy.requireComplexity) {
    return `${base} Include a lowercase letter, an uppercase letter, a number and a symbol.`;
  }
  return `${base} Spaces and symbols are fine; a few unrelated words make a strong password.`;
}

/** A Zod string schema for a new password under `policy`. */
export const createNewPasswordSchema = (policy: PasswordPolicy) =>
  z.string().superRefine((password, ctx) => {
    const problem = passwordProblem(password, policy);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });
