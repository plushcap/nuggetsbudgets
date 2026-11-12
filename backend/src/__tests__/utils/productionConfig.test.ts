import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { weakSecrets } from '../../utils/docker-secrets.js';
import {
  checkProductionConfig,
  ProductionConfigError,
  refuseSetting,
  rpIdCoversHost,
  validateStartupConfig,
} from '../../utils/productionConfig.js';
import { strictSetting } from '../../config.js';
import { cookiesAreSecure } from '../../utils/cookieSecurity.js';

/**
 * What a production server checks before it starts: settings that used to
 * pass startup and fail later, and confusingly.
 */
describe('checkProductionConfig', () => {
  let tmp: string;
  let goodKey: string;
  let shortKey: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'production-config-'));
    goodKey = path.join(tmp, 'good');
    shortKey = path.join(tmp, 'short');
    await writeFile(goodKey, randomBytes(32).toString('base64'));
    await writeFile(shortKey, 'too-short');
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  const env = (overrides: Record<string, string | undefined>) =>
    ({ NODE_ENV: 'production', DOMAIN_URL: 'https://nuggets.example.com', DATA_ENCRYPTION_KEY_FILE: goodKey, ...overrides }) as NodeJS.ProcessEnv;

  it('passes a complete configuration, and checks nothing outside production', () => {
    expect(checkProductionConfig(env({}))).toEqual([]);
    expect(checkProductionConfig(env({ WEBAUTHN_RP_ID: 'example.com' }))).toEqual([]);
    expect(checkProductionConfig({ NODE_ENV: 'development' })).toEqual([]);
  });

  it.each([
    ['no DOMAIN_URL', { DOMAIN_URL: undefined }, /Set DOMAIN_URL/],
    ['a relative DOMAIN_URL', { DOMAIN_URL: 'nuggets.example.com' }, /not an absolute URL/],
    ['an http DOMAIN_URL', { DOMAIN_URL: 'http://nuggets.example.com' }, /must be an https/],
    ['a passkey domain the host is not under', { WEBAUTHN_RP_ID: 'other.example' }, /WEBAUTHN_RP_ID \(other\.example\) is not the host/],
    ['a passkey domain that only ends the same', { WEBAUTHN_RP_ID: 'ample.com' }, /is not the host/],
  ])('refuses %s', (_name, overrides, message) => {
    expect(() => checkProductionConfig(env(overrides))).toThrow(ProductionConfigError);
    expect(() => checkProductionConfig(env(overrides))).toThrow(message);
  });

  it('refuses a data encryption key that is too short', () => {
    expect(() => checkProductionConfig(env({ DATA_ENCRYPTION_KEY_FILE: shortKey }))).toThrow(
      /data_encryption_key secret can't be used: .*at least 32/
    );
  });

  // The weak-secret check the other secrets get: a 32-character key of
  // one repeated character used to start production.
  it.each([
    ['one character repeated', 'a'.repeat(32), 'fewer than 8 different characters'],
    ['two characters alternating', 'ab'.repeat(22), 'fewer than 8 different characters'],
    ['seven different characters', '1234567'.repeat(6), 'fewer than 8 different characters'],
  ])('refuses a weak data encryption key: %s', async (_name, key, weakness) => {
    const file = path.join(tmp, `weak-${key.length}-${new Set(key).size}`);
    await writeFile(file, key);
    let error: unknown;
    try {
      checkProductionConfig(env({ DATA_ENCRYPTION_KEY_FILE: file }));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ProductionConfigError);
    expect((error as ProductionConfigError).problems).toEqual([expect.stringMatching(new RegExp(`^data_encryption_key is ${weakness}: .*rewrap-secrets`))]);
    // For a backend that won't start: a container of the backend's image, not "with the
    // backend stopped" (the rotation runs in the live one), and the command to run there.
    const [problem] = (error as ProductionConfigError).problems;
    expect(problem).toContain("in a container of its own from the backend's image");
    expect(problem).toContain('node dist/scripts/rewrap-secrets.js --old-key-file /run/secrets/data_encryption_key --new-key-file');
    expect(problem).not.toMatch(/\.md\b/);
    expect(problem).not.toMatch(/backend stopped/);
    // The problem names the secret, never its value.
    expect((error as ProductionConfigError).message).not.toContain(key);
    // Outside production it is only the length that counts.
    expect(validateStartupConfig({ NODE_ENV: 'development', DATA_ENCRYPTION_KEY_FILE: file })).toEqual([]);
  });

  it('starts in production with the secrets generate-secrets.js writes', async () => {
    const dir = path.join(tmp, 'generated');
    const script = fileURLToPath(new URL('../../../../scripts/generate-secrets.js', import.meta.url));
    execFileSync(process.execPath, [script, '--dir', dir], { stdio: 'ignore' });
    const read = (name: string) => readFileSync(path.join(dir, `${name}.txt`), 'utf8').trim();

    expect(checkProductionConfig(env({ DATA_ENCRYPTION_KEY_FILE: path.join(dir, 'data_encryption_key.txt') }))).toEqual([]);
    expect(
      weakSecrets({
        dbPassword: read('db_password'),
        appDbPassword: read('app_db_password'),
        jwtSecret: read('jwt_secret'),
        sessionSecret: read('session_secret'),
        csrfSecret: read('csrf_secret'),
      })
    ).toEqual([]);
  });

  it('allows http for a loopback host (a smoke test on one machine)', () => {
    expect(checkProductionConfig(env({ DOMAIN_URL: 'http://localhost:13000' }))).toEqual([]);
  });

  it('warns, without refusing, when there is no data encryption key at all', () => {
    expect(checkProductionConfig(env({ DATA_ENCRYPTION_KEY_FILE: path.join(tmp, 'missing') }))).toEqual([
      expect.stringMatching(/There is no data_encryption_key secret/),
    ]);
  });

  // The rest of what can be wrong, and all of it in one go.
  it('refuses a CLIENT_URL that is not https, and an explicit WEBAUTHN_ORIGIN outside the passkey domain', () => {
    expect(() => checkProductionConfig(env({ CLIENT_URL: 'http://192.168.1.10:3000' }))).toThrow(/CLIENT_URL must be an https/);
    expect(() => checkProductionConfig(env({ WEBAUTHN_ORIGIN: 'https://other.example.net' }))).toThrow(
      /WEBAUTHN_RP_ID \(nuggets\.example\.com\) is not the host of WEBAUTHN_ORIGIN \(other\.example\.net\)/
    );
    expect(() => checkProductionConfig(env({ WEBAUTHN_USER_VERIFICATION: 'discouraged' }))).toThrow(/must be required or preferred/);
    // A parent domain covers both.
    expect(
      checkProductionConfig(env({ DOMAIN_URL: 'https://app.example.com', WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGIN: 'https://app.example.com' }))
    ).toEqual([]);
  });

  it('lists every problem at once, numeric settings included', () => {
    const bad = env({ DOMAIN_URL: 'http://nuggets.example.com', DATA_ENCRYPTION_KEY_FILE: shortKey, SHUTDOWN_TIMEOUT_MS: 'soon' });
    let error: unknown;
    try {
      validateStartupConfig(bad, [() => strictSetting('SHUTDOWN_TIMEOUT_MS', bad, refuseSetting)]);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ProductionConfigError);
    const { problems, message } = error as ProductionConfigError;
    expect(problems).toEqual([
      expect.stringMatching(/^DOMAIN_URL must be an https/),
      expect.stringMatching(/^The data_encryption_key secret can't be used/),
      'SHUTDOWN_TIMEOUT_MS must be a whole number from 1000 to 600000, not "soon"',
    ]);
    expect(message).toMatch(/^3 configuration problems:\n {2}- /);
    // And the warnings come back when nothing is refused.
    expect(validateStartupConfig(env({ DATA_ENCRYPTION_KEY_FILE: path.join(tmp, 'missing') }))).toEqual([
      expect.stringMatching(/There is no data_encryption_key secret/),
    ]);
  });

  it('checks only the passkey and numeric settings outside production', () => {
    expect(validateStartupConfig({ NODE_ENV: 'development' })).toEqual([]);
    expect(() => validateStartupConfig({ NODE_ENV: 'development', WEBAUTHN_USER_VERIFICATION: 'discouraged' })).toThrow(
      'WEBAUTHN_USER_VERIFICATION must be required or preferred, not discouraged'
    );
    const dev = { NODE_ENV: 'test', DB_POOL_MAX: '0' };
    expect(() => validateStartupConfig(dev, [() => strictSetting('DB_POOL_MAX', dev, refuseSetting)])).toThrow(
      'DB_POOL_MAX must be a whole number from 1 to 1000, not "0"'
    );
  });

  // Cookies are Secure in production, and elsewhere as COOKIE_SECURE or
  // DOMAIN_URL's scheme says (utils/cookieSecurity.ts).
  it('refuses a COOKIE_SECURE that is not true or false, and warns that production ignores false', () => {
    expect(() => validateStartupConfig({ NODE_ENV: 'development', COOKIE_SECURE: 'yes' })).toThrow(/COOKIE_SECURE must be true or false \(it is yes\)/);
    expect(validateStartupConfig({ NODE_ENV: 'development', COOKIE_SECURE: 'TRUE' })).toEqual([]);
    expect(() => checkProductionConfig(env({ COOKIE_SECURE: '1' }))).toThrow(/COOKIE_SECURE must be true or false/);
    expect(checkProductionConfig(env({ COOKIE_SECURE: 'false' }))).toEqual([
      'COOKIE_SECURE=false is ignored in production: its cookies are always Secure',
    ]);
  });

  it('decides whether cookies are Secure from NODE_ENV, COOKIE_SECURE and DOMAIN_URL', () => {
    expect(cookiesAreSecure({ NODE_ENV: 'production', COOKIE_SECURE: 'false', DOMAIN_URL: 'http://localhost:3000' })).toBe(true);
    expect(cookiesAreSecure({ NODE_ENV: 'development' })).toBe(false);
    expect(cookiesAreSecure({ NODE_ENV: 'development', DOMAIN_URL: 'http://localhost:3000' })).toBe(false);
    expect(cookiesAreSecure({ NODE_ENV: 'development', DOMAIN_URL: 'https://nuggets.example.com' })).toBe(true);
    expect(cookiesAreSecure({ NODE_ENV: 'development', DOMAIN_URL: 'https://nuggets.example.com', COOKIE_SECURE: 'false' })).toBe(false);
    expect(cookiesAreSecure({ NODE_ENV: 'test', DOMAIN_URL: 'http://localhost:3000', COOKIE_SECURE: 'true' })).toBe(true);
    expect(cookiesAreSecure({ NODE_ENV: 'development', DOMAIN_URL: 'not a url' })).toBe(false);
  });

  it('matches passkey RP IDs as WebAuthn does', () => {
    expect(rpIdCoversHost('example.com', 'example.com')).toBe(true);
    expect(rpIdCoversHost('example.com', 'app.example.com')).toBe(true);
    expect(rpIdCoversHost('Example.COM', 'app.example.com')).toBe(true);
    expect(rpIdCoversHost('example.com', 'badexample.com')).toBe(false);
    expect(rpIdCoversHost('app.example.com', 'example.com')).toBe(false);
  });
});
