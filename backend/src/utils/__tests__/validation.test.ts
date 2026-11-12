import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getPasswordPolicy, validateEmail } from '../validation.js';
import { bcryptRounds, checkNewPassword } from '../passwords.js';

/**
 * The password policy, NIST SP 800-63B-aligned: at least 12 characters
 * by default (MIN_PASSWORD_LENGTH, kept within 8..64), at most 72 bytes (bcrypt's limit),
 * no composition rules unless REQUIRE_PASSWORD_COMPLEXITY=true (and then any symbol counts),
 * and no password that is easy to guess from context. checkNewPassword is what every path that
 * sets a password calls: passwordProblem (@nuggets/shared) under getPasswordPolicy's settings
 * (the breach check is off unless PASSWORD_BREACH_CHECK=true).
 */
describe('checkNewPassword', () => {
  /** Why the policy refuses `password`, or null. */
  const problem = (password: string, context?: { email?: string }) => checkNewPassword(password, context);
  const allowed = async (password: string, context?: { email?: string }) => (await problem(password, context)) === null;

  const savedMin = process.env.MIN_PASSWORD_LENGTH;
  const savedComplexity = process.env.REQUIRE_PASSWORD_COMPLEXITY;

  beforeEach(() => {
    delete process.env.MIN_PASSWORD_LENGTH;
    delete process.env.REQUIRE_PASSWORD_COMPLEXITY;
  });

  afterEach(() => {
    if (savedMin === undefined) delete process.env.MIN_PASSWORD_LENGTH;
    else process.env.MIN_PASSWORD_LENGTH = savedMin;
    if (savedComplexity === undefined) delete process.env.REQUIRE_PASSWORD_COMPLEXITY;
    else process.env.REQUIRE_PASSWORD_COMPLEXITY = savedComplexity;
  });

  it('rejects passwords shorter than the default minimum of 12', async () => {
    expect(await problem('Ab1!cdef')).toBe('Password must be at least 12 characters long');
  });

  it('needs no particular kinds of character by default: a passphrase is fine', async () => {
    expect(await problem('correct horse battery staple')).toBeNull();
    expect(await allowed('lowercaseonlywords')).toBe(true);
  });

  it('counts characters, not bytes or UTF-16 units, toward the minimum', async () => {
    expect(await allowed('😀'.repeat(6) + 'ünïcødé')).toBe(true); // 13 code points
    expect(await allowed('éé'.repeat(5) + 'x')).toBe(false); // 11 code points
  });

  it('refuses a password bcrypt would cut short (over 72 bytes)', async () => {
    expect(await allowed('word '.repeat(14) + 'ab')).toBe(true); // 72 bytes
    expect(await problem('word '.repeat(14) + 'abc')).toMatch(/at most 72 bytes/);
    expect(await problem('é'.repeat(37))).toMatch(/at most 72 bytes/); // 37 characters, 74 bytes
  });

  it('with REQUIRE_PASSWORD_COMPLEXITY=true, asks for four kinds of character, and any symbol counts', async () => {
    process.env.REQUIRE_PASSWORD_COMPLEXITY = 'true';
    expect(await allowed('lowercaseonlywords')).toBe(false);
    expect(await allowed('Abcdef1#ghij')).toBe(true); // '#' was once refused
    expect(await allowed('Correct horse 9 staple')).toBe(true); // a space is a symbol
  });

  it('honors a custom MIN_PASSWORD_LENGTH, but never below 8 or above 64', async () => {
    process.env.MIN_PASSWORD_LENGTH = '8';
    expect(await allowed('tWo-wrds')).toBe(true);
    process.env.MIN_PASSWORD_LENGTH = '4';
    expect(getPasswordPolicy().minLength).toBe(8);
    process.env.MIN_PASSWORD_LENGTH = '500';
    expect(getPasswordPolicy().minLength).toBe(64);
    process.env.MIN_PASSWORD_LENGTH = 'twelve';
    expect(getPasswordPolicy().minLength).toBe(12);
  });

  it('refuses passwords that are easy to guess', async () => {
    expect(await allowed('aaaaaaaaaaaaaaa')).toBe(false); // one character
    expect(await allowed('123456789012')).toBe(false); // a run
    expect(await allowed('abcdefghijkl')).toBe(false);
    expect(await allowed('qwertyuiopas')).toBe(false);
    expect(await allowed('Password1234!')).toBe(false); // a common word and digits
    expect(await allowed('Nuggets2026!!')).toBe(false);
  });

  it('refuses a password containing the account email address', async () => {
    const context = { email: 'Robin.Smith@example.com' };
    expect(await problem('robin.smith@example.com!', context)).toBe('Password must not contain your email address');
    expect(await allowed('my name is robin.smith', context)).toBe(false);
    expect(await allowed('robin likes long walks', context)).toBe(true);
  });
});

describe('bcryptRounds (BCRYPT_ROUNDS)', () => {
  it('is 12 by default and honors a value from 10 to 15', () => {
    expect(bcryptRounds(undefined)).toBe(12);
    expect(bcryptRounds('')).toBe(12);
    expect(bcryptRounds('10')).toBe(10);
    expect(bcryptRounds('14')).toBe(14);
  });

  it('falls back to 12 for a value out of range or not a number', () => {
    expect(bcryptRounds('4')).toBe(12);
    expect(bcryptRounds('31')).toBe(12);
    expect(bcryptRounds('twelve')).toBe(12);
  });

  it('never goes below 12 in production, where sign-in would rehash every account down', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(bcryptRounds('10')).toBe(12);
      expect(bcryptRounds('13')).toBe(13);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe('validateEmail', () => {
  it('takes an address of up to 254 characters, and refuses a longer one before the pattern runs', () => {
    expect(validateEmail('someone@example.com')).toBe(true);
    expect(validateEmail('a@b')).toBe(false);
    const longest = `${'a'.repeat(64)}@${'b'.repeat(185)}.com`;
    expect(longest).toHaveLength(254);
    expect(validateEmail(longest)).toBe(true);
    expect(validateEmail(`a${longest}`)).toBe(false);
    // The pattern is quadratic in a run of dots: 100,000 of them took seconds.
    const start = performance.now();
    expect(validateEmail(`a@${'.'.repeat(100_000)} `)).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
    // Not a string (a JSON array, say): refused, where the pattern read ['a@b.co'] as 'a@b.co'.
    expect(validateEmail(['a@b.co'] as unknown as string)).toBe(false);
  });

  // The same check sign-in makes (loginSchema's z.email()): an address it refuses could never
  // sign in, and the mailer reads 'x<attacker@evil.com>' as a name and another address.
  it('refuses what sign-in refuses: angle brackets, a name and address, spaces', () => {
    for (const address of ['a<b>N@x.com', 'x<attacker@evil.com>', 'Ada <ada@example.com>', 'a b@x.com', 'a@b..com']) {
      expect(validateEmail(address), address).toBe(false);
    }
    expect(validateEmail('first.last+tag@sub.example.co.uk')).toBe(true);
  });
});
