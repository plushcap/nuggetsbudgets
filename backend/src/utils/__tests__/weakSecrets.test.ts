import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadSecrets, secretWeakness } from '../docker-secrets.js';

/**
 * A production server refuses to start with a weak secret; it used
 * to log a warning and run with a guessable JWT or HMAC key.
 */
describe('weak secrets', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  const strong = () => randomBytes(32).toString('base64');
  const useSecrets = (overrides: Record<string, string> = {}) => {
    Object.assign(process.env, {
      DB_PASSWORD: strong(),
      APP_DB_PASSWORD: strong(),
      JWT_SECRET: randomBytes(64).toString('base64'),
      SESSION_SECRET: strong(),
      CSRF_SECRET: strong(),
      ...overrides,
    });
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
