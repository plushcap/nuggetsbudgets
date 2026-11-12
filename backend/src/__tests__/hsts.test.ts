import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

/**
 * HSTS's includeSubDomains and preload reach every other site under the domain, so they
 * are opt-in. They used to be sent always, which can lock out a plain-HTTP service
 * on a sibling or parent domain.
 */
describe('Strict-Transport-Security', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('covers only this host by default', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await request(createApp()).get('/no-such-path');
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('adds includeSubDomains and preload when asked', async () => {
    vi.stubEnv('HSTS_INCLUDE_SUBDOMAINS', 'true');
    vi.stubEnv('HSTS_PRELOAD', 'true');
    const res = await request(createApp()).get('/no-such-path');
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains; preload');
  });
});
