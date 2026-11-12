import { existsSync } from 'fs';
import { DATA_ENCRYPTION_SECRET_PATH, readDataEncryptionSecretSync } from './data-encryption-secret.js';
import { dbPasswordFileProblems, secretWeakness } from './docker-secrets.js';

/** What the data key's validation (data-encryption-secret.ts) also requires. */
const DATA_ENCRYPTION_KEY_MIN_LENGTH = 32;
import { resolveWebAuthnConfig, WebAuthnConfigError } from './webauthnConfig.js';
import { configFor, loadConfig } from '../config.js';
import { cookieSecureProblem, cookieSecureSetting } from './cookieSecurity.js';

/**
 * Settings the server checks before it starts, so a mistake shows at
 * once, with what to fix, rather than as a failure much later and elsewhere: a passkey that
 * can't be enrolled, an email link to localhost, a backup that can't be encrypted. Every
 * problem is listed, so one restart shows them all; index.ts refuses to start on any.
 *
 * In production:
 *   - DOMAIN_URL is an absolute https URL (http only for a loopback host, as a smoke test
 *     on one machine uses): passkeys, CORS and links are bound to it, and without it CORS
 *     fell back to http://localhost:3000. CLIENT_URL, when set, likewise;
 *   - the passkey RP ID is that host or a domain it is under, and the host of an explicit
 *     WEBAUTHN_ORIGIN too: passkeys enrolled for any other domain can't be used here;
 *   - a data_encryption_key secret that is there is at least 32 characters, and passes the
 *     weak-secret check the other secrets do (secretWeakness: not a placeholder, at least 8
 *     different characters). One that isn't there at all is reported (a warning), not
 *     refused: what needs it answers 503 until it is configured.
 * In every environment: the passkey settings can be read, every setting config.ts parses
 * is usable (the numeric ones whole numbers in their range), and Postgres and the backend
 * read the same password from the db_password file (dbPasswordFileProblems;
 * loadSecrets refuses one they don't too, so the migration runner does before it signs in
 * to the database).
 */

/** A setting the server can't start with (all of them, in `problems`). */
export class ProductionConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string | string[]) {
    const list = Array.isArray(problems) ? problems : [problems];
    super(
      list.length === 1
        ? list[0]
        : `${list.length} configuration problems:\n${list.map((p) => `  - ${p}`).join('\n')}`
    );
    this.name = 'ProductionConfigError';
    this.problems = list;
  }
}

/** Throw a setting's problem as a ProductionConfigError (config.ts strictSetting). */
export function refuseSetting(problem: string): never {
  throw new ProductionConfigError(problem);
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a passkey bound to `rpId` can be used on `host`: WebAuthn takes the host itself
 * or a domain it is under (`example.com` covers `app.example.com`), nothing else.
 */
export function rpIdCoversHost(rpId: string, host: string): boolean {
  const id = rpId.toLowerCase();
  const h = host.toLowerCase();
  return h === id || h.endsWith(`.${id}`);
}

/** Parse an address setting that must be https (http only on loopback); record what is wrong. */
function checkAddress(name: string, raw: string, problems: string[]): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} is not an absolute URL: ${raw}`);
    return undefined;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    problems.push(`${name} must be an https:// address (it is ${raw}): sign-in cookies are Secure, and browsers send them only over https`);
  }
  return url;
}

/** The production checks: problems (refused) and warnings (logged). */
function productionChecks(env: NodeJS.ProcessEnv): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const settings = loadConfig(env).config;

  // Production's cookies are always Secure (utils/cookieSecurity.ts).
  const cookieProblem = cookieSecureProblem(env);
  if (cookieProblem) problems.push(cookieProblem);
  if (cookieSecureSetting(env) === false) {
    warnings.push('COOKIE_SECURE=false is ignored in production: its cookies are always Secure');
  }

  const raw = settings.DOMAIN_URL?.trim();
  let domain: URL | undefined;
  if (!raw) {
    problems.push('Set DOMAIN_URL to the address Nuggets is served at, e.g. https://nuggets.example.com');
  } else {
    domain = checkAddress('DOMAIN_URL', raw, problems);
  }
  const client = settings.CLIENT_URL?.trim();
  if (client) checkAddress('CLIENT_URL', client, problems);

  try {
    const { rpID, origin } = resolveWebAuthnConfig(env);
    if (domain && !rpIdCoversHost(rpID, domain.hostname)) {
      problems.push(
        `WEBAUTHN_RP_ID (${rpID}) is not the host of DOMAIN_URL (${domain.hostname}) or a domain it is under, so passkeys could not be used at DOMAIN_URL`
      );
    }
    // An origin taken from DOMAIN_URL was checked with it.
    if (settings.WEBAUTHN_ORIGIN) {
      const originUrl = checkAddress('WEBAUTHN_ORIGIN', origin, problems);
      if (originUrl && !rpIdCoversHost(rpID, originUrl.hostname)) {
        problems.push(
          `WEBAUTHN_RP_ID (${rpID}) is not the host of WEBAUTHN_ORIGIN (${originUrl.hostname}) or a domain it is under, so the browser's passkeys would not match it`
        );
      }
    }
  } catch (err) {
    if (!(err instanceof WebAuthnConfigError)) throw err;
    problems.push(err.message);
  }

  try {
    // The weak-secret check the other secrets get (docker-secrets.ts). Here rather than in
    // loadSecrets, which the migration runner and rewrap-secrets load too: they still run,
    // so a deployment can rotate to a new key (the problem says how).
    const weakness = secretWeakness(readDataEncryptionSecretSync(env), DATA_ENCRYPTION_KEY_MIN_LENGTH);
    if (weakness) {
      problems.push(
        `data_encryption_key is ${weakness}: generate a new one (openssl rand -base64 32) and rotate to it with rewrap-secrets, run in a container of its own from the backend's image while this server can't start (node dist/scripts/rewrap-secrets.js --old-key-file /run/secrets/data_encryption_key --new-key-file <the new key's file>), then write the new key over the secret file and start the backend`
      );
    }
  } catch (error) {
    const present = [settings.DATA_ENCRYPTION_KEY_FILE, DATA_ENCRYPTION_SECRET_PATH].some((p) => p && existsSync(p));
    if (present) {
      problems.push(`The data_encryption_key secret can't be used: ${(error as Error).message}`);
    } else {
      warnings.push(
        'There is no data_encryption_key secret: backups, bank sync credentials and OneDrive are unavailable until one is configured (a key of 32 characters or more, such as openssl rand -base64 32 makes, in the data_encryption_key secret file)'
      );
    }
  }
  return { problems, warnings };
}

/**
 * Outside production, only what the passkey settings can't be read from (a bad URL or
 * value), and a COOKIE_SECURE that isn't true or false.
 */
function otherChecks(env: NodeJS.ProcessEnv): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const cookieProblem = cookieSecureProblem(env);
  if (cookieProblem) problems.push(cookieProblem);
  try {
    resolveWebAuthnConfig(env);
  } catch (err) {
    if (!(err instanceof WebAuthnConfigError)) throw err;
    problems.push(err.message);
  }
  return { problems, warnings: [] };
}

/**
 * The production checks alone. Returns the warnings; throws ProductionConfigError listing
 * every problem. Does nothing outside production.
 */
export function checkProductionConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  if (configFor(env).NODE_ENV !== 'production') return [];
  const { problems, warnings } = productionChecks(env);
  if (problems.length > 0) throw new ProductionConfigError(problems);
  return warnings;
}

/**
 * Everything index.ts checks before it starts: the production checks (or, elsewhere, the
 * passkey settings), every setting config.ts parses, then `numericChecks`, the callers'
 * own checks (the secrets; shutdownSettings, poolSettings and retentionPolicy, which read
 * their settings with config.ts's strictSetting and check how they fit together), so their
 * problems are listed with the rest, each once. Returns the warnings; throws
 * ProductionConfigError listing every problem.
 */
export function validateStartupConfig(
  env: NodeJS.ProcessEnv = process.env,
  numericChecks: Array<() => unknown> = []
): string[] {
  const { problems, warnings } = configFor(env).NODE_ENV === 'production' ? productionChecks(env) : otherChecks(env);
  problems.push(...loadConfig(env).problems);
  problems.push(...dbPasswordFileProblems(env));
  for (const check of numericChecks) {
    try {
      check();
    } catch (err) {
      if (!(err instanceof ProductionConfigError)) throw err;
      problems.push(...err.problems);
    }
  }
  const unique = [...new Set(problems)];
  if (unique.length > 0) throw new ProductionConfigError(unique);
  return warnings;
}
