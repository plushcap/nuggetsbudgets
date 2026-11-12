import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

/**
 * The API rate limiter skips the public liveness and readiness probes, and nothing else.
 * It skipped any path starting with `/health`, so `POST
 * /api/health<15,000 letters>` with a forged session cookie went unlimited to the CSRF
 * check, which logged a security event carrying the path, and masking the addresses in it
 * took a quarter of a second each: four clients slowed /api/ready from 18 ms to a second.
 * Here the limiter is on (as in production) with a budget of 3.
 */
vi.mock('../middleware/security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/security.js')>();
  return {
    ...actual,
    isApiRateLimitingEnabled: () => true,
    apiRateLimiter: actual.buildRateLimiter(60_000, 3, actual.apiRateLimitKey),
  };
});

const { createApp, isUncountedHealthProbe } = await import('../app.js');
const { getRecentSecurityEvents } = await import('../middleware/security-enhanced.js');
const { sessionCookieName } = await import('../utils/session-cookie-config.js');
const { MAX_LOGGED_PATH_LENGTH } = await import('../utils/logger.js');

function appWithProbes() {
  const app = createApp();
  // createApp mounts no routes: answer every /api path, as the probes would.
  app.all(/^\/api\//, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('the API rate limiter and the health probes', () => {
  it('skips only a GET or HEAD of /health or /ready', () => {
    expect(isUncountedHealthProbe({ method: 'GET', path: '/health' })).toBe(true);
    expect(isUncountedHealthProbe({ method: 'HEAD', path: '/ready' })).toBe(true);
    expect(isUncountedHealthProbe({ method: 'POST', path: '/health' })).toBe(false);
    expect(isUncountedHealthProbe({ method: 'GET', path: '/healthz' })).toBe(false);
    expect(isUncountedHealthProbe({ method: 'GET', path: `/health${'a'.repeat(100)}` })).toBe(false);
    expect(isUncountedHealthProbe({ method: 'GET', path: '/health/detailed' })).toBe(false);
    expect(isUncountedHealthProbe({ method: 'GET', path: '/ready/x' })).toBe(false);
  });

  it('never limits the probes themselves', async () => {
    const app = appWithProbes();
    for (let i = 0; i < 6; i++) {
      await request(app).get('/api/health').expect(200);
      await request(app).get('/api/ready').expect(200);
    }
  });

  it('counts a long path that starts with /health, and the CSRF check logs it cut short', async () => {
    const app = appWithProbes();
    const path = `/api/health${'a'.repeat(15_000)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(path)
        .set('Cookie', `${sessionCookieName()}=forged-session-token`)
        .set('X-CSRF-Token', 'forged')
        .send({});
      statuses.push(res.status);
    }
    // Three CSRF refusals, then the limiter.
    expect(statuses).toEqual([403, 403, 403, 429, 429]);
    const [event] = getRecentSecurityEvents(1);
    expect(event.message).toBe('CSRF token validation failed');
    expect(String(event.metadata?.endpoint)).toHaveLength(MAX_LOGGED_PATH_LENGTH + 1);
    expect(String(event.metadata?.endpoint).startsWith('/healthaaaa')).toBe(true);
  });
});
