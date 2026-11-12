// Validation utility functions

import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH_CEILING,
  PASSWORD_MIN_LENGTH_DEFAULT,
  PASSWORD_MIN_LENGTH_FLOOR,
  type PasswordPolicy,
} from '@nuggets/shared';
import { z } from 'zod';
import { createLogger } from './logger.js';
import { configFor } from '../config.js';

const logger = createLogger({ service: 'ValidationUtils' });

/** The longest email address (RFC 5321's 254), checked before the pattern, which is quadratic in a long one. */
const MAX_EMAIL_LENGTH = 254;

/**
 * The check sign-in makes (loginSchema's z.email()), so an address an admin or the first-run
 * setup stores can sign in, and the mailer can't read part of it as a display name.
 */
const EMAIL_ADDRESS = z.email();

export const validateEmail = (email: string): boolean => {
  const isValid = typeof email === 'string' && email.length <= MAX_EMAIL_LENGTH && EMAIL_ADDRESS.safeParse(email).success;

  if (!isValid) {
    logger.warn({ emailLength: email?.length }, 'Invalid email format detected');
  }

  return isValid;
};

let warnedMinLength: string | undefined;

/**
 * The password policy this server enforces, from its settings:
 * - MIN_PASSWORD_LENGTH: default 12, raised to 8 / lowered to 64 when set outside that;
 * - REQUIRE_PASSWORD_COMPLEXITY=true: also require a lowercase and an uppercase letter, a
 *   number and a symbol (any other character). Off by default, as NIST SP 800-63B advises.
 * GET /api/auth/password-policy hands it to the pages that set a password, and
 * checkNewPassword (passwords.ts) checks a new one against it.
 */
export function getPasswordPolicy(env: NodeJS.ProcessEnv = process.env): PasswordPolicy {
  const settings = configFor(env);
  const raw = settings.MIN_PASSWORD_LENGTH?.trim();
  let minLength = PASSWORD_MIN_LENGTH_DEFAULT;
  if (raw) {
    const n = Number(raw);
    minLength = Number.isInteger(n)
      ? Math.min(PASSWORD_MIN_LENGTH_CEILING, Math.max(PASSWORD_MIN_LENGTH_FLOOR, n))
      : PASSWORD_MIN_LENGTH_DEFAULT;
    if (minLength !== n && warnedMinLength !== raw) {
      warnedMinLength = raw;
      logger.warn(
        { MIN_PASSWORD_LENGTH: raw, using: minLength },
        `MIN_PASSWORD_LENGTH must be a whole number from ${PASSWORD_MIN_LENGTH_FLOOR} to ${PASSWORD_MIN_LENGTH_CEILING}`
      );
    }
  }
  return {
    minLength,
    maxBytes: PASSWORD_MAX_BYTES,
    requireComplexity: settings.REQUIRE_PASSWORD_COMPLEXITY,
  };
}
