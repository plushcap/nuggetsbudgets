import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { getDirname } from '../utils/esm-compat.js';
import { config, configProblems, loadConfig, SETTINGS, settingProblem, settingsMarkdown, settingsNotReachingBackend } from '../config.js';
import { composeBackendEnv, ENV_TABLE_END, ENV_TABLE_START, withEnvTable } from '../scripts/env-docs.js';

/**
 * The settings registry: every variable the code reads is listed in
 * config.ts, documented from that list (`npm run docs:env`), and parsed the way its readers
 * used to parse it.
 */
const here = getDirname(import.meta.url);
const backendRoot = path.join(here, '../..');
const repoRoot = path.join(backendRoot, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === '__tests__' || name === 'test' || name === 'node_modules' ? [] : sourceFiles(full);
    }
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

/** The variables a piece of source reads, by the ways this code reads them. */
function variablesRead(source: string): string[] {
  const patterns = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
    /\benv\.([A-Z][A-Z0-9_]+)\b/g,
    /\benv\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
    /\bconfig(?:For\([^)]*\))?\(\)\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /\bstrictSetting\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
    /\breadDockerSecret\(\s*['"][a-z_]+['"]\s*,\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
    /\benvSecret\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  ];
  return patterns.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]));
}

// Variables the code sets for a child process or itself, not settings anyone configures.
const NOT_SETTINGS = new Set(['PGPASSWORD']);

describe('the settings registry', () => {
  it('lists every variable the backend, the MCP server and the entrypoint read', () => {
    const files = [...sourceFiles(path.join(backendRoot, 'src')), ...sourceFiles(path.join(repoRoot, 'mcp/src'))];
    const read = new Map<string, string>();
    for (const file of files) {
      if (file.endsWith(path.join('src', 'config.ts'))) continue;
      for (const name of variablesRead(readFileSync(file, 'utf8'))) read.set(name, path.relative(repoRoot, file));
    }
    const entrypoint = readFileSync(path.join(backendRoot, 'docker-entrypoint.sh'), 'utf8');
    for (const m of entrypoint.matchAll(/\$\{([A-Z][A-Z0-9_]+)/g)) read.set(m[1], 'backend/docker-entrypoint.sh');

    const missing = [...read].filter(([name]) => !(name in SETTINGS) && !NOT_SETTINGS.has(name));
    expect(missing.map(([name, file]) => `${name} (${file})`)).toEqual([]);
    // The scan finds what it should (a regression in it would pass the check above).
    expect(read.has('DB_POOL_MAX') && read.has('RETENTION_SESSION_DAYS') && read.has('APP_DB_PASSWORD')).toBe(true);
    expect(read.has('CSRF_SECRET') && read.has('SHUTDOWN_DRAIN_MS')).toBe(true);
  });

  it('lists nothing nobody reads', () => {
    const sources = [...sourceFiles(path.join(backendRoot, 'src')), path.join(backendRoot, 'docker-entrypoint.sh')]
      .filter((f) => !f.endsWith(path.join('src', 'config.ts')))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const unread = Object.entries(SETTINGS)
      .filter(([name]) => !new RegExp(`\\b${name}\\b`).test(sources))
      .map(([name]) => name);
    expect(unread).toEqual([]);
  });

  // A function that takes an environment (`env = process.env`, so its tests can pass
  // another) reads it through configFor(env), which parses each setting the one way, or
  // envSecret(name, env) for a secret: `env.COOKIE_SECURE?.trim()` was a second parser.
  it('reads a passed environment through configFor or envSecret, never a variable of it directly', () => {
    const helpers = [path.join('src', 'config.ts'), path.join('src', 'utils', 'docker-secrets.ts')];
    const raw = sourceFiles(path.join(backendRoot, 'src'))
      .filter((file) => !helpers.some((helper) => file.endsWith(helper)))
      .flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/(?<![\w.])env(?:\.([A-Z][A-Z0-9_]+)|\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\])/g)].map(
          (m) => `${path.relative(backendRoot, file)}: env.${m[1] ?? m[2]}`
        )
      );
    expect(raw).toEqual([]);
  });

  it('parses COOKIE_SECURE as cookieSecurity.ts read it: true or false in any case, else a problem for the server', () => {
    expect(loadConfig({ COOKIE_SECURE: ' TRUE ' }).config.COOKIE_SECURE).toBe(true);
    expect(loadConfig({ COOKIE_SECURE: 'false' }).config.COOKIE_SECURE).toBe(false);
    expect(loadConfig({ COOKIE_SECURE: ' ' })).toMatchObject({ config: { COOKIE_SECURE: undefined }, problems: [] });
    // The server refuses to start on it (productionConfig.test.ts); the command-line tools,
    // which refuse to run on any of configProblems(), never read it, so it isn't one.
    expect(loadConfig({ COOKIE_SECURE: ' yes ' })).toMatchObject({ config: { COOKIE_SECURE: undefined }, problems: [] });
    expect(settingProblem('COOKIE_SECURE', { COOKIE_SECURE: ' yes ' })).toBe('COOKIE_SECURE must be true or false (it is yes)');
  });

  // The deployment's compose files: a container gets only the variables its
  // environment: block names, so a setting the backend's block leaves out can't be set.
  const composeFiles = ['docker-compose.portainer.yml', 'docker-compose.prod.yml'];
  const backendEnv = (file: string) => composeBackendEnv(readFileSync(path.join(repoRoot, file), 'utf8'));

  it('takes every backend setting from the stack, in both deployment compose files', () => {
    for (const file of composeFiles) expect(settingsNotReachingBackend(backendEnv(file)), file).toEqual([]);
    // The same block in both, so what the table says of the compose files holds for each.
    const [portainer, prod] = composeFiles.map((file) => Object.fromEntries(backendEnv(file)));
    expect(prod).toEqual(portainer);
  });

  it('reads the backend block as compose does, and notes the settings it fixes or renames', () => {
    const env = backendEnv('docker-compose.portainer.yml');
    // A variable read inside another's default is read too; quotes and comments are not the value.
    expect(env.get('MIGRATION_DB_USER')).toEqual({ reads: ['MIGRATION_DB_USER'], value: '${MIGRATION_DB_USER:-nuggetsApp_user}' });
    expect(env.get('DB_NAME')).toEqual({ reads: ['DB_NAME'], value: '${DB_NAME:-}' });
    expect(env.get('CLIENT_URL')).toEqual({ reads: ['CLIENT_URL', 'DOMAIN_URL'], value: '${CLIENT_URL:-${DOMAIN_URL}}' });
    expect(env.get('USE_DOCKER_SECRETS')).toEqual({ reads: [], value: 'true' });
    expect(env.get('WEBAUTHN_RP_ID')).toEqual({ reads: ['WEBAUTHN_RP_ID'], value: '${WEBAUTHN_RP_ID:-}' });

    const table = settingsMarkdown(env);
    expect(table).toContain('| `PORT` | `5000` | Port the backend listens on (inside its container). The compose files take it from `BACKENDPORT`. |');
    expect(table).toMatch(/^\| `NODE_ENV` \|.*\. The compose files set it to `production`\. \|$/m);
    expect(table).toMatch(/^\| `UPLOADS_DIR` \|.*\. The compose files leave it at its default\. \|$/m);
    // Taken from the stack by its own name: no note.
    for (const name of ['DB_POOL_MAX', 'DB_HOST', 'POSTGRES_DB', 'LOG_LEVEL', 'WEBAUTHN_RP_NAME', 'JWT_SECRET', 'APP_VERSION']) {
      expect(table.split('\n').find((row) => row.startsWith(`| \`${name}\` |`)), name).not.toMatch(
        /The compose files (take it from|set it to|leave it at its default)/
      );
    }
    expect(table).not.toContain('†');
    // No setting has an old name the backend still reads.
    expect(table).not.toMatch(/Formerly|deprecated/);
  });

  it('refuses to document a setting that, set in the stack, would not reach the backend', () => {
    const env = backendEnv('docker-compose.portainer.yml');
    env.delete('DB_POOL_MAX');
    env.set('LOG_LEVEL', { reads: [], value: 'info' }); // fixed: noted, not missing
    // Read only inside another entry's default (CLIENT_URL: ${CLIENT_URL:-${DOMAIN_URL}}),
    // DOMAIN_URL would reach CLIENT_URL, not the backend's DOMAIN_URL.
    env.delete('DOMAIN_URL');
    expect(settingsNotReachingBackend(env)).toEqual(['DOMAIN_URL', 'DB_POOL_MAX']);
    expect(() => settingsMarkdown(env)).toThrow(/wouldn't reach the backend: DOMAIN_URL, DB_POOL_MAX\./);
    expect(() => composeBackendEnv('services:\n  postgres:\n    environment:\n      A: b\n')).toThrow(/no backend environment/);
    expect(() => composeBackendEnv('services:\n  backend:\n    environment:\n    image: x\n')).toThrow(/is empty/);
  });

  it('fills the table between the markers of a doc (npm run docs:env -- <file>), and only there', () => {
    const doc = `# Settings\n\n${ENV_TABLE_START}\nan old table\n${ENV_TABLE_END}\n\nAfter it.\n`;
    const filled = withEnvTable(doc);
    expect(filled.startsWith(`# Settings\n\n${ENV_TABLE_START}\n\n`)).toBe(true);
    expect(filled.endsWith(`\n\n${ENV_TABLE_END}\n\nAfter it.\n`)).toBe(true);
    expect(filled).not.toContain('an old table');
    expect(withEnvTable(filled)).toBe(filled);
    for (const name of Object.keys(SETTINGS)) expect(filled).toContain(`| \`${name}\` |`);
    expect(() => withEnvTable('# Settings\n')).toThrow(/no env-table markers/);
  });

  it('has descriptions the table writes as they are, with only `|` escaped: none has a backslash', () => {
    // A description is Markdown, code spans included. In a table cell a backslash before `|`
    // would end the cell, and one escaped for that would show doubled inside a code span.
    for (const [name, spec] of Object.entries(SETTINGS)) {
      expect((spec as { description: string }).description, name).not.toContain('\\');
    }
  });
});

describe('loadConfig', () => {
  it('reads the defaults from an empty environment, with no problems', () => {
    const { config: c, problems } = loadConfig({});
    expect(problems).toEqual([]);
    expect(c.PORT).toBe(5000);
    expect(c.NODE_ENV).toBe('development');
    expect(c.RATE_LIMIT_MAX_REQUESTS).toBe(500);
    expect(c.RATE_LIMIT_WINDOW_MS).toBe(900_000);
    expect(c.RATE_LIMIT_AUTH_MAX).toBe(10);
    expect(c.API_RATE_LIMITING).toBe(false);
    expect(c.DB_USER).toBe('postgres');
    expect(c.DB_POOL_MAX).toBe(20);
    expect(c.SHUTDOWN_DRAIN_MS).toBe(0);
    expect(c.LOG_LEVEL).toBe('debug');
    expect(c.SECRETS_PATH).toBe('/run/secrets');
    expect(c.WEBAUTHN_USER_VERIFICATION).toBe('required');
    expect(loadConfig({ NODE_ENV: 'production' }).config.SHUTDOWN_DRAIN_MS).toBe(2000);
    expect(loadConfig({ NODE_ENV: 'production' }).config.LOG_LEVEL).toBe('info');
  });

  it('treats an empty value as unset, as the readers did', () => {
    const { config: c, problems } = loadConfig({ PORT: '', DB_USER: '', RATE_LIMIT_WINDOW_MS: ' ', NODE_ENV: '' });
    expect(problems).toEqual([]);
    expect([c.PORT, c.DB_USER, c.RATE_LIMIT_WINDOW_MS, c.NODE_ENV]).toEqual([5000, 'postgres', 900_000, 'development']);
  });

  it('keeps flags as strict as they were', () => {
    expect(loadConfig({ ENABLE_TEST_DATA: 'TRUE' }).config.ENABLE_TEST_DATA).toBe(false);
    expect(loadConfig({ ENABLE_TEST_DATA: 'true' }).config.ENABLE_TEST_DATA).toBe(true);
    expect(loadConfig({ API_RATE_LIMITING: 'TRUE' }).config.API_RATE_LIMITING).toBe(true);
    expect(loadConfig({ PASSWORD_BREACH_CHECK: ' True ' }).config.PASSWORD_BREACH_CHECK).toBe(true);
  });

  it('names a value it cannot use, and reads the default for it', () => {
    const { config: c, problems } = loadConfig({ RATE_LIMIT_AUTH_MAX: 'ten', PORT: '70000', WEBAUTHN_USER_VERIFICATION: 'discouraged' });
    expect(problems).toEqual([
      'WEBAUTHN_USER_VERIFICATION must be required or preferred, not discouraged',
      'RATE_LIMIT_AUTH_MAX must be a whole number from 1 to 2147483647, not "ten"',
      'PORT must be a whole number from 0 to 65535, not "70000"',
    ].sort((a, b) => Object.keys(SETTINGS).indexOf(a.split(' ')[0]) - Object.keys(SETTINGS).indexOf(b.split(' ')[0])));
    expect([c.RATE_LIMIT_AUTH_MAX, c.PORT, c.WEBAUTHN_USER_VERIFICATION]).toEqual([10, 5000, 'required']);
  });

  // Gone in 3.0.0: useAPIRateLimiting and APIRateLimit, the old names of API_RATE_LIMITING
  // and RATE_LIMIT_MAX_REQUESTS, and FORCE_HTTPS, which never did anything. A stack that
  // still sets one starts, and the backend takes no notice of it.
  it('ignores the removed names, whatever they hold', () => {
    const old = loadConfig({ useAPIRateLimiting: 'true', APIRateLimit: '42', FORCE_HTTPS: 'true' });
    expect(old.problems).toEqual([]);
    expect(old.config.API_RATE_LIMITING).toBe(false);
    expect(old.config.RATE_LIMIT_MAX_REQUESTS).toBe(500);
    expect(old.config).not.toHaveProperty('FORCE_HTTPS');
    // Beside the new names, the new names alone count; a value the old name can't hold is no problem.
    const both = loadConfig({ APIRateLimit: 'abc', RATE_LIMIT_MAX_REQUESTS: '700', API_RATE_LIMITING: 'true', useAPIRateLimiting: 'false' });
    expect(both.problems).toEqual([]);
    expect(both.config.RATE_LIMIT_MAX_REQUESTS).toBe(700);
    expect(both.config.API_RATE_LIMITING).toBe(true);
    for (const name of ['useAPIRateLimiting', 'APIRateLimit', 'FORCE_HTTPS']) expect(SETTINGS).not.toHaveProperty(name);
  });

  it('refuses number forms parseInt used to cut short, where it read the setting', () => {
    for (const value of ['1e6', '0x10', '500abc', '500.5', '-1']) {
      expect(loadConfig({ RATE_LIMIT_WINDOW_MS: value }).problems).toHaveLength(1);
    }
    expect(loadConfig({ DB_PORT: '5433abc' }).problems).toEqual(['DB_PORT must be a whole number from 1 to 65535, not "5433abc"']);
    expect(loadConfig({ RATE_LIMIT_WINDOW_MS: ' 300000 ' }).config.RATE_LIMIT_WINDOW_MS).toBe(300_000);
    // The settings that always took any whole number Number() reads still do.
    expect(loadConfig({ DB_POOL_MAX: '1e1' }).config.DB_POOL_MAX).toBe(10);
  });

  it('never carries a secret', () => {
    const { config: c } = loadConfig({ JWT_SECRET: 'jwt-value', DB_PASSWORD: 'db-value' });
    expect(JSON.stringify(c)).not.toMatch(/jwt-value|db-value/);
  });
});

describe('config()', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('follows changes to process.env', () => {
    process.env.DB_POOL_MAX = '7';
    expect(config().DB_POOL_MAX).toBe(7);
    process.env.DB_POOL_MAX = 'lots';
    expect(config().DB_POOL_MAX).toBe(20);
    expect(configProblems()).toContain('DB_POOL_MAX must be a whole number from 1 to 1000, not "lots"');
    // A setting only the server reads isn't a problem for the command-line tools.
    process.env.COOKIE_SECURE = 'yes';
    expect(configProblems().filter((p) => p.startsWith('COOKIE_SECURE'))).toEqual([]);
  });
});
