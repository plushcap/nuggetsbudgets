import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import crypto from 'crypto';
import { Pool } from 'pg';
import { sessionService } from '../middleware/auth.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * A session keeps the password_changed_at it was created under, and one from before the
 * latest change is over (SessionService). The column keeps microseconds; the snapshot was
 * written through a JS Date, which keeps milliseconds, so the two compared equal only in
 * JS: in SQL, `password_changed_at <= created_after_password_change_at` refused every
 * session. Compared here in SQL.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

// A change with microseconds a Date can't hold.
const CHANGED_AT = '2026-11-04 05:00:00.123456+00';

describeDb("a session's password-change snapshot is the user's own value", () => {
  let owner: Pool;
  let tenant: TestTenant;
  let userId: number;

  beforeAll(async () => {
    owner = new Pool({ connectionString, max: 2 });
    tenant = await createTestTenant('Session password snapshot');
    userId = (
      await owner.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, first_name, last_name, password_changed_at, last_tenant_id)
         VALUES ($1, 'not-a-hash', 'Session', 'Snapshot', $2, $3) RETURNING id`,
        [`session-snapshot-${crypto.randomUUID()}@test.local`, CHANGED_AT, tenant.tenantId]
      )
    ).rows[0].id;
    await owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [tenant.tenantId, userId]);
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      if (userId) {
        await owner.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
        await owner.query('DELETE FROM tenant_users WHERE user_id = $1', [userId]);
        await owner.query('DELETE FROM users WHERE id = $1', [userId]);
      }
      await tenant?.cleanup();
    } finally {
      await owner.end();
    }
  });

  /** The session's snapshot against the user's change, in SQL. */
  const snapshot = async (sessionId: number) =>
    (
      await owner.query<{ equal: boolean; predates_change: boolean; microseconds: number }>(
        `SELECT s.created_after_password_change_at = u.password_changed_at AS equal,
                s.created_after_password_change_at < u.password_changed_at AS predates_change,
                (extract(microseconds FROM s.created_after_password_change_at)::int % 1000) AS microseconds
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
        [sessionId]
      )
    ).rows[0];

  it('is the change to the microsecond when the session is created, and when it is rotated', async () => {
    // As the sign-in passes it: password_changed_at read through pg, a Date.
    const read = await owner.query<{ password_changed_at: Date }>('SELECT password_changed_at FROM users WHERE id = $1', [userId]);
    const created = await sessionService.createSession({ userId, passwordChangedAt: read.rows[0].password_changed_at });
    expect(await snapshot(created.sessionId)).toEqual({ equal: true, predates_change: false, microseconds: 456 });
    expect(await sessionService.validateSession(created.token)).toMatchObject({ sessionId: created.sessionId, userId });

    const rotated = await sessionService.rotateSession(created.sessionId, { userId });
    expect(rotated).not.toBeNull();
    expect(await snapshot(rotated!.sessionId)).toEqual({ equal: true, predates_change: false, microseconds: 456 });
    expect(await sessionService.validateSession(rotated!.token)).toMatchObject({ sessionId: rotated!.sessionId, userId });
  });

  it('predates a later change, in SQL as in the session check', async () => {
    const { sessionId, token } = await sessionService.createSession({ userId });
    await owner.query(`UPDATE users SET password_changed_at = password_changed_at + interval '1 millisecond' WHERE id = $1`, [userId]);
    expect(await snapshot(sessionId)).toMatchObject({ equal: false, predates_change: true });
    expect(await sessionService.validateSession(token)).toBeNull();
  });
});
