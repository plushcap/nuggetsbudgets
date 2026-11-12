/**
 * The backend's settings: every environment variable it reads, parsed once with Zod.
 * Each setting lists its type, default and description. The settings table of the
 * deployment docs is generated from this list (`npm run docs:env`), and `config.test.ts`
 * fails when the code reads a variable that isn't listed here.
 *
 * - `config()` gives the parsed settings. It never throws: a value that can't be used
 *   reads as the default, and `configProblems()` names it. index.ts refuses to start on
 *   any problem (`validateStartupConfig`, utils/productionConfig.ts), with every problem
 *   listed at once. Modules read settings when they're loaded, before that check runs,
 *   so throwing there would hide the list behind the first one.
 * - It reads `process.env` again when the environment changes (index.ts copies Docker
 *   secrets into it, tests change it), so it's always current.
 * - `loadConfig(env)` parses any environment, for checks and tests.
 * - Secrets (`secret: true`) are listed so they're documented, but aren't in `config()`:
 *   they're read from Docker secrets through utils/docker-secrets.ts, with the variable as
 *   the fallback outside production (production refuses one), and never logged.
 *
 * Imports nothing from the app: the logger reads its level from here.
 */
import { z } from 'zod';

type Env = NodeJS.ProcessEnv;

/** The outcome of reading one setting: its value, and what's wrong with the raw one. */
interface Parsed<T> {
  value: T;
  /** The value can't be used: the default stands, and the server refuses to start. */
  problem?: string;
}

interface SettingSpec<T> {
  group: SettingGroup;
  /** One line for the docs table. */
  description: string;
  /** The default, as the docs show it. */
  defaultText: string;
  /** Read from a Docker secret first; never in config(), never logged. */
  secret?: boolean;
  /** Read only outside the Node process (docker-entrypoint.sh). */
  readBy?: string;
  /** Set by the image build, not by the compose files. */
  bakedIn?: boolean;
  /**
   * Not for the deployment to set: the compose files leave it at its default, which fits
   * the image and the directories they mount (a path inside the container, say). Every
   * other setting must reach the backend from the stack's environment (settingsMarkdown).
   */
  notFromStack?: boolean;
  /**
   * Read only by the server, never by the command-line tools (migrate, restore,
   * rewrap-secrets): an unusable value stops the server (validateStartupConfig asks
   * settingProblem), but isn't one of configProblems(), on which those tools refuse to
   * run. A restore after a disaster shouldn't wait on a cookie setting it never reads.
   */
  serverOnly?: boolean;
  parse: (raw: string | undefined, name: string, env: Env) => Parsed<T>;
}

export type SettingGroup =
  | 'Server'
  | 'Passwords and sessions'
  | 'Passkeys'
  | 'Rate limits'
  | 'Database'
  | 'Migrations'
  | 'Files and backups'
  | 'Integrations'
  | 'Data retention'
  | 'Shutdown'
  | 'Logging and build'
  | 'Secrets (development and tests only: production reads the Docker secret files and refuses these)';

const blank = (raw: string | undefined): boolean => raw === undefined || raw.trim() === '';

/** Text, `fallback` when unset or empty. */
const text = (fallback = '') => (raw: string | undefined): Parsed<string> => ({ value: blank(raw) ? fallback : raw! });

/** Text that is undefined when unset or empty. */
const optionalText = () => (raw: string | undefined): Parsed<string | undefined> => ({ value: blank(raw) ? undefined : raw });

/** The variable as it is, for settings their reader interprets (empty included). */
const asIs = () => (raw: string | undefined): Parsed<string | undefined> => ({ value: raw });

/** On only for exactly `true` (the variables that always worked that way). */
const exactFlag = () => (raw: string | undefined): Parsed<boolean> => ({ value: raw === 'true' });

/** On for `true` in any case, with or without spaces around it. */
const looseFlag = () => (raw: string | undefined): Parsed<boolean> => ({ value: raw?.trim().toLowerCase() === 'true' });

/**
 * `true` or `false` (case and spaces ignored), or undefined when unset or empty, for a
 * setting whose absence means something else. Any other value is a problem.
 */
const optionalFlag = () => (raw: string | undefined, name: string): Parsed<boolean | undefined> => {
  if (blank(raw)) return { value: undefined };
  const value = raw!.trim().toLowerCase();
  if (value === 'true' || value === 'false') return { value: value === 'true' };
  return { value: undefined, problem: `${name} must be true or false (it is ${raw!.trim()})` };
};

/**
 * A whole number from `min` to `max`, `fallback` when unset or empty. Anything else is a
 * problem (the server refuses to start) rather than NaN or a value nobody chose.
 */
const wholeNumber = (
  fallback: number | ((env: Env) => number),
  min: number,
  max: number,
  { digitsOnly = false }: { digitsOnly?: boolean } = {}
) => {
  const schema = z.number().int().min(min).max(max);
  return (raw: string | undefined, name: string, env: Env): Parsed<number> => {
    const dflt = typeof fallback === 'function' ? fallback(env) : fallback;
    if (blank(raw)) return { value: dflt };
    // digitsOnly: the settings once read with parseInt, which took "1e6" as 1 and "0x10"
    // as 0. Refusing such a value beats silently changing its meaning.
    const text = raw!.trim();
    const result = digitsOnly && !/^\d+$/.test(text) ? { success: false as const } : schema.safeParse(Number(text));
    if (result.success) return { value: result.data };
    return { value: dflt, problem: `${name} must be a whole number from ${min} to ${max}, not "${raw}"` };
  };
};

/** One of `values` (case and spaces ignored), `fallback` when unset or empty. */
const oneOf = <const V extends readonly [string, ...string[]]>(values: V, fallback: V[number]) => {
  const schema = z.enum(values);
  return (raw: string | undefined, name: string): Parsed<V[number]> => {
    if (blank(raw)) return { value: fallback };
    const result = schema.safeParse(raw!.trim().toLowerCase());
    if (result.success) return { value: result.data };
    return { value: fallback, problem: `${name} must be ${values.join(' or ')}, not ${raw}` };
  };
};

const setting = <T>(spec: SettingSpec<T>): SettingSpec<T> => spec;
const secret = (description: string): SettingSpec<undefined> =>
  setting({
    group: 'Secrets (development and tests only: production reads the Docker secret files and refuses these)',
    description,
    defaultText: 'unset',
    secret: true,
    parse: () => ({ value: undefined }),
  });

const isProduction = (env: Env) => env.NODE_ENV === 'production';

/**
 * Every setting, in the order the docs list them. Add one here before reading it; the
 * variable's name is the key.
 */
export const SETTINGS = {
  // ---- Server ----
  NODE_ENV: setting({
    group: 'Server',
    description: '`production` turns on the production checks, the `__Host-` cookies and the always-on API rate limit. `test` is for the test suite',
    defaultText: '`development`',
    parse: text('development'),
  }),
  PORT: setting({
    group: 'Server',
    description: 'Port the backend listens on (inside its container)',
    defaultText: '`5000`',
    parse: wholeNumber(5000, 0, 65535, { digitsOnly: true }),
  }),
  DOMAIN_URL: setting({
    group: 'Server',
    description: 'Public URL, e.g. `https://nuggets.example.com`. The backend refuses to start in production without it, or when it isn\'t `https://` (`http://` is accepted only for `localhost`). Passkeys, CORS, cookies and email links use it',
    defaultText: 'unset (required in production)',
    parse: optionalText(),
  }),
  CLIENT_URL: setting({
    group: 'Server',
    description: 'The browser-facing origin, when it differs from `DOMAIN_URL`: CORS, links in emails and push notifications, and the OneDrive redirect URI the Backup page starts with. Checked like `DOMAIN_URL` in production',
    defaultText: '`DOMAIN_URL`',
    parse: optionalText(),
  }),
  COOKIE_SECURE: setting({
    group: 'Server',
    description: 'Whether sign-in cookies are `Secure` (with `SameSite=Strict` and the `__Host-` names). Always in production (`false` is ignored there, with a warning). Elsewhere `true` or `false`, or else from `DOMAIN_URL`: `Secure` for `https://`, not for `http://` (the dev stack at `http://localhost:3000`). Any other value stops the server (utils/cookieSecurity.ts)',
    defaultText: '(from `DOMAIN_URL`)',
    parse: optionalFlag(),
    // Checked at the server's start (utils/productionConfig.ts, cookieSecureProblem).
    serverOnly: true,
  }),
  TRUST_PROXY: setting({
    group: 'Server',
    description: 'How many proxies in front of the backend to believe about the client address: `true` is 1 (Caddy), `2` behind a CDN and Caddy; or their addresses / CIDR ranges (`10.0.0.0/8,loopback`). The sign-in rate limits are per client address, so a wrong value either puts every client in one bucket (the log warns once when forwarded requests arrive with it off) or lets clients name their own address. An unusable value is logged and trusts no proxy',
    defaultText: 'off',
    parse: optionalText(),
  }),
  HSTS_INCLUDE_SUBDOMAINS: setting({
    group: 'Server',
    description: 'Add `includeSubDomains` to HSTS (production): only when every subdomain serves HTTPS',
    defaultText: '`false`',
    parse: exactFlag(),
  }),
  HSTS_PRELOAD: setting({
    group: 'Server',
    description: 'Add `preload` to HSTS (also needs `HSTS_INCLUDE_SUBDOMAINS`; see hstspreload.org first)',
    defaultText: '`false`',
    parse: exactFlag(),
  }),
  ENABLE_TEST_DATA: setting({
    group: 'Server',
    description: 'Mount the developer test-data generator in production. Its "delete" wipes the whole active tenant; leave it off',
    defaultText: '`false`',
    parse: exactFlag(),
  }),
  MCP_API_BASE_URL: setting({
    group: 'Server',
    description: 'Where the MCP server (`/api/mcp`) calls the backend\'s API',
    defaultText: '`http://127.0.0.1:${PORT}`',
    notFromStack: true,
    parse: optionalText(),
  }),
  USE_DOCKER_SECRETS: setting({
    group: 'Server',
    description: '`true` checks the secrets read from `/run/secrets` at startup with the rest of the configuration. Production always does',
    defaultText: '`false`',
    parse: exactFlag(),
  }),
  SECRETS_PATH: setting({
    group: 'Server',
    description: 'Directory the Docker secrets are read from (not the data encryption key, which is `/run/secrets/data_encryption_key` or `DATA_ENCRYPTION_KEY_FILE`)',
    defaultText: '`/run/secrets`',
    notFromStack: true,
    parse: text('/run/secrets'),
  }),
  RUN_MIGRATIONS: setting({
    group: 'Server',
    description: 'Apply pending database migrations when the backend container starts',
    defaultText: '`true`',
    readBy: 'docker-entrypoint.sh',
    parse: text('true'),
  }),

  // ---- Passwords and sessions ----
  BCRYPT_ROUNDS: setting({
    group: 'Passwords and sessions',
    description: 'bcrypt cost, 12 to 15 in production (10 to 15 elsewhere; other values fall back to 12 with a warning). New passwords are hashed at it, and a stored hash at another cost is redone at its user\'s next password sign-in',
    defaultText: '`12`',
    parse: optionalText(),
  }),
  MIN_PASSWORD_LENGTH: setting({
    group: 'Passwords and sessions',
    description: 'Minimum password length in characters, 8 to 64 (a value outside that is logged and moved into it). Applies when a password is set, never at sign-in',
    defaultText: '`12`',
    parse: optionalText(),
  }),
  REQUIRE_PASSWORD_COMPLEXITY: setting({
    group: 'Passwords and sessions',
    description: 'Also require a lowercase and an uppercase letter, a number and a symbol. Off by default, as NIST SP 800-63B advises',
    defaultText: '`false`',
    parse: looseFlag(),
  }),
  PASSWORD_BREACH_CHECK: setting({
    group: 'Passwords and sessions',
    description: 'Refuse new passwords found in known breaches, using Have I Been Pwned\'s range API (only the first 5 hex digits of the password\'s SHA-1 leave the server; if the service can\'t be reached the check is skipped)',
    defaultText: '`false`',
    parse: looseFlag(),
  }),
  SESSION_IDLE_HOURS: setting({
    group: 'Passwords and sessions',
    description: 'A sign-in session ends after this many hours without use (an unusable value is logged and uses the default)',
    defaultText: '`72`',
    parse: optionalText(),
  }),
  SESSION_ABSOLUTE_DAYS: setting({
    group: 'Passwords and sessions',
    description: 'A sign-in session ends this many days after sign-in, however often it\'s used (an unusable value is logged and uses the default)',
    defaultText: '`30`',
    parse: optionalText(),
  }),

  // ---- Passkeys ----
  WEBAUTHN_RP_NAME: setting({
    group: 'Passkeys',
    description: 'Passkey relying-party name, shown by the browser',
    defaultText: '`Nuggets`',
    parse: (raw) => ({ value: raw?.trim() || 'Nuggets' }),
  }),
  WEBAUTHN_RP_ID: setting({
    group: 'Passkeys',
    description: 'Passkey RP ID: the host of `DOMAIN_URL` or a domain it is under (`example.com` for `app.example.com`). Production refuses any other. Changing it strands every enrolled passkey',
    defaultText: 'the host of `DOMAIN_URL`',
    parse: (raw) => ({ value: raw?.trim() || undefined }),
  }),
  WEBAUTHN_ORIGIN: setting({
    group: 'Passkeys',
    description: 'Passkey origin (must match the URL the browser uses; its host must be under `WEBAUTHN_RP_ID`)',
    defaultText: 'the origin of `DOMAIN_URL`',
    parse: (raw) => ({ value: raw?.trim().replace(/\/$/, '') || undefined }),
  }),
  WEBAUTHN_USER_VERIFICATION: setting({
    group: 'Passkeys',
    description: '`required`: a passkey must verify its user (fingerprint, face, PIN), since it signs in without a password. `preferred` also accepts security keys without a PIN',
    defaultText: '`required`',
    parse: oneOf(['required', 'preferred'] as const, 'required'),
  }),

  // ---- Rate limits ----
  API_RATE_LIMITING: setting({
    group: 'Rate limits',
    description: 'Turn on the general API rate limit outside production; production always has it on, and tests never',
    defaultText: '`false`',
    parse: looseFlag(),
  }),
  RATE_LIMIT_MAX_REQUESTS: setting({
    group: 'Rate limits',
    description: 'Requests per `RATE_LIMIT_WINDOW_MS` the general API limit allows, per client address (per token for MCP tokens)',
    defaultText: '`500`',
    parse: wholeNumber(500, 1, 2_147_483_647, { digitsOnly: true }),
  }),
  RATE_LIMIT_WINDOW_MS: setting({
    group: 'Rate limits',
    description: 'The general API limit\'s window, in milliseconds',
    defaultText: '`900000` (15 minutes)',
    parse: wholeNumber(900_000, 1, 2_147_483_647, { digitsOnly: true }),
  }),
  RATE_LIMIT_AUTH_MAX: setting({
    group: 'Rate limits',
    description: 'Failed sign-ins per client address per `RATE_LIMIT_AUTH_WINDOW_MS`, for password and passkey sign-in separately, and re-authentications per user. Always on',
    defaultText: '`10`',
    parse: wholeNumber(10, 1, 2_147_483_647, { digitsOnly: true }),
  }),
  RATE_LIMIT_AUTH_WINDOW_MS: setting({
    group: 'Rate limits',
    description: 'The sign-in limits\' window, in milliseconds',
    defaultText: '`900000` (15 minutes)',
    parse: wholeNumber(900_000, 1, 2_147_483_647, { digitsOnly: true }),
  }),
  RATE_LIMIT_PASSKEY_OPTIONS_MAX: setting({
    group: 'Rate limits',
    description: 'Passkey sign-in starts per client address per `RATE_LIMIT_AUTH_WINDOW_MS`',
    defaultText: '`30`',
    parse: wholeNumber(30, 1, 2_147_483_647, { digitsOnly: true }),
  }),

  // ---- Database ----
  DB_HOST: setting({ group: 'Database', description: 'Database host', defaultText: '`localhost`', parse: text('localhost') }),
  DB_PORT: setting({ group: 'Database', description: 'Database port', defaultText: '`5432`', parse: wholeNumber(5432, 1, 65535, { digitsOnly: true }) }),
  DB_NAME: setting({
    group: 'Database',
    description: 'Database name',
    defaultText: '`POSTGRES_DB`, else `nuggets_db`',
    parse: optionalText(),
  }),
  POSTGRES_DB: setting({
    group: 'Database',
    description: 'The database the Postgres image creates. The backend uses it when `DB_NAME` isn\'t set. The compose files leave `DB_NAME` empty unless the stack sets it, so there `POSTGRES_DB` names both',
    defaultText: '`nuggets_db`',
    parse: optionalText(),
  }),
  DB_USER: setting({
    group: 'Database',
    description: 'Role the **app server** connects as: the unprivileged, RLS-enforced serving role (`nuggets_app`), with the `app_db_password` secret. The server refuses a role RLS doesn\'t apply to',
    defaultText: '`postgres`',
    parse: text('postgres'),
  }),
  MIGRATION_DB_USER: setting({
    group: 'Database',
    description: 'Role used for **migrations/DDL and backups**: the schema owner, with the `db_password` secret',
    defaultText: '`DB_USER`',
    parse: optionalText(),
  }),
  BACKUP_DB_USER: setting({
    group: 'Database',
    description: 'Overrides `MIGRATION_DB_USER` for backups, restores and the schema download (Settings → Utilities) only',
    defaultText: '`MIGRATION_DB_USER`',
    parse: optionalText(),
  }),
  DB_MAINTENANCE_NAME: setting({
    group: 'Database',
    description: 'Database a restore connects to while it swaps the app\'s database',
    defaultText: '`postgres`',
    parse: text('postgres'),
  }),
  ALLOW_RLS_BYPASS_ROLE: setting({
    group: 'Database',
    description: 'Leave unset. `true` lets the backend start as a role that bypasses Row-Level Security (see below), but only while the deployment has at most one tenant: the app relies on RLS to keep tenants apart, so with two it still refuses',
    defaultText: 'unset',
    parse: exactFlag(),
  }),
  DB_POOL_MAX: setting({
    group: 'Database',
    description: 'Database connections the backend may hold, 1 to 1000. Postgres allows 100; migrations and backups use a few of their own',
    defaultText: '`20`',
    parse: wholeNumber(20, 1, 1000),
  }),
  DB_LOCK_TIMEOUT_MS: setting({
    group: 'Database',
    description: 'How long a backend statement waits for a lock before it fails, 0 to 600000 (`0`: as long as its 30 s statement timeout)',
    defaultText: '`15000`',
    parse: wholeNumber(15_000, 0, 600_000),
  }),
  PGOPTIONS: setting({
    group: 'Database',
    description: 'Extra Postgres session settings (`-c name=value …`) for the backend\'s connections; its time zone and date style are pinned after them',
    defaultText: 'unset',
    parse: optionalText(),
  }),
  PG_BIN_DIR: setting({
    group: 'Database',
    description: 'Directory of `pg_dump` / `pg_restore` / `psql` for backups, restores and the schema download, when the ones on PATH aren\'t the server\'s major version',
    defaultText: 'PATH',
    notFromStack: true,
    parse: optionalText(),
  }),

  // ---- Migrations ----
  DB_WAIT_ATTEMPTS: setting({
    group: 'Migrations',
    description: 'How many times, 3 s apart, the entrypoint tries a database that isn\'t reachable yet before the container gives up',
    defaultText: '`30`',
    readBy: 'docker-entrypoint.sh',
    parse: text('30'),
  }),
  MIGRATION_LOCK_TIMEOUT: setting({
    group: 'Migrations',
    description: 'How long a migration statement waits for a table lock before it gives up (Postgres `lock_timeout`), so a migration can\'t queue behind a long query and stall everything behind it',
    defaultText: '`5s`',
    parse: asIs(),
  }),
  MIGRATION_LOCK_RETRIES: setting({
    group: 'Migrations',
    description: 'How many more times a migration that gave up on a lock is tried, 2 s, 4 s, 8 s, 16 s apart',
    defaultText: '`4`',
    parse: asIs(),
  }),
  MIGRATION_LOCK_WAIT_SECONDS: setting({
    group: 'Migrations',
    description: 'How long `migrate` or `rollback` waits for another runner\'s advisory lock; it logs who holds it every 30 s, then gives up',
    defaultText: '`600`',
    parse: asIs(),
  }),

  // ---- Files and backups ----
  UPLOADS_DIR: setting({
    group: 'Files and backups',
    description: 'Uploads directory inside the container (backups include it)',
    defaultText: '`/app/uploads`',
    notFromStack: true,
    parse: optionalText(),
  }),
  BACKUP_LOCATION: setting({
    group: 'Files and backups',
    description: 'Where backups are written inside the container',
    defaultText: '`/app/backups`',
    notFromStack: true,
    parse: optionalText(),
  }),
  BACKUP_TEMP_DIR: setting({
    group: 'Files and backups',
    description: 'Scratch directory for making and restoring backups',
    defaultText: '`/app/temp`',
    notFromStack: true,
    parse: optionalText(),
  }),
  BACKUP_MAX_FILE_SIZE_MB: setting({
    group: 'Files and backups',
    description: 'Largest backup file an upload for restore may be, in MB (an unusable value uses the default)',
    defaultText: '`4096`',
    parse: optionalText(),
  }),
  DATA_ENCRYPTION_KEY_FILE: setting({
    group: 'Files and backups',
    description: 'A file holding the data encryption key, looked at before the Docker secret (for the restore command outside a container)',
    defaultText: 'unset',
    notFromStack: true,
    parse: optionalText(),
  }),

  // ---- Integrations ----
  SIMPLEFIN_ALLOWED_HOSTS: setting({
    group: 'Integrations',
    description: 'Extra SimpleFin bridge hosts, comma-separated (`host` for port 443, `host:port` otherwise). Nuggets talks to SimpleFin only over https, and by default only to `bridge.simplefin.org` and `beta-bridge.simplefin.org`; a setup token or access URL for any other host is refused',
    defaultText: 'unset',
    parse: optionalText(),
  }),
  VAPID_SUBJECT: setting({
    group: 'Integrations',
    description: 'Contact (`mailto:` or `https:` URL) push services see for this server\'s web-push key',
    defaultText: 'the origin of an https `CLIENT_URL`, else the notification sender address',
    parse: optionalText(),
  }),
  BACKUPS_PATH: setting({
    group: 'Integrations',
    description: 'Inside the backend container: the backups directory OneDrive uploads from (the compose files\' `BACKUPS_PATH` is the host directory they mount there)',
    defaultText: '`/app/backups`',
    notFromStack: true,
    parse: optionalText(),
  }),
  TEMP_PATH: setting({
    group: 'Integrations',
    description: 'Inside the backend container: where the OneDrive connection test writes its file (the compose files\' `TEMP_PATH` is a host directory)',
    defaultText: '`/tmp`',
    notFromStack: true,
    parse: text('/tmp'),
  }),

  // ---- Data retention ----
  RETENTION_SESSION_DAYS: setting({
    group: 'Data retention',
    description: 'Sign-in sessions that expired or were revoked this many days ago are deleted (1 to 36500)',
    defaultText: '`30`',
    parse: wholeNumber(30, 1, 36_500),
  }),
  RETENTION_NOTIFICATION_DAYS: setting({
    group: 'Data retention',
    description: 'Sent or failed notifications this old are deleted; pending ones never (7 to 36500)',
    defaultText: '`90`',
    parse: wholeNumber(90, 7, 36_500),
  }),
  RETENTION_NOTIFICATION_DELIVERY_DAYS: setting({
    group: 'Data retention',
    description: 'The record that an alert went out, which stops it going twice (120 to 36500: an alert\'s subject can come round for about 90 days)',
    defaultText: '`365`',
    parse: wholeNumber(365, 120, 36_500),
  }),
  RETENTION_SYNC_LOG_DAYS: setting({
    group: 'Data retention',
    description: 'Bank-import and price-sync history this old is deleted, except each tenant\'s and organization\'s newest (7 to 36500)',
    defaultText: '`180`',
    parse: wholeNumber(180, 7, 36_500),
  }),

  // ---- Shutdown ----
  SHUTDOWN_TIMEOUT_MS: setting({
    group: 'Shutdown',
    description: 'How long the backend\'s shutdown may take, 1000 to 600000: it stops taking connections, lets the requests in flight and the schedulers\' runs finish, gives a running backup 35 s to finish (then stops it), stops a restore that hasn\'t begun replacing the data or waits for one that has, and closes the database pool, then exits. Keep it below the compose `stop_grace_period` (`60s`) and above 50 s, or a backup in progress is cut short',
    defaultText: '`55000`',
    parse: wholeNumber(55_000, 1000, 600_000),
  }),
  SHUTDOWN_DRAIN_MS: setting({
    group: 'Shutdown',
    description: 'Of that, how long it goes on serving while `/api/ready` answers 503, so a proxy that polls it stops sending requests first. Must be less than `SHUTDOWN_TIMEOUT_MS`',
    defaultText: '`2000` in production, else `0`',
    parse: wholeNumber((env) => (isProduction(env) ? 2000 : 0), 0, 600_000),
  }),

  // ---- Logging and build ----
  LOG_LEVEL: setting({
    group: 'Logging and build',
    description: 'Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`',
    defaultText: '`info` in production, else `debug`',
    parse: (raw, _name, env) => ({ value: blank(raw) ? (isProduction(env) ? 'info' : 'debug') : raw! }),
  }),
  APP_VERSION: setting({
    group: 'Logging and build',
    description: 'The release, shown by `/api/health` and in every log line. Set by the image build',
    defaultText: '`unknown`',
    bakedIn: true,
    parse: optionalText(),
  }),
  GIT_SHA: setting({
    group: 'Logging and build',
    description: 'The commit, shown by `/api/health` and in every log line. Set by the image build',
    defaultText: '`unknown`',
    bakedIn: true,
    parse: optionalText(),
  }),

  // ---- Secrets: the Docker secret files; these variables stand in for them outside production ----
  DB_PASSWORD: secret('The owner\'s database password (secret `db_password`)'),
  APP_DB_PASSWORD: secret('The serving role\'s database password (secret `app_db_password`)'),
  JWT_SECRET: secret('Signs tokens (secret `jwt_secret`)'),
  SESSION_SECRET: secret('Session signing (secret `session_secret`)'),
  CSRF_SECRET: secret('Keys the CSRF token (secret `csrf_secret`)'),
  MIGRATION_DB_PASSWORD: secret('The owner\'s password, over the `db_password` secret, for migrations, backups and restores (optional secret `migration_db_password`)'),
  BACKUP_DB_PASSWORD: secret('Overrides the owner\'s password for backups, restores and the schema download only (optional secret `backup_db_password`)'),
} as const satisfies Record<string, SettingSpec<unknown>>;

export type SettingName = keyof typeof SETTINGS;
type ValueOf<K extends SettingName> = ReturnType<(typeof SETTINGS)[K]['parse']>['value'];
type PublicName = { [K in SettingName]: (typeof SETTINGS)[K] extends { secret: true } ? never : K }[SettingName];

/** The parsed settings (secrets excluded). */
export type AppConfig = { readonly [K in PublicName]: ValueOf<K> };

export interface LoadedConfig {
  config: AppConfig;
  /** Values that can't be used: the server refuses to start (validateStartupConfig). */
  problems: string[];
}

/** One setting from `env`. */
function parseSetting<T>(name: string, spec: SettingSpec<T>, env: Env): Parsed<T> {
  return spec.parse(env[name], name, env);
}

/** Parse every setting from `env`. Never throws. */
export function loadConfig(env: Env = process.env): LoadedConfig {
  const problems: string[] = [];
  const config: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(SETTINGS) as Array<[string, SettingSpec<unknown>]>) {
    if (spec.secret) continue;
    const parsed = parseSetting(name, spec, env);
    if (parsed.problem && !spec.serverOnly) problems.push(parsed.problem);
    config[name] = parsed.value;
  }
  return { config: Object.freeze(config) as AppConfig, problems };
}

// The names whose values decide the result, for noticing a changed environment.
const WATCHED = Object.entries(SETTINGS).flatMap(([name, spec]) => ((spec as SettingSpec<unknown>).secret ? [] : [name]));

let cached: { key: string; loaded: LoadedConfig } | undefined;

function current(): LoadedConfig {
  // Joining ~90 lookups is far cheaper than parsing; NUL can't appear in a variable.
  const key = WATCHED.map((n) => process.env[n] ?? '\u0001').join('\u0000');
  if (cached?.key !== key) cached = { key, loaded: loadConfig(process.env) };
  return cached.loaded;
}

/** The settings from the current environment. */
export function config(): AppConfig {
  return current().config;
}

/** The settings from `env`: config() for process.env (cached), else a fresh parse. */
export function configFor(env: Env = process.env): AppConfig {
  return env === process.env ? config() : loadConfig(env).config;
}

/** What's wrong with the current environment's settings (the server refuses to start). */
export function configProblems(): string[] {
  return current().problems;
}

/**
 * What's wrong with one setting's value in `env`, if anything: the problem configProblems()
 * lists, or for a `serverOnly` setting the one only the server's start checks.
 */
export function settingProblem(name: PublicName, env: Env = process.env): string | undefined {
  return parseSetting(name, SETTINGS[name] as SettingSpec<unknown>, env).problem;
}

/**
 * One whole-number setting from `env`, throwing ProductionConfigError's message when it
 * can't be used: for the settings code that checks just its own (db.ts poolSettings,
 * retentionPolicy, shutdownSettings).
 */
export function strictSetting<K extends PublicName>(name: K, env: Env, onProblem: (problem: string) => never): ValueOf<K> {
  const spec = SETTINGS[name] as SettingSpec<ValueOf<K>>;
  const parsed = parseSetting(name, spec, env);
  if (parsed.problem) onProblem(parsed.problem);
  return parsed.value;
}

/**
 * One variable a compose file's `backend` service names in its `environment:` block, as
 * scripts/env-docs.ts reads it: `PORT: ${BACKENDPORT:-5000}` reads BACKENDPORT from the
 * stack's environment, `NODE_ENV: production` reads nothing.
 */
export interface ComposeEnvEntry {
  /** The stack variables its value reads (`${NAME}`, `${NAME:-default}`, nested ones too). */
  reads: readonly string[];
  /** The value as written, without quotes or a trailing comment. */
  value: string;
}

/** How a setting set in the stack's environment reaches the backend, by a compose file. */
type StackReach =
  | { how: 'own' } // its own entry reads it (DB_POOL_MAX: ${DB_POOL_MAX:-20})
  | { how: 'as'; names: readonly string[] } // its entry reads others (PORT: ${BACKENDPORT:-5000})
  | { how: 'fixed'; value: string } // the compose file sets it (NODE_ENV: production)
  | { how: 'default' } // notFromStack: left at its default
  | { how: 'none' }; // set in the stack, it would change nothing

/**
 * By its own entry only: a name read inside another entry's default (DOMAIN_URL inside
 * CLIENT_URL's) reaches that variable, not the backend's own.
 */
function stackReach(name: string, spec: SettingSpec<unknown>, env: ReadonlyMap<string, ComposeEnvEntry>): StackReach | undefined {
  // Secrets come from the secret files, and the image build sets the baked-in settings.
  if (spec.secret || spec.bakedIn) return undefined;
  const entry = env.get(name);
  if (entry?.reads.includes(name)) return { how: 'own' };
  if (entry && entry.reads.length > 0) return { how: 'as', names: entry.reads };
  if (entry) return { how: 'fixed', value: entry.value };
  return spec.notFromStack ? { how: 'default' } : { how: 'none' };
}

/**
 * The settings that set in the stack's environment wouldn't reach the backend: `env`, a
 * compose file's backend block, has no entry that reads or sets them, and they aren't
 * `notFromStack`. config.test.ts expects none in either compose file.
 */
export function settingsNotReachingBackend(env: ReadonlyMap<string, ComposeEnvEntry>): string[] {
  return Object.entries(SETTINGS)
    .filter(([name, spec]) => stackReach(name, spec as SettingSpec<unknown>, env)?.how === 'none')
    .map(([name]) => name);
}

/** What the docs say about a setting the compose files don't take from the stack as it is. */
function stackNote(reach: StackReach | undefined): string {
  switch (reach?.how) {
    case 'as':
      return `The compose files take it from ${reach.names.map((n) => `\`${n}\``).join(' or ')}.`;
    case 'fixed':
      return `The compose files set it to \`${reach.value}\`.`;
    case 'default':
      return 'The compose files leave it at its default.';
    default:
      return '';
  }
}

/**
 * The deployment docs' settings table, generated: `npm run docs:env`. `backendEnv`:
 * docker-compose.portainer.yml's backend `environment:` block (scripts/env-docs.ts), which
 * says how a setting reaches the backend when it isn't by its own name. Throws when a
 * setting doesn't reach it at all, so a new setting comes with its line in the compose
 * files (or `notFromStack`).
 */
export function settingsMarkdown(backendEnv?: ReadonlyMap<string, ComposeEnvEntry>): string {
  if (backendEnv) {
    const missing = settingsNotReachingBackend(backendEnv);
    if (missing.length > 0) {
      throw new Error(
        `Set in the stack, these settings wouldn't reach the backend: ${missing.join(', ')}. Pass each in the backend's ` +
          'environment: block of docker-compose.portainer.yml and docker-compose.prod.yml (NAME: ${NAME:-default}), ' +
          'or mark it notFromStack in backend/src/config.ts'
      );
    }
  }
  const groups = new Map<SettingGroup, string[]>();
  for (const [name, raw] of Object.entries(SETTINGS)) {
    const spec = raw as SettingSpec<unknown>;
    const notes = [
      spec.readBy ? `Read by \`${spec.readBy}\`.` : '',
      backendEnv ? stackNote(stackReach(name, spec, backendEnv)) : '',
    ].filter(Boolean);
    // The descriptions are Markdown, code spans and all: in a table cell only `|` needs
    // escaping. None has a backslash, which would read differently there (config.test.ts).
    const description = [spec.description.replace(/\|/g, '\\|') + '.', ...notes].join(' ').replace(/\.\./g, '.');
    const rows = groups.get(spec.group) ?? [];
    rows.push(`| \`${name}\` | ${spec.defaultText} | ${description} |`);
    groups.set(spec.group, rows);
  }
  const out: string[] = [];
  for (const [group, rows] of groups) {
    out.push(`**${group}:**`, '', '| Variable | Default | Purpose |', '|---|---|---|', ...rows, '');
  }
  return out.join('\n').trimEnd();
}
