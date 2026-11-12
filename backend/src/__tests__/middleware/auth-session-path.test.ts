import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.js';

/**
 * authenticateSession's browser-session path, and the two guards mounted after it
 * (requireInteractiveSession, requireRecentReauth): each refusal's answer, the rotation and
 * sliding-cookie branches, and that an internal failure answers a generic 500. The
 * session service, the cookies and the user lookup are stubbed; the session rules
 * themselves are tested against the database in auth-sessions.db.test.ts, the Bearer path
 * in auth-bearer.test.ts.
 */

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

const state = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  users: [] as unknown[],
  validateSession: null as unknown as Mock,
  rotateSession: null as unknown as Mock,
  isRecentlyReauthenticated: null as unknown as Mock,
  setCookie: null as unknown as Mock,
  clearCookie: null as unknown as Mock,
}));

vi.mock('../../db.js', () => {
  const builder: object = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'executeTakeFirst') return () => Promise.resolve(state.users.shift());
        if (prop === 'execute') return () => Promise.resolve([]);
        return () => builder;
      },
    }
  );
  return { default: {}, db: { selectFrom: () => builder, updateTable: () => builder } };
});

vi.mock('../../services/SessionService.js', () => ({
  SessionService: class {
    validateSession = (...args: unknown[]) => state.validateSession(...args);
    rotateSession = (...args: unknown[]) => state.rotateSession(...args);
    isRecentlyReauthenticated = (...args: unknown[]) => state.isRecentlyReauthenticated(...args);
  },
}));

vi.mock('../../utils/session-cookie-config.js', () => ({
  getSessionFromCookies: () => state.cookie,
  setSessionCookie: (...args: unknown[]) => state.setCookie(...args),
  clearSessionCookie: (...args: unknown[]) => state.clearCookie(...args),
}));

const { authenticateSession, requireInteractiveSession, requireRecentReauth } = await import('../../middleware/auth.js');

type Body = { error?: string; code?: string };
function mockRes() {
  const res = {} as Response & { statusCode?: number; body?: Body };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: Body) => {
    res.body = body;
    return res;
  });
  return res;
}

const request = (fields: Partial<AuthenticatedRequest> = {}) =>
  ({ headers: {}, ip: '127.0.0.1', method: 'GET', originalUrl: '/api/categories', ...fields }) as AuthenticatedRequest;

async function authenticate(fields: Partial<AuthenticatedRequest> = {}) {
  const req = request(fields);
  const res = mockRes();
  const next = vi.fn() as NextFunction;
  await authenticateSession(req, res, next);
  return { req, res, next };
}

const user = (overrides: Record<string, unknown> = {}) => ({ id: 42, email: 'member@example.com', must_change_password: false, ...overrides });
const valid = (overrides: Record<string, unknown> = {}) => ({ sessionId: 10, userId: 42, needsRotation: false, graceRotated: false, ...overrides });

beforeEach(() => {
  state.cookie = 'session-token';
  state.users = [];
  state.validateSession = vi.fn(async () => valid());
  state.rotateSession = vi.fn(async () => ({ token: 'rotated-token', sessionId: 11 }));
  state.isRecentlyReauthenticated = vi.fn(async () => true);
  state.setCookie = vi.fn();
  state.clearCookie = vi.fn();
});

describe('authenticateSession, with a session cookie', () => {
  it('refuses a request without one (401 MISSING_SESSION)', async () => {
    state.cookie = undefined;
    const { res, next } = await authenticate();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body?.code).toBe('MISSING_SESSION');
  });

  it('clears the cookie of a session that is no longer valid (401 INVALID_SESSION)', async () => {
    state.validateSession = vi.fn(async () => null);
    const { res, next } = await authenticate();
    expect(next).not.toHaveBeenCalled();
    expect(res.body?.code).toBe('INVALID_SESSION');
    expect(state.clearCookie).toHaveBeenCalledOnce();
  });

  it("clears the cookie of a session whose user is gone (401 USER_NOT_FOUND)", async () => {
    const { res, next } = await authenticate();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body?.code).toBe('USER_NOT_FOUND');
    expect(state.clearCookie).toHaveBeenCalledOnce();
  });

  it('lets a user who must change their password reach only the routes for that', async () => {
    state.users = [user({ must_change_password: true })];
    let { res, next } = await authenticate({ method: 'POST', originalUrl: '/api/transactions' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // A trailing slash and a query don't make it another route.
    state.users = [user({ must_change_password: true })];
    ({ res, next } = await authenticate({ method: 'GET', originalUrl: '/api/auth/me/?fresh=1' }));
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it('slides the cookie of a current session, and attaches the user and session', async () => {
    state.users = [user()];
    const { req, next } = await authenticate();
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ userId: 42, email: 'member@example.com' });
    expect(req.session).toEqual({ id: 10, needsRotation: false });
    expect(state.setCookie).toHaveBeenCalledWith(expect.anything(), 'session-token');
    expect(state.rotateSession).not.toHaveBeenCalled();
  });

  it("doesn't slide the cookie of an old token accepted in the rotation grace window", async () => {
    state.users = [user()];
    state.validateSession = vi.fn(async () => valid({ graceRotated: true }));
    const { next } = await authenticate();
    expect(next).toHaveBeenCalledOnce();
    expect(state.setCookie).not.toHaveBeenCalled();
  });

  it('rotates a token due for it, and points the request at the new session', async () => {
    state.users = [user()];
    state.validateSession = vi.fn(async () => valid({ needsRotation: true }));
    const { req, next } = await authenticate({ headers: { 'user-agent': 'test-agent' } });
    expect(next).toHaveBeenCalledOnce();
    expect(state.rotateSession).toHaveBeenCalledWith(10, { userId: 42, ipAddress: '127.0.0.1', userAgent: 'test-agent' });
    expect(state.setCookie).toHaveBeenCalledWith(expect.anything(), 'rotated-token');
    expect(req.session).toEqual({ id: 11, needsRotation: true });
  });

  it('keeps the current cookie when another request rotated first, or the rotation fails', async () => {
    for (const rotate of [async () => null, async () => Promise.reject(new Error('rotation failed (internal detail)'))]) {
      state.users = [user()];
      state.validateSession = vi.fn(async () => valid({ needsRotation: true }));
      state.rotateSession = vi.fn(rotate);
      state.setCookie = vi.fn();
      const { req, res, next } = await authenticate();
      expect(next).toHaveBeenCalledOnce();
      expect(res.statusCode).toBeUndefined();
      expect(state.setCookie).not.toHaveBeenCalled();
      expect(req.session).toEqual({ id: 10, needsRotation: true });
    }
  });

  it('answers a generic 500 when the session check itself fails', async () => {
    state.validateSession = vi.fn(async () => {
      throw new Error('connection terminated (internal detail)');
    });
    const { res, next } = await authenticate();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Authentication error', code: 'AUTH_ERROR' });
  });
});

describe('requireInteractiveSession and requireRecentReauth', () => {
  const run = async (guard: typeof requireRecentReauth, fields: Partial<AuthenticatedRequest>) => {
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await guard(request(fields), res, next);
    return { res, next };
  };
  const signedIn = { user: { userId: 42, email: 'member@example.com' }, session: { id: 10, needsRotation: false } };

  it.each([
    ['requireInteractiveSession', requireInteractiveSession],
    ['requireRecentReauth', requireRecentReauth],
  ] as const)('%s: 401 without a user, 403 for a token or without a session', async (_name, guard) => {
    let { res, next } = await run(guard as typeof requireRecentReauth, {});
    expect(res.statusCode).toBe(401);
    expect(res.body?.code).toBe('AUTH_REQUIRED');
    expect(next).not.toHaveBeenCalled();

    ({ res, next } = await run(guard as typeof requireRecentReauth, { ...signedIn, patId: 3 }));
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('INTERACTIVE_SESSION_REQUIRED');
    expect(next).not.toHaveBeenCalled();

    ({ res, next } = await run(guard as typeof requireRecentReauth, { user: signedIn.user }));
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('INTERACTIVE_SESSION_REQUIRED');
    expect(next).not.toHaveBeenCalled();
  });

  it('requireRecentReauth: asks for the password again (403 REAUTH_REQUIRED), else lets the session through', async () => {
    state.isRecentlyReauthenticated = vi.fn(async () => false);
    let { res, next } = await run(requireRecentReauth, signedIn);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('REAUTH_REQUIRED');
    expect(state.isRecentlyReauthenticated).toHaveBeenCalledWith(10);

    state.isRecentlyReauthenticated = vi.fn(async () => true);
    ({ res, next } = await run(requireRecentReauth, signedIn));
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  // It answered a 500 AUTH_CHECK_ERROR of its own; the error handler answers it now.
  it('requireRecentReauth: a check that fails goes to the error handler', async () => {
    const failure = new Error('sessions table locked (internal detail)');
    state.isRecentlyReauthenticated = vi.fn(async () => {
      throw failure;
    });
    const { res, next } = await run(requireRecentReauth, signedIn);
    expect(next).toHaveBeenCalledExactlyOnceWith(failure);
    expect(res.statusCode).toBeUndefined();
  });
});
