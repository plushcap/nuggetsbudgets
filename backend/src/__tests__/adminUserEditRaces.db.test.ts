import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// Refused requests log warnings; keep them out of the test output unless asked for.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import http from 'http';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Pool } from 'pg';
import { sql, type Kysely } from 'kysely';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { sessionCookieName } from '../utils/session-cookie-config.js';
import { csrfTokenFor } from '../utils/csrfToken.js';
import type { DB } from '../db/schema.generated.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * The deployment admin's Users page under concurrency:
 * PUT /api/admin/users/:uuid (UserService.updateUserByAdmin → applyUserAccountFlags), the
 * admin password reset and the admin token revocation, racing a sign-in, a token mint, or
 * each other. Every one of them takes the user's row lock (withUserCredentialLock),
 * so:
 * - a credential being created while an edit locks the account or disables its sign-in
 *   either finishes first and the edit revokes it, or waits for the edit and is refused;
 * - two admins changing the same account at once run one after the other: the later
 *   write wins whole, and each credential is revoked once, by the first change that ends
 *   it (the second finds nothing left to revoke).
 *
 * The interleavings are forced, not timed: a request is held at a row lock the test owns
 * (as credential-revocation.test.ts does), or an edit is held inside its transaction, after
 * it took the user's lock and wrote the account and before it revokes (a gate on
 * sessionService.revokeAllUserSessions); the test then checks in pg_stat_activity that
 * the other request waits on it before letting go.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const OLD_PASSWORD = 'Old-Passw0rd!Kq7-races';
const PASSWORD_A = 'Admin-A-Chose-This!Kq7';
const PASSWORD_B = 'Admin-B-Chose-That!Kq7';

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

interface TestUser {
  id: number;
  uuid: string;
  email: string;
}

/**
 * Holds an edit inside its transaction at its first revocation of `userId`'s sessions:
 * after withUserCredentialLock took the user's row lock and the account was written, before
 * anything is revoked. `entered` resolves with that transaction's backend pid. Every
 * revocation (held or not) is recorded with what it revoked.
 */
const revocationGate = (() => {
  let armed: { userId: number; entered: (pid: number) => void; release: Promise<void> } | null = null;
  const calls: Array<{ userId: number; reason: string; revoked: number }> = [];
  return {
    calls,
    arm(userId: number) {
      let entered!: (pid: number) => void;
      let release!: () => void;
      const enteredP = new Promise<number>((resolve) => (entered = resolve));
      const releaseP = new Promise<void>((resolve) => (release = resolve));
      armed = { userId, entered, release: releaseP };
      return {
        entered: enteredP,
        release: () => {
          if (armed?.userId === userId) armed = null;
          release();
        },
      };
    },
    disarm() {
      armed = null;
    },
    async pass(userId: number, executor: Kysely<DB> | undefined) {
      const gate = armed;
      if (!gate || gate.userId !== userId || !executor) return;
      armed = null;
      const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(executor);
      gate.entered(rows[0].pid);
      await gate.release;
    },
  };
})();

// Generous for a loaded machine: a password reset hashes at the production cost.
describeDb('Admin user edits under concurrency', { timeout: 30_000 }, () => {
  let owner: Pool;
  let tenant: TestTenant;
  let tenantUuid: string;
  let server: http.Server;
  let adminA: string;
  let adminB: string;
  const userIds: number[] = [];
  const passwordHash = bcrypt.hashSync(OLD_PASSWORD, 4);

  beforeAll(async () => {
    // OneDriveService needs a key at construction when no Docker secret is present.
    process.env.ENCRYPTION_KEY ??= 'admin-user-edit-races-test-encryption-key-0123456789';
    const realRevoke = sessionService.revokeAllUserSessions.bind(sessionService);
    vi.spyOn(sessionService, 'revokeAllUserSessions').mockImplementation(async (userId, reason, executor) => {
      await revocationGate.pass(userId, executor);
      const revoked = await realRevoke(userId, reason, executor);
      revocationGate.calls.push({ userId, reason, revoked });
      return revoked;
    });

    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    owner = new Pool({ connectionString, max: 6 });
    tenant = await createTestTenant('Admin user edit races');
    tenantUuid = (await owner.query<{ uuid: string }>('SELECT uuid FROM tenants WHERE id = $1', [tenant.tenantId])).rows[0]
      .uuid;

    // Two deployment admins, each signed in.
    adminA = await signIn((await deploymentAdmin('admin-a')).id);
    adminB = await signIn((await deploymentAdmin('admin-b')).id);
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!owner) return;
    try {
      // Deleting the users also deletes their sessions, tokens and passkeys (ON DELETE CASCADE).
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
    revocationGate.disarm();
    revocationGate.calls.length = 0;
  });

  /** A user with a password, a member of the test ledger and of its organization. */
  async function addUser(label: string): Promise<TestUser> {
    const email = `admin-edit-races-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
    const row = (
      await owner.query<{ id: number; uuid: string }>(
        `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, $2, 'Test', $3) RETURNING id, uuid`,
        [email, passwordHash, label]
      )
    ).rows[0];
    userIds.push(row.id);
    await owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [tenant.tenantId, row.id]);
    await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, false)', [
      tenant.organizationId,
      row.id,
    ]);
    return { id: row.id, uuid: row.uuid, email };
  }

  async function deploymentAdmin(label: string): Promise<TestUser> {
    const user = await addUser(label);
    const made = await owner.query(
      `INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`,
      [user.id]
    );
    if (made.rowCount !== 1) throw new Error('No deployment row to make the admin a member of');
    return user;
  }

  async function signIn(userId: number): Promise<string> {
    const { token, sessionId } = await sessionService.createSession({ userId });
    await owner.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenant.tenantId, sessionId]);
    return token;
  }

  const withCookie = (req: request.Test, sessionToken: string) =>
    req.set('Cookie', `${sessionCookieName()}=${sessionToken}`).set('X-CSRF-Token', csrfTokenFor(sessionToken));

  const mint = (sessionToken: string) =>
    withCookie(request(server).post('/api/auth/mcp-token'), sessionToken).send({ label: 'admin-edit-race', tenantUuid });
  const login = (email: string, password = OLD_PASSWORD) => request(server).post('/api/auth/login').send({ email, password });
  const edit = (admin: string, user: TestUser, body: Record<string, unknown>) =>
    withCookie(request(server).put(`/api/admin/users/${user.uuid}`), admin).send(body);
  const resetPassword = (admin: string, user: TestUser, newPassword: string) =>
    withCookie(request(server).put(`/api/admin/users/${user.uuid}/change-password`), admin).send({ newPassword });
  const revokeTokens = (admin: string, user: TestUser) =>
    withCookie(request(server).delete(`/api/admin/users/${user.uuid}/tokens`), admin);

  const probeSession = (sessionToken: string) => withCookie(request(server).get('/api/auth/mcp-tokens'), sessionToken);
  const probeToken = (pat: string) => request(server).get('/api/categories').set('Authorization', `Bearer ${pat}`);
  const status = async (req: request.Test) => (await req).status;

  function sessionTokenFrom(res: request.Response): string | undefined {
    const name = sessionCookieName();
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
    return cookie?.split(';')[0].slice(name.length + 1) || undefined;
  }

  /** A user with two sessions and a token, all checked to work. */
  async function userWithCredentials(label: string) {
    const user = await addUser(label);
    const sessions = [await signIn(user.id), await signIn(user.id)];
    const minted = await mint(sessions[0]);
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const pat = minted.body.token as string;
    for (const s of sessions) expect(await status(probeSession(s))).toBe(200);
    expect(await status(probeToken(pat))).toBe(200);
    return { user, sessions, pat };
  }

  const account = async (userId: number) =>
    (
      await owner.query<{
        first_name: string;
        last_name: string;
        is_locked: boolean;
        login_disabled: boolean;
        must_change_password: boolean;
        password_hash: string;
      }>('SELECT first_name, last_name, is_locked, login_disabled, must_change_password, password_hash FROM users WHERE id = $1', [
        userId,
      ])
    ).rows[0];
  const undoFlags = (userId: number) =>
    owner.query('UPDATE users SET is_locked = false, login_disabled = false WHERE id = $1', [userId]);
  const liveSessions = async (userId: number) =>
    (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND NOT is_revoked', [userId]))
      .rows[0].n;
  const liveTokens = async (userId: number) =>
    (
      await owner.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM personal_access_tokens WHERE user_id = $1 AND revoked_at IS NULL',
        [userId]
      )
    ).rows[0].n;

  /** The database's clock, to the microsecond, as text (a Date would round it to the millisecond). */
  const dbNow = async () => (await owner.query<{ t: string }>('SELECT clock_timestamp()::text AS t')).rows[0].t;

  /**
   * How each of the user's sessions and tokens was revoked: its reason, and whether that
   * was before `instant` (a transaction that started before it) or after.
   */
  async function revocations(userId: number, instant: string) {
    const sessions = await owner.query<{ reason: string | null; before: boolean | null }>(
      `SELECT revocation_reason AS reason, revoked_at < $2::timestamptz AS before FROM sessions WHERE user_id = $1 ORDER BY id`,
      [userId, instant]
    );
    const tokens = await owner.query<{ reason: string | null; before: boolean | null }>(
      `SELECT revoked_reason AS reason, revoked_at < $2::timestamptz AS before FROM personal_access_tokens WHERE user_id = $1 ORDER BY id`,
      [userId, instant]
    );
    return { sessions: sessions.rows, tokens: tokens.rows };
  }

  const passkeyCount = async (userId: number) =>
    (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM passkey_credentials WHERE user_id = $1', [userId])).rows[0]
      .n;
  const addPasskey = (userId: number) =>
    owner.query(
      `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter) VALUES ($1, $2, 'public-key', 0)`,
      [userId, `admin-edit-races-${userId}-${Math.random().toString(36).slice(2)}`]
    );

  // --- Waiting on locks ---

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Hold `lockSql` (a FOR UPDATE row lock) in a transaction on a connection of its own. */
  async function holdRow(lockSql: string, params: unknown[]) {
    const client = await owner.connect();
    await client.query('BEGIN');
    await client.query(lockSql, params);
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let open = true;
    return {
      pid,
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
   * ledger is this one, checks its foreign key with FOR KEY SHARE on that row, so the insert
   * waits there: after the request's checks, holding the user's row FOR KEY SHARE.
   */
  const holdTenantRow = () => holdRow('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenant.tenantId]);

  /** Backends waiting on a lock one of `pids` holds. */
  const waitingOn = async (pids: number[]) =>
    (await owner.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) && $1::int[]', [pids]))
      .rows.map((r) => r.pid);

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
   * Wait until all of `requests` wait on a lock one of `pids` holds ('waiting'), or one of
   * them answers ('answered'): with the user's lock none can answer while `pids` hold it.
   */
  async function untilAnsweredOrWaiting(requests: Promise<unknown>[], pids: number[]): Promise<'waiting' | 'answered'> {
    let answered = false;
    const settle = () => {
      answered = true;
    };
    requests.forEach((r) => r.then(settle, settle));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (answered) return 'answered';
      if ((await waitingOn(pids)).length >= requests.length) return 'waiting';
      await sleep(20);
    }
    throw new Error('The requests neither answered nor waited');
  }

  /** The pid of the change `gate` holds, or a clear failure if it answered without revoking. */
  const heldAtRevocation = (gate: { entered: Promise<number> }, answer: Promise<request.Response>) =>
    Promise.race([
      gate.entered,
      answer.then((r): never => {
        throw new Error(`The change answered ${r.status} without revoking anything: ${JSON.stringify(r.body)}`);
      }),
    ]);

  /**
   * Start `first` and hold it inside its transaction, before it revokes anything (it holds
   * the user's row lock and has written the account); note the database's time; start
   * `second` and wait until it waits on `first`; let `first` go. `before` is that time:
   * a revocation before it is `first`'s, one after it `second`'s.
   */
  async function race(user: TestUser, first: () => request.Test, second: () => request.Test) {
    const gate = revocationGate.arm(user.id);
    try {
      const firstAnswer = first().then((r) => r);
      const firstPid = await heldAtRevocation(gate, firstAnswer);
      const before = await dbNow();
      const secondAnswer = second().then((r) => r);
      const secondWaited = (await untilAnsweredOrWaiting([secondAnswer], [firstPid])) === 'waiting';
      gate.release();
      const [a, b] = await Promise.all([firstAnswer, secondAnswer]);
      return { a, b, before, secondWaited };
    } finally {
      gate.release();
    }
  }

  const sessionRevocations = (userId: number) =>
    revocationGate.calls.filter((c) => c.userId === userId).map(({ reason, revoked }) => ({ reason, revoked }));

  // ---------------------------------------------------------------------------------------

  describe('an edit while the user signs in or mints a token', () => {
    const edits: Record<string, { body: Record<string, unknown>; locks: boolean }> = {
      'a profile edit that locks the account': {
        body: { first_name: 'Locked', last_name: 'Out', is_locked: true },
        locks: true,
      },
      'a profile edit that disables sign-in': {
        body: { first_name: 'Service', last_name: 'Account', login_disabled: true },
        locks: false,
      },
    };

    it.each(Object.keys(edits))('a sign-in held at its insert during %s gets no session that outlives it', async (name) => {
      const { body } = edits[name];
      const user = await addUser('signin-held');
      // The new session restores this ledger, so its insert waits on the held ledger row.
      await owner.query('UPDATE users SET last_tenant_id = $1 WHERE id = $2', [tenant.tenantId, user.id]);
      const hold = await holdTenantRow();
      try {
        const signingIn = login(user.email).then((r) => r);
        const signers = await untilWaitingOn([hold.pid]); // checked the account, about to insert
        const editing = edit(adminA, user, body).then((r) => r);
        // The edit waits for the sign-in's share lock on the user's row.
        expect(await untilAnsweredOrWaiting([editing], signers)).toBe('waiting');
        await hold.release();
        const [signedIn, edited] = await Promise.all([signingIn, editing]);
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);
        // The profile fields and the flag landed together.
        expect(await account(user.id)).toMatchObject({
          first_name: body.first_name,
          last_name: body.last_name,
          is_locked: body.is_locked === true,
          login_disabled: body.login_disabled === true,
        });
        await undoFlags(user.id);

        // The sign-in finished first and got a session; the edit revoked it.
        expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
        expect(await status(probeSession(sessionTokenFrom(signedIn)!))).toBe(401);
        expect(await liveSessions(user.id)).toBe(0);
      } finally {
        await hold.release();
      }
    });

    it.each(Object.keys(edits))('a token mint held at its insert during %s', async (name) => {
      const { body, locks } = edits[name];
      const user = await addUser('mint-held');
      const session = await signIn(user.id);
      const hold = await holdTenantRow();
      try {
        const minting = mint(session).then((r) => r);
        const minters = await untilWaitingOn([hold.pid]); // checked the account, about to insert
        const editing = edit(adminA, user, body).then((r) => r);
        expect(await untilAnsweredOrWaiting([editing], minters)).toBe('waiting');
        await hold.release();
        const [minted, edited] = await Promise.all([minting, editing]);
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);
        await undoFlags(user.id);

        // The mint finished first; the edit then ended what it ends.
        expect(minted.status, JSON.stringify(minted.body)).toBe(201);
        expect(await status(probeSession(session))).toBe(401);
        if (locks) {
          expect(await status(probeToken(minted.body.token))).toBe(401);
          expect(await liveTokens(user.id)).toBe(0);
        } else {
          // Disabling sign-in keeps a service account's tokens, this one too.
          expect(await status(probeToken(minted.body.token))).toBe(200);
          expect(await liveTokens(user.id)).toBe(1);
        }
      } finally {
        await hold.release();
      }
    });

    it.each(Object.keys(edits))(
      'a sign-in and a token mint that arrive while %s holds the user lock wait for it, and are refused',
      async (name) => {
        const { body, locks } = edits[name];
        const user = await addUser('arrive-during');
        const session = await signIn(user.id);
        expect(await status(probeSession(session))).toBe(200);
        const gate = revocationGate.arm(user.id);
        try {
          const editing = edit(adminA, user, body).then((r) => r);
          // The edit holds the user's row FOR UPDATE and has written the flag, not committed it.
          const editPid = await heldAtRevocation(gate, editing);
          const minting = mint(session).then((r) => r);
          const signingIn = login(user.email).then((r) => r);
          // Both read the account before the edit commits, so they pass their first checks,
          // and wait for its lock to create the credential.
          expect(await untilAnsweredOrWaiting([minting, signingIn], [editPid])).toBe('waiting');
          gate.release();
          const [edited, minted, signedIn] = await Promise.all([editing, minting, signingIn]);
          expect(edited.status, JSON.stringify(edited.body)).toBe(200);

          // Re-checked under the lock, after the edit: refused, with nothing created.
          expect(minted.status, JSON.stringify(minted.body)).toBe(401);
          expect(signedIn.body.code).toBe(locks ? 'ACCOUNT_LOCKED' : 'LOGIN_DISABLED');
          expect(signedIn.status).toBe(locks ? 401 : 403);
          expect(sessionTokenFrom(signedIn)).toBeUndefined();
          await undoFlags(user.id);
          expect(await liveSessions(user.id)).toBe(0);
          expect(await liveTokens(user.id)).toBe(0);
        } finally {
          gate.release();
        }
      }
    );
  });

  // ---------------------------------------------------------------------------------------

  describe('two deployment admins changing one account at once', () => {
    it('two locks: the later profile wins, and the credentials are revoked once, by the first', async () => {
      const { user, sessions, pat } = await userWithCredentials('lock-lock');
      const { a, b, before, secondWaited } = await race(
        user,
        () => edit(adminA, user, { first_name: 'Alpha', is_locked: true }),
        () => edit(adminB, user, { first_name: 'Bravo', is_locked: true })
      );
      expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
      expect(secondWaited).toBe(true);
      expect(await account(user.id)).toMatchObject({ first_name: 'Bravo', last_name: 'lock-lock', is_locked: true });

      expect(sessionRevocations(user.id)).toEqual([
        { reason: 'account_locked', revoked: 2 },
        { reason: 'account_locked', revoked: 0 },
      ]);
      expect(await revocations(user.id, before)).toEqual({
        sessions: [
          { reason: 'account_locked', before: true },
          { reason: 'account_locked', before: true },
        ],
        tokens: [{ reason: 'account_locked', before: true }],
      });
      await undoFlags(user.id);
      for (const s of sessions) expect(await status(probeSession(s))).toBe(401);
      expect(await status(probeToken(pat))).toBe(401);
    });

    it('a lock and an unlock: the unlock wins, and what the lock ended stays ended', async () => {
      const { user, sessions, pat } = await userWithCredentials('lock-unlock');
      const { a, b, before, secondWaited } = await race(
        user,
        () => edit(adminA, user, { first_name: 'Alpha', is_locked: true }),
        () => edit(adminB, user, { first_name: 'Bravo', is_locked: false })
      );
      expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
      expect(secondWaited).toBe(true);
      expect(await account(user.id)).toMatchObject({ first_name: 'Bravo', is_locked: false, login_disabled: false });

      // Unlocking revokes nothing, and brings nothing back.
      expect(sessionRevocations(user.id)).toEqual([{ reason: 'account_locked', revoked: 2 }]);
      expect((await revocations(user.id, before)).tokens).toEqual([{ reason: 'account_locked', before: true }]);
      for (const s of sessions) expect(await status(probeSession(s))).toBe(401);
      expect(await status(probeToken(pat))).toBe(401);
      // The account works again with a new sign-in.
      expect((await login(user.email)).status).toBe(200);
    });

    it('a lock and a password reset: both apply, and the reset finds nothing left to revoke', async () => {
      const { user, pat } = await userWithCredentials('lock-reset');
      await addPasskey(user.id);
      const { a, b, before, secondWaited } = await race(
        user,
        () => edit(adminA, user, { is_locked: true }),
        () => resetPassword(adminB, user, PASSWORD_B)
      );
      expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
      expect(secondWaited).toBe(true);
      expect(b.body).toMatchObject({ sessionsRevoked: 0, tokensRevoked: 0, passkeysRemoved: 1 });

      const after = await account(user.id);
      expect(after).toMatchObject({ is_locked: true, must_change_password: true });
      expect(await bcrypt.compare(PASSWORD_B, after.password_hash)).toBe(true);
      expect(await passkeyCount(user.id)).toBe(0);
      const changed = await owner.query<{ later: boolean }>(
        'SELECT password_changed_at > $2::timestamptz AS later FROM users WHERE id = $1',
        [user.id, before]
      );
      expect(changed.rows[0].later).toBe(true);

      expect(sessionRevocations(user.id)).toEqual([
        { reason: 'account_locked', revoked: 2 },
        { reason: 'admin_password_reset', revoked: 0 },
      ]);
      expect(await revocations(user.id, before)).toEqual({
        sessions: [
          { reason: 'account_locked', before: true },
          { reason: 'account_locked', before: true },
        ],
        tokens: [{ reason: 'account_locked', before: true }],
      });
      await undoFlags(user.id);
      expect(await status(probeToken(pat))).toBe(401);
    });

    it('two password resets: the later password wins, and the credentials are revoked once', async () => {
      const { user, sessions, pat } = await userWithCredentials('reset-reset');
      await addPasskey(user.id);
      const { a, b, before, secondWaited } = await race(
        user,
        () => resetPassword(adminA, user, PASSWORD_A),
        () => resetPassword(adminB, user, PASSWORD_B)
      );
      expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
      expect(secondWaited).toBe(true);
      expect(a.body).toMatchObject({ sessionsRevoked: 2, tokensRevoked: 1, passkeysRemoved: 1 });
      expect(b.body).toMatchObject({ sessionsRevoked: 0, tokensRevoked: 0, passkeysRemoved: 0 });

      const after = await account(user.id);
      expect(after.must_change_password).toBe(true);
      expect(await bcrypt.compare(PASSWORD_B, after.password_hash)).toBe(true);
      expect(await bcrypt.compare(PASSWORD_A, after.password_hash)).toBe(false);
      expect(await revocations(user.id, before)).toEqual({
        sessions: [
          { reason: 'admin_password_reset', before: true },
          { reason: 'admin_password_reset', before: true },
        ],
        tokens: [{ reason: 'admin_password_reset', before: true }],
      });
      for (const s of sessions) expect(await status(probeSession(s))).toBe(401);
      expect(await status(probeToken(pat))).toBe(401);

      // Only the later admin's password signs in (and must be replaced).
      expect((await login(user.email, PASSWORD_A)).status).toBe(401);
      const signedIn = await login(user.email, PASSWORD_B);
      expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
      expect(signedIn.body.user.must_change_password).toBe(true);
    });

    it('a sign-in disable and a lock: the disable ends the sessions, the lock the tokens, each once', async () => {
      const { user, sessions, pat } = await userWithCredentials('disable-lock');
      const { a, b, before, secondWaited } = await race(
        user,
        () => edit(adminA, user, { login_disabled: true }),
        () => edit(adminB, user, { is_locked: true })
      );
      expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
      expect(secondWaited).toBe(true);
      expect(await account(user.id)).toMatchObject({ is_locked: true, login_disabled: true });

      expect(sessionRevocations(user.id)).toEqual([
        { reason: 'login_disabled', revoked: 2 },
        { reason: 'account_locked', revoked: 0 },
      ]);
      expect(await revocations(user.id, before)).toEqual({
        sessions: [
          { reason: 'login_disabled', before: true },
          { reason: 'login_disabled', before: true },
        ],
        // Disabling sign-in kept the token; the lock, after it, ended it.
        tokens: [{ reason: 'account_locked', before: false }],
      });
      await undoFlags(user.id);
      for (const s of sessions) expect(await status(probeSession(s))).toBe(401);
      expect(await status(probeToken(pat))).toBe(401);
    });

    it("a lock and a revocation of the user's tokens: the revocation waits, and finds them revoked", async () => {
      const { user, pat } = await userWithCredentials('lock-revoke-tokens');
      const { a, b, before, secondWaited } = await race(
        user,
        () => edit(adminA, user, { is_locked: true }),
        () => revokeTokens(adminB, user)
      );
      expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
      // The token revocation changes no account, but it takes the user's lock all the same.
      expect(secondWaited).toBe(true);
      expect(b.body.revokedCount).toBe(0);
      expect((await revocations(user.id, before)).tokens).toEqual([{ reason: 'account_locked', before: true }]);
      await undoFlags(user.id);
      expect(await status(probeToken(pat))).toBe(401);
    });
  });
});
