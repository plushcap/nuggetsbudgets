import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'crypto';

/**
 * The key behind trusted-device cookies and sign-in throttle keys. A known key would
 * let anyone mint trusted-device cookies and skip the per-account throttle, so production
 * never falls back to one.
 */
describe('serverHmac', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const withoutSecrets = () => {
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('CSRF_SECRET', '');
    vi.stubEnv('JWT_SECRET', '');
  };

  it('refuses to fall back to a known key in production', async () => {
    withoutSecrets();
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { serverHmac } = await import('../serverHmac.js');
    expect(() => serverHmac('x')).toThrow(/server secret/);
  });

  it('keys with the session secret when there is one', async () => {
    withoutSecrets();
    vi.stubEnv('SESSION_SECRET', 'a-session-secret-for-tests');
    vi.resetModules();
    const { serverHmac } = await import('../serverHmac.js');
    expect(serverHmac('x').toString('hex')).toBe(createHmac('sha256', 'a-session-secret-for-tests').update('x').digest('hex'));
  });
});
