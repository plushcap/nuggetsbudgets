#!/usr/bin/env node

/**
 * Print a new one-time setup token for first-run admin setup.
 *
 * Usage (in the backend container):
 *   node dist/scripts/setup-token.js        # or: npm run setup-token
 *
 * The server logs a token at startup while the deployment has no users. This prints a new
 * one without a restart, for when that log line is gone. The earlier token stops working:
 * only the newest one does. Once a user exists it issues none and exits with status 1.
 */

// Keep the routine startup logging (secrets, pool) out of the way of the token unless
// LOG_LEVEL asks for it. The logger reads LOG_LEVEL when it loads, so the app modules are
// imported after this, dynamically.
// eslint-disable-next-line no-restricted-syntax -- set before the logger loads, which reads it through config()
process.env.LOG_LEVEL ??= 'warn';

// As the server does, refuse a secret in the environment in production (before db.js reads them).
const { secretsInEnvironment } = await import('../utils/docker-secrets.js');
const refused = secretsInEnvironment();
if (refused.length > 0) {
  process.stderr.write(`Fix the configuration first:\n${refused.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}

const { default: pool, db } = await import('../db.js');
const { issueSetupToken } = await import('../services/SetupTokenService.js');
const { createLogger } = await import('../utils/logger.js');

const logger = createLogger({ service: 'SetupTokenCli' });

try {
  const token = await issueSetupToken(db);
  if (token === null) {
    process.stderr.write('Setup is already complete: the deployment has users, so no setup token was issued.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(
      'One-time setup token (enter it on the setup page; any earlier token no longer works):\n' + `${token}\n`
    );
  }
} catch (err) {
  logger.error({ err }, 'Could not issue a setup token');
  process.exitCode = 1;
} finally {
  await pool.end();
}

export {};
