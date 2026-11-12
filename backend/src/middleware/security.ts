import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import { createLogger, pathOnly } from '../utils/logger.js';
import { extractTokenFromHeader, verifyPersonalAccessToken } from '../utils/jwt-helper.js';
import { config } from '../config.js';

const logger = createLogger({ service: 'Security' });

/**
 * Whether the general API rate limiter is active.
 *
 * Fail-safe in production: rate limiting is ALWAYS on when NODE_ENV=production,
 * so a missing/typo'd `API_RATE_LIMITING` flag can no longer silently disable
 * brute-force/abuse protection on a live deployment. Elsewhere it stays opt-in
 * via the flag, and it is always off under NODE_ENV=test so suites can hammer
 * endpoints freely.
 */
export const isApiRateLimitingEnabled = (): boolean => {
  if (config().NODE_ENV === 'test') return false;
  if (config().NODE_ENV === 'production') return true;
  return config().API_RATE_LIMITING;
};

/**
 * The bucket the general API limiter counts a request in: its
 * personal access token's own (`pat:<jti>`) when it carries one whose signature verifies,
 * else its address. The MCP tools call the API back from 127.0.0.1 with the caller's token,
 * so counted by address every MCP user of the deployment shared one bucket, and one busy
 * agent could lock the others out. Counted by token, a token's /api/mcp calls and the API
 * calls its tools make share its own bucket. Only the signature is checked here (no
 * database read): a revoked token still counts in its own bucket, and authentication then
 * refuses it.
 */
export function apiRateLimitKey(req: Request): string {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = extractTokenFromHeader(header);
    if (token) {
      try {
        const { jti } = verifyPersonalAccessToken(token);
        if (typeof jti === 'string' && jti) return `pat:${jti}`;
      } catch {
        // Not a token of ours: counted by address, like any other request.
      }
    }
  }
  return `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

/**
 * A rate limiter, always on: `max` requests per `windowMs` for each key (the client's
 * address unless `keyGenerator` says otherwise). Mount createRateLimiter or
 * createApiRateLimiter, which build it only when rate limiting is enabled.
 */
export const buildRateLimiter = (windowMs: number, max: number, keyGenerator?: (req: Request) => string) =>
  rateLimit({
    windowMs,
    max,
    message: {
      error: 'Too many requests, please try again later.',
      retryAfter: Math.ceil(windowMs / 1000)
    },
    standardHeaders: true,
    legacyHeaders: false,
    // express-rate-limit's default store: in memory, per process.
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (req: Request, res: Response) => {
      logger.warn({
        ip: req.ip,
        url: pathOnly(req.originalUrl),
        method: req.method
      }, 'Rate limit exceeded');
      res.status(429).json({
        error: 'Too many requests, please try again later.',
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }
  });

// Rate limiting middleware - configurable via environment
export const createRateLimiter = (windowMs: number = 15 * 60 * 1000, max: number = 100) => {
  const rateLimitingEnabled = isApiRateLimitingEnabled();

  if (!rateLimitingEnabled) {
    logger.debug('Rate limiting disabled');
    // Return a no-op middleware if rate limiting is disabled
    return (_req: Request, _res: Response, next: NextFunction) => {
      next();
    };
  }

  logger.info({ windowMs, max }, 'Rate limiting enabled');

  return buildRateLimiter(windowMs, max);
};

/**
 * The general API limiter: RATE_LIMIT_MAX_REQUESTS (default 500) requests
 * per RATE_LIMIT_WINDOW_MS (default 15 minutes), counted per personal access token for a
 * token's requests and per address for the rest (apiRateLimitKey). A no-op unless enabled.
 */
export const createApiRateLimiter = (enabled: boolean = isApiRateLimitingEnabled()) => {
  if (!enabled) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  const windowMs = config().RATE_LIMIT_WINDOW_MS;
  const max = config().RATE_LIMIT_MAX_REQUESTS;
  logger.info({ windowMs, max }, 'Rate limiting enabled');
  return buildRateLimiter(windowMs, max, apiRateLimitKey);
};

export const apiRateLimiter = createApiRateLimiter();

/**
 * Always-on per-IP limiters for signing in, one bucket each.
 *
 * Unlike the general API limiter, these are NOT gated on API_RATE_LIMITING:
 * credential-stuffing/brute-force protection should not be optional on a financial
 * app. RATE_LIMIT_AUTH_MAX (default 10) per RATE_LIMIT_AUTH_WINDOW_MS (default 15 min).
 * Each is a separate instance, so password sign-in, passkey sign-in and first-run setup
 * don't use up each other's budget, and the sign-in ones count only failed attempts, so
 * a household behind one address doesn't lock itself out by signing in. Passkey
 * ceremony starts are all counted (they always succeed), against a larger budget
 * (RATE_LIMIT_PASSKEY_OPTIONS_MAX, default 30): each one stores a challenge.
 *
 * Keyed by req.ip, which is the client's address only when TRUST_PROXY matches the
 * proxies in front of the app (utils/trustProxy.ts). Password sign-in is also
 * throttled per account (services/LoginThrottleService.ts). Bypassed under
 * NODE_ENV=test, read when the module loads, so the test suite can authenticate
 * repeatedly.
 */
interface AuthLimiterOptions {
  name: string;
  max: number;
  /** Count only answers of 400 and above. */
  countFailuresOnly: boolean;
  error: string;
}

/**
 * Tell the sign-in limiters this refusal isn't a failed attempt from the caller's address
 * (a sign-in the per-account throttle refused without checking the password), so it
 * doesn't count against the address's failures.
 */
export function markNotAFailedSignIn(res: Response): void {
  res.locals.notAFailedSignIn = true;
}

export function buildAuthRateLimiter(options: AuthLimiterOptions) {
  if (config().NODE_ENV === 'test') {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const windowMs = config().RATE_LIMIT_AUTH_WINDOW_MS;
  const { name, max, countFailuresOnly, error } = options;

  logger.info({ limiter: name, windowMs, max, countFailuresOnly }, 'Sign-in rate limiter enabled (always on)');

  return rateLimit({
    windowMs,
    max,
    skipSuccessfulRequests: countFailuresOnly,
    requestWasSuccessful: (_req: Request, res: Response) => res.statusCode < 400 || res.locals.notAFailedSignIn === true,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
      logger.warn({ limiter: name, ip: req.ip, url: pathOnly(req.originalUrl) }, 'Sign-in rate limit exceeded');
      res.status(429).json({
        error,
        code: 'RATE_LIMITED',
        retryAfter: Math.ceil(windowMs / 1000),
      });
    },
  });
}

const authMax = () => config().RATE_LIMIT_AUTH_MAX;

export const loginRateLimiter = buildAuthRateLimiter({
  name: 'password-login',
  max: authMax(),
  countFailuresOnly: true,
  error: 'Too many failed sign-in attempts from this address, please try again later.',
});
export const passkeyOptionsRateLimiter = buildAuthRateLimiter({
  name: 'passkey-options',
  max: config().RATE_LIMIT_PASSKEY_OPTIONS_MAX,
  countFailuresOnly: false,
  error: 'Too many passkey sign-in attempts from this address, please try again later.',
});
export const passkeyLoginRateLimiter = buildAuthRateLimiter({
  name: 'passkey-login',
  max: authMax(),
  countFailuresOnly: true,
  error: 'Too many failed passkey sign-in attempts from this address, please try again later.',
});
// First-run setup gets its own bucket: a run of wrong setup tokens shouldn't lock
// everyone behind the same IP out of signing in.
export const setupRateLimiter = buildAuthRateLimiter({
  name: 'setup',
  max: authMax(),
  countFailuresOnly: false,
  error: 'Too many setup attempts from this address, please try again later.',
});

// Always-on limiter for re-authenticating in a signed-in session (password or passkey).
// Same settings as the login limiter, but counted per user rather than per IP, so
// a stolen session can't guess the password from many addresses. Mount after
// authenticateToken. Bypassed under NODE_ENV=test, like the login limiter.
const buildReauthRateLimiter = () => {
  if (config().NODE_ENV === 'test') {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const windowMs = config().RATE_LIMIT_AUTH_WINDOW_MS;
  const max = config().RATE_LIMIT_AUTH_MAX;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => `reauth:user:${req.user?.userId ?? 'none'}`,
    handler: (req: Request, res: Response) => {
      logger.warn({ url: pathOnly(req.originalUrl) }, 'Re-authentication rate limit exceeded');
      res.status(429).json({
        error: 'Too many attempts to confirm your identity, please try again later.',
        code: 'RATE_LIMITED',
        retryAfter: Math.ceil(windowMs / 1000),
      });
    },
  });
};

export const reauthRateLimiter = buildReauthRateLimiter();
