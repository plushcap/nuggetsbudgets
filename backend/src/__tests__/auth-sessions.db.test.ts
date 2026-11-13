import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Refused requests log warnings; keep them out of the test output unless asked for.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import http from 'http';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../utils/session-cookie-config.js';
// The CSRF token is bound to the session.
import { csrfTokenFor } from '../utils/csrfToken.js';
import { sessionIdleMs } from '../utils/session-lifetime.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * Sign-in sessions, the active ledger, MCP tokens and passkey removal, through their
 * routes on the real app: what the other auth suites leave out. Sign-in and
 * its throttles are login-abuse-resistance.db.test.ts and login-rate-limits.db.test.ts;
 * revocation on a lock or password change, and session lifetime, credential-revocation;
 * token scopes and strict verification, personal-access-tokens; passkey ceremonies,
 * passkey-ceremonies; one user reaching another's sessions, tokens or passkeys,
 * tenant-isolation-api.
 *
 * Sessions are cookies set by POST /api/auth/login, tokens are minted by
 * POST /api/auth/mcp-token and sent as `Authorization: Bearer`, as the browser and the MCP
 * server do.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

// The header the passkey sign-in sends. Its endpoints are exempt from the CSRF check (for a
// JSON body): a browser signing in has no session yet. A signed-in request sends its
// session's token (withCookie).
const CSRF_TOKEN = 'auth-sessions-csrf-token';
const PASSWORD = 'Auth sessions passphrase Qd8!';
// Where passkeys are bound outside production with no DOMAIN_URL (utils/webauthnConfig.ts).
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

/** An ES256 passkey that signs WebAuthn assertions the way an authenticator does. */
class SoftPasskey {
  readonly id = randomBytes(16).toString('base64url');
  /** The WebAuthn user handle it was made with: a discoverable passkey names it when it signs in. */
  readonly userHandle = randomBytes(32).toString('base64url');
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private counter = 0;

  /** The public key as PasskeyService stores it: COSE (EC2, ES256, P-256), base64url. */
  publicKey(): string {
    const jwk = (this.keys.publicKey as KeyObject).export({ format: 'jwk' }) as { x: string; y: string };
    return Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from([0x22, 0x58, 0x20]),
      Buffer.from(jwk.y, 'base64url'),
    ]).toString('base64url');
  }

  assertion(challenge: string) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
    // User present + user verified.
    const authenticatorData = Buffer.concat([sha256(RP_ID), Buffer.from([0x05]), counter]);
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}

interface TestUser {
  id: number;
  uuid: string;
  email: string;
}

describeDb('Sessions, the active ledger, MCP tokens and passkey removal through their routes', () => {
  let owner: Pool;
  let a: TestTenant;
  let b: TestTenant;
  let aUuid: string;
  let bUuid: string;
  let server: http.Server;
  let previousRounds: string | undefined;
  let passwordHash: string;
  const userIds: number[] = [];

  beforeAll(async () => {
    // Every test signs in through the route; bcrypt at the lowest cost the app allows, and
    // hashes at that cost, so a sign-in doesn't re-hash the password.
    previousRounds = process.env.BCRYPT_ROUNDS;
    process.env.BCRYPT_ROUNDS = '10';
    passwordHash = bcrypt.hashSync(PASSWORD, 10);
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    owner = new Pool({ connectionString, max: 2 });
    a = await createTestTenant('Auth sessions A');
    b = await createTestTenant('Auth sessions B');
    const uuidOf = async (id: number) =>
      (await owner.query<{ uuid: string }>('SELECT uuid FROM tenants WHERE id = $1', [id])).rows[0].uuid;
    aUuid = await uuidOf(a.tenantId);
    bUuid = await uuidOf(b.tenantId);
    // One account in each ledger, named for it: GET /api/accounts shows which ledger a
    // request acted in.
    await a.pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Ledger A account', 'checking', 'cash', 'Asset')`);
    await b.pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Ledger B account', 'checking', 'cash', 'Asset')`);
  }, 60_000);

  afterAll(async () => {
    if (previousRounds === undefined) delete process.env.BCRYPT_ROUNDS;
    else process.env.BCRYPT_ROUNDS = previousRounds;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!owner) return;
    try {
      // Their sessions, tokens and passkeys go with them (ON DELETE CASCADE).
      await owner.query('DELETE FROM deployment_users WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM tenant_users WHERE user_id = ANY($1)', [userIds]);
      await owner.query('UPDATE users SET last_tenant_id = NULL WHERE id = ANY($1)', [userIds]);
      const settled = await Promise.allSettled([a?.cleanup(), b?.cleanup()]);
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      await owner.end();
    }
  }, 60_000);

  /** A user with PASSWORD, a member of ledger A (and B with `both`), who last used A. */
  async function addUser(label: string, opts: { both?: boolean } = {}): Promise<TestUser> {
    const email = `auth-sessions-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
    const row = (
      await owner.query<{ id: number; uuid: string }>(
        `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, $2, 'Test', $3) RETURNING id, uuid`,
        [email, passwordHash, label]
      )
    ).rows[0];
    userIds.push(row.id);
    await owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [a.tenantId, row.id]);
    if (opts.both) await owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [b.tenantId, row.id]);
    await owner.query('UPDATE users SET last_tenant_id = $1 WHERE id = $2', [a.tenantId, row.id]);
    return { id: row.id, uuid: row.uuid, email };
  }

  const setCookies = (res: request.Response): string[] => ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  /**
   * The last cookie named `name` the response sets: a browser applies a response's cookies
   * in order, so it is the one the browser keeps.
   */
  const cookieFrom = (res: request.Response, name: string) => setCookies(res).filter((c) => c.startsWith(`${name}=`)).at(-1);
  const cookieValue = (cookie: string | undefined, name: string) => cookie?.split(';')[0].slice(name.length + 1) || undefined;
  const sessionCookieFrom = (res: request.Response) => cookieFrom(res, SESSION_COOKIE_NAME);
  const sessionTokenFrom = (res: request.Response) => cookieValue(sessionCookieFrom(res), SESSION_COOKIE_NAME);

  /** Sign in through POST /api/auth/login; the session token its cookie carries. */
  async function login(user: TestUser): Promise<string> {
    const res = await request(server).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const token = sessionTokenFrom(res);
    expect(token).toBeTruthy();
    return token!;
  }

  /**
   * A request from the browser that holds this session: its session cookie, and the CSRF
   * cookie the server sets with it, whose value is the session's token, echoed in
   * the header as the SPA does.
   */
  const withCookie = (req: request.Test, sessionToken: string) =>
    req
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}; csrf_token=${csrfTokenFor(sessionToken)}`)
      .set('X-CSRF-Token', csrfTokenFor(sessionToken));
  /** GET /api/auth/me: any signed-in session may call it. */
  const me = (sessionToken: string) => withCookie(request(server).get('/api/auth/me'), sessionToken);
  const status = async (req: request.Test) => (await req).status;
  const sessionRow = async (sessionToken: string) =>
    (
      await owner.query<{ id: number; uuid: string; is_revoked: boolean; revocation_reason: string | null; active_tenant_id: number | null }>(
        'SELECT id, uuid, is_revoked, revocation_reason, active_tenant_id FROM sessions WHERE session_token_hash = $1',
        [sessionService.hashSessionToken(sessionToken)]
      )
    ).rows[0];
  /** The names of the accounts GET /api/accounts lists: the ledger the session acts in. */
  const accountNames = async (sessionToken: string) => {
    const res = await withCookie(request(server).get('/api/accounts'), sessionToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.accounts as Array<{ name: string }>).map((acct) => acct.name);
  };

  describe('the session cookie', () => {
    const attributes = (cookie: string) => cookie.split(';').slice(1).map((part) => part.trim());
    const hasDomain = (cookie: string) => attributes(cookie).some((part) => /^domain=/i.test(part));
    const IDLE_MAX_AGE = `Max-Age=${sessionIdleMs() / 1000}`;
    // A week (utils/csrfToken.ts), longer than a session left idle lasts; it is set again
    // with every session cookie anyway.
    const CSRF_MAX_AGE = `Max-Age=${7 * 24 * 60 * 60}`;

    /**
     * `fn`'s requests, answered as a production backend: the cookie code reads NODE_ENV on each
     * call. Production reads its secrets only from their files, so they are written to some.
     */
    async function inProduction<T>(fn: () => Promise<T>): Promise<T> {
      const previous = { NODE_ENV: process.env.NODE_ENV, SECRETS_PATH: process.env.SECRETS_PATH };
      const dir = mkdtempSync(path.join(os.tmpdir(), 'auth-sessions-secrets-'));
      for (const name of ['SESSION_SECRET', 'CSRF_SECRET', 'JWT_SECRET']) {
        writeFileSync(path.join(dir, name.toLowerCase()), process.env[name] || randomBytes(32).toString('base64'));
      }
      process.env.NODE_ENV = 'production';
      process.env.SECRETS_PATH = dir;
      try {
        return await fn();
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('is nuggets_session, HttpOnly, SameSite=Lax and Path=/ with the idle timeout as Max-Age, and not Secure outside production; csrf_token holds its CSRF token', async () => {
      const user = await addUser('cookie');
      const res = await request(server).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const cookie = cookieFrom(res, 'nuggets_session');
      expect(cookie, 'the session cookie').toBeDefined();
      const attrs = attributes(cookie!);
      expect(attrs).toContain('HttpOnly');
      expect(attrs).toContain('SameSite=Lax');
      expect(attrs).toContain('Path=/');
      expect(attrs).toContain(IDLE_MAX_AGE);
      expect(attrs).not.toContain('Secure');
      const session = cookieValue(cookie, 'nuggets_session')!;

      // The CSRF cookie set with it holds the session's token, and the SPA can read
      // it, to echo it in X-CSRF-Token.
      const csrf = cookieFrom(res, 'csrf_token');
      expect(csrf, 'the CSRF cookie').toBeDefined();
      expect(cookieValue(csrf, 'csrf_token')).toBe(csrfTokenFor(session));
      expect(attributes(csrf!)).toEqual(expect.arrayContaining(['SameSite=Lax', 'Path=/', CSRF_MAX_AGE]));
      expect(attributes(csrf!)).not.toContain('HttpOnly');
      expect(attributes(csrf!)).not.toContain('Secure');
      // The __Host- names are production's.
      expect(setCookies(res).filter((c) => c.startsWith('__Host-'))).toEqual([]);

      // Signing out clears it with the same attributes, already expired. (The sign-in check
      // refreshes the cookie first; a browser applies the response's cookies in order, so
      // the last one is what it keeps.)
      const out = await withCookie(request(server).post('/api/auth/logout'), session);
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      const cleared = cookieFrom(out, 'nuggets_session')!;
      expect(cleared.split(';')[0]).toBe('nuggets_session=');
      expect(attributes(cleared)).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/']));
      expect(cleared).toMatch(/; Max-Age=0;|Expires=Thu, 01 Jan 1970/);
    });

    it('is __Host-nuggets_session in production: HttpOnly, Secure, SameSite=Strict, Path=/ and no Domain, with __Host-csrf_token; signing out clears it the same way', async () => {
      const user = await addUser('cookie-production');
      const res = await inProduction(() => request(server).post('/api/auth/login').send({ email: user.email, password: PASSWORD }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // A browser takes a __Host- cookie only when it is Secure, with Path=/ and no Domain:
      // then only this host can set it, and no other host under the same parent domain can
      // fix a session or a CSRF token for it.
      const cookie = cookieFrom(res, '__Host-nuggets_session');
      expect(cookie, 'the session cookie').toBeDefined();
      expect(attributes(cookie!)).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', IDLE_MAX_AGE]));
      expect(hasDomain(cookie!)).toBe(false);
      const session = cookieValue(cookie, '__Host-nuggets_session')!;

      const csrf = cookieFrom(res, '__Host-csrf_token');
      expect(csrf, 'the CSRF cookie').toBeDefined();
      const csrfToken = cookieValue(csrf, '__Host-csrf_token')!;
      expect(csrfToken).toBe(csrfTokenFor(session));
      expect(attributes(csrf!)).toEqual(expect.arrayContaining(['Secure', 'SameSite=Strict', 'Path=/', CSRF_MAX_AGE]));
      expect(attributes(csrf!)).not.toContain('HttpOnly');
      expect(hasDomain(csrf!)).toBe(false);
      // Nothing under the names without the prefix.
      expect(setCookies(res).filter((c) => /^(nuggets_session|csrf_token)=/.test(c))).toEqual([]);

      // Signing out with the cookies the browser was given. Clearing a __Host- cookie takes
      // the same Secure and Path=/, or the browser ignores it and keeps the cookie.
      const out = await inProduction(() =>
        request(server)
          .post('/api/auth/logout')
          .set('Cookie', `__Host-nuggets_session=${session}; __Host-csrf_token=${csrfToken}`)
          .set('X-CSRF-Token', csrfToken)
      );
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      expect(await sessionRow(session)).toMatchObject({ is_revoked: true, revocation_reason: 'logout' });
      const cleared = cookieFrom(out, '__Host-nuggets_session')!;
      expect(cleared.split(';')[0]).toBe('__Host-nuggets_session=');
      expect(attributes(cleared)).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']));
      expect(hasDomain(cleared)).toBe(false);
      expect(cleared).toMatch(/; Max-Age=0;|Expires=Thu, 01 Jan 1970/);
    });

    /** `fn`'s requests, answered with these settings (each read on every call), outside production. */
    async function withSettings<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
      const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
      for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        return await fn();
      } finally {
        for (const [k, v] of Object.entries(previous)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }

    // Secure followed NODE_ENV alone, so a server not run with
    // NODE_ENV=production (the dev stack, exposed at an https address) sent the session
    // cookie without Secure, with SameSite=Lax.
    it.each([
      ['an https DOMAIN_URL', { DOMAIN_URL: 'https://nuggets.example.com', COOKIE_SECURE: undefined }],
      ['COOKIE_SECURE=true', { DOMAIN_URL: 'http://localhost:3000', COOKIE_SECURE: 'true' }],
    ])('is Secure, SameSite=Strict and __Host- outside production with %s, and signs out the same way', async (_label, settings) => {
      const user = await addUser(`cookie-secure-${_label.length}`);
      const res = await withSettings(settings, () => request(server).post('/api/auth/login').send({ email: user.email, password: PASSWORD }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const cookie = cookieFrom(res, '__Host-nuggets_session');
      expect(cookie, 'the session cookie').toBeDefined();
      expect(attributes(cookie!)).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']));
      expect(hasDomain(cookie!)).toBe(false);
      const csrf = cookieFrom(res, '__Host-csrf_token');
      expect(attributes(csrf!)).toEqual(expect.arrayContaining(['Secure', 'SameSite=Strict', 'Path=/']));
      expect(setCookies(res).filter((c) => /^(nuggets_session|csrf_token)=/.test(c))).toEqual([]);
      const session = cookieValue(cookie, '__Host-nuggets_session')!;
      const csrfToken = cookieValue(csrf, '__Host-csrf_token')!;
      expect(csrfToken).toBe(csrfTokenFor(session));

      // The server reads the cookie under the same name, and the CSRF check passes.
      const out = await withSettings(settings, () =>
        request(server)
          .post('/api/auth/logout')
          .set('Cookie', `__Host-nuggets_session=${session}; __Host-csrf_token=${csrfToken}`)
          .set('X-CSRF-Token', csrfToken)
      );
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      expect(await sessionRow(session)).toMatchObject({ is_revoked: true, revocation_reason: 'logout' });
      const cleared = cookieFrom(out, '__Host-nuggets_session')!;
      expect(attributes(cleared)).toEqual(expect.arrayContaining(['Secure', 'SameSite=Strict', 'Path=/']));
    });

    it.each([
      ['an http DOMAIN_URL (the dev stack on localhost)', { DOMAIN_URL: 'http://localhost:3000', COOKIE_SECURE: undefined }],
      ['COOKIE_SECURE=false', { DOMAIN_URL: 'https://nuggets.example.com', COOKIE_SECURE: 'false' }],
    ])('is not Secure, SameSite=Lax and nuggets_session outside production with %s', async (_label, settings) => {
      const user = await addUser(`cookie-plain-${_label.length}`);
      const res = await withSettings(settings, () => request(server).post('/api/auth/login').send({ email: user.email, password: PASSWORD }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const cookie = cookieFrom(res, 'nuggets_session');
      expect(cookie, 'the session cookie').toBeDefined();
      expect(attributes(cookie!)).toContain('SameSite=Lax');
      expect(attributes(cookie!)).not.toContain('Secure');
      expect(attributes(cookieFrom(res, 'csrf_token')!)).not.toContain('Secure');
      expect(setCookies(res).filter((c) => c.startsWith('__Host-'))).toEqual([]);
      const session = cookieValue(cookie, 'nuggets_session')!;
      expect(await withSettings(settings, () => status(me(session)))).toBe(200);
    });

    it('is Secure in production whatever COOKIE_SECURE says', async () => {
      const user = await addUser('cookie-production-insecure');
      const res = await withSettings({ COOKIE_SECURE: 'false' }, () =>
        inProduction(() => request(server).post('/api/auth/login').send({ email: user.email, password: PASSWORD }))
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(attributes(cookieFrom(res, '__Host-nuggets_session')!)).toEqual(expect.arrayContaining(['Secure', 'SameSite=Strict']));
    });
  });

  describe('signing out', () => {
    it('ends the session on the server: the cookie is refused afterwards, and the user’s other session still works', async () => {
      const user = await addUser('logout');
      const session = await login(user);
      const other = await login(user);
      expect(await status(me(session))).toBe(200);

      expect(await status(withCookie(request(server).post('/api/auth/logout'), session))).toBe(200);
      // A copy of the cookie (another tab, or a stolen one) no longer works.
      expect(await status(me(session))).toBe(401);
      expect(await sessionRow(session)).toMatchObject({ is_revoked: true, revocation_reason: 'logout' });
      expect(await status(me(other))).toBe(200);
    });
  });

  describe('the session list', () => {
    it('lists the caller’s live sessions, marks the current one, and revokes only the one named', async () => {
      const user = await addUser('session-list');
      const ended = await login(user);
      await withCookie(request(server).post('/api/auth/logout'), ended).expect(200);
      const current = await login(user);
      const second = await login(user);
      const [currentRow, secondRow, endedRow] = [await sessionRow(current), await sessionRow(second), await sessionRow(ended)];

      const list = await withCookie(request(server).get('/api/auth/sessions'), current);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const listed = list.body.sessions as Array<{ uuid: string; isCurrent: boolean }>;
      expect(listed.map((s) => s.uuid).sort()).toEqual([currentRow.uuid, secondRow.uuid].sort());
      expect(listed.filter((s) => s.isCurrent).map((s) => s.uuid)).toEqual([currentRow.uuid]);
      expect(listed.map((s) => s.uuid)).not.toContain(endedRow.uuid);

      const revoked = await withCookie(request(server).delete(`/api/auth/sessions/${secondRow.uuid}`), current);
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      expect(await status(me(second))).toBe(401);
      expect(await status(me(current))).toBe(200);
      // Revoked already: nothing to revoke.
      const again = await withCookie(request(server).delete(`/api/auth/sessions/${secondRow.uuid}`), current);
      expect(again.status).toBe(404);
      expect(again.body.code).toBe('SESSION_NOT_FOUND');
    });

    // The list checked the cookie again to find the current session. On the request
    // that rotated it the cookie names the session just retired, so none was marked current.
    it('marks the new session current on the request that rotates it', async () => {
      const user = await addUser('session-list-rotation');
      const session = await login(user);
      await owner.query(`UPDATE sessions SET last_rotated_at = NOW() - interval '2 hours' WHERE session_token_hash = $1`, [
        sessionService.hashSessionToken(session),
      ]);
      const list = await withCookie(request(server).get('/api/auth/sessions'), session);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const rotated = sessionTokenFrom(list);
      expect(rotated, 'the request should have rotated the session').toBeTruthy();
      const listed = list.body.sessions as Array<{ uuid: string; isCurrent: boolean }>;
      expect(listed.map((s) => s.uuid)).toEqual([(await sessionRow(rotated!)).uuid]);
      expect(listed.filter((s) => s.isCurrent).map((s) => s.uuid)).toEqual([(await sessionRow(rotated!)).uuid]);
    });
  });

  describe('the active ledger', () => {
    it('switches every ledger request to the chosen ledger, is remembered at the next sign-in, and survives rotation', async () => {
      const user = await addUser('active-ledger', { both: true });
      const session = await login(user);
      // A sign-in starts in the ledger the user last used.
      expect(await accountNames(session)).toEqual(['Ledger A account']);

      const switched = await withCookie(request(server).post('/api/auth/active-tenant'), session).send({ tenantUuid: bUuid });
      expect(switched.status, JSON.stringify(switched.body)).toBe(200);
      expect(switched.body.activeTenant.uuid).toBe(bUuid);
      expect(await accountNames(session)).toEqual(['Ledger B account']);

      // The next sign-in starts there.
      const next = await login(user);
      expect(await accountNames(next)).toEqual(['Ledger B account']);

      // A session older than the rotation interval is replaced on its next request; the
      // replacement keeps the ledger.
      await owner.query(`UPDATE sessions SET last_rotated_at = NOW() - interval '2 hours' WHERE session_token_hash = $1`, [
        sessionService.hashSessionToken(next),
      ]);
      const rotating = await withCookie(request(server).get('/api/accounts'), next);
      expect(rotating.status).toBe(200);
      const rotated = sessionTokenFrom(rotating);
      expect(rotated, 'the request should have rotated the session').toBeTruthy();
      expect(rotated).not.toBe(next);
      // The CSRF cookie comes with it, so the SPA's next write sends the new session's token.
      expect(cookieValue(cookieFrom(rotating, 'csrf_token'), 'csrf_token')).toBe(csrfTokenFor(rotated!));
      expect((await sessionRow(rotated!)).active_tenant_id).toBe(b.tenantId);
      expect(await accountNames(rotated!)).toEqual(['Ledger B account']);

      // And back.
      await withCookie(request(server).post('/api/auth/active-tenant'), rotated!).send({ tenantUuid: aUuid }).expect(200);
      expect(await accountNames(rotated!)).toEqual(['Ledger A account']);
    });
  });

  describe('MCP tokens through their routes', () => {
    it('mints one that works as a Bearer token, lists it, and revoking it with DELETE refuses it and drops it from the list', async () => {
      const user = await addUser('pat-lifecycle');
      const session = await login(user);
      const mint = (label: string) =>
        withCookie(request(server).post('/api/auth/mcp-token'), session).send({ label, tenantUuid: aUuid, scope: 'read', expiresIn: '30d' });
      const listed = async () => {
        const res = await withCookie(request(server).get('/api/auth/mcp-tokens'), session);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return (res.body as Array<{ uuid: string }>).map((t) => t.uuid);
      };
      const probe = (token: string) => request(server).get('/api/accounts').set('Authorization', `Bearer ${token}`);

      const kept = await mint('kept');
      const revoking = await mint('revoking');
      const expiring = await mint('expiring');
      for (const res of [kept, revoking, expiring]) expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect((await probe(revoking.body.token)).status).toBe(200);
      expect((await listed()).sort()).toEqual([kept.body.uuid, revoking.body.uuid, expiring.body.uuid].sort());

      const revoked = await withCookie(request(server).delete(`/api/auth/mcp-tokens/${revoking.body.uuid}`), session);
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      const refused = await probe(revoking.body.token);
      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe('TOKEN_REVOKED');
      const again = await withCookie(request(server).delete(`/api/auth/mcp-tokens/${revoking.body.uuid}`), session);
      expect(again.status).toBe(404);

      // An expired token is no longer listed either.
      await owner.query(`UPDATE personal_access_tokens SET expires_at = NOW() - interval '1 second' WHERE uuid = $1`, [expiring.body.uuid]);
      expect(await listed()).toEqual([kept.body.uuid]);
      expect((await probe(kept.body.token)).status).toBe(200);
    });
  });

  describe('passkey removal by a deployment admin', () => {
    /** A browser that keeps the cookies the server sets (the passkey ceremony cookie). */
    async function passkeySignIn(passkey: SoftPasskey) {
      const cookies = new Map<string, string>();
      const post = async (path: string, body: object) => {
        const req = request(server).post(path).set('X-CSRF-Token', CSRF_TOKEN);
        const header = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
        if (header) req.set('Cookie', header);
        const res = await req.send(body);
        for (const cookie of setCookies(res)) {
          const [pair] = cookie.split(';');
          cookies.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
        }
        return res;
      };
      const options = await post('/api/passkeys/auth/options', {});
      expect(options.status, JSON.stringify(options.body)).toBe(200);
      return post('/api/passkeys/auth/verify', { response: passkey.assertion(options.body.challenge) });
    }

    it("removes the named passkey of the named user only: it can't sign in, the user's other one still can", async () => {
      const admin = await addUser('passkey-admin');
      await owner.query(
        `INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`,
        [admin.id]
      );
      const user = await addUser('passkey-owner');
      const bystander = await addUser('passkey-bystander');
      const [lost, spare, bystanders] = [new SoftPasskey(), new SoftPasskey(), new SoftPasskey()];
      for (const [owned, key] of [[user, lost], [user, spare], [bystander, bystanders]] as const) {
        await owner.query(
          `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports, device_name)
           VALUES ($1, $2, $3, 0, $4, $5)`,
          [owned.id, key.id, key.publicKey(), ['internal'], `${owned.email} key`]
        );
      }
      for (const key of [lost, spare, bystanders]) expect((await passkeySignIn(key)).status).toBe(200);
      const adminSession = await login(admin);
      const asAdmin = (req: request.Test) => withCookie(req, adminSession);

      const before = await asAdmin(request(server).get(`/api/admin/users/${user.uuid}/passkeys`));
      expect(before.status, JSON.stringify(before.body)).toBe(200);
      expect((before.body as Array<{ id: string }>).map((p) => p.id).sort()).toEqual([lost.id, spare.id].sort());

      // Another user's passkey, named under this user, is not found and stays.
      const elsewhere = await asAdmin(request(server).delete(`/api/admin/users/${user.uuid}/passkeys/${bystanders.id}`));
      expect(elsewhere.status).toBe(404);
      expect((await passkeySignIn(bystanders)).status).toBe(200);

      const removed = await asAdmin(request(server).delete(`/api/admin/users/${user.uuid}/passkeys/${lost.id}`));
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      const after = await asAdmin(request(server).get(`/api/admin/users/${user.uuid}/passkeys`));
      expect((after.body as Array<{ id: string }>).map((p) => p.id)).toEqual([spare.id]);

      const refused = await passkeySignIn(lost);
      expect(refused.status).toBe(401);
      expect(sessionCookieFrom(refused)).toBeUndefined();
      const stillWorks = await passkeySignIn(spare);
      expect(stillWorks.status).toBe(200);
      expect(stillWorks.body.user.id).toBe(user.id);
    });
  });
});
