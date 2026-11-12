import dotenv from 'dotenv';
import logger from './utils/logger.js';
import pool, { poolSettings } from './db.js';
import { retentionPolicy } from './services/maintenance/retention.js';
import { checkSecretsForStartup } from './utils/security-validator.js';
import { config } from './config.js';
import { initializeSecrets, secretsInEnvironment } from './utils/docker-secrets.js';
import { createApp } from './app.js';
import { mountRoutes } from './routes.js';
import { ImportService } from './services/ImportService.js';
import { BackupService } from './services/BackupService.js';
import { OneDriveService } from './services/OneDriveService.js';
import { ApplicationLifecycleService, shutdownSettings } from './services/ApplicationLifecycleService.js';
import { assertServingRoleEnforcesRls, RlsBypassRoleError } from './db/servingRole.js';
import { assertSchemaMigrated, SchemaNotReadyError } from './db/schemaReady.js';
import { announceSetupToken } from './services/SetupTokenService.js';
import { resolveTrustProxy } from './utils/trustProxy.js';
import { bcryptRounds, warmPasswordHashing } from './utils/passwords.js';
import { getPasswordPolicy } from './utils/validation.js';
import { breachCheckEnabled } from './services/breachedPasswords.js';
import { ProductionConfigError, validateStartupConfig } from './utils/productionConfig.js';
import { isApiRateLimitingEnabled } from './middleware/security.js';

// Load environment variables first
dotenv.config();

// In production a secret comes only from its Docker secret file: one in the environment (the
// stack's settings, a .env) is refused. Checked first, before the secrets read from the files
// are copied into the environment, and before a file missing beside the variable is reported.
// Rethrown so the reason reaches stderr even if the async log transport hasn't flushed.
const secretsFromEnvironment = secretsInEnvironment();
if (secretsFromEnvironment.length > 0) {
  const err = new ProductionConfigError(secretsFromEnvironment);
  logger.fatal({ err }, 'Refusing to start: fix the configuration');
  throw err;
}

// Load Docker secrets into process.env before security validation
if (config().USE_DOCKER_SECRETS) {
  const secrets = initializeSecrets();
  // Set secrets as environment variables for validation, where envSecret reads them.
  /* eslint-disable no-restricted-syntax -- the Docker secrets, copied into the environment once at startup */
  process.env.JWT_SECRET = secrets.jwtSecret;
  process.env.DB_PASSWORD = secrets.dbPassword;
  process.env.SESSION_SECRET = secrets.sessionSecret;
  process.env.CSRF_SECRET = secrets.csrfSecret;
  /* eslint-enable no-restricted-syntax */
}

// The configuration, checked now rather than failing later:
// the secrets (after they're loaded above); in production the address it is served at,
// passkeys bound to it (rather than fail at the first enrolment) and the data encryption
// key; everywhere, the passkey settings and every setting config.ts parses. Every problem
// is listed at once. Rethrown so the reason reaches stderr even if the async log
// transport hasn't flushed.
try {
  const checks = [checkSecretsForStartup, () => shutdownSettings(), () => poolSettings(), () => retentionPolicy()];
  for (const warning of validateStartupConfig(process.env, checks)) logger.error(warning);
} catch (err) {
  logger.fatal({ err }, 'Refusing to start: fix the configuration');
  throw err;
}

const PORT = config().PORT;

// Log startup configuration
logger.info({
  nodeEnv: config().NODE_ENV,
  port: PORT,
  trustProxy: resolveTrustProxy(),
  useDockerSecrets: config().USE_DOCKER_SECRETS,
  // Production always limits, whatever API_RATE_LIMITING says.
  rateLimitingEnabled: isApiRateLimitingEnabled(),
  domainUrl: config().DOMAIN_URL || 'not configured',
  bcryptRounds: bcryptRounds(),
  passwordPolicy: getPasswordPolicy(),
  passwordBreachCheck: breachCheckEnabled(),
}, 'Application startup configuration');

// The dummy hash a sign-in to an unknown address is compared with, made at the configured
// cost before the first such sign-in.
void warmPasswordHashing().catch((err) => logger.warn({ err }, 'Could not prepare password hashing'));

// Tenant isolation is row-level security, so don't serve as a role it doesn't apply to.
// Rethrown so the reason reaches stderr even if the async log transport hasn't flushed.
try {
  await assertServingRoleEnforcesRls(pool);
} catch (err) {
  logger.fatal({ err }, err instanceof RlsBypassRoleError ? 'Refusing to start' : 'Could not check the database role the app serves as');
  throw err;
}

// The migration runner, not the server, creates the schema (docker-entrypoint.sh).
try {
  await assertSchemaMigrated(pool);
} catch (err) {
  logger.fatal(
    { err },
    err instanceof SchemaNotReadyError ? 'Refusing to start: the database schema is not there' : 'Could not check the database schema'
  );
  throw err;
}

// While there are no users, log the one-time token first-run admin setup needs.
// Not fatal: `node dist/scripts/setup-token.js` issues one too.
try {
  await announceSetupToken();
} catch (err) {
  logger.error({ err }, 'Could not issue the first-run setup token; run node dist/scripts/setup-token.js for one');
}

// Initialize application services (constructed before routes that capture them)
const importService = new ImportService(pool);
const backupService = new BackupService(pool);
const oneDriveService = new OneDriveService();
const lifecycleService = new ApplicationLifecycleService(pool, importService, backupService, { oneDriveService });

logger.info('Application services initialized: ImportService, BackupService, OneDriveService, LifecycleService');

// Build the app: middleware stack (createApp), then routes (mountRoutes). The routes use
// the schedulers' import, backup and OneDrive services; mountRoutes builds the rest.
const app = createApp();
mountRoutes(app, { lifecycleService, importService, backupService, oneDriveService });

// Start server. /api/health answers from now on; /api/ready once the services below
// have started.
//
// The callback goes on 'listening', not to app.listen: Express 5 also calls a listen
// callback with the server's first 'error' (the port is taken, say), and that listener
// stays, so it would log that the server runs, start the schedulers, and swallow any
// later server error. Without one an 'error' stays an uncaught exception, which the
// lifecycle's handler logs and exits 1 on, as with Express 4.
const server = app.listen(PORT);
server.once('listening', () => {
  logger.info({ port: PORT }, '🚀 Server running');
  logger.info({ liveness: '/api/health', readiness: '/api/ready' }, '🏥 Health checks available');

  // Log rate limiting configuration: what the limiter does (always on in production).
  const { RATE_LIMIT_MAX_REQUESTS: apiRateLimit, RATE_LIMIT_WINDOW_MS: windowMs } = config();

  if (isApiRateLimitingEnabled()) {
    logger.info({
      enabled: true,
      rateLimit: apiRateLimit,
      windowMinutes: windowMs / 60000,
    }, '🛡️  API Rate Limiting: ENABLED');
  } else {
    logger.info({ enabled: false }, '🛡️  API Rate Limiting: DISABLED');
  }

  // Start the schedulers. One that can't start is tried again; if it still can't, stop
  // with exit code 1 so the restart policy starts the server again, rather than serve
  // with no bank sync, backups or alerts until someone notices.
  lifecycleService.initializeServices().catch((err) => {
    logger.fatal({ err }, 'Shutting down: the background services did not start');
    void lifecycleService.shutdown('startup failure', 1);
  });
});

// Set server reference for graceful shutdown, and the signal handlers that start one.
lifecycleService.setServer(server);
lifecycleService.registerSignalHandlers();
