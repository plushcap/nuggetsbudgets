import { describe, it, expect } from 'vitest';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.generated.js';
import { SessionService, sessionTouchIntervalMs } from '../services/SessionService.js';

// Minimal chainable Kysely stub. Terminal calls (executeTakeFirst /
// executeTakeFirstOrThrow / execute) drain a per-test results queue in call
// order; `.values()` / `.set()` arguments are captured for assertions.
//
// The stub answers whatever a query asks, so these tests check the service's own
// branching (the grace window, the lifetime and password-snapshot checks on the row
// it is handed) and nothing a WHERE clause does. The queries are
// checked against the database through the routes: credential-revocation.test.ts
// (lifetime, rotation, revocation), auth-sessions.db.test.ts (sign-out, the session
// list, the active ledger through rotation) and tenant-isolation-api.test.ts.
type Captured = { inserts: Record<string, unknown>[]; updates: Record<string, unknown>[] };

function svcWith(results: unknown[]) {
  const captured: Captured = { inserts: [], updates: [] };
  const builder: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'executeTakeFirstOrThrow') {
          return async () => {
            const r = results.shift();
            if (r === undefined || r === null) throw new Error('no result');
            return r;
          };
        }
        if (prop === 'executeTakeFirst') return async () => results.shift();
        if (prop === 'execute') return async () => results.shift() ?? [];
        if (prop === 'values') return (v: Record<string, unknown>) => { captured.inserts.push(v); return builder; };
        if (prop === 'set') return (v: Record<string, unknown>) => { captured.updates.push(v); return builder; };
        return () => builder;
      },
    }
  );
  const db: Record<string, unknown> = {
    selectFrom: () => builder,
    insertInto: () => builder,
    updateTable: () => builder,
  };
  // A transaction runs its callback on the same stub.
  db.transaction = () => ({ execute: (fn: (trx: unknown) => unknown) => fn(db) });
  const svc = new SessionService(db as unknown as Kysely<DB>);
  return { svc, captured };
}

const userRow = { id: 1, is_locked: false, login_disabled: false, password_changed_at: null, last_tenant_id: null };

describe('SessionService.rotateSession (single-winner + ledger carry-over)', () => {
  it('returns null when another request already rotated (lost the claim)', async () => {
    const { svc } = svcWith([userRow, undefined]); // user row lock; conditional claim matches no row
    const result = await svc.rotateSession(10, { userId: 1 });
    expect(result).toBeNull();
  });

  // The password snapshot is copied in SQL: sessionPasswordSnapshot.db.test.ts checks it.
  it('carries the ledger and sign-in time forward and returns the new session', async () => {
    const signedInAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const snapshot = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const { svc, captured } = svcWith([
      userRow, // user row lock
      // claim won (returns what carries over)
      { active_tenant_id: 7, original_created_at: signedInAt, created_after_password_change_at: snapshot },
      { id: 99 }, // new session insert
    ]);
    const result = await svc.rotateSession(10, { userId: 1 });
    expect(result).toMatchObject({ sessionId: 99 });
    expect(typeof result!.token).toBe('string');
    const sessionInsert = captured.inserts.at(-1)!;
    expect(sessionInsert.active_tenant_id).toBe(7);
    expect(sessionInsert.rotated_from_session_id).toBe(10);
    expect(sessionInsert.original_created_at).toEqual(signedInAt);
    // The sliding expiry never passes the absolute lifetime (30 days) from sign-in.
    expect((sessionInsert.expires_at as Date).getTime()).toBeLessThanOrEqual(
      signedInAt.getTime() + 30 * 24 * 60 * 60 * 1000
    );
  });
});

describe('SessionService.validateSession (rotation grace window)', () => {
  const base = {
    id: 10,
    user_id: 1,
    expires_at: new Date(Date.now() + 60_000),
    last_rotated_at: new Date(),
    original_created_at: new Date(),
    created_after_password_change_at: null,
    password_changed_at: null,
    is_locked: false,
    login_disabled: false,
  };

  it('accepts a session revoked for rotation within the grace window', async () => {
    const { svc } = svcWith([{ ...base, is_revoked: true, revocation_reason: 'rotated', revoked_at: new Date() }]);
    const v = await svc.validateSession('tok');
    expect(v).toEqual({ sessionId: 10, userId: 1, needsRotation: false, graceRotated: true });
  });

  it('rejects a rotated session once the grace window has passed', async () => {
    const { svc } = svcWith([
      { ...base, is_revoked: true, revocation_reason: 'rotated', revoked_at: new Date(Date.now() - 5 * 60_000) },
    ]);
    expect(await svc.validateSession('tok')).toBeNull();
  });

  it('rejects a hard-revoked session (e.g. logout) immediately', async () => {
    const { svc } = svcWith([{ ...base, is_revoked: true, revocation_reason: 'logout', revoked_at: new Date() }]);
    expect(await svc.validateSession('tok')).toBeNull();
  });

  it('validates a live session and flags rotation when the token is old', async () => {
    const { svc } = svcWith([
      {
        ...base,
        is_revoked: false,
        revocation_reason: null,
        revoked_at: null,
        last_rotated_at: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago → needs rotation
      },
    ]);
    const v = await svc.validateSession('tok');
    expect(v).toMatchObject({ sessionId: 10, userId: 1, needsRotation: true });
    expect(v!.graceRotated).toBeUndefined();
  });

  const live = { is_revoked: false, revocation_reason: null, revoked_at: null };

  it('rejects and revokes a session past its absolute lifetime (30 days from sign-in)', async () => {
    const { svc, captured } = svcWith([
      { ...live, ...base, original_created_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    ]);
    expect(await svc.validateSession('tok')).toBeNull();
    expect(captured.updates.at(-1)).toMatchObject({ is_revoked: true, revocation_reason: 'absolute_lifetime_reached' });
  });

  it('rejects a session with no password snapshot once the user has changed their password (fail closed)', async () => {
    const { svc, captured } = svcWith([{ ...live, ...base, password_changed_at: new Date() }]);
    expect(await svc.validateSession('tok')).toBeNull();
    expect(captured.updates.at(-1)).toMatchObject({ is_revoked: true, revocation_reason: 'password_changed' });
  });

  it('still accepts a session created after the latest password change', async () => {
    const changedAt = new Date(Date.now() - 60_000);
    const { svc } = svcWith([
      { ...live, ...base, password_changed_at: changedAt, created_after_password_change_at: changedAt },
    ]);
    expect(await svc.validateSession('tok')).toMatchObject({ sessionId: 10, userId: 1 });
  });

  it('rejects a rotated-out cookie in its grace window once the password has changed', async () => {
    const { svc } = svcWith([
      {
        ...base,
        is_revoked: true,
        revocation_reason: 'rotated',
        revoked_at: new Date(),
        created_after_password_change_at: new Date(Date.now() - 60_000),
        password_changed_at: new Date(),
      },
    ]);
    expect(await svc.validateSession('tok')).toBeNull();
  });
});

// Every request used to write the session row. Now a request slides the
// expiry and records its activity at most once per touch interval.
describe('SessionService.validateSession (touches the row at most every few minutes)', () => {
  const live = (lastActivityMsAgo: number | null) => ({
    id: 10,
    user_id: 1,
    expires_at: new Date(Date.now() + 60 * 60_000),
    last_rotated_at: new Date(),
    original_created_at: new Date(Date.now() - 60 * 60_000),
    created_after_password_change_at: null,
    password_changed_at: null,
    is_locked: false,
    login_disabled: false,
    is_revoked: false,
    revocation_reason: null,
    revoked_at: null,
    last_activity_at: lastActivityMsAgo === null ? null : new Date(Date.now() - lastActivityMsAgo),
  });

  it('leaves a session used a moment ago alone', async () => {
    const { svc, captured } = svcWith([live(60_000)]);
    expect(await svc.validateSession('tok')).toMatchObject({ sessionId: 10, userId: 1 });
    expect(captured.updates).toEqual([]);
  });

  it('slides the expiry of a session last written five minutes or more ago', async () => {
    for (const ago of [5 * 60_000, 30 * 60_000, null]) {
      const { svc, captured } = svcWith([live(ago)]);
      expect(await svc.validateSession('tok')).toMatchObject({ sessionId: 10 });
      expect(captured.updates).toHaveLength(1);
      expect(captured.updates[0]).toHaveProperty('expires_at');
      expect((captured.updates[0].expires_at as Date).getTime()).toBeGreaterThan(Date.now() + 71 * 60 * 60_000);
    }
  });

  it('writes at once a stored expiry the absolute lifetime no longer allows', async () => {
    // Signed in 30 days less 10 minutes ago: the expiry stored an hour ago is past the cap.
    const row = { ...live(60_000), original_created_at: new Date(Date.now() - 30 * 24 * 60 * 60_000 + 10 * 60_000) };
    const { svc, captured } = svcWith([row]);
    expect(await svc.validateSession('tok')).toMatchObject({ sessionId: 10 });
    expect(captured.updates).toHaveLength(1);
    expect((captured.updates[0].expires_at as Date).getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
  });

  it('writes at least every half idle timeout, so a short one never lapses in use', async () => {
    const before = process.env.SESSION_IDLE_HOURS;
    process.env.SESSION_IDLE_HOURS = '0.05'; // 3 minutes
    try {
      expect(sessionTouchIntervalMs()).toBe(90_000);
      const { svc, captured } = svcWith([live(100_000)]);
      await svc.validateSession('tok');
      expect(captured.updates).toHaveLength(1);
    } finally {
      if (before === undefined) delete process.env.SESSION_IDLE_HOURS;
      else process.env.SESSION_IDLE_HOURS = before;
    }
    expect(sessionTouchIntervalMs()).toBe(5 * 60_000);
  });
});

describe('SessionService.createSession (last-ledger memory)', () => {
  it("seeds the new session with the user's durable last-used ledger", async () => {
    const { svc, captured } = svcWith([
      { count: 0 }, // enforceMaxSessions count (< max → no revoke path)
      { ...userRow, last_tenant_id: 5 }, // user row lock (+ remembered ledger)
      { id: 42 }, // session insert
    ]);
    const { sessionId } = await svc.createSession({ userId: 1 });
    expect(sessionId).toBe(42);
    expect(captured.inserts.at(-1)!.active_tenant_id).toBe(5);
  });

  it('defaults the active ledger to null when the user has no remembered ledger', async () => {
    const { svc, captured } = svcWith([
      { count: 0 }, // enforceMaxSessions count
      userRow, // user row lock
      { id: 43 }, // session insert
    ]);
    await svc.createSession({ userId: 1 });
    expect(captured.inserts.at(-1)!.active_tenant_id).toBeNull();
  });
});

describe('SessionService.createSession (refuses when the account changed during sign-in)', () => {
  const changedAt = new Date(Date.now() - 60_000);

  it.each([
    ['ACCOUNT_LOCKED', { ...userRow, is_locked: true }, {}],
    ['LOGIN_DISABLED', { ...userRow, login_disabled: true }, {}],
    ['PASSWORD_CHANGED', { ...userRow, password_changed_at: new Date() }, { passwordChangedAt: changedAt }],
    ['PASSWORD_CHANGED', { ...userRow, password_changed_at: new Date() }, { passwordChangedAt: null }],
  ])('refuses with %s', async (code, user, data) => {
    const { svc, captured } = svcWith([{ count: 0 }, user]);
    await expect(svc.createSession({ userId: 1, ...data })).rejects.toMatchObject({ name: 'SessionRefusedError', code });
    expect(captured.inserts).toEqual([]);
  });

  // What it records of the password change is the user's own value: sessionPasswordSnapshot.db.test.ts.
  it('creates the session when the password checked is still the current one', async () => {
    const { svc, captured } = svcWith([{ count: 0 }, { ...userRow, password_changed_at: changedAt }, { id: 44 }]);
    await expect(svc.createSession({ userId: 1, passwordChangedAt: new Date(changedAt.getTime()) })).resolves.toMatchObject({ sessionId: 44 });
    expect(captured.inserts).toHaveLength(1);
  });
});
