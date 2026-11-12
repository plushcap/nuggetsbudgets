import { createHmac } from 'crypto';
import { readDockerSecret } from './docker-secrets.js';
import { config } from '../config.js';

let cachedSecret: string | undefined;

/**
 * The server secret behind keyed hashes a client must not be able to compute: passkey
 * decoy credential ids, login-throttle keys and trusted-device cookies.
 *
 * In production the secrets are Docker secret files (the env vars are unset), so read the
 * files first, then env. Only outside production may it fall back to a constant: with a
 * known key anyone could mint trusted-device cookies and skip the sign-in throttle.
 */
export function serverHmacSecret(): string {
  if (cachedSecret) return cachedSecret;
  const secret =
    readDockerSecret('session_secret', 'SESSION_SECRET') ||
    readDockerSecret('csrf_secret', 'CSRF_SECRET') ||
    readDockerSecret('jwt_secret', 'JWT_SECRET');
  if (!secret && config().NODE_ENV === 'production') {
    throw new Error('No server secret (session_secret) to key sign-in throttling and trusted-device cookies with');
  }
  cachedSecret = secret || 'nuggets-passkey-decoy';
  return cachedSecret;
}

/** HMAC-SHA256 of `message` under the server secret. */
export function serverHmac(message: string): Buffer {
  return createHmac('sha256', serverHmacSecret()).update(message).digest();
}
