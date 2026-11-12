import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { getDirname } from '../utils/esm-compat.js';
import { loadConfig } from '../config.js';
import { composeBackendEnv } from '../scripts/env-docs.js';
import { loadSecrets } from '../utils/docker-secrets.js';
import { validateStartupConfig } from '../utils/productionConfig.js';
import { checkSecretsForStartup } from '../utils/security-validator.js';
import { shutdownSettings } from '../services/ApplicationLifecycleService.js';
import { poolSettings } from '../db.js';
import { retentionPolicy } from '../services/maintenance/retention.js';
import { DATA_ENCRYPTION_SECRET_PATH } from '../utils/data-encryption-secret.js';

/**
 * A stack pasted from 2.4.0 starts 3.0.0. Portainer stacks hold the compose text that was
 * pasted into them, so nothing re-pastes it on an upgrade: the deployment keeps running
 * 2.4.0's docker.compose.portainer.yml (src/test/fixtures/portainer-compose-2.4.0.yml, a
 * copy of it as released, but for some comments and its image owner) with the new images. Those are published
 * from the project's new home (github.com/plushcap/nuggetsbudgets), so its three image lines
 * take the new owner (ghcr.io/plushcap) and nothing else. 3.0.0 removed from
 * the backend:
 * - useAPIRateLimiting and APIRateLimit, which that compose still passes (APIRateLimit
 *   empty unless the stack sets it), and FORCE_HTTPS, which it never passed;
 * - the smtp_password secret, which it still mounts: compose needs the file to be there,
 *   and the backend reads nothing from it.
 * Here the backend's environment is that compose's backend block, resolved as compose does
 * for a stack's variables, and its secrets the files that compose mounts; the backend's
 * own startup checks (index.ts) then pass, with the configuration the current compose
 * gives. What isn't here: the database (the migrations' upgrade from 2.4.0 has tests of
 * its own) and Docker itself (CI's compose checks run on the current files).
 */
const here = getDirname(import.meta.url);
const repoRoot = path.join(here, '../../..');
const OLD_COMPOSE = readFileSync(path.join(here, '../test/fixtures/portainer-compose-2.4.0.yml'), 'utf8');
const NEW_COMPOSE = readFileSync(path.join(repoRoot, 'docker-compose.portainer.yml'), 'utf8');

type Stack = Readonly<Record<string, string | undefined>>;

/**
 * A compose value with the stack's variables put in, as compose does it: `${NAME}`,
 * `${NAME:-default}` (unset or empty), `${NAME-default}` (unset), defaults nested, `$$`.
 */
function interpolate(text: string, stack: Stack): string {
  let pos = 0;
  const read = (inDefault: boolean): string => {
    let out = '';
    while (pos < text.length) {
      const c = text[pos];
      if (inDefault && c === '}') return out;
      if (c === '$' && text[pos + 1] === '$') {
        out += '$';
        pos += 2;
      } else if (c === '$' && text[pos + 1] === '{') {
        pos += 2;
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(pos))?.[0];
        if (!name) throw new Error(`can't read the variable in ${text}`);
        pos += name.length;
        const op = /^(?::-|-)?/.exec(text.slice(pos))?.[0] ?? '';
        pos += op.length;
        const fallback = op ? read(true) : '';
        if (text[pos] !== '}') throw new Error(`unclosed \${ in ${text}`);
        pos += 1;
        const value = stack[name];
        const unset = op === ':-' ? !value : value === undefined;
        out += op && unset ? fallback : (value ?? '');
      } else {
        out += c;
        pos += 1;
      }
    }
    if (inDefault) throw new Error(`unclosed \${ in ${text}`);
    return out;
  };
  return read(false);
}

/** The backend's environment, as compose builds it from the file's block and the stack. */
function backendEnvironment(compose: string, stack: Stack): Record<string, string> {
  return Object.fromEntries([...composeBackendEnv(compose)].map(([name, { value }]) => [name, interpolate(value, stack)]));
}

/** A list in the backend service (`secrets:`): its `- name` lines. */
function backendList(compose: string, key: string): string[] {
  const lines = compose.split('\n');
  const service = lines.findIndex((l) => /^ {2}backend:\s*$/.test(l));
  const start = lines.findIndex((l, i) => i > service && new RegExp(`^ {4}${key}:\\s*$`).test(l));
  if (service < 0 || start < 0) throw new Error(`no backend ${key}: in the compose file`);
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^ {6}- (\S+)\s*$/.exec(line);
    if (!item) break;
    items.push(item[1]!);
  }
  return items;
}

/** Each service's `image:` line. */
function images(compose: string): Record<string, string> {
  const out: Record<string, string> = {};
  let service = '';
  for (const line of compose.split('\n')) {
    const named = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (named) service = named[1]!;
    const image = /^ {4}image: (\S+)/.exec(line);
    if (image && service) out[service] = image[1]!;
  }
  return out;
}

/** What a Portainer stack sets: the variables the compose file's header lists as required, and the image tag. */
const STACK: Stack = {
  SECRETS_BASE_PATH: '/opt/nuggets/secrets',
  POSTGRES_DATA_PATH: '/opt/nuggets/data/postgres',
  DOMAIN_URL: 'https://nuggets.example.com',
  UPLOADS_PATH: '/opt/nuggets/data/uploads',
  BACKUPS_PATH: '/opt/nuggets/data/backups',
  TEMP_PATH: '/opt/nuggets/data/temp',
  LOGS_PATH: '/opt/nuggets/data/logs',
  NUGGETS_IMAGE_TAG: '3.0.0',
};
/** And one from before the renames, which still sets the old names. */
const OLD_NAMES_STACK: Stack = { ...STACK, useAPIRateLimiting: 'false', APIRateLimit: '1000', FORCE_HTTPS: 'true' };

describe('the compose file 2.4.0 shipped, with the 3.0.0 images', () => {
  it('is read as compose reads it', () => {
    expect(interpolate('${A:-${B:-x}}', { B: 'b' })).toBe('b');
    expect(interpolate('${A:-x}', { A: '' })).toBe('x');
    expect(interpolate('${A-x}', { A: '' })).toBe('');
    expect(interpolate('a$${B}', {})).toBe('a${B}');
    const env = backendEnvironment(OLD_COMPOSE, STACK);
    expect(env).toMatchObject({ NODE_ENV: 'production', CLIENT_URL: 'https://nuggets.example.com', API_RATE_LIMITING: 'true' });
    // The old name still has its line, and with nothing set in the stack it is empty.
    expect(env.APIRateLimit).toBe('');
    expect(backendList(OLD_COMPOSE, 'secrets')).toContain('smtp_password');
  });

  // Releases before 3.0.0 were published under another owner; the fixture names it
  // `previous-owner`.
  it('runs the images 3.0.0 publishes once its image lines name the new owner', () => {
    const old = images(OLD_COMPOSE);
    const current = images(NEW_COMPOSE);
    for (const service of ['postgres', 'backend', 'frontend']) {
      expect(old[service], service).toMatch(/^ghcr\.io\/previous-owner\/nuggets-[a-z]+:\$\{NUGGETS_IMAGE_TAG:-latest\}$/);
      expect(current[service], service).toMatch(/^ghcr\.io\/plushcap\/nuggets-[a-z]+:\$\{NUGGETS_IMAGE_TAG:-latest\}$/);
      // The owner is all that differs: the image's name and its tag stay.
      expect(old[service]!.replace('ghcr.io/previous-owner/', 'ghcr.io/plushcap/'), service).toBe(current[service]);
    }
  });

  it('gives the backend the configuration the current compose file gives it', () => {
    const old = loadConfig(backendEnvironment(OLD_COMPOSE, STACK));
    expect(old.problems).toEqual([]);
    expect(old.config).toEqual(loadConfig(backendEnvironment(NEW_COMPOSE, STACK)).config);
  });

  it('starts with the old names still set in the stack, and the backend takes no notice of them', () => {
    const env = backendEnvironment(OLD_COMPOSE, OLD_NAMES_STACK);
    // APIRateLimit reaches the backend and is ignored: the limit is RATE_LIMIT_MAX_REQUESTS's.
    expect(env.APIRateLimit).toBe('1000');
    // FORCE_HTTPS never reached it.
    expect(env).not.toHaveProperty('FORCE_HTTPS');
    const { config, problems } = loadConfig(env);
    expect(problems).toEqual([]);
    expect(config.RATE_LIMIT_MAX_REQUESTS).toBe(500);
    // 2.4.0's compose still maps the old flag onto the new name (production limits anyway).
    expect(config.API_RATE_LIMITING).toBe(false);
  });

  it('mounts every secret the 3.0.0 backend reads, and one more it no longer reads', () => {
    const mounted = backendList(OLD_COMPOSE, 'secrets');
    // The secrets the backend's code reads by name (readDockerSecret), and the data key.
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) return name === '__tests__' || name === 'test' ? [] : sources(full);
        return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
      });
    const read = new Set([path.basename(DATA_ENCRYPTION_SECRET_PATH)]);
    for (const file of sources(path.join(here, '..'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\breadDockerSecret\(\s*['"]([a-z0-9_]+)['"]/g)) read.add(m[1]!);
    }
    expect([...read].sort()).toEqual(['app_db_password', 'csrf_secret', 'data_encryption_key', 'db_password', 'jwt_secret', 'session_secret']);
    expect(mounted.filter((name) => !read.has(name))).toEqual(['smtp_password']);
    expect([...read].filter((name) => !mounted.includes(name))).toEqual([]);
    expect(backendList(NEW_COMPOSE, 'secrets').filter((name) => !mounted.includes(name))).toEqual([]);
  });

  describe("passes the backend's startup checks", () => {
    let secrets: string;

    beforeAll(() => {
      // The files the old compose mounts at /run/secrets, the SMTP password among them.
      secrets = mkdtempSync(path.join(os.tmpdir(), 'compose-2.4.0-secrets-'));
      for (const name of backendList(OLD_COMPOSE, 'secrets')) {
        writeFileSync(path.join(secrets, name), randomBytes(name === 'jwt_secret' ? 64 : 32).toString('base64'));
      }
    });
    afterAll(() => rmSync(secrets, { recursive: true, force: true }));
    afterEach(() => vi.unstubAllEnvs());

    it.each([
      ['as the current docs set it up', STACK],
      ['with the old names set', OLD_NAMES_STACK],
    ])('%s', (_name, stack) => {
      const env: Record<string, string> = {
        ...backendEnvironment(OLD_COMPOSE, stack),
        // Where the container has them: SECRETS_PATH is /run/secrets, and the data key the
        // fixed /run/secrets/data_encryption_key, which DATA_ENCRYPTION_KEY_FILE stands in for.
        SECRETS_PATH: secrets,
        DATA_ENCRYPTION_KEY_FILE: path.join(secrets, 'data_encryption_key'),
      };
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

      // As index.ts does with USE_DOCKER_SECRETS=true: load the secrets, copy them into the
      // environment, then check the whole configuration.
      expect(env.USE_DOCKER_SECRETS).toBe('true');
      const loaded = loadSecrets();
      vi.stubEnv('JWT_SECRET', loaded.jwtSecret);
      vi.stubEnv('DB_PASSWORD', loaded.dbPassword);
      vi.stubEnv('SESSION_SECRET', loaded.sessionSecret);
      vi.stubEnv('CSRF_SECRET', loaded.csrfSecret);
      const checks = [checkSecretsForStartup, () => shutdownSettings(), () => poolSettings(), () => retentionPolicy()];
      expect(validateStartupConfig(process.env, checks)).toEqual([]);
    });
  });
});
