import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './logger.js';
import { config, configFor, SETTINGS } from '../config.js';

const logger = createLogger({ service: 'DockerSecrets' });

/**
 * Docker secrets: files in SECRETS_PATH (/run/secrets in a container). Outside production a
 * secret may also come from its environment variable, for development and the tests;
 * production reads only the files, and refuses to start with one in the environment
 * (secretsInEnvironment), so the stack's settings never hold a secret.
 */

export interface SecretsConfig {
  dbPassword: string;
  appDbPassword: string;
  jwtSecret: string;
  sessionSecret: string;
  csrfSecret: string;
}

/**
 * Why a secret file that is there couldn't be used (it can't be read, or is empty), by
 * secret name, so a missing-secret error can say so: an unreadable file is the commonest
 * mistake, and "missing" sends people looking in the wrong place.
 */
const unusableSecretFiles = new Map<string, string>();

/**
 * Read a Docker secret from the filesystem
 * @param secretName - Name of the secret (matches the secret key in docker-compose.yml)
 * @param fallbackEnvVar - Environment variable to use as fallback, outside production only
 * @returns The secret value or undefined if not found
 */
export const readDockerSecret = (secretName: string, fallbackEnvVar?: string): string | undefined => {
  // Docker secrets are mounted at /run/secrets/<secret_name> (SECRETS_PATH elsewhere).
  const secretPath = path.join(config().SECRETS_PATH, secretName);
  unusableSecretFiles.delete(secretName);
  try {
    if (fs.existsSync(secretPath)) {
      const secret = fs.readFileSync(secretPath, 'utf8').trim();
      if (secret) {
        logger.info({ secretName }, 'Loaded Docker secret');
        return secret;
      }
      unusableSecretFiles.set(secretName, `${secretPath} is empty`);
    }
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'EACCES'
      ? `${secretPath} can't be read by this user (uid ${process.getuid?.() ?? '?'}): check its owner and mode`
      : `${secretPath} can't be read: ${(error as Error).message}`;
    unusableSecretFiles.set(secretName, reason);
    logger.warn({ err: error, secretName }, 'Failed to read Docker secret');
  }

  // Fallback to environment variable, outside production (production refuses one at startup)
  if (fallbackEnvVar && process.env[fallbackEnvVar] && config().NODE_ENV !== 'production') {
    logger.warn({ secretName, fallbackEnvVar }, 'Using environment variable fallback for secret');
    return process.env[fallbackEnvVar];
  }

  return undefined;
};

/**
 * A secret as the environment holds it, or undefined when it is unset or empty: one
 * index.ts copied there from its Docker secret at startup (JWT_SECRET, DB_PASSWORD,
 * SESSION_SECRET, CSRF_SECRET), or, outside production, one set as a variable.
 * config() leaves secrets out, so code reads them here or with
 * readDockerSecret, never from process.env itself (eslint.config.mjs). A function
 * that takes an environment to read (its tests pass another) passes it as `env`.
 */
export function envSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[name] || undefined;
}

/**
 * What startup copied into the environment from the files (copySecretsIntoEnvironment), by
 * variable: a variable still holding that value is the server's own, not a stack's.
 */
const copiedFromFiles = new Map<string, string>();

/**
 * Copy the secrets read from their files into the environment, where envSecret's readers
 * (the security checks, the CSRF token) find them; once, at startup (index.ts). Remembered,
 * so a variable set this way is never taken for one a stack set (refusedVariable).
 */
export function copySecretsIntoEnvironment(secrets: SecretsConfig): void {
  const copies = {
    JWT_SECRET: secrets.jwtSecret,
    DB_PASSWORD: secrets.dbPassword,
    SESSION_SECRET: secrets.sessionSecret,
    CSRF_SECRET: secrets.csrfSecret,
  };
  for (const [name, value] of Object.entries(copies)) {
    process.env[name] = value;
    copiedFromFiles.set(name, value);
  }
}

/**
 * In production, why a secret's variable is no use: it is set in the environment, which
 * production never reads a secret from (startup copies aside). Undefined otherwise.
 */
export function refusedVariable(variable: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = envSecret(variable, env);
  if (configFor(env).NODE_ENV !== 'production' || !value || copiedFromFiles.get(variable) === value) return undefined;
  return `${variable} is set in the environment, which production never reads a secret from`;
}

/**
 * An optional secret read for one task, by the environment it is given: its file in
 * SECRETS_PATH (the variable's name in lower case: `migration_db_password` for
 * MIGRATION_DB_PASSWORD), else, outside production, the variable. Undefined when neither.
 * A file that is there but can't be read is an error, not a reason to sign in another way.
 */
export function optionalSecret(
  variable: 'MIGRATION_DB_PASSWORD' | 'BACKUP_DB_PASSWORD',
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const settings = configFor(env);
  const file = path.join(settings.SECRETS_PATH, secretFileName(variable));
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value) return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `The ${secretFileName(variable)} secret file (${file}) can't be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
        { cause: error }
      );
    }
  }
  return settings.NODE_ENV === 'production' ? undefined : envSecret(variable, env);
}

/** The variables config.ts lists as secrets (DB_PASSWORD, JWT_SECRET, …). */
export const SECRET_VARIABLES: readonly string[] = Object.entries(SETTINGS)
  .filter(([, spec]) => (spec as { secret?: boolean }).secret === true)
  .map(([name]) => name);

/** The Docker secret file a secret variable stands in for: its name in lower case. */
export const secretFileName = (variable: string): string => variable.toLowerCase();

/**
 * In production, a problem for each secret set in the environment `env` (as it was before
 * index.ts copied the Docker secrets into it): production reads secrets only from their
 * files, so one in a stack's settings is a mistake to fix, not a value to use. None outside
 * production, where the variables are how development and the tests set them.
 */
export function secretsInEnvironment(env: NodeJS.ProcessEnv = process.env): string[] {
  return SECRET_VARIABLES.flatMap((name) => {
    const refused = refusedVariable(name, env);
    return refused ? [`${refused}: put it in the ${secretFileName(name)} Docker secret file (in SECRETS_PATH) and remove the variable`] : [];
  });
}

/**
 * Why Postgres and the backend would read different passwords from the content of a
 * db_password file, or null when they read the same. Both read the one file:
 *  - the postgres image's first start reads it with `$(< file)`, which drops its trailing
 *    newlines (and any NUL byte), signs in with that during its own setup, and has initdb
 *    set the first line of it, less a CR at its end, as the password;
 *  - the backend trims whitespace from both ends (readDockerSecret).
 * So a CR or spaces at the end of the line (CRLF line endings, say) make the image's first
 * start fail, or give the database a password the backend doesn't send; so does whitespace
 * at the start, or a line break or NUL byte inside. Sign-in then fails, saying nothing about
 * why. Whitespace at the end alone can be cut from the file (deploy.sh does); for the rest,
 * which password was meant is its owner's call.
 */
export function dbPasswordFileProblem(content: string): string | null {
  const postgres = content.replace(/\0/g, '').replace(/\n+$/, '');
  const backend = content.trim();
  if (postgres === backend && !backend.includes('\n')) return null;
  if (!content.includes('\0') && content.trimStart() === content && !backend.includes('\n')) {
    return (
      'ends in whitespace other than a newline (a carriage return from CRLF line endings, or spaces), which the backend ' +
      "drops and Postgres doesn't: Postgres's first start fails, or its password isn't the one the backend sends. " +
      "Remove it from the end of the file (deploy.sh does; by hand, sed -i 's/[[:space:]]*$//' on the file), then restart."
    );
  }
  const what = content.includes('\0')
    ? 'has a NUL byte in it'
    : backend.includes('\n')
      ? 'has a line break inside the password (Postgres takes only its first line)'
      : 'starts with whitespace (the backend drops it, Postgres keeps it)';
  return (
    `${what}, so Postgres and the backend would read different passwords from it. Write the password alone on ` +
    'one line, with nothing before or after it, then restart.'
  );
}

/**
 * The db_password secret file's problem (dbPasswordFileProblem), naming the file, or none.
 * Only that file: every other secret is read by the backend alone, which trims it, so a CR
 * at its ends changes nothing, and one inside is part of the value it has always had. A file
 * that isn't there or can't be read is left to the check that reads it.
 */
export function dbPasswordFileProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const file = path.join(configFor(env).SECRETS_PATH, 'db_password');
  let bytes: Buffer;
  try {
    if (!fs.statSync(file).isFile()) return [];
    bytes = fs.readFileSync(file);
  } catch {
    return [];
  }
  const content = bytes.toString('utf8');
  // Postgres takes the file's bytes; the backend reads it as UTF-8, so a byte that isn't
  // UTF-8 (an "é" a Windows editor saved as Latin-1) becomes U+FFFD and the two passwords
  // differ: Postgres starts, and the backend can't sign in.
  if (!Buffer.from(content, 'utf8').equals(bytes)) {
    return [
      `The secret file ${file} isn't UTF-8 text (a character saved in another encoding, as some Windows editors do), ` +
        "so the backend wouldn't read the password Postgres has. Save it as UTF-8, then restart.",
    ];
  }
  const problem = dbPasswordFileProblem(content);
  return problem ? [`The secret file ${file} ${problem}`] : [];
}

/**
 * Load all required secrets with appropriate fallbacks
 * @returns SecretsConfig object with all required secrets
 * @throws Error if any required secret is missing
 */
export const loadSecrets = (): SecretsConfig => {
  // Before anything connects with them: the migration runner loads them too, and with a
  // db_password Postgres reads differently it would fail to sign in without saying why.
  const dbPasswordFile = dbPasswordFileProblems();
  if (dbPasswordFile.length > 0) throw new Error(dbPasswordFile.join(' '));

  const secrets: SecretsConfig = {
    dbPassword: readDockerSecret('db_password', 'DB_PASSWORD') || '',
    // The unprivileged serving role's password. Not part of the
    // required-secrets check below: a single-role setup has none, and db/servingRole.ts
    // refuses a separate serving role without it.
    appDbPassword: readDockerSecret('app_db_password', 'APP_DB_PASSWORD') || '',
    jwtSecret: readDockerSecret('jwt_secret', 'JWT_SECRET') || '',
    sessionSecret: readDockerSecret('session_secret', 'SESSION_SECRET') || '',
    csrfSecret: readDockerSecret('csrf_secret', 'CSRF_SECRET') || ''
  };

  // Validate that all required secrets are present
  const missingSecrets: string[] = [];
  
  if (!secrets.dbPassword) missingSecrets.push('db_password');
  if (!secrets.jwtSecret) missingSecrets.push('jwt_secret');
  if (!secrets.sessionSecret) missingSecrets.push('session_secret');
  if (!secrets.csrfSecret) missingSecrets.push('csrf_secret');

  if (missingSecrets.length > 0) {
    const production = config().NODE_ENV === 'production';
    const described = missingSecrets.map((name) => {
      // In production a variable left where the file should be is the likeliest cause: name it.
      const refused = refusedVariable(name.toUpperCase());
      const reasons = [
        unusableSecretFiles.get(name),
        refused ? `${refused}: put it in this file and remove the variable` : undefined,
      ].filter(Boolean);
      return reasons.length > 0 ? `${name} (${reasons.join('; ')})` : name;
    });
    throw new Error(`Missing required secrets: ${described.join(', ')}. ` +
      (production
        ? 'Mount each as a Docker secret file (production reads no secret from the environment).'
        : 'Ensure Docker secrets are configured or environment variables are set.'));
  }

  // Weak secrets stop a production server; in development they're a warning.
  validateSecretStrength(secrets);

  return secrets;
};

/** Values from examples and templates, which a deployment must not run with. */
const PLACEHOLDER_SECRETS = new Set([
  'changeme', 'change_me', 'change-me', 'password', 'secret', 'test_secret', 'test_session_secret',
  'test_csrf_secret', 'test_password', 'regen', 'your-secret', 'your_secret', 'example',
]);

/**
 * Why a secret is too weak to run with, or null. A random secret from
 * `npm run security:generate` (or `openssl rand -base64 32`) is 44 characters.
 */
export function secretWeakness(value: string, minLength: number): string | null {
  if (value.length < minLength) return `shorter than ${minLength} characters`;
  if (PLACEHOLDER_SECRETS.has(value.toLowerCase())) return 'a placeholder value';
  if (new Set(value).size < 8) return 'fewer than 8 different characters';
  return null;
}

/**
 * The secrets a deployment may not start with in production: they
 * used to be logged as warnings only, and the server ran with a guessable JWT or HMAC key.
 * Names only: never a secret's value.
 */
export const weakSecrets = (secrets: SecretsConfig): string[] => {
  const checks: Array<[string, string, number]> = [
    ['db_password', secrets.dbPassword, 16],
    ['jwt_secret', secrets.jwtSecret, 32],
    ['session_secret', secrets.sessionSecret, 16],
    ['csrf_secret', secrets.csrfSecret, 16],
  ];
  // Only when there is one: a single-role setup has no serving-role password.
  if (secrets.appDbPassword) checks.push(['app_db_password', secrets.appDbPassword, 16]);
  return checks.flatMap(([name, value, min]) => {
    const weakness = secretWeakness(value, min);
    return weakness ? [`${name} is ${weakness}`] : [];
  });
};

/**
 * Refuse to start in production with a weak secret; outside production, warn.
 * @param secrets - The loaded secrets configuration
 */
const validateSecretStrength = (secrets: SecretsConfig): void => {
  const problems = weakSecrets(secrets);
  if (problems.length === 0) return;
  if (config().NODE_ENV === 'production') {
    throw new Error(
      `Weak secrets: ${problems.join('; ')}. Replace each. With deploy.sh, remove its file and run ` +
        './deploy/deploy.sh production setup, which writes a new one with the owner and permissions the ' +
        "containers need. By hand, as root, openssl rand -base64 32 | tr -d '\\n' > <the file> keeps the " +
        "file's owner and permissions. A new db_password must also be set on the database's owner role " +
        '(ALTER ROLE ... PASSWORD) before the restart, and a new jwt, session or CSRF secret signs everyone ' +
        'out. Then restart.'
    );
  }
  if (config().NODE_ENV === 'development') logger.warn({ problems }, 'Weak secrets (refused in production)');
};

/**
 * Initialize secrets and return the configuration
 * This is the main function to call during application startup
 */
export const initializeSecrets = (): SecretsConfig => {
  logger.info('Initializing Docker secrets');
  
  try {
    const secrets = loadSecrets();
    logger.info('All secrets loaded successfully');
    return secrets;
  } catch (error) {
    logger.error({ err: error }, 'Failed to initialize secrets');
    
    // In development, provide helpful guidance
    if (config().NODE_ENV !== 'production') {
      logger.error({ 
        setupGuide: {
          secretFiles: ['db_password.txt', 'jwt_secret.txt', 'session_secret.txt', 'csrf_secret.txt'],
          envVars: ['DB_PASSWORD', 'JWT_SECRET', 'SESSION_SECRET', 'CSRF_SECRET'],
          secretsDirectory: 'secrets/'
        }
      }, 'Development setup guide for secrets');
    }
    
    throw error;
  }
};