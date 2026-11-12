import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
// Types only: the modules themselves load in beforeAll, after the environment is set.
import type * as AuthModule from '../middleware/auth.js';
import type * as JwtHelperModule from '../utils/jwt-helper.js';

// Configure a JWT secret BEFORE importing any module that reads it at load time.
const SECRET = 'test-secret-do-not-use-in-production';
process.env.JWT_SECRET = SECRET;
process.env.DB_PASSWORD = 'test';
process.env.SESSION_SECRET = 'test';
process.env.CSRF_SECRET = 'test';

// Mock db.js so the middleware doesn’t touch Postgres. The bearer path uses the
// Kysely `db` export (selectFrom/updateTable...). Stub it with a chainable
// builder whose executeTakeFirst() drains a per-test results queue (each entry
// is the row the next lookup should resolve to, or undefined for "not found").
// It answers whatever a query asks, so these tests check the middleware's own
// branching on the row it is handed, not the lookup's filters: the
// jti, revoked_at and expiry checks are tested against the database by
// personal-access-tokens.test.ts ("strict verification") and auth-sessions.db.test.ts.
const mockQuery = vi.fn();
const takeFirstQueue: unknown[] = [];
const builder: object = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'executeTakeFirst') return () => Promise.resolve(takeFirstQueue.shift());
      if (prop === 'execute') return () => Promise.resolve([]);
      return () => builder;
    },
  }
);
vi.mock('../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
  db: { selectFrom: () => builder, updateTable: () => builder },
}));

let authenticateSession: typeof AuthModule.authenticateSession;
let requireInteractiveSession: typeof AuthModule.requireInteractiveSession;
let requireRecentReauth: typeof AuthModule.requireRecentReauth;
let signPersonalAccessToken: typeof JwtHelperModule.signPersonalAccessToken;
let verifyPersonalAccessToken: typeof JwtHelperModule.verifyPersonalAccessToken;

/** A request double: only the fields the middleware reads. */
const asRequest = (fields: Partial<AuthModule.AuthenticatedRequest>) => fields as AuthModule.AuthenticatedRequest;

beforeAll(async () => {
  const auth = await import('../middleware/auth.js');
  authenticateSession = auth.authenticateSession;
  requireInteractiveSession = auth.requireInteractiveSession;
  requireRecentReauth = auth.requireRecentReauth;
  const helper = await import('../utils/jwt-helper.js');
  signPersonalAccessToken = helper.signPersonalAccessToken;
  verifyPersonalAccessToken = helper.verifyPersonalAccessToken;
});

beforeEach(() => {
  takeFirstQueue.length = 0;
});

/** The error body the middleware answers with. */
type ErrorBody = { error?: string; code?: string };

function mockRes() {
  const res = {} as Response & { statusCode?: number; body?: ErrorBody };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((payload: ErrorBody) => {
    res.body = payload;
    return res;
  });
  return res;
}

const DAY_MS = 86_400_000;
const UUID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const livePat = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  user_id: 42,
  tenant_id: 7,
  scope: 'read_write',
  revoked_at: null,
  expires_at: new Date(Date.now() + DAY_MS),
  ...overrides,
});
const liveUser = { id: 42, email: 'a@b.c', is_locked: false };

function mintToken(overrides: { jti?: string; userId?: number; tenantId?: number } = {}) {
  return signPersonalAccessToken(
    { userId: overrides.userId ?? 42, email: 'a@b.c', tenantId: overrides.tenantId ?? 7, scope: 'read_write' },
    { expiresIn: '365d', jwtid: overrides.jti ?? 'test-jti' }
  );
}

async function authenticate(token: string, opts: { method?: string; url?: string } = {}) {
  const req = asRequest({
    headers: { authorization: `Bearer ${token}` },
    ip: '127.0.0.1',
    originalUrl: opts.url ?? '/api/categories',
    method: opts.method ?? 'GET',
  });
  const res = mockRes();
  const next = vi.fn() as NextFunction;
  await authenticateSession(req, res, next);
  return { req, res, next };
}

describe('signPersonalAccessToken', () => {
  it('signs HS256 with the MCP audience, our issuer and the given jti', () => {
    const token = mintToken();
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
    const decoded = verifyPersonalAccessToken(token);
    expect(decoded).toMatchObject({ userId: 42, tenantId: 7, scope: 'read_write', aud: 'mcp', iss: 'nuggets', jti: 'test-jti' });
  });

  it('verifies a token without an issuer (minted before it was set) but not one with another issuer', () => {
    const old = jwt.sign({ userId: 42, tenantId: 7 }, SECRET, { audience: 'mcp', jwtid: 'x', expiresIn: '1d' });
    expect(verifyPersonalAccessToken(old).iss).toBeUndefined();
    const foreign = jwt.sign({ userId: 42, tenantId: 7 }, SECRET, { audience: 'mcp', jwtid: 'x', issuer: 'elsewhere', expiresIn: '1d' });
    expect(() => verifyPersonalAccessToken(foreign)).toThrow();
  });
});

describe('authenticateSession Bearer path', () => {
  it('populates req.user and the token from a live row, and calls next()', async () => {
    takeFirstQueue.push(livePat(), liveUser);
    const { req, res, next } = await authenticate(mintToken());
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ userId: 42, email: 'a@b.c' });
    expect(req.tokenTenantId).toBe(7);
    expect(req.patId).toBe(1);
    expect(req.patScope).toBe('read_write');
    expect(res.statusCode).toBeUndefined();
  });

  it.each([
    ['revoked', livePat({ revoked_at: new Date() }), 'TOKEN_REVOKED'],
    ['absent from the table', undefined, 'TOKEN_REVOKED'],
    ['expired in its row', livePat({ expires_at: new Date(Date.now() - 1000) }), 'TOKEN_EXPIRED'],
    // pg reads an 'infinity' timestamptz as the number Infinity.
    ['expiring at infinity (pg reads it as a number)', livePat({ expires_at: Infinity }), 'TOKEN_EXPIRED'],
    ['expiring at -infinity (pg reads it as a number)', livePat({ expires_at: -Infinity }), 'TOKEN_EXPIRED'],
    ['for another user', livePat({ user_id: 43 }), 'TOKEN_INVALID'],
    ['for another ledger', livePat({ tenant_id: 8 }), 'TOKEN_INVALID'],
  ])('rejects a token whose row is %s (401 %s)', async (_label, row, code) => {
    takeFirstQueue.push(row, liveUser);
    const { res, next } = await authenticate(mintToken());
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body?.code).toBe(code);
  });

  it.each([
    ['without an audience', () => jwt.sign({ userId: 42, tenantId: 7 }, SECRET, { jwtid: 'j', expiresIn: '1d' })],
    ['with another audience', () => jwt.sign({ userId: 42, tenantId: 7 }, SECRET, { audience: 'web', jwtid: 'j', expiresIn: '1d' })],
    ['with an audience list', () => jwt.sign({ userId: 42, tenantId: 7 }, SECRET, { audience: ['mcp'], jwtid: 'j', expiresIn: '1d' })],
    ['without a jti', () => jwt.sign({ userId: 42, tenantId: 7 }, SECRET, { audience: 'mcp', expiresIn: '1d' })],
    ['signed HS512', () => jwt.sign({ userId: 42, tenantId: 7 }, SECRET, { algorithm: 'HS512', audience: 'mcp', jwtid: 'j', expiresIn: '1d' })],
    ['unsigned (alg none)', () => jwt.sign({ userId: 42, tenantId: 7 }, '', { algorithm: 'none', audience: 'mcp', jwtid: 'j', expiresIn: '1d' })],
    ['from another issuer', () => jwt.sign({ userId: 42, tenantId: 7 }, SECRET, { audience: 'mcp', issuer: 'x', jwtid: 'j', expiresIn: '1d' })],
    ['past its exp', () => jwt.sign({ userId: 42, tenantId: 7, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET, { audience: 'mcp', jwtid: 'j' })],
    ['not a JWT', () => 'not.a.jwt'],
  ])('rejects a token %s before looking it up (401)', async (_label, make) => {
    takeFirstQueue.push(livePat(), liveUser); // would pass, if it got that far
    const { res, next } = await authenticate(make());
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(takeFirstQueue).toHaveLength(2);
  });

  it.each([
    ['no ledger claim', { userId: 42 }],
    ['a ledger claim as a string', { userId: 42, tenantId: '7' }],
    ['a user claim as a string', { userId: '42', tenantId: 7 }],
  ])('rejects a token with %s, though its row is live (401 TOKEN_INVALID)', async (_label, claims) => {
    takeFirstQueue.push(livePat(), liveUser);
    const { res, next } = await authenticate(jwt.sign(claims, SECRET, { audience: 'mcp', jwtid: 'j', expiresIn: '1d' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body?.code).toBe('TOKEN_INVALID');
  });

  it('takes a malformed Bearer header as a failed token, not as no token', async () => {
    const req = asRequest({
      headers: { authorization: 'Bearer two parts', cookie: 'nuggets_session=whatever' },
      ip: '127.0.0.1',
      originalUrl: '/api/categories',
      method: 'GET',
    });
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await authenticateSession(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('refuses a verified token on a route tokens may not reach (403 INTERACTIVE_SESSION_REQUIRED)', async () => {
    takeFirstQueue.push(livePat(), liveUser);
    const { req, res, next } = await authenticate(mintToken(), { method: 'POST', url: '/api/auth/mcp-token' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('INTERACTIVE_SESSION_REQUIRED');
    expect(req.user).toBeUndefined();
  });

  it('refuses a write by a read token (403 TOKEN_READ_ONLY) but lets it read and call /api/mcp', async () => {
    takeFirstQueue.push(livePat({ scope: 'read' }), liveUser);
    const write = await authenticate(mintToken(), { method: 'PUT', url: `/api/transactions/${UUID}` });
    expect(write.res.statusCode).toBe(403);
    expect(write.res.body?.code).toBe('TOKEN_READ_ONLY');

    takeFirstQueue.push(livePat({ scope: 'read' }), liveUser);
    expect((await authenticate(mintToken(), { method: 'GET', url: `/api/transactions/${UUID}` })).next).toHaveBeenCalledOnce();

    takeFirstQueue.push(livePat({ scope: 'read' }), liveUser);
    expect((await authenticate(mintToken(), { method: 'POST', url: '/api/mcp' })).next).toHaveBeenCalledOnce();
  });

  it('lets a token reach only listed routes, with ids where the route has parameters', async () => {
    const reach = async (method: string, url: string) => {
      takeFirstQueue.push(livePat(), liveUser);
      const { res, next } = await authenticate(mintToken(), { method, url });
      return vi.mocked(next).mock.calls.length === 1 ? 'next' : `${res.statusCode} ${res.body?.code}`;
    };
    expect(await reach('GET', `/api/transactions/${UUID}`)).toBe('next');
    expect(await reach('HEAD', '/api/categories')).toBe('next');
    expect(await reach('DELETE', '/api/tags/budget-items/' + UUID + '/tags/12')).toBe('next');
    expect(await reach('GET', '/api/transactions/paginated?page=2')).toBe('next');
    for (const [method, url] of [
      ['GET', '/api/transactions'], // a ledger route no MCP tool calls
      ['DELETE', `/api/categories/${UUID}`], // ditto
      ['GET', '/api/transactions/not-an-id'],
      ['GET', '/api/investments/securities/paginated'], // not /securities/:uuid
      ['GET', '/api/auth/me'],
      ['GET', '/api/accounts/../auth/sessions'],
      ['GET', '/api//categories'],
    ]) {
      expect(await reach(method, url), `${method} ${url}`).toBe('403 INTERACTIVE_SESSION_REQUIRED');
    }
  });
});

describe('requireInteractiveSession and requireRecentReauth', () => {
  // Tokens are already refused on every route that mounts these (tokenAccess.ts); these
  // guards keep such a route closed to a token even if the allowlist ever opened it.
  it.each([
    ['requireInteractiveSession', () => requireInteractiveSession],
    ['requireRecentReauth', () => requireRecentReauth],
  ])('%s refuses a request that authenticated with a token, and one with no session', async (_name, guard) => {
    for (const req of [
      // (A token request never has a session; this one does, to test the token check alone.)
      asRequest({ user: { userId: 42, email: 'a@b.c' }, patId: 1, patScope: 'read_write', session: { id: 5, needsRotation: false } }),
      asRequest({ user: { userId: 42, email: 'a@b.c' } }),
    ]) {
      const res = mockRes();
      const next = vi.fn() as NextFunction;
      await guard()(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body?.code).toBe('INTERACTIVE_SESSION_REQUIRED');
    }
  });

  it('requireInteractiveSession lets a browser session through', async () => {
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await requireInteractiveSession(asRequest({ user: { userId: 42, email: 'a@b.c' }, session: { id: 5, needsRotation: false } }), res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
