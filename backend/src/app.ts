import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'path';
import logger from './utils/logger.js';
import { httpLogger } from './middleware/logger.js';
import { requestScope } from './middleware/requestScope.js';
import { refuseNulText } from './middleware/nulText.js';
import { getDirname } from './utils/esm-compat.js';
import { CSRFProtection } from './middleware/security-enhanced.js';
import { apiRateLimiter, isApiRateLimitingEnabled } from './middleware/security.js';
import { authenticateSession } from './middleware/auth.js';
import { resolveTrustProxy, warnOnUntrustedForwarding } from './utils/trustProxy.js';
import { restoreMaintenanceGate } from './middleware/restoreMaintenance.js';
import { config } from './config.js';

const __dirname = getDirname(import.meta.url);

/** The public probes under /api (routes.ts): liveness and readiness. */
const HEALTH_PROBE_PATHS = new Set(['/health', '/ready']);

/**
 * A request the API rate limiter doesn't count: a GET or HEAD of the liveness or readiness
 * probe itself, which the container healthchecks and uptime monitors call. Exactly
 * those paths: the skip took any path starting with `/health`, so `POST /api/health<15,000
 * letters>` went unlimited to the CSRF check, whose security event carried the path.
 * The admin-only health routes (`/api/health/detailed` …) are counted like any other
 * route.
 */
export function isUncountedHealthProbe(req: Pick<express.Request, 'method' | 'path'>): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && HEALTH_PROBE_PATHS.has(req.path);
}

/**
 * Build the Express application and apply the full middleware stack.
 *
 * This is middleware only — no routes and no server start. Routes are mounted
 * separately by `mountRoutes` (routes.ts), and the process is started by
 * index.ts. The registration order here is load-bearing; keep it as-is.
 */
export function createApp(): express.Application {
  const app = express();

  // Trust proxy: which proxies in front of the app (Caddy, a CDN) may name the client's
  // address, which the sign-in rate limits key on. TRUST_PROXY is a hop count or a list
  // of proxy addresses (utils/trustProxy.ts).
  const trustProxy = resolveTrustProxy();
  if (trustProxy === false) {
    app.use(warnOnUntrustedForwarding());
  } else {
    app.set('trust proxy', trustProxy);
    logger.info({ trustProxy }, 'Trusting the proxies in front of the app for the client address');
  }

  app.use(helmet({
    // The backend serves JSON, uploaded images and attachments, never the app: the SPA
    // document comes from the frontend container, with its own policy
    // (frontend/public/serve.json). So nothing the backend sends may load or run anything,
    // be framed, or post a form. The two HTML pages it renders set their own policy: the
    // OneDrive OAuth callback (routes/onedrive.ts) and the email preview
    // (routes/notifications.ts).
    //
    // The one allowance, style attributes, is for the browser's own viewer when an image
    // or attachment is opened in a tab: Chromium centres the image with them, and logs a
    // violation for each one refused. They can load nothing (every fetch is 'none'), and no
    // <style> element or stylesheet is allowed.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        styleSrcAttr: ["'unsafe-inline'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // Only the app's own origin may embed what the backend serves (an uploaded image, an
    // attachment). The app loads them through the reverse proxy, or the Vite proxy in
    // development, so always from its own origin.
    crossOriginResourcePolicy: { policy: 'same-origin' },
    // For browsers without frame-ancestors; set here, not only below, so that /uploads,
    // which answers before the security-headers middleware, gets it too.
    xFrameOptions: { action: 'deny' },
    // includeSubDomains and preload reach every other site under the domain (and preload
    // can't be undone quickly), so they're opt-in: Nuggets may be served from a domain
    // that also hosts plain-HTTP services.
    hsts: {
      maxAge: 31536000,
      includeSubDomains: config().HSTS_INCLUDE_SUBDOMAINS,
      preload: config().HSTS_PRELOAD,
    },
  }));

  // CORS configuration
  // In production with reverse proxy: same origin, CORS not needed
  // In development: different ports, CORS required
  const corsOrigin = config().CLIENT_URL || config().DOMAIN_URL || 'http://localhost:3000';

  logger.info({ corsOrigin }, 'CORS configured');

  app.use(cors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // X-CSRF-Token: a cookie-authenticated write sends it, and a preflight that
    // doesn't allow it stops the browser sending the write at all.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    // The UI reads a request's id off an error answer, so a report can quote it.
    exposedHeaders: ['X-Request-Id'],
  }));

  // Pino HTTP logger middleware (replaces Morgan)
  app.use(httpLogger);

  // The request's id (from httpLogger): the X-Request-Id answer header, on every log
  // line of the request, and in every error body, which it completes to the one shape.
  app.use(requestScope);

  // Cookie parser middleware for the session cookie
  app.use(cookieParser());

  // Issue a double-submit CSRF cookie to every client (readable by the SPA).
  app.use(CSRFProtection.cookieSetter());

  app.use(express.json({ limit: '1mb' })); // Reduced from 10mb
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  // Express 5 leaves req.body undefined when no parser took the request (a GET or DELETE,
  // a POST without a body or with another content type); Express 4's parsers set {}. The
  // handlers read it as an object (`const { name } = req.body`), so a request without a
  // body would throw a TypeError and answer 500 rather than its route's 400. Upload routes'
  // multer sets its own.
  app.use(function defaultEmptyBody(req, _res, next) {
    if (req.body === undefined) req.body = {};
    next();
  });
  // A NUL character in a body's text ("\u0000" in JSON) is a 400, once for every route: Postgres
  // can't store it in text or jsonb, and answered it with a 500.
  app.use(refuseNulText);

  // Serve uploaded IMAGES (profile / account / merchant / goal avatars) as
  // static files — but only to an authenticated session, and only from the known
  // image subdirectories, with an image extension. Everything else under
  // uploads/ is deliberately NOT reachable here:
  //   - financial attachments (bank statements, bills) live in the uploads root
  //     and are served by the authenticated, tenant-scoped
  //     GET /api/attachments/file/:uuid route so RLS enforces ownership;
  //   - CSV imports and statement PDFs are never served statically.
  // Requiring auth closes the unauthenticated read of uploaded files; scoping to
  // image subdirs + extensions (plus X-Content-Type-Options: nosniff) prevents a
  // stored file from being served as executable content.
  const uploadsRoot = path.join(__dirname, '../uploads');
  // Exactly `<image-subdir>/<safe-name>.<image-ext>` and nothing else. The strict
  // character class rejects any path separator, `..`, or percent-encoding in the
  // filename, so encoded-traversal attempts (e.g. `account-images/..%2fbill.pdf`)
  // fail this test before reaching the file server.
  const SERVABLE_IMAGE_PATH =
    /^(?:user-profiles|account-images|merchant-images|goal-images)\/[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp)$/i;
  app.use(
    '/uploads',
    authenticateSession,
    (req, res, next) => {
      const rel = path.posix.normalize(req.path).replace(/^\/+/, '');
      if (!SERVABLE_IMAGE_PATH.test(rel)) {
        return res.status(404).json({ error: 'Not found' });
      }
      return next();
    },
    express.static(uploadsRoot, {
      index: false,
      dotfiles: 'deny',
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, max-age=300');
      },
    }),
    // What the file server passes on (no such file, a dotfile it denies): the JSON 404 in
    // the error shape, as above, not Express's HTML page.
    (_req: express.Request, res: express.Response) => {
      res.status(404).json({ error: 'Not found' });
    }
  );

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });

  logger.info('Security middleware configured: Helmet, CORS, CSP, HSTS');

  // Apply rate limiting to all routes except health checks. Enabled follows
  // isApiRateLimitingEnabled() — always on in production, opt-in elsewhere.
  app.use('/api', (req, res, next) => {
    if (isUncountedHealthProbe(req)) {
      return next();
    }

    if (isApiRateLimitingEnabled()) {
      return apiRateLimiter(req, res, next);
    }
    // Rate limiting disabled (dev without the flag, or test) — proceed.
    return next();
  });

  // CSRF double-submit verification for cookie-authenticated mutations on /api.
  // Safe methods, Bearer/PAT clients, and unauthenticated requests are exempt.
  app.use('/api', CSRFProtection.verify());

  // While a backup is restored, refuse everything that would change data.
  app.use('/api', restoreMaintenanceGate);

  return app;
}
