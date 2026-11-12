/**
 * Personal access tokens (MCP tokens) as JWTs: signing and verification.
 *
 * Browsers sign in with server-side sessions (SessionService); the only JWTs the app
 * accepts are personal access tokens, minted by POST /api/auth/mcp-token for the MCP
 * server and other non-browser clients. Each one carries `aud: 'mcp'` and a `jti` that
 * names its row in personal_access_tokens, which the auth middleware checks on every
 * request.
 */

import jwt from 'jsonwebtoken';
import { initializeSecrets } from './docker-secrets.js';
import { createLogger } from './logger.js';

const logger = createLogger({ service: 'JWTHelper' });

// Initialize secrets once at module load
const secrets = initializeSecrets();

/** The only algorithm, audience and issuer a personal access token may have. */
export const PAT_ALGORITHM = 'HS256';
export const PAT_AUDIENCE = 'mcp';
export const PAT_ISSUER = 'nuggets';

/**
 * A verified token's claims. The signature proves we signed it, not what its claims hold
 * (a token minted by older code can lack one), so the app's own claims are `unknown`:
 * the caller compares them with the token's row, which is what counts.
 */
export interface JWTPayload {
  userId?: unknown;
  email?: unknown;
  /** The ledger (tenant id) the token is pinned to. */
  tenantId?: unknown;
  /** What the token may do: 'read' or 'read_write'. Informational; the DB row is what's enforced. */
  scope?: unknown;
  iat?: number | undefined;
  exp?: number | undefined;
  aud?: string | string[] | undefined;
  iss?: string | undefined;
  jti?: string | undefined;
}

/**
 * Get validated JWT secret
 * This function ensures the secret is properly configured before use
 */
function getJWTSecret(): string {
  const jwtSecret = secrets.jwtSecret;

  if (!jwtSecret) {
    throw new Error('JWT secret is not configured');
  }

  return jwtSecret;
}

/**
 * Sign a personal access token: HS256, `aud: 'mcp'`, `iss: 'nuggets'`, and the given
 * `jti` (its personal_access_tokens row) and lifetime.
 */
export const signPersonalAccessToken = (
  payload: { userId: number; email: string; tenantId: number; scope: string },
  options: { expiresIn: string; jwtid: string }
): string => {
  const secret = getJWTSecret();
  try {
    return jwt.sign(payload, secret, {
      algorithm: PAT_ALGORITHM,
      audience: PAT_AUDIENCE,
      issuer: PAT_ISSUER,
      jwtid: options.jwtid,
      expiresIn: options.expiresIn as NonNullable<jwt.SignOptions['expiresIn']>,
    });
  } catch (error) {
    logger.error({ err: error, userId: payload.userId }, 'Personal access token signing failed');
    throw new Error('Token generation failed', { cause: error });
  }
};

/**
 * Verify a personal access token's signature, algorithm, audience, issuer and expiry, and
 * decode it. Tokens minted before the issuer was set carry none, so a missing `iss` is
 * accepted; any other issuer is refused. The caller still checks the token's row.
 */
export function verifyPersonalAccessToken(token: string): JWTPayload {
  const secret = getJWTSecret();

  let verified: string | jwt.JwtPayload;
  try {
    verified = jwt.verify(token, secret, {
      algorithms: [PAT_ALGORITHM],
      audience: PAT_AUDIENCE,
    });
  } catch (error) {
    // TokenExpiredError and NotBeforeError extend JsonWebTokenError, so test them first.
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Token has expired', { cause: error });
    } else if (error instanceof jwt.NotBeforeError) {
      throw new Error('Token not yet valid', { cause: error });
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid token', { cause: error });
    } else {
      throw new Error('Token verification failed', { cause: error });
    }
  }
  if (typeof verified !== 'object' || verified === null) {
    throw new Error('Invalid token');
  }
  if (verified.iss !== undefined && verified.iss !== PAT_ISSUER) {
    throw new Error('Invalid token issuer');
  }
  return verified;
}

/**
 * Extract token from Authorization header
 */
export function extractTokenFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  // Expected format: "Bearer <token>"
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
    return null;
  }

  return parts[1];
}

/**
 * Decode token without verification (for debugging purposes only)
 * WARNING: Never use this for authentication - only for logging/debugging
 */
export function decodeTokenUnsafe(token: string): jwt.JwtPayload | string | null {
  try {
    return jwt.decode(token);
  } catch {
    return null;
  }
}
