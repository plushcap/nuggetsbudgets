import { describe, it, expect, vi } from 'vitest';

// Nothing here reaches the database: the JSON check comes first in each route.
vi.mock('../db.js', () => ({ default: {}, db: {} }));

import express from 'express';
import request from 'supertest';
import { createAuthPublicRoutes } from '../routes/auth.js';
import { createPasskeySignInRoutes } from '../routes/passkeys.js';

/**
 * The sign-in, first-run setup and passkey sign-in handlers take JSON only, whatever path
 * reached them. CSRFProtection.verify refuses a form for the paths it
 * knows, but it once compared the path as written while Express routes ignoring case, so
 * `POST /api/Auth/Login` with a form body signed a browser in. Here the routers are
 * mounted without that middleware, as a path it misses would reach them.
 */
function app() {
  const a = express();
  a.use(express.json());
  a.use(express.urlencoded({ extended: true }));
  a.use('/api/auth', createAuthPublicRoutes());
  a.use('/api/passkeys', createPasskeySignInRoutes());
  return a;
}

describe('sign-in handlers take JSON only', () => {
  it.each([
    '/api/auth/login',
    '/api/Auth/Login',
    '/API/AUTH/LOGIN/',
    '/api/auth/setup-admin',
    '/api/Auth/Setup-Admin/',
    '/api/passkeys/auth/options',
    '/api/PassKeys/Auth/Options',
    '/api/passkeys/auth/verify',
    '/api/Passkeys/auth/Verify/',
  ])('answers a form posted to %s with 415', async (path) => {
    for (const send of [
      (r: request.Test) => r.type('form').send('email=a%40b.example&password=whatever'),
      (r: request.Test) => r.type('text/plain').send('{"email":"a@b.example","password":"whatever"}'),
      (r: request.Test) => r.field('email', 'a@b.example').field('password', 'whatever'),
    ]) {
      const res = await send(request(app()).post(path));
      expect(res.status, path).toBe(415);
      expect(res.body.code).toBe('JSON_REQUIRED');
      expect([res.headers['set-cookie'] ?? []].flat().some((c: string) => c.startsWith('nuggets_session='))).toBe(false);
    }
  });
});
