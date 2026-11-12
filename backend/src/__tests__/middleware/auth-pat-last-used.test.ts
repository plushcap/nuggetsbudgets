import { describe, it, expect, vi } from 'vitest';
import { inspect } from 'util';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.js';

/**
 * A personal access token's last_used_at bump is best-effort: authenticateSession
 * doesn't wait for it, and when it fails the request goes on as if it hadn't, and the
 * failure is logged as `{ err }` with the token's jti, never the token. The token checks
 * themselves are in auth-bearer.test.ts and personal-access-tokens.test.ts.
 */

const state = vi.hoisted(() => {
  process.env.JWT_SECRET ??= 'test-secret-do-not-use-in-production'; // gitleaks:allow (made-up)
  process.env.DB_PASSWORD ??= 'test';
  process.env.SESSION_SECRET ??= 'test';
  process.env.CSRF_SECRET ??= 'test';
  return {
    rows: [] as unknown[],
    bumpError: new Error('canceling statement due to lock timeout on personal_access_tokens'),
    logged: [] as { level: string; args: unknown[] }[],
  };
});

// The lookups answer the token's row, then its user's; the bump fails.
vi.mock('../../db.js', () => {
  const select: object = new Proxy({}, {
    get: (_t, prop) => (prop === 'executeTakeFirst' ? () => Promise.resolve(state.rows.shift()) : () => select),
  });
  const update: object = new Proxy({}, {
    get: (_t, prop) => (prop === 'execute' ? () => Promise.reject(state.bumpError) : () => update),
  });
  return { default: {}, db: { selectFrom: () => select, updateTable: () => update } };
});

// The middleware's logger, recorded.
vi.mock('../../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/logger.js')>();
  const fake = Object.fromEntries(
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((level) => [
      level,
      (...args: unknown[]) => {
        state.logged.push({ level, args });
      },
    ])
  );
  return {
    ...actual,
    createLogger: (context: Record<string, unknown>) => (context.service === 'Auth' ? fake : actual.createLogger(context)),
  };
});

const { authenticateSession } = await import('../../middleware/auth.js');
const { signPersonalAccessToken } = await import('../../utils/jwt-helper.js');

describe("a failed update of a token's last_used_at", () => {
  it('lets the request through, and logs the failure as { err } without the token', async () => {
    const token = signPersonalAccessToken(
      { userId: 42, email: 'a@b.c', tenantId: 7, scope: 'read_write' },
      { expiresIn: '1d', jwtid: 'last-used-jti' }
    );
    state.rows.push(
      { id: 1, user_id: 42, tenant_id: 7, scope: 'read_write', revoked_at: null, expires_at: new Date(Date.now() + 86_400_000) },
      { id: 42, email: 'a@b.c', is_locked: false }
    );
    const req = {
      headers: { authorization: `Bearer ${token}` },
      ip: '127.0.0.1',
      originalUrl: '/api/categories',
      method: 'GET',
    } as unknown as AuthenticatedRequest;
    const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await authenticateSession(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toEqual({ userId: 42, email: 'a@b.c' });
    expect(req.patId).toBe(1);

    // The bump isn't awaited: its failure is logged once it settles.
    await vi.waitFor(() => expect(state.logged.some(({ args }) => args[1] === 'Failed to update PAT last_used_at')).toBe(true));
    const line = state.logged.find(({ args }) => args[1] === 'Failed to update PAT last_used_at')!;
    expect(line.level).toBe('warn');
    expect(line.args[0]).toEqual({ err: state.bumpError, jti: 'last-used-jti' });

    // Nothing the middleware logged carries the token, or its signature alone.
    const everything = inspect(state.logged, { depth: 10 });
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(token.split('.')[2]);
  });
});
