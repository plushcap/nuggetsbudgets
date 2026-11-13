import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSecrets, secretWeakness } from '../docker-secrets.js';

/**
 * A production server refuses to start with a weak secret; it used
 * to log a warning and run with a guessable JWT or HMAC key.
 */
describe('weak secrets', () => {
  const saved = { ...process.env };
  const dirs: string[] = [];
  afterEach(() => {
    process.env = { ...saved };
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const strong = () => randomBytes(32).toString('base64');
  /**
   * The secrets, overrides applied: Docker secret files in production, which reads nothing
   * else; the variables elsewhere, as development and the tests set them.
   */
  const useSecrets = (overrides: Record<string, string> = {}) => {
    const secrets: Record<string, string> = {
      DB_PASSWORD: strong(),
      APP_DB_PASSWORD: strong(),
      JWT_SECRET: randomBytes(64).toString('base64'),
      SESSION_SECRET: strong(),
      CSRF_SECRET: strong(),
      ...overrides,
    };
    for (const name of Object.keys(secrets)) delete process.env[name];
    if (process.env.NODE_ENV !== 'production') {
      Object.assign(process.env, secrets);
      return;
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'weak-secrets-'));
    dirs.push(dir);
    for (const [name, value] of Object.entries(secrets)) writeFileSync(path.join(dir, name.toLowerCase()), value);
    process.env.SECRETS_PATH = dir;
  };

  it('starts in production with generated secrets', () => {
    process.env.NODE_ENV = 'production';
    useSecrets();
    expect(() => loadSecrets()).not.toThrow();
  });

  it.each([
    [{ JWT_SECRET: 'short-jwt-secret' }, 'jwt_secret is shorter than 32 characters'],
    [{ SESSION_SECRET: 'changeme' }, 'session_secret is shorter than 16 characters'],
    [{ CSRF_SECRET: 'a'.repeat(40) }, 'csrf_secret is fewer than 8 different characters'],
    [{ DB_PASSWORD: 'password' }, 'db_password is shorter than 16 characters'],
    [{ APP_DB_PASSWORD: 'abababababababababab' }, 'app_db_password is fewer than 8 different characters'],
  ])('refuses to start in production with %o', (overrides, problem) => {
    process.env.NODE_ENV = 'production';
    useSecrets(overrides);
    expect(() => loadSecrets()).toThrow(problem);
  });

  it('names the weak secret, never its value', () => {
    process.env.NODE_ENV = 'production';
    useSecrets({ JWT_SECRET: 'tiny-but-secret' });
    expect(() => loadSecrets()).toThrow(expect.objectContaining({ message: expect.not.stringContaining('tiny-but-secret') }));
  });

  it('lets development and tests run with them', () => {
    process.env.NODE_ENV = 'test';
    useSecrets({ JWT_SECRET: 'test_secret' });
    expect(() => loadSecrets()).not.toThrow();
  });

  it('knows a placeholder when it is long enough', () => {
    expect(secretWeakness('test_session_secret', 16)).toBe('a placeholder value');
  });
});
