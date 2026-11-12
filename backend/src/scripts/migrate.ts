
/**
 * Migration CLI Tool
 *
 * Usage (from backend/, after `npm run build`; `node dist/scripts/migrate.js <command>` is the same):
 *   npm run migrate              # Load the baseline into an empty database, run all pending migrations
 *   npm run migrate:status       # Show migration status (read-only)
 *   npm run migrate:rollback     # Rollback last migration
 *   npm run migrate:rollback 3   # Rollback last 3 migrations
 *   npm run migrate:create       # Create a new migration file
 *   node dist/scripts/migrate.js check  # Can the database be used? (docker-entrypoint.sh's wait)
 *
 * With NODE_ENV=production a rollback asks for confirmation, so it needs a terminal
 * (`docker exec -it`), or `--yes` to skip the question.
 */

import dotenv from 'dotenv';
import type { Pool } from 'pg';
import { createMigrationPool } from '../db/migrationPool.js';
import { servingRolePassword } from '../db/servingRole.js';
import { SERVING_ROLE, syncServingRoleLogin } from '../db/servingRoleLogin.js';
import { allowConnectionsHint, describeError, isDatabaseNotAcceptingConnections, isDatabaseUnreachable } from '../utils/dbErrors.js';
import { dbErrorLine } from '../utils/dbErrorText.js';
import { getDbLocation } from '../db/dbConfig.js';
import { initializeSecrets, secretsInEnvironment } from '../utils/docker-secrets.js';
import { MigrationRefusal, MigrationService } from '../services/MigrationService.js';
import { nextMigrationVersion } from '../db/baseline.js';
import type { MigrationFailureInput } from '../services/migrationFailureFiles.js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import { getDirname } from '../utils/esm-compat.js';
import { config, configProblems } from '../config.js';

const __dirname = getDirname(import.meta.url);
// dist/scripts/ -> backend/ (dev and CI) or /app (production image), which hold both.
const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
const BASELINE_PATH = path.join(__dirname, '../../init.sql');

// Load env (.env) for local runs; in Docker these are real environment vars.
dotenv.config();

// Migrations connect as the schema OWNER via a dedicated pool, independent of the
// request-serving pool (which runs as the non-owner nuggets_app role). Without
// MIGRATION_DB_USER it falls back to DB_USER, as a single-role setup has it. Created on
// first use, so that `check` can report a secret it can't read like any other problem.
let poolInstance: Pool | undefined;
const getPool = (): Pool => (poolInstance ??= createMigrationPool());

/**
 * `check`'s exit code when the database isn't reachable yet and a later attempt may
 * succeed (EX_TEMPFAIL). docker-entrypoint.sh tries again only then.
 */
const EXIT_TRY_AGAIN = 75;

/** What to look at for a connection the database refused. */
function hintFor(err: unknown): string {
  const user = config().MIGRATION_DB_USER || config().DB_USER;
  // 55000 on connecting: the database's ALLOW_CONNECTIONS is off (a restore stopped while
  // it swapped the databases). Waiting won't fix it; its owner turns it back on.
  if (isDatabaseNotAcceptingConnections(err)) return allowConnectionsHint(getDbLocation().database);
  switch ((err as { code?: string }).code) {
    case '28P01':
      return `The password for "${user}" is wrong: the db_password secret must be the password the database ` +
        'was created with (POSTGRES_PASSWORD_FILE only applies to a new, empty data directory).';
    case '28000':
      return `The server doesn't accept "${user}": check MIGRATION_DB_USER and the server's pg_hba.conf.`;
    case '3D000':
      return `There is no database "${config().DB_NAME || config().POSTGRES_DB || 'nuggets_db'}" on the server: check DB_NAME.`;
    default:
      return 'Check DB_HOST, DB_PORT, DB_NAME, MIGRATION_DB_USER and the db_password secret.';
  }
}

/**
 * Whether the database can be used with this configuration, for docker-entrypoint.sh's
 * wait loop. Exits 0 when it answers, EXIT_TRY_AGAIN when it isn't
 * reachable yet, and 1, with what to fix, for anything waiting won't fix: a secret that
 * is missing or can't be read, a wrong password, an unknown role or database. The last
 * line printed says why.
 */
async function checkConnection(): Promise<void> {
  let pool: Pool;
  try {
    pool = getPool();
    // The server needs the serving role's password too; refuse here, before migrating.
    servingRolePassword(initializeSecrets());
  } catch (err) {
    console.error(`❌ The configuration can't be used: ${describeError(err)}`);
    process.exit(1);
  }
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    if (isDatabaseUnreachable(err)) {
      console.error(`⏳ The database isn't reachable yet: ${describeError(err)}`);
      process.exit(EXIT_TRY_AGAIN);
    }
    console.error(`❌ The database refused the connection: ${describeError(err)}. ${hintFor(err)}`);
    process.exit(1);
  }
  console.log('✅ The database answers');
}

/**
 * The version of a new migration (its file name's 14 digits): UTC now, or one second after
 * the newest version the runner knows (the baseline's, or a migration file's) when that is
 * later, since the runner refuses a migration that isn't newer than both.
 */
export function generateTimestamp(now: Date = new Date(), migrationsDir: string = MIGRATIONS_DIR): string {
  const versions = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => /^\d{14}_.*\.sql$/.test(f)).map((f) => f.slice(0, 14))
    : [];
  return nextMigrationVersion(now, versions);
}

/**
 * Prompt user for input
 */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Create a new migration file
 */
async function createMigration(): Promise<void> {
  console.log('📝 Creating new migration\n');

  const description = await prompt('Migration description (e.g., "add user settings table"): ');

  if (!description) {
    console.log('❌ Description is required\n');
    process.exit(1);
  }

  // Convert description to filename-safe format
  const filenameSafe = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_');

  const timestamp = generateTimestamp();
  const filename = `${timestamp}_${filenameSafe}.sql`;
  const filepath = path.join(MIGRATIONS_DIR, filename);

  // Ensure migrations directory exists
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  }

  // Migration template
  const template = `-- Migration: ${description}
-- Created: ${new Date().toISOString()}

-- Add your migration SQL here



-- === DOWN ===

-- Add rollback SQL here (optional but recommended)

`;

  fs.writeFileSync(filepath, template);

  console.log(`✅ Created migration: ${filename}`);
  console.log(`📍 Location: ${filepath}\n`);
  console.log('Next steps:');
  console.log('1. Edit the migration file and add your SQL');
  console.log('2. Add rollback SQL in the DOWN section (recommended)');
  console.log('3. Run: npm run migrate\n');
}

/**
 * The console line for a failed migrate: the error's code and message without its DETAIL,
 * its SQL, or what its message quotes or lists (utils/dbErrorText.ts), since the log of the
 * failed start is meant to be posted on an issue. The whole error was printed, row values
 * and all.
 */
export function migrationFailedLine(error: unknown): string {
  // A refusal changed nothing, and its message is the runner's own: whole, on its lines.
  if (error instanceof MigrationRefusal) return `Migration refused (nothing was changed): ${error.message}`;
  return `Migration failed: ${dbErrorLine(error)}`;
}

/**
 * A failed migrate leaves its report, the schema and the applied migrations in the
 * backups directory (BACKUPS_PATH on the host), since a backend that stops here has no
 * Settings → Utilities to download them from. Loaded only now, and it never
 * throws: what couldn't be written is logged, and the script exits with the migration's
 * own error.
 */
export async function writeFailureFiles(
  service: MigrationService,
  error: unknown,
  options: Partial<Omit<MigrationFailureInput, 'error' | 'migration'>> = {}
): Promise<void> {
  try {
    const { reportMigrationFailure } = await import('../services/migrationFailureFiles.js');
    await reportMigrationFailure({ ...options, error, migration: service.failedMigration, pool: options.pool ?? getPool() });
  } catch (err) {
    console.error(`Could not write the migration failure files: ${describeError(err)}`);
  }
}

/**
 * Run migrations
 */
async function runMigrate(): Promise<void> {
  const service = new MigrationService(getPool(), { migrationsDir: MIGRATIONS_DIR, baselinePath: BASELINE_PATH });

  try {
    await service.migrate();
  } catch (error) {
    console.error(migrationFailedLine(error));
    await writeFailureFiles(service, error);
    process.exit(1);
  }

  try {
    // Sync the serving role's login credentials. An earlier
    // migration creates `nuggets_app` NOLOGIN; once the app_db_password secret is provided,
    // grant it LOGIN + that password here — run as the schema owner (the migration pool) so
    // the request-serving pool can connect as the unprivileged role. No-op until the secret
    // exists, so this is safe to run on every startup pre- and post-cut-over.
    const { appDbPassword } = initializeSecrets();
    if (appDbPassword) {
      await syncServingRoleLogin(getPool(), appDbPassword);
      console.log(`✅ Synced ${SERVING_ROLE} serving-role login credentials`);
    }
  } catch (error) {
    console.error(migrationFailedLine(error));
    process.exit(1);
  }
}

/**
 * Show migration status
 */
async function showStatus(): Promise<void> {
  const service = new MigrationService(getPool(), { migrationsDir: MIGRATIONS_DIR });

  let refusal: string | undefined;
  try {
    refusal = (await service.status()).refusal;
  } catch (error) {
    console.error('Failed to get migration status:', error);
    process.exit(1);
  }
  // What migrate would refuse, as it would say it; exit 1, so a script can tell.
  if (refusal) {
    console.error(`❌ migrate refuses this database (nothing was changed): ${refusal}`);
    process.exit(1);
  }
}

/**
 * Rollback migrations
 */
async function runRollback(count: number, confirmed: boolean): Promise<void> {
  const service = new MigrationService(getPool(), { migrationsDir: MIGRATIONS_DIR });

  // Confirm rollback in production
  if (config().NODE_ENV === 'production' && !confirmed) {
    if (!process.stdin.isTTY) {
      // readline would wait on a stdin that never answers (docker exec without -it).
      console.error('❌ A production rollback needs confirmation: run it in a terminal (docker exec -it), or add --yes\n');
      process.exit(1);
    }
    console.log('⚠️  WARNING: You are about to rollback migrations in PRODUCTION!\n');
    const confirm = await prompt('Type "yes" to confirm: ');

    if (confirm.toLowerCase() !== 'yes') {
      console.log('❌ Rollback cancelled\n');
      process.exit(0);
    }
  }

  try {
    await service.rollback(count);
  } catch (error) {
    console.error(`Rollback failed: ${dbErrorLine(error)}`);
    process.exit(1);
  }
}

/**
 * Main CLI handler
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'migrate';

  // The server refuses to start with these; the migration runs first (docker-entrypoint.sh),
  // so it refuses too rather than act on a default nobody chose (a DB_PORT it can't read),
  // or sign in with a secret production doesn't take from the environment.
  const problems = [...configProblems(), ...secretsInEnvironment()];
  if (problems.length > 0) {
    console.error(`❌ Fix the configuration first:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }

  console.log('🗄️  Nuggets Database Migration Tool\n');

  try {
    switch (command) {
      case 'migrate':
      case 'up':
        await runMigrate();
        break;

      case 'status':
        await showStatus();
        break;

      case 'check':
        await checkConnection();
        break;

      case 'rollback':
      case 'down': {
        const confirmed = args.includes('--yes');
        const countArg = args.slice(1).find((a) => a !== '--yes');
        const count = countArg === undefined ? 1 : Number(countArg);
        if (!Number.isInteger(count) || count < 1) {
          console.error(`❌ rollback takes a number of migrations (1 or more), not "${countArg}"\n`);
          process.exit(1);
        }
        await runRollback(count, confirmed);
        break;
      }

      case 'create':
      case 'new':
        await createMigration();
        break;

      default:
        console.log('Unknown command:', command);
        console.log('\nAvailable commands:');
        console.log('  migrate           Run all pending migrations');
        console.log('  status            Show migration status');
        console.log('  check             Whether the database can be used (exit 75: not reachable yet)');
        console.log('  rollback [count] [--yes]  Rollback last N migrations (default: 1)');
        console.log('  create            Create a new migration file\n');
        process.exit(1);
    }

    await poolInstance?.end();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error);
    await poolInstance?.end();
    process.exit(1);
  }
}

// Run if executed directly (ESM compatible)
// In ESM, check if this file is the entry point by comparing import.meta.url with process.argv[1]
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
