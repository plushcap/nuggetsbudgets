import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// Refused requests log warnings; keep them out of the test output unless asked for.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

// A sign-in spends ~250 ms in bcrypt.compare between reading the user and creating the
// session. The race tests below hold it there (arm, wait for `entered`, act, release)
// to change the account mid-sign-in.
const bcryptGate = vi.hoisted(() => {
  let armed: { entered: () => void; release: Promise<void> } | null = null;
  return {
    arm() {
      let entered!: () => void;
      let release!: () => void;
      const enteredP = new Promise<void>((resolve) => (entered = resolve));
      const releaseP = new Promise<void>((resolve) => (release = resolve));
      armed = { entered, release: releaseP };
      return { entered: enteredP, release };
    },
    async pass() {
      const gate = armed;
      if (!gate) return;
      armed = null;
      gate.entered();
      await gate.release;
    },
  };
});
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<{ default: { compare: (s: string, hash: string) => Promise<boolean> } }>();
  const compare = async (s: string, hash: string) => {
    await bcryptGate.pass();
    return actual.default.compare(s, hash);
  };
  return { ...actual, default: { ...actual.default, compare } };
});

import http from 'http';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../utils/session-cookie-config.js';
// The CSRF token is bound to the session.
import { csrfTokenFor } from '../utils/csrfToken.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * Locking a user, disabling their sign-in, an admin password reset and a password change
 * end every credential the user holds, and sessions have an absolute
 * lifetime and a configurable idle timeout.
 *
 * Runs through the real app (createApp + mountRoutes), as the browser and the MCP server
 * do: sessions are cookies, personal access tokens (PATs) are minted by
 * POST /api/auth/mcp-token and sent as `Authorization: Bearer`. A session "works" when
 * GET /api/auth/mcp-tokens, a route any signed-in user may call, answers 200; a token
 * works when GET /api/categories, a ledger route tokens may reach, answers 200.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const CSRF_TOKEN = 'credential-revocation-csrf-token';
const OLD_PASSWORD = 'Old-Passw0rd!Zt5';
const NEW_PASSWORD = 'New-Passw0rd!Zt5';
const CHOSEN_PASSWORD = 'one I chose myself Zt5';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

interface TestUser {
  id: number;
  uuid: string;
  email: string;
  orgMemberUuid: string;
}

describeDb('Credential revocation and session lifetime', () => {
  let owner: Pool;
  let tenant: TestTenant;
  let tenantUuid: string;
  let orgUuid: string;
  let server: http.Server;
  let adminToken: string;
  const userIds: number[] = [];
  const passwordHash = bcrypt.hashSync(OLD_PASSWORD, 4);

  beforeAll(async () => {
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    owner = new Pool({ connectionString, max: 4 });
    tenant = await createTestTenant('Credential revocation');
    tenantUuid = (await owner.query<{ uuid: string }>('SELECT uuid FROM tenants WHERE id = $1', [tenant.tenantId]))
      .rows[0].uuid;
    orgUuid = (
      await owner.query<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [tenant.organizationId])
    ).rows[0].uuid;

    const admin = await addUser('admin');
    const made = await owner.query(
      `INSERT INTO deployment_users (user_id, deployment_id, role)
       SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`,
      [admin.id]
    );
    if (made.rowCount !== 1) throw new Error('No deployment row to make the admin a member of');
    adminToken = await signIn(admin.id);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!owner) return;
    try {
      // Deleting the users also deletes their sessions and tokens (ON DELETE CASCADE).
      await owner.query('DELETE FROM deployment_users WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM organization_users WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM tenant_users WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
      await tenant?.cleanup();
    } finally {
      await owner.end();
    }
  }, 60_000);

  afterEach(() => {
    delete process.env.SESSION_IDLE_HOURS;
    delete process.env.SESSION_ABSOLUTE_DAYS;
  });

  /** A user with a real password, a member of the test ledger and of its organization. */
  async function addUser(label: string): Promise<TestUser> {
    const email = `cred-revocation-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
    const row = (
      await owner.query<{ id: number; uuid: string }>(
        `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, $2, 'Test', $3)
         RETURNING id, uuid`,
        [email, passwordHash, label]
      )
    ).rows[0];
    userIds.push(row.id);
    await owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [tenant.tenantId, row.id]);
    const orgMemberUuid = (
      await owner.query<{ uuid: string }>(
        'INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, false) RETURNING uuid',
        [tenant.organizationId, row.id]
      )
    ).rows[0].uuid;
    return { id: row.id, uuid: row.uuid, email, orgMemberUuid };
  }

  async function signIn(userId: number): Promise<string> {
    const { token, sessionId } = await sessionService.createSession({ userId });
    await owner.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenant.tenantId, sessionId]);
    return token;
  }

  const withCookie = (req: request.Test, sessionToken: string) =>
    req
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}; csrf_token=${CSRF_TOKEN}`)
      .set('X-CSRF-Token', csrfTokenFor(sessionToken));

  /** Mint an MCP personal access token the way Settings → MCP Access does. */
  async function mintToken(sessionToken: string): Promise<string> {
    const res = await withCookie(request(server).post('/api/auth/mcp-token'), sessionToken).send({
      label: 'credential-revocation',
      tenantUuid,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.token as string;
  }

  const probeSession = (sessionToken: string) => withCookie(request(server).get('/api/auth/mcp-tokens'), sessionToken);
  const probeToken = (pat: string) => request(server).get('/api/categories').set('Authorization', `Bearer ${pat}`);
  const status = async (req: request.Test) => (await req).status;

  const asAdmin = (req: request.Test) => withCookie(req, adminToken);

  /** The session cookie a response sets, if any. */
  const sessionCookieFrom = (res: request.Response): string | undefined =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  const sessionTokenFrom = (res: request.Response): string | undefined =>
    sessionCookieFrom(res)?.split(';')[0].slice(SESSION_COOKIE_NAME.length + 1) || undefined;

  /**
   * Sign in with the new password: the new session and a new token work. When an admin set
   * it, the user replaces it first and signs in with their own.
   */
  async function expectFreshSignInWorks(email: string) {
    let login = await request(server).post('/api/auth/login').send({ email, password: NEW_PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    if (login.body.user.must_change_password) {
      const changed = await withCookie(request(server).put('/api/auth/change-password'), sessionTokenFrom(login)!).send({
        currentPassword: NEW_PASSWORD,
        newPassword: CHOSEN_PASSWORD,
      });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      login = await request(server).post('/api/auth/login').send({ email, password: CHOSEN_PASSWORD });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      expect(login.body.user.must_change_password).toBe(false);
    }
    const session = sessionTokenFrom(login);
    expect(session).toBeTruthy();
    expect(await status(probeSession(session!))).toBe(200);
    expect(await status(probeToken(await mintToken(session!)))).toBe(200);
  }

  /** A passkey row for `userId` (its key is never used here). */
  const addPasskey = (userId: number) =>
    owner.query(
      `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter) VALUES ($1, $2, 'public-key', 0)`,
      [userId, `revocation-test-${userId}-${Math.random().toString(36).slice(2)}`]
    );
  const passkeyCount = async (userId: number) =>
    Number((await owner.query('SELECT count(*)::int AS n FROM passkey_credentials WHERE user_id = $1', [userId])).rows[0].n);

  /** A user with two sessions and a token, all checked to work. */
  async function userWithCredentials(label: string) {
    const user = await addUser(label);
    const sessionA = await signIn(user.id);
    const sessionB = await signIn(user.id);
    const pat = await mintToken(sessionA);
    expect(await status(probeSession(sessionA))).toBe(200);
    expect(await status(probeSession(sessionB))).toBe(200);
    expect(await status(probeToken(pat))).toBe(200);
    return { user, sessionA, sessionB, pat };
  }

  describe('revoking every credential', () => {
    it('locking a user on the Users page ends their sessions and tokens, and unlocking brings none back', async () => {
      const { user, sessionA, sessionB, pat } = await userWithCredentials('lock-admin');
      // A cookie retired by rotation a moment ago (valid for a minute so in-flight requests finish).
      const retired = await signIn(user.id);
      const retiredId = (
        await owner.query<{ id: number }>('SELECT id FROM sessions WHERE session_token_hash = $1', [
          sessionService.hashSessionToken(retired),
        ])
      ).rows[0].id;
      expect(await sessionService.rotateSession(retiredId, { userId: user.id })).not.toBeNull();
      expect(await status(probeSession(retired))).toBe(200);

      const locked = await asAdmin(request(server).put(`/api/admin/users/${user.uuid}`)).send({ is_locked: true });
      expect(locked.status, JSON.stringify(locked.body)).toBe(200);

      expect(await status(probeToken(pat))).toBe(401);
      expect(await status(probeSession(sessionA))).toBe(401);

      const unlocked = await asAdmin(request(server).put(`/api/admin/users/${user.uuid}`)).send({ is_locked: false });
      expect(unlocked.status, JSON.stringify(unlocked.body)).toBe(200);

      expect(await status(probeSession(sessionA))).toBe(401);
      expect(await status(probeSession(sessionB))).toBe(401);
      expect(await status(probeSession(retired))).toBe(401);
      expect(await status(probeToken(pat))).toBe(401);
    });

    it('locking a member from the organization member list ends their tokens too', async () => {
      const { user, sessionA, pat } = await userWithCredentials('lock-org');

      const locked = await asAdmin(
        request(server).patch(`/api/organizations/${orgUuid}/members/${user.orgMemberUuid}/flags`)
      ).send({ isLocked: true });
      expect(locked.status, JSON.stringify(locked.body)).toBe(200);
      expect(await status(probeToken(pat))).toBe(401);

      const unlocked = await asAdmin(
        request(server).patch(`/api/organizations/${orgUuid}/members/${user.orgMemberUuid}/flags`)
      ).send({ isLocked: false });
      expect(unlocked.status, JSON.stringify(unlocked.body)).toBe(200);
      expect(await status(probeToken(pat))).toBe(401);
      expect(await status(probeSession(sessionA))).toBe(401);
    });

    it('disabling sign-in on the Users page ends sessions but keeps a service account’s tokens', async () => {
      const { user, sessionA, sessionB, pat } = await userWithCredentials('service-account');
      const res = await asAdmin(request(server).put(`/api/admin/users/${user.uuid}`)).send({ login_disabled: true });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await status(probeSession(sessionA))).toBe(401);
      expect(await status(probeSession(sessionB))).toBe(401);
      // A service account works through its tokens.
      expect(await status(probeToken(pat))).toBe(200);
      const tokens = await asAdmin(request(server).get(`/api/admin/users/${user.uuid}/tokens`));
      expect(tokens.body).toHaveLength(1);

      // Locking it ends the tokens too.
      const locked = await asAdmin(request(server).put(`/api/admin/users/${user.uuid}`)).send({ is_locked: true });
      expect(locked.status, JSON.stringify(locked.body)).toBe(200);
      await owner.query('UPDATE users SET is_locked = false WHERE id = $1', [user.id]);
      expect(await status(probeToken(pat))).toBe(401);
    });

    it('disabling sign-in from the organization member list ends sessions but keeps tokens', async () => {
      const { user, sessionA, pat } = await userWithCredentials('disable-org');
      const res = await asAdmin(
        request(server).patch(`/api/organizations/${orgUuid}/members/${user.orgMemberUuid}/flags`)
      ).send({ loginDisabled: true });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await status(probeSession(sessionA))).toBe(401);
      expect(await status(probeToken(pat))).toBe(200);

      // Locking and disabling together is a lock: the tokens go too.
      const both = await asAdmin(
        request(server).patch(`/api/organizations/${orgUuid}/members/${user.orgMemberUuid}/flags`)
      ).send({ isLocked: true, loginDisabled: true });
      expect(both.status, JSON.stringify(both.body)).toBe(200);
      await owner.query('UPDATE users SET is_locked = false WHERE id = $1', [user.id]);
      expect(await status(probeToken(pat))).toBe(401);
    });

    it('an admin password reset ends sessions, tokens and passkeys, and records the change', async () => {
      const { user, sessionA, sessionB, pat } = await userWithCredentials('admin-reset');
      // The passkeys go with them: one someone else enrolled would keep
      // them signing in after the reset meant to lock them out.
      await addPasskey(user.id);
      await addPasskey(user.id);

      const res = await asAdmin(request(server).put(`/api/admin/users/${user.uuid}/change-password`)).send({
        newPassword: NEW_PASSWORD,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.passkeysRemoved).toBe(2);
      expect(await passkeyCount(user.id)).toBe(0);

      expect(await status(probeSession(sessionA))).toBe(401);
      expect(await status(probeSession(sessionB))).toBe(401);
      expect(await status(probeToken(pat))).toBe(401);
      const changed = await owner.query('SELECT password_changed_at FROM users WHERE id = $1', [user.id]);
      expect(changed.rows[0].password_changed_at).not.toBeNull();

      // The admin's own session is untouched, and the user signs in with the new password.
      expect(await status(probeSession(adminToken))).toBe(200);
      await expectFreshSignInWorks(user.email);
    });

    it('changing your own password ends your sessions, a rotated-out cookie and your tokens', async () => {
      const { user, sessionA, sessionB, pat } = await userWithCredentials('self-change');
      // A cookie retired by rotation stays valid for a minute so in-flight requests finish.
      const sessionC = await signIn(user.id);
      const sessionCId = (
        await owner.query<{ id: number }>(
          'SELECT id FROM sessions WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
          [user.id]
        )
      ).rows[0].id;
      expect(await sessionService.rotateSession(sessionCId, { userId: user.id })).not.toBeNull();
      expect(await status(probeSession(sessionC))).toBe(200);

      // Passkeys stay unless the user asks for them to go.
      await addPasskey(user.id);

      const res = await withCookie(request(server).put('/api/auth/change-password'), sessionA).send({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.passkeysRemoved).toBe(0);
      expect(await passkeyCount(user.id)).toBe(1);

      expect(await status(probeSession(sessionB))).toBe(401);
      expect(await status(probeSession(sessionC))).toBe(401);
      expect(await status(probeToken(pat))).toBe(401);
      // No session stays alive here: the response asks the user to sign in again.
      expect(await status(probeSession(sessionA))).toBe(401);
      await expectFreshSignInWorks(user.email);
    });

    it('changing your own password removes your passkeys too when you ask', async () => {
      const user = await addUser('self-change-passkeys');
      const session = await signIn(user.id);
      await addPasskey(user.id);
      await addPasskey(user.id);

      const odd = await withCookie(request(server).put('/api/auth/change-password'), session).send({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        removePasskeys: 'yes',
      });
      expect(odd.status).toBe(400);
      expect(odd.body.code).toBe('INVALID_REMOVE_PASSKEYS');
      expect(await passkeyCount(user.id)).toBe(2);

      const res = await withCookie(request(server).put('/api/auth/change-password'), session).send({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        removePasskeys: true,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.passkeysRemoved).toBe(2);
      expect(await passkeyCount(user.id)).toBe(0);
    });

    it('refuses a token of a locked account even when the token was never revoked', async () => {
      const { user, pat } = await userWithCredentials('locked-bearer');
      await owner.query('UPDATE users SET is_locked = true WHERE id = $1', [user.id]);
      const res = await probeToken(pat);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('ACCOUNT_LOCKED');

      // A service account (sign-in disabled, not locked) keeps using its tokens by design.
      await owner.query('UPDATE users SET is_locked = false, login_disabled = true WHERE id = $1', [user.id]);
      expect(await status(probeToken(pat))).toBe(200);
    });

    it('refuses a session from before the first password change (fail closed on a missing snapshot)', async () => {
      const user = await addUser('null-snapshot');
      // An account with no recorded password change (the column is nullable), so the
      // session's snapshot of it is NULL too.
      await owner.query('UPDATE users SET password_changed_at = NULL WHERE id = $1', [user.id]);
      const session = await signIn(user.id);
      const snapshot = await owner.query(
        'SELECT created_after_password_change_at FROM sessions WHERE session_token_hash = $1',
        [sessionService.hashSessionToken(session)]
      );
      expect(snapshot.rows[0].created_after_password_change_at).toBeNull();
      expect(await status(probeSession(session))).toBe(200);
      await owner.query('UPDATE users SET password_changed_at = NOW() WHERE id = $1', [user.id]);
      expect(await status(probeSession(session))).toBe(401);
      // A session signed in after the change keeps working, through rotation too.
      const fresh = await signIn(user.id);
      expect(await status(probeSession(fresh))).toBe(200);
      await owner.query(`UPDATE sessions SET last_rotated_at = NOW() - interval '2 hours' WHERE session_token_hash = $1`, [
        sessionService.hashSessionToken(fresh),
      ]);
      const rotated = await probeSession(fresh);
      expect(rotated.status).toBe(200);
      expect(await status(probeSession(sessionTokenFrom(rotated)!))).toBe(200);
    });

    it('lets a deployment admin list and revoke another user’s tokens', async () => {
      const { user, pat } = await userWithCredentials('admin-tokens');
      const patUuid = (
        await owner.query<{ uuid: string }>('SELECT uuid FROM personal_access_tokens WHERE user_id = $1', [user.id])
      ).rows[0].uuid;

      const list = await asAdmin(request(server).get(`/api/admin/users/${user.uuid}/tokens`));
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.map((t: { uuid: string }) => t.uuid)).toEqual([patUuid]);
      expect(JSON.stringify(list.body)).not.toContain(pat); // metadata only, never the token

      const revoke = await asAdmin(request(server).delete(`/api/admin/users/${user.uuid}/tokens`));
      expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
      expect(revoke.body.revokedCount).toBe(1);
      expect(await status(probeToken(pat))).toBe(401);

      const after = await asAdmin(request(server).get(`/api/admin/users/${user.uuid}/tokens`));
      expect(after.body).toEqual([]);

      const missing = await asAdmin(request(server).get('/api/admin/users/00000000-0000-0000-0000-000000000000/tokens'));
      expect(missing.status).toBe(404);
    });
  });

  describe('session lifetime', () => {
    const sessionRow = async (sessionToken: string) => {
      const hash = sessionService.hashSessionToken(sessionToken);
      return (
        await owner.query<{ id: number; expires_at: Date; original_created_at: Date }>(
          'SELECT id, expires_at, original_created_at FROM sessions WHERE session_token_hash = $1',
          [hash]
        )
      ).rows[0];
    };

    it('refuses a session past its absolute lifetime even while it is in use', async () => {
      const user = await addUser('absolute');
      const session = await signIn(user.id);
      await owner.query(
        `UPDATE sessions SET original_created_at = NOW() - interval '31 days', last_rotated_at = NOW()
          WHERE session_token_hash = $1`,
        [sessionService.hashSessionToken(session)]
      );
      expect(await status(probeSession(session))).toBe(401);
    });

    it('does not slide a session past its absolute lifetime', async () => {
      const user = await addUser('absolute-cap');
      const session = await signIn(user.id);
      await owner.query(
        `UPDATE sessions SET original_created_at = NOW() - interval '30 days' + interval '1 hour'
          WHERE session_token_hash = $1`,
        [sessionService.hashSessionToken(session)]
      );
      expect(await status(probeSession(session))).toBe(200);
      const row = await sessionRow(session);
      expect(row.expires_at.getTime()).toBeLessThanOrEqual(row.original_created_at.getTime() + 30 * DAY_MS + 1000);
      expect(row.expires_at.getTime()).toBeLessThan(Date.now() + 2 * HOUR_MS);
    });

    it('takes the absolute lifetime from SESSION_ABSOLUTE_DAYS', async () => {
      const user = await addUser('absolute-env');
      const session = await signIn(user.id);
      await owner.query(
        `UPDATE sessions SET original_created_at = NOW() - interval '3 days' WHERE session_token_hash = $1`,
        [sessionService.hashSessionToken(session)]
      );
      expect(await status(probeSession(session))).toBe(200);
      process.env.SESSION_ABSOLUTE_DAYS = '2';
      expect(await status(probeSession(session))).toBe(401);
    });

    it('carries the original sign-in time through rotation', async () => {
      const user = await addUser('rotation');
      const session = await signIn(user.id);
      await owner.query(
        `UPDATE sessions SET original_created_at = NOW() - interval '10 days', last_rotated_at = NOW() - interval '2 hours'
          WHERE session_token_hash = $1`,
        [sessionService.hashSessionToken(session)]
      );
      const before = await sessionRow(session);

      const res = await probeSession(session);
      expect(res.status).toBe(200);
      const rotatedToken = sessionTokenFrom(res);
      expect(rotatedToken).toBeTruthy();
      expect(rotatedToken).not.toBe(session);

      const after = await sessionRow(rotatedToken!);
      expect(after.id).not.toBe(before.id);
      expect(after.original_created_at.getTime()).toBe(before.original_created_at.getTime());
      // The replacement works, and still ends at the original sign-in's absolute lifetime.
      expect(await status(probeSession(rotatedToken!))).toBe(200);
      await owner.query(`UPDATE sessions SET original_created_at = NOW() - interval '31 days' WHERE id = $1`, [after.id]);
      expect(await status(probeSession(rotatedToken!))).toBe(401);
    });

    it('takes the idle timeout from SESSION_IDLE_HOURS, for the session and its cookie', async () => {
      process.env.SESSION_IDLE_HOURS = '2';
      const user = await addUser('idle');
      const session = await signIn(user.id);
      const res = await probeSession(session);
      expect(res.status).toBe(200);
      const row = await sessionRow(session);
      expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 1.9 * HOUR_MS);
      expect(row.expires_at.getTime()).toBeLessThan(Date.now() + 2.1 * HOUR_MS);
      expect(sessionCookieFrom(res)).toMatch(/Max-Age=7200;/);
    });

    it('signing in ends the session the browser already carried', async () => {
      // A shared family computer: one member's session cookie is still in the browser.
      const previous = await addUser('previous-signin');
      const previousSession = await signIn(previous.id);
      expect(await status(probeSession(previousSession))).toBe(200);

      const next = await addUser('next-signin');
      const login = await request(server)
        .post('/api/auth/login')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${previousSession}`)
        .send({ email: next.email, password: OLD_PASSWORD });
      expect(login.status, JSON.stringify(login.body)).toBe(200);

      expect(await status(probeSession(previousSession))).toBe(401);
      expect(await status(probeSession(sessionTokenFrom(login)!))).toBe(200);
    });
  });

  /**
   * A credential created while the account changes must not outlive the change:
   * a token mint, a session rotation or a sign-in that passed its checks before
   * a lock, disable or password change and inserts after the revocation ran. Each test
   * holds a row lock from the test's own connection so the request stops in that window,
   * makes the change, then lets the request finish.
   */
  describe('a change landing while a credential is being created', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const hashOf = (sessionToken: string) => sessionService.hashSessionToken(sessionToken);

    /** Hold `sql` (a FOR UPDATE row lock) in a transaction on its own connection. */
    async function holdRow(lockSql: string, params: unknown[]) {
      const client = await owner.connect();
      await client.query('BEGIN');
      await client.query(lockSql, params);
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let open = true;
      return {
        pid,
        query: (text: string, values: unknown[]) => client.query(text, values),
        async release() {
          if (!open) return;
          open = false;
          try {
            await client.query('COMMIT');
          } finally {
            client.release();
          }
        },
      };
    }

    /**
     * Hold the test ledger's `tenants` row. Inserting a token, or a session whose active
     * ledger is this one, checks its foreign key with FOR KEY SHARE on that row, so the
     * insert waits: the request is held after its checks and before its insert.
     */
    const holdTenantRow = () => holdRow('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenant.tenantId]);

    /** Backends waiting on a lock that one of `pids` holds. */
    const waitingOn = async (pids: number[]) =>
      (
        await owner.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) && $1::int[]',
          [pids]
        )
      ).rows.map((r) => r.pid);

    async function untilWaitingOn(pids: number[]): Promise<number[]> {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const waiting = await waitingOn(pids);
        if (waiting.length > 0) return waiting;
        await sleep(20);
      }
      throw new Error(`No request waited on ${pids.join(', ')}`);
    }

    /**
     * Wait until the change has finished (without the user lock it doesn't wait for the
     * held request) or waits on a lock the held request holds (with it, it does).
     */
    async function untilFinishedOrWaitingOn(change: Promise<unknown>, pids: number[]): Promise<void> {
      let finished = false;
      const settle = () => {
        finished = true;
      };
      change.then(settle, settle);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (finished || (await waitingOn(pids)).length > 0) return;
        await sleep(20);
      }
      throw new Error('The change neither finished nor waited for the held request');
    }

    const liveTokens = async (userId: number) =>
      (
        await owner.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM personal_access_tokens WHERE user_id = $1 AND revoked_at IS NULL',
          [userId]
        )
      ).rows[0].n;
    const liveSessions = async (userId: number) =>
      (
        await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND NOT is_revoked', [
          userId,
        ])
      ).rows[0].n;
    const undoChange = (userId: number) =>
      owner.query('UPDATE users SET is_locked = false, login_disabled = false WHERE id = $1', [userId]);

    const changes: Record<string, (user: TestUser, otherSession: string) => request.Test> = {
      'an admin password reset': (user) =>
        asAdmin(request(server).put(`/api/admin/users/${user.uuid}/change-password`)).send({ newPassword: NEW_PASSWORD }),
      'a lock': (user) => asAdmin(request(server).put(`/api/admin/users/${user.uuid}`)).send({ is_locked: true }),
      'their own password change': (_user, otherSession) =>
        withCookie(request(server).put('/api/auth/change-password'), otherSession).send({
          currentPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
    };

    it.each(Object.keys(changes))('A: a token minted during %s does not outlive it', async (change) => {
      const user = await addUser('mint-race');
      const mintingSession = await signIn(user.id);
      const otherSession = await signIn(user.id);
      const hold = await holdTenantRow();
      try {
        const minting = withCookie(request(server).post('/api/auth/mcp-token'), mintingSession)
          .send({ label: 'race', tenantUuid })
          .then((r) => r);
        const minters = await untilWaitingOn([hold.pid]); // checked, about to insert
        const changing = changes[change](user, otherSession).then((r) => r);
        await untilFinishedOrWaitingOn(changing, minters);
        await hold.release();
        const [minted, changed] = await Promise.all([minting, changing]);
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
        await undoChange(user.id);

        if (minted.status === 201) expect(await status(probeToken(minted.body.token))).toBe(401);
        expect(await liveTokens(user.id)).toBe(0);
      } finally {
        await hold.release();
      }
    });

    it('A: a token mint that reaches the user lock after a revocation took it is refused', async () => {
      const user = await addUser('mint-after');
      const session = await signIn(user.id);
      // Stand in for a revocation holding the user's row lock.
      const revocation = await holdRow('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      try {
        const minting = withCookie(request(server).post('/api/auth/mcp-token'), session)
          .send({ label: 'race', tenantUuid })
          .then((r) => r);
        await untilWaitingOn([revocation.pid]);
        await revocation.query(
          `UPDATE sessions SET is_revoked = true, revoked_at = NOW(), revocation_reason = 'password_changed' WHERE user_id = $1`,
          [user.id]
        );
        await revocation.release();
        const minted = await minting;

        if (minted.status === 201) expect(await status(probeToken(minted.body.token))).toBe(401);
        expect(minted.status, JSON.stringify(minted.body)).toBe(401);
        expect(await liveTokens(user.id)).toBe(0);
      } finally {
        await revocation.release();
      }
    });

    it('B: a sign-in with the old password that an admin reset overtakes gets no working session', async () => {
      const user = await addUser('signin-reset');
      const gate = bcryptGate.arm();
      const signingIn = request(server)
        .post('/api/auth/login')
        .send({ email: user.email, password: OLD_PASSWORD })
        .then((r) => r);
      await gate.entered; // the old password is being checked
      const reset = await asAdmin(request(server).put(`/api/admin/users/${user.uuid}/change-password`)).send({
        newPassword: NEW_PASSWORD,
      });
      expect(reset.status, JSON.stringify(reset.body)).toBe(200);
      gate.release();
      const signedIn = await signingIn;

      const session = sessionTokenFrom(signedIn);
      if (session) expect(await status(probeSession(session))).toBe(401);
      expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(401);
      expect(await liveSessions(user.id)).toBe(0);
    });

    it("B': a password change an admin reset overtakes doesn't replace the admin's password", async () => {
      const user = await addUser('change-reset');
      const session = await signIn(user.id);
      const gate = bcryptGate.arm();
      const changing = withCookie(request(server).put('/api/auth/change-password'), session)
        .send({ currentPassword: OLD_PASSWORD, newPassword: 'Someone-Elses-Passw0rd!' })
        .then((r) => r);
      await gate.entered; // the old password is being checked
      const reset = await asAdmin(request(server).put(`/api/admin/users/${user.uuid}/change-password`)).send({
        newPassword: NEW_PASSWORD,
      });
      expect(reset.status, JSON.stringify(reset.body)).toBe(200);
      gate.release();
      const changed = await changing;

      expect(changed.status, JSON.stringify(changed.body)).toBe(401);
      await expectFreshSignInWorks(user.email); // the admin's password still works
      const other = await request(server).post('/api/auth/login').send({ email: user.email, password: 'Someone-Elses-Passw0rd!' });
      expect(other.status).toBe(401);
    });

    it.each([
      ['a lock', { is_locked: true }],
      ['a sign-in disable', { login_disabled: true }],
    ])('C: a session rotating during %s does not come back when it is undone', async (_change, body) => {
      const user = await addUser('rotate-race');
      const session = await signIn(user.id); // its active ledger is the test ledger
      await owner.query(`UPDATE sessions SET last_rotated_at = NOW() - interval '2 hours' WHERE session_token_hash = $1`, [
        hashOf(session),
      ]);
      const hold = await holdTenantRow();
      try {
        const rotating = probeSession(session).then((r) => r);
        const rotators = await untilWaitingOn([hold.pid]); // old session claimed, replacement about to insert
        const changing = asAdmin(request(server).put(`/api/admin/users/${user.uuid}`))
          .send(body)
          .then((r) => r);
        await untilFinishedOrWaitingOn(changing, rotators);
        await hold.release();
        const [rotated, changed] = await Promise.all([rotating, changing]);
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
        await undoChange(user.id);

        const replacement = sessionTokenFrom(rotated);
        if (replacement) expect(await status(probeSession(replacement))).toBe(401);
        expect(await status(probeSession(session))).toBe(401);
        expect(await liveSessions(user.id)).toBe(0);
      } finally {
        await hold.release();
      }
    });

    it('C: a rotation that reaches the user lock after a revocation took it mints no replacement', async () => {
      const user = await addUser('rotate-after');
      const session = await signIn(user.id);
      await owner.query(`UPDATE sessions SET last_rotated_at = NOW() - interval '2 hours' WHERE session_token_hash = $1`, [
        hashOf(session),
      ]);
      const revocation = await holdRow('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      try {
        const rotating = probeSession(session).then((r) => r);
        await untilWaitingOn([revocation.pid]);
        await revocation.query(
          `UPDATE sessions SET is_revoked = true, revoked_at = NOW(), revocation_reason = 'password_changed' WHERE user_id = $1`,
          [user.id]
        );
        await revocation.release();
        const rotated = await rotating;

        const replacement = sessionTokenFrom(rotated);
        if (replacement && replacement !== session) expect(await status(probeSession(replacement))).toBe(401);
        expect(await liveSessions(user.id)).toBe(0);
      } finally {
        await revocation.release();
      }
    });

    it('D: a sign-in that a lock overtakes gets no session that works after the unlock', async () => {
      const user = await addUser('signin-lock');
      const gate = bcryptGate.arm();
      const signingIn = request(server)
        .post('/api/auth/login')
        .send({ email: user.email, password: OLD_PASSWORD })
        .then((r) => r);
      await gate.entered; // past the is_locked check, checking the password
      const locked = await asAdmin(request(server).put(`/api/admin/users/${user.uuid}`)).send({ is_locked: true });
      expect(locked.status, JSON.stringify(locked.body)).toBe(200);
      gate.release();
      const signedIn = await signingIn;
      await undoChange(user.id);

      const session = sessionTokenFrom(signedIn);
      if (session) expect(await status(probeSession(session))).toBe(401);
      expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(401);
      expect(await liveSessions(user.id)).toBe(0);
    });

    it('D: a sign-in inserting its session while a lock runs gets no session that works after the unlock', async () => {
      const user = await addUser('signin-insert-lock');
      // The new session restores this ledger, so its insert waits on the held ledger row.
      await owner.query('UPDATE users SET last_tenant_id = $1 WHERE id = $2', [tenant.tenantId, user.id]);
      const hold = await holdTenantRow();
      try {
        const signingIn = request(server)
          .post('/api/auth/login')
          .send({ email: user.email, password: OLD_PASSWORD })
          .then((r) => r);
        const signers = await untilWaitingOn([hold.pid]);
        const locking = asAdmin(request(server).put(`/api/admin/users/${user.uuid}`))
          .send({ is_locked: true })
          .then((r) => r);
        await untilFinishedOrWaitingOn(locking, signers);
        await hold.release();
        const [signedIn, locked] = await Promise.all([signingIn, locking]);
        expect(locked.status, JSON.stringify(locked.body)).toBe(200);
        await undoChange(user.id);

        const session = sessionTokenFrom(signedIn);
        if (session) expect(await status(probeSession(session))).toBe(401);
        expect(await liveSessions(user.id)).toBe(0);
      } finally {
        await hold.release();
      }
    });
  });
});
