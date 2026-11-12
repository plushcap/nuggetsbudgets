import { describe, it, expect, vi, afterEach } from 'vitest';

// Defensive: some transitive imports load Docker secrets at init; keep this test
// hermetic. (security-enhanced.ts itself doesn't touch the DB.)
process.env.SESSION_SECRET = 'test';
process.env.CSRF_SECRET = 'test';
process.env.JWT_SECRET = 'test';
process.env.DB_PASSWORD = 'test';
vi.mock('../db.js', () => ({ default: {}, db: {} }));

import express from 'express';
import cookieParser from 'cookie-parser';
import supertest from 'supertest';
import { CSRFProtection, routedPath, withoutTrailingSlashes } from '../middleware/security-enhanced.js';
import { SESSION_COOKIE_NAME, clearSessionCookie, sessionCookieName, setSessionCookie } from '../utils/session-cookie-config.js';
import { csrfCookieName, csrfTokenFor } from '../utils/csrfToken.js';

/**
 * A request as the verify middleware sees it, mounted with app.use('/api', …): Express
 * puts the matched mount (as the request spelled it) in baseUrl and the rest of the
 * parsed path in path.
 */
function request(opts: { method?: string; path?: string; cookies?: Record<string, string>; headers?: Record<string, string> }) {
  const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const url = opts.path || '/api/accounts';
  const pathname = url.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/, 1)[0];
  const mounted = /^\/api(?=\/|$)/i.test(pathname);
  return {
    method: opts.method || 'POST',
    originalUrl: url,
    baseUrl: mounted ? pathname.slice(0, 4) : '',
    path: (mounted ? pathname.slice(4) : pathname) || '/',
    cookies: opts.cookies || {},
    headers,
    get: (h: string) => headers[h.toLowerCase()],
    ip: '127.0.0.1',
  } as never;
}

function response() {
  const set: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  const cleared: string[] = [];
  const result = { status: 200, code: undefined as string | undefined, set, cleared };
  const res = {
    status: (c: number) => {
      result.status = c;
      return res;
    },
    json: (b: { code?: string }) => {
      result.code = b.code;
      return res;
    },
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      set.push({ name, value, options });
      return res;
    },
    clearCookie: (name: string) => {
      cleared.push(name);
      return res;
    },
  };
  return { res: res as never, result };
}

function run(opts: Parameters<typeof request>[0]) {
  const { res, result } = response();
  let nexted = false;
  CSRFProtection.verify()(request(opts), res, () => {
    nexted = true;
  });
  return { ...result, nexted };
}

const JSON_BODY = { 'Content-Type': 'application/json' };
const staleSession = { [SESSION_COOKIE_NAME]: 'stale-token' };

describe('CSRFProtection.verify (stale-cookie lockout fix)', () => {
  it('exempts login even with a stale session cookie and no csrf token', () => {
    const r = run({ path: '/api/auth/login', cookies: staleSession, headers: JSON_BODY });
    expect(r.nexted).toBe(true);
    expect(r.status).toBe(200);
  });

  it('exempts the passkey auth endpoints with a stale session cookie', () => {
    expect(run({ path: '/api/passkeys/auth/options', cookies: staleSession, headers: JSON_BODY }).nexted).toBe(true);
    expect(run({ path: '/api/passkeys/auth/verify', cookies: staleSession, headers: { 'content-type': 'application/json; charset=utf-8' } }).nexted).toBe(true);
  });

  it('still blocks a non-exempt mutation when the token is missing', () => {
    const r = run({ path: '/api/accounts', cookies: staleSession });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
    expect(r.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('allows a non-exempt mutation that sends its session’s token', () => {
    const r = run({
      path: '/api/accounts',
      cookies: { ...staleSession, csrf_token: csrfTokenFor('stale-token') },
      headers: { 'X-CSRF-Token': csrfTokenFor('stale-token') },
    });
    expect(r.nexted).toBe(true);
  });

  it('exempts unauthenticated requests (no session cookie) and safe methods', () => {
    expect(run({ path: '/api/accounts', cookies: {} }).nexted).toBe(true); // no session cookie
    expect(run({ method: 'GET', path: '/api/accounts', cookies: staleSession }).nexted).toBe(true);
  });
});

describe('CSRF residuals', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a token that is not the session’s, even when cookie and header match', () => {
    // A double-submit pair someone else chose: a sibling subdomain can write the cookie.
    const r = run({ path: '/api/accounts', cookies: { ...staleSession, csrf_token: 'abc' }, headers: { 'X-CSRF-Token': 'abc' } });
    expect(r.nexted).toBe(false);
    expect(r.code).toBe('CSRF_TOKEN_INVALID');
    // Another session's token doesn't do either.
    const other = run({ path: '/api/accounts', cookies: staleSession, headers: { 'X-CSRF-Token': csrfTokenFor('another-session') } });
    expect(other.nexted).toBe(false);
  });

  it.each([
    ['application/x-www-form-urlencoded'],
    ['multipart/form-data; boundary=x'],
    ['text/plain'],
    [undefined],
  ])('refuses sign-in and setup sent as %s, which a cross-site form can post (login CSRF)', (type) => {
    for (const path of ['/api/auth/login', '/api/auth/setup-admin', '/api/passkeys/auth/verify']) {
      const r = run({ path, headers: type ? { 'Content-Type': type } : {} });
      expect(r.nexted, `${path} ${type}`).toBe(false);
      expect(r.status).toBe(415);
      expect(r.code).toBe('JSON_REQUIRED');
    }
  });

  // Express routes ignoring case and a trailing slash, so each of these reaches a sign-in
  // handler; compared as written they skipped the JSON check, and a form signed in.
  // An absolute-form target is routed by its path too.
  const VARIANTS = [
    '/api/Auth/Login',
    '/API/auth/login',
    '/api/auth/login/',
    '/API/AUTH/LOGIN/',
    '/api/auth/login?next=1',
    'http://nuggets.example/api/Auth/Login',
    '/api/Auth/Setup-Admin/',
    '/api/PassKeys/Auth/Options',
    '/api/passkeys/auth/Verify/',
  ];

  it.each(VARIANTS)('refuses a form posted to %s, which Express routes to a sign-in handler', (path) => {
    for (const type of ['application/x-www-form-urlencoded', 'text/plain']) {
      const r = run({ path, headers: { 'Content-Type': type } });
      expect(r.nexted, `${path} ${type}`).toBe(false);
      expect(r.status).toBe(415);
      expect(r.code).toBe('JSON_REQUIRED');
    }
    // JSON still passes, a stale session cookie notwithstanding.
    expect(run({ path, cookies: staleSession, headers: JSON_BODY }).nexted).toBe(true);
  });

  it('reads a path of thousands of slashes in linear time', () => {
    // replace(/\/+$/, '') tried each slash of a run that doesn't end the path: quadratic,
    // about 140 ms for the 16,000 a request line can hold, on every unauthenticated POST.
    expect(withoutTrailingSlashes('/api/auth/login///')).toBe('/api/auth/login');
    expect(withoutTrailingSlashes('///')).toBe('');
    expect(withoutTrailingSlashes('/a//b')).toBe('/a//b');
    const slashes = `/api${'/'.repeat(100_000)}x`;
    const start = performance.now();
    expect(routedPath({ baseUrl: '', path: slashes })).toBe(slashes);
    expect(routedPath({ baseUrl: '/api', path: `/auth/login${'/'.repeat(100_000)}` })).toBe('/api/auth/login');
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('gives a signed-in browser its session’s token, and a new one with a new session', () => {
    const { res, result } = response();
    CSRFProtection.cookieSetter()(request({ method: 'GET', cookies: { [SESSION_COOKIE_NAME]: 'session-1', csrf_token: 'old-random' } }), res, () => undefined);
    expect(result.set).toEqual([expect.objectContaining({ name: 'csrf_token', value: csrfTokenFor('session-1') })]);

    const signIn = response();
    setSessionCookie(signIn.res, 'session-2');
    expect(signIn.result.set.map((c) => [c.name, c.value])).toEqual([
      [SESSION_COOKIE_NAME, 'session-2'],
      ['csrf_token', csrfTokenFor('session-2')],
    ]);
  });

  it.each(['test', 'production'])(
    'clears the CSRF cookie with the session cookie, instead of setting it to the revoked session’s token (%s)',
    async (env) => {
      vi.stubEnv('NODE_ENV', env);
      const app = express();
      app.use(cookieParser());
      app.use(CSRFProtection.cookieSetter());
      // As a sign-out does: the request's sliding refresh set both cookies, then it ends the session.
      app.post('/api/auth/logout', (_req, res) => {
        setSessionCookie(res, 'session-to-revoke');
        res.cookie('nuggets_trusted_device', 'kept', { path: '/api/auth/login' });
        clearSessionCookie(res);
        res.json({ ok: true });
      });
      const res = await supertest(app)
        .post('/api/auth/logout')
        .set('Cookie', `${sessionCookieName()}=session-to-revoke; ${csrfCookieName()}=stale`);
      const cookies = [res.headers['set-cookie'] ?? []].flat() as string[];
      const named = (name: string) => cookies.filter((c) => c.startsWith(`${name}=`));
      // One line each, and it clears: empty, already expired, at Path=/ (which a __Host-
      // cookie must be cleared with, or the browser keeps it). Express 5's clearCookie
      // expires it at the epoch and drops a maxAge, so the CSRF cookie's 7 days don't reach
      // the clearing line.
      const cleared = (name: string) =>
        expect.stringMatching(new RegExp(`^${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT(;|$)`));
      expect(named(sessionCookieName())).toEqual([cleared(sessionCookieName())]);
      expect(named(csrfCookieName())).toEqual([cleared(csrfCookieName())]);
      for (const cookie of [...named(sessionCookieName()), ...named(csrfCookieName())]) {
        expect(cookie).not.toMatch(/Max-Age=[1-9]/i);
        expect(cookie).not.toMatch(/; Domain=/i);
      }
      expect(cookies.join('\n')).not.toContain(csrfTokenFor('session-to-revoke'));
      // Other cookies stay.
      expect(named('nuggets_trusted_device')).toHaveLength(1);
      if (env === 'production') {
        expect(sessionCookieName()).toBe('__Host-nuggets_session');
        expect(named(sessionCookieName())[0]).toMatch(/; Secure/);
        expect(named(csrfCookieName())[0]).toMatch(/; Secure/);
      }
    }
  );

  // Until 3.0.0 a production server also cleared the cookies' names from before the
  // prefix; a browser that still sends them gets nothing for them, and they don't count.
  it('names the cookies __Host- in production, and takes no notice of the old names', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(sessionCookieName()).toBe('__Host-nuggets_session');
    expect(csrfCookieName()).toBe('__Host-csrf_token');

    const signIn = response();
    setSessionCookie(signIn.res, 'session-3');
    for (const cookie of signIn.result.set) {
      expect(cookie.name.startsWith('__Host-')).toBe(true);
      // What the browser requires of a __Host- cookie.
      expect(cookie.options).toMatchObject({ secure: true, path: '/' });
      expect(cookie.options.domain).toBeUndefined();
    }

    const { res, result } = response();
    CSRFProtection.cookieSetter()(
      request({ method: 'GET', cookies: { '__Host-nuggets_session': 'session-3', nuggets_session: 'old', csrf_token: 'old' } }),
      res,
      () => undefined
    );
    expect(result.cleared).toEqual([]);
    expect(result.set).toEqual([expect.objectContaining({ name: '__Host-csrf_token', value: csrfTokenFor('session-3') })]);
    // The old name no longer counts as a session.
    expect(run({ path: '/api/accounts', cookies: { nuggets_session: 'old' } }).nexted).toBe(true);
    expect(run({ path: '/api/accounts', cookies: { '__Host-nuggets_session': 'session-3' } }).nexted).toBe(false);
  });
});
