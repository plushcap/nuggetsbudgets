import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// Refused requests log warnings; keep them out of the test output unless asked for.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

// Every bcrypt.compare the routes make: the password tried, and the hash it was compared
// against. A test reads only its own sign-ins' (comparesOf, with a password of its own), so a
// test that timed out, whose requests still run, can't add to another's.
const compares = vi.hoisted(() => [] as Array<{ password: string; hash: string }>);
// A test that signs in many times may hash at a lower cost than the app allows
// (BCRYPT_ROUNDS is at least 10), so a rehash at sign-in doesn't make every later compare
// slow; afterEach puts it back.
const hashCost = vi.hoisted(() => ({ override: undefined as number | undefined }));
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<{
    default: { compare: (s: string, hash: string) => Promise<boolean>; hash: (s: string, rounds: number) => Promise<string> };
  }>();
  const compare = async (s: string, hash: string) => {
    compares.push({ password: s, hash });
    return actual.default.compare(s, hash);
  };
  const hash = (s: string, rounds: number) => actual.default.hash(s, hashCost.override ?? rounds);
  return { ...actual, default: { ...actual.default, compare, hash } };
});

import crypto from 'crypto';
import http from 'http';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { getRecentSecurityEvents } from '../middleware/security-enhanced.js';
import { SESSION_COOKIE_NAME } from '../utils/session-cookie-config.js';
// The CSRF token is bound to the session.
import { csrfTokenFor } from '../utils/csrfToken.js';
import { LOGIN_DEVICE_COOKIE_NAME } from '../utils/loginDevice.js';
import { accountThrottleKey, deviceThrottleKey, LOGIN_FREE_ATTEMPTS } from '../services/LoginThrottleService.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * Password sign-in resists guessing and enumeration, and the password policy is the one
 * the pages show. Through the real app (createApp +
 * mountRoutes), as the browser uses it. The per-IP limiters are off under NODE_ENV=test;
 * login-rate-limits.db.test.ts covers them.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const CSRF_TOKEN = 'login-abuse-csrf-token';
// Both meet the old composition rules too, so a test fails without today's password policy for its own reason.
const PASSWORD = 'A household passphrase Lx4!';
const WRONG = 'Not the passphrase Lx4!';

/** A password no other sign-in sends, so a test can count the compares its own made. */
const ownPassword = (label: string) => `${label} passphrase Lx4! ${crypto.randomUUID()}`;
/** The hashes `password` was compared against, by any sign-in so far. */
const comparesOf = (password: string) => compares.filter((c) => c.password === password).map((c) => c.hash);

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

interface TestUser {
  id: number;
  uuid: string;
  email: string;
}

describeDb('Login abuse resistance and password policy', () => {
  let owner: Pool;
  let tenant: TestTenant;
  let server: http.Server;
  let adminToken: string;
  let admin: TestUser;
  const userIds: number[] = [];
  const emails: string[] = [];
  const passwordHash = bcrypt.hashSync(PASSWORD, 4);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= 'login-abuse-test-encryption-key-0123456789abcdef';
    server = await listen();
    owner = new Pool({ connectionString, max: 4 });
    tenant = await createTestTenant('Login abuse');
    admin = await addUser('admin');
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
      const created = await owner.query<{ id: number }>('SELECT id FROM users WHERE email = ANY($1)', [emails]);
      const ids = [...new Set([...userIds, ...created.rows.map((r) => r.id)])];
      await owner.query('DELETE FROM deployment_users WHERE user_id = ANY($1)', [ids]);
      await owner.query('DELETE FROM organization_users WHERE user_id = ANY($1)', [ids]);
      await owner.query('DELETE FROM tenant_users WHERE user_id = ANY($1)', [ids]);
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
      await owner.query('DELETE FROM login_throttles WHERE throttle_key = ANY($1)', [emails.map(accountThrottleKey)]);
      await tenant?.cleanup();
    } finally {
      await owner.end();
    }
  }, 60_000);

  afterEach(() => {
    for (const name of ['BCRYPT_ROUNDS', 'MIN_PASSWORD_LENGTH', 'REQUIRE_PASSWORD_COMPLEXITY', 'PASSWORD_BREACH_CHECK']) {
      delete process.env[name];
    }
    hashCost.override = undefined;
    vi.unstubAllGlobals();
  });

  async function listen(): Promise<http.Server> {
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    const s = http.createServer(app);
    await new Promise<void>((resolve) => s.listen(0, resolve));
    return s;
  }

  const newEmail = (label: string) => {
    const email = `login-abuse-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
    emails.push(email);
    return email;
  };

  /** A user with PASSWORD, a member of the test ledger. */
  async function addUser(label: string, hash = passwordHash): Promise<TestUser> {
    const email = newEmail(label);
    const row = (
      await owner.query<{ id: number; uuid: string }>(
        `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, $2, 'Test', $3) RETURNING id, uuid`,
        [email, hash, label]
      )
    ).rows[0];
    userIds.push(row.id);
    await owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [tenant.tenantId, row.id]);
    await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, false)', [
      tenant.organizationId,
      row.id,
    ]);
    await owner.query('UPDATE users SET last_tenant_id = $1 WHERE id = $2', [tenant.tenantId, row.id]);
    return { id: row.id, uuid: row.uuid, email };
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
  const asAdmin = (req: request.Test) => withCookie(req, adminToken);

  const cookieValue = (res: request.Response, name: string): string | undefined =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0]
      .slice(name.length + 1);

  const login = (email: string, password: string, cookie?: string) => {
    const req = request(server).post('/api/auth/login');
    if (cookie) req.set('Cookie', cookie);
    return req.send({ email, password });
  };

  // The first lock lasts a second, and under load the next sign-in's bcrypt can outlast it,
  // so a test that checks the lock holds extends it first. The backoff itself is checked on
  // its own (the capped delay below).
  const holdLock = (key: string) =>
    owner.query(`UPDATE login_throttles SET locked_until = now() + interval '1 hour' WHERE throttle_key = $1 AND locked_until IS NOT NULL`, [key]);

  const unlock = (email: string) =>
    owner.query(`UPDATE login_throttles SET locked_until = now() - interval '1 second' WHERE throttle_key = $1`, [
      accountThrottleKey(email),
    ]);

  describe('enumeration', () => {
    it('runs bcrypt at the configured cost for an address with no account, as for a wrong password', async () => {
      const user = await addUser('timing');
      const guessForNobody = ownPassword('timing-nobody');
      const unknown = await login(newEmail('nobody'), guessForNobody);
      expect(unknown.status).toBe(401);
      expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
      expect(comparesOf(guessForNobody)).toHaveLength(1);
      expect(comparesOf(guessForNobody)[0]).toMatch(/^\$2[aby]\$12\$/);

      const guess = ownPassword('timing');
      const wrong = await login(user.email, guess);
      expect(wrong.status).toBe(401);
      // The same answer, apart from each request's own id.
      expect({ ...wrong.body, requestId: undefined }).toEqual({ ...unknown.body, requestId: undefined });
      expect(comparesOf(guess)).toHaveLength(1);
    });

    it('says nothing about a locked account to a wrong password', async () => {
      const user = await addUser('locked');
      await owner.query('UPDATE users SET is_locked = true WHERE id = $1', [user.id]);
      const wrong = await login(user.email, WRONG);
      expect(wrong.status).toBe(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      const right = await login(user.email, PASSWORD);
      expect(right.status).toBe(401);
      expect(right.body.code).toBe('ACCOUNT_LOCKED');
    });

    it('makes a hash at another cost again at sign-in, so unknown addresses take as long as real ones', async () => {
      const user = await addUser('rehash'); // a cost-4 hash
      const before = await owner.query<{ password_changed_at: Date }>('SELECT password_changed_at FROM users WHERE id = $1', [
        user.id,
      ]);
      const res = await login(user.email, PASSWORD);
      expect(res.status).toBe(200);
      const after = await owner.query<{ password_hash: string; password_changed_at: Date }>(
        'SELECT password_hash, password_changed_at FROM users WHERE id = $1',
        [user.id]
      );
      expect(after.rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/);
      expect(await bcrypt.compare(PASSWORD, after.rows[0].password_hash)).toBe(true);
      // Not a password change: the session it signed in with still works.
      expect(after.rows[0].password_changed_at).toEqual(before.rows[0].password_changed_at);
      const session = cookieValue(res, SESSION_COOKIE_NAME)!;
      expect((await withCookie(request(server).get('/api/auth/me'), session)).status).toBe(200);
    });

    it('says nothing about a sign-in-disabled account to a wrong password', async () => {
      const user = await addUser('disabled');
      await owner.query('UPDATE users SET login_disabled = true WHERE id = $1', [user.id]);
      const wrong = await login(user.email, WRONG);
      expect(wrong.status).toBe(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      const right = await login(user.email, PASSWORD);
      expect(right.status).toBe(403);
      expect(right.body.code).toBe('LOGIN_DISABLED');
    });
  });

  // A sign-in that fails inside answers a generic 500, and its security event (which
  // /api/health/security shows) doesn't carry the error's text either.
  it("keeps an internal error's text out of a failed sign-in's answer and security event", async () => {
    const user = await addUser('internal-error');
    const secret = 'relation "sessions_secret_xyz" does not exist';
    vi.spyOn(sessionService, 'createSession').mockRejectedValueOnce(Object.assign(new Error(secret), { code: '42P01' }));
    const res = await login(user.email, PASSWORD);
    expect(res.status).toBe(500);
    // The route wrapper's answer for any failure that isn't a refusal (was LOGIN_ERROR).
    expect(res.body).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId: res.headers['x-request-id'] });
    expect(JSON.stringify(res.body)).not.toContain('sessions_secret_xyz');
    const events = getRecentSecurityEvents(100).map((event) => event.message);
    expect(events.some((message) => message.includes('Login error'))).toBe(true);
    expect(events.join('\n')).not.toContain('sessions_secret_xyz');
  });

  // The success event logged `User ${user.email} logged in successfully`.
  it("logs a sign-in by the user's id, not their address", async () => {
    const user = await addUser('signed-in-event');
    const res = await login(user.email, PASSWORD);
    expect(res.status).toBe(200);
    const events = getRecentSecurityEvents(100).filter((e) => e.type === 'authentication' && e.metadata?.event === 'success');
    expect(events[0]).toMatchObject({ userId: user.id, message: 'Authentication success: Signed in with a password' });
    const all = JSON.stringify(getRecentSecurityEvents(1000));
    expect(all).not.toContain(user.email);
    expect(all).not.toContain(user.email.split('@')[0]);
  });

  describe('per-account throttling', () => {
    it(`lets ${LOGIN_FREE_ATTEMPTS} attempts through, then backs off, the same way for an address with no account`, async () => {
      // An address with no account is compared at the configured cost: the lowest the app
      // allows, so its six guesses stay quick on a loaded machine.
      process.env.BCRYPT_ROUNDS = '10';
      const right = ownPassword('throttle');
      const user = await addUser('throttle', bcrypt.hashSync(right, 4));
      const nobody = newEmail('throttle-nobody');
      for (const [email, lastTry] of [[user.email, right], [nobody, ownPassword('throttle-nobody')]]) {
        const statuses: number[] = [];
        for (let i = 0; i <= LOGIN_FREE_ATTEMPTS; i++) statuses.push((await login(email, WRONG)).status);
        expect(statuses).toEqual(Array(LOGIN_FREE_ATTEMPTS + 1).fill(401));
        await holdLock(accountThrottleKey(email));

        // Now locked: even the right password is refused without being checked.
        const refused = await login(email, lastTry);
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('LOGIN_THROTTLED');
        expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
        expect(comparesOf(lastTry)).toHaveLength(0);
      }
    });

    it.each(['an account', 'an address with no account'])('doubles the wait with each further failure, up to 15 minutes, for %s', async (kind) => {
      // An account's wrong passwords are compared against its own (cost-4) hash, so its ten
      // sign-ins cost little. An address with no account is compared at the configured cost,
      // and ten such sign-ins timed this test out on a loaded machine: its free
      // attempts are used up in the table instead (the test above makes them by signing
      // in), and its five sign-ins here are at the lowest cost the app allows.
      let email: string;
      if (kind === 'an account') {
        email = (await addUser('backoff')).email;
        for (let i = 0; i < LOGIN_FREE_ATTEMPTS; i++) await login(email, WRONG);
      } else {
        process.env.BCRYPT_ROUNDS = '10';
        email = newEmail('backoff-nobody');
        await owner.query(
          `INSERT INTO login_throttles (throttle_key, attempts, locked_until, last_attempt_at) VALUES ($1, $2, NULL, now())`,
          [accountThrottleKey(email), LOGIN_FREE_ATTEMPTS]
        );
      }
      const waits: number[] = [];
      for (let i = 0; i < 4; i++) {
        await login(email, WRONG);
        const row = await owner.query<{ ms: number }>(
          `SELECT extract(epoch FROM locked_until - last_attempt_at) * 1000 AS ms FROM login_throttles WHERE throttle_key = $1`,
          [accountThrottleKey(email)]
        );
        waits.push(Math.round(Number(row.rows[0].ms)));
        await unlock(email);
      }
      expect(waits).toEqual([1000, 2000, 4000, 8000]);

      await owner.query(`UPDATE login_throttles SET attempts = 40 WHERE throttle_key = $1`, [accountThrottleKey(email)]);
      await login(email, WRONG);
      const capped = await owner.query<{ ms: number }>(
        `SELECT extract(epoch FROM locked_until - last_attempt_at) * 1000 AS ms FROM login_throttles WHERE throttle_key = $1`,
        [accountThrottleKey(email)]
      );
      expect(Math.round(Number(capped.rows[0].ms))).toBe(15 * 60 * 1000);
    });

    it("lets the right password through once the wait is over, refunding that attempt but not the guesses' count", async () => {
      // Its two sign-ins make the cost-4 hashes again at BCRYPT_ROUNDS: the lowest the app
      // allows, so they stay quick on a loaded machine.
      process.env.BCRYPT_ROUNDS = '10';
      const user = await addUser('expiry');
      for (let i = 0; i <= LOGIN_FREE_ATTEMPTS; i++) await login(user.email, WRONG);
      await holdLock(accountThrottleKey(user.email));
      expect((await login(user.email, PASSWORD)).status).toBe(429);
      await unlock(user.email);
      expect((await login(user.email, PASSWORD)).status).toBe(200);
      // A member signing in between someone's guesses doesn't hand the guesser free attempts.
      const left = await owner.query<{ attempts: number }>('SELECT attempts FROM login_throttles WHERE throttle_key = $1', [
        accountThrottleKey(user.email),
      ]);
      expect(left.rows).toEqual([{ attempts: LOGIN_FREE_ATTEMPTS + 1 }]);

      // Within the free attempts, a correct password leaves no lock behind.
      const typo = await addUser('typo');
      await login(typo.email, WRONG);
      expect((await login(typo.email, PASSWORD)).status).toBe(200);
      const typoRow = await owner.query('SELECT attempts, locked_until FROM login_throttles WHERE throttle_key = $1', [
        accountThrottleKey(typo.email),
      ]);
      expect(typoRow.rows).toEqual([{ attempts: 1, locked_until: null }]);
    });

    /**
     * Twenty sign-ins at once, each charged by a statement that started while all twenty
     * were in flight: an owner transaction holds the address's throttle row until every
     * one of them is waiting on it in the database, then lets them through together.
     * Resolves with their answers and how far apart the charges started (the throttle
     * reads each statement's now(), its start).
     */
    async function burst(email: string, password: string): Promise<{ results: request.Response[]; spreadMs: number }> {
      const key = accountThrottleKey(email);
      await owner.query(`INSERT INTO login_throttles (throttle_key, attempts, locked_until, last_attempt_at) VALUES ($1, 0, NULL, now())`, [
        key,
      ]);
      const gate = await owner.connect();
      let pending: Promise<request.Response[]> | undefined;
      let open = true;
      try {
        await gate.query('BEGIN');
        await gate.query('SELECT 1 FROM login_throttles WHERE throttle_key = $1 FOR UPDATE', [key]);
        const gatePid = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        // Each request is sent once its response is awaited; then() starts them all now.
        pending = Promise.all(Array.from({ length: 20 }, () => login(email, password).then((res) => res)));
        // The first waits on the gate, the others on it in turn: every backend blocked by
        // the gate, directly or behind another.
        const waiting = async () =>
          (
            await owner.query<{ n: number; spread_ms: number }>(
              `WITH RECURSIVE blocked(pid) AS (
                 SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
                 UNION
                 SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
               )
               SELECT count(*)::int AS n,
                      coalesce(extract(epoch FROM max(a.query_start) - min(a.query_start)) * 1000, 0)::float8 AS spread_ms
                 FROM blocked JOIN pg_stat_activity a USING (pid)`,
              [gatePid]
            )
          ).rows[0];
        // Under the app pool's lock_timeout (DB_LOCK_TIMEOUT_MS, 15 s), after which the first to wait would fail.
        const deadline = Date.now() + 10_000;
        let state = await waiting();
        while (state.n < 20) {
          if (Date.now() > deadline) throw new Error(`only ${state.n} of the 20 sign-ins reached the throttle in 10 s (DB_POOL_MAX below 20?)`);
          await new Promise((resolve) => setTimeout(resolve, 25));
          state = await waiting();
        }
        await gate.query('COMMIT');
        open = false;
        return { results: await pending, spreadMs: Number(state.spread_ms) };
      } finally {
        if (open) await gate.query('ROLLBACK').catch(() => undefined);
        gate.release();
        await pending?.catch(() => undefined);
      }
    }

    it('lets parallel guesses through only up to the free attempts', { timeout: 60_000 }, async () => {
      // Charged before the check, the free attempts and one more get through, and that one
      // locks the address for a second; checked after the check, all twenty would. A charge
      // that started a second or more after the locking one would rightly get through, as
      // the lock had run out by its start: the burst is tried again, on a fresh address, so
      // the count asserted is exact however slow the machine.
      for (let attempt = 1; ; attempt++) {
        const user = await addUser(`burst-${attempt}`);
        const guess = ownPassword('burst');
        const { results, spreadMs } = await burst(user.email, guess);
        if (spreadMs >= 900 && attempt < 3) continue;
        expect(spreadMs, 'the twenty charges started within the lock').toBeLessThan(900);
        const checked = results.filter((r) => r.status === 401).length;
        expect(checked).toBe(LOGIN_FREE_ATTEMPTS + 1);
        expect(comparesOf(guess)).toHaveLength(checked);
        expect(results.filter((r) => r.status === 429)).toHaveLength(20 - checked);
        return;
      }
    });

    // Twenty-one sign-ins. The first, with the right password, would make the account's
    // cost-4 hash again at BCRYPT_ROUNDS (10 at the lowest), and every later compare would
    // run at that cost: hashed at cost 4 instead (afterEach restores it), the compares stay
    // at cost 4, and the test takes well under its default 10 s on a loaded machine.
    it("doesn't keep the account's own browser out while someone else guesses", async () => {
      hashCost.override = 4;
      const user = await addUser('device');
      // The member's browser signed in before, and was given a trusted-device cookie.
      const first = await login(user.email, PASSWORD);
      expect(first.status).toBe(200);
      const device = cookieValue(first, LOGIN_DEVICE_COOKIE_NAME);
      expect(device).toBeTruthy();
      const deviceCookie = `${LOGIN_DEVICE_COOKIE_NAME}=${device}`;

      // Someone else locks the address.
      for (let i = 0; i <= LOGIN_FREE_ATTEMPTS; i++) await login(user.email, WRONG);
      await holdLock(accountThrottleKey(user.email));
      expect((await login(user.email, PASSWORD)).status).toBe(429);

      // The member's browser still signs in, and the address stays locked for everyone else.
      const member = await login(user.email, PASSWORD, deviceCookie);
      expect(member.status, JSON.stringify(member.body)).toBe(200);
      expect((await login(user.email, PASSWORD)).status).toBe(429);

      // A device cookie for one account is no use for another.
      const other = await addUser('device-other');
      for (let i = 0; i <= LOGIN_FREE_ATTEMPTS; i++) await login(other.email, WRONG);
      await holdLock(accountThrottleKey(other.email));
      expect((await login(other.email, PASSWORD, deviceCookie)).status).toBe(429);

      // Guessing from the trusted browser is throttled too, on its own key.
      const fresh = cookieValue(member, LOGIN_DEVICE_COOKIE_NAME);
      const freshCookie = `${LOGIN_DEVICE_COOKIE_NAME}=${fresh}`;
      for (let i = 0; i <= LOGIN_FREE_ATTEMPTS; i++) expect((await login(user.email, WRONG, freshCookie)).status).toBe(401);
      await holdLock(deviceThrottleKey(user.email, fresh!.split('.')[0]));
      expect((await login(user.email, PASSWORD, freshCookie)).status).toBe(429);
      // The table is shared with other test runs: drop this device's row.
      await owner.query('DELETE FROM login_throttles WHERE throttle_key = $1', [deviceThrottleKey(user.email, fresh!.split('.')[0])]);
    });
  });

  describe('the policy applies where a password is set, never at sign-in', () => {
    it('signs in with a password that meets no composition rule, and a failed sign-in says nothing about the policy', async () => {
      const user = await addUser('simple', bcrypt.hashSync('short', 4));
      const ok = await login(user.email, 'short');
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const failed = await login(user.email, 'x');
      expect(failed.status).toBe(401);
      expect(failed.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('creates a user with a passphrase, and refuses a short one with the same message the pages show', async () => {
      const email = newEmail('created');
      const short = await asAdmin(request(server).post('/api/admin/users')).send({
        email, first_name: 'New', last_name: 'User', password: 'Sh0rt!pw',
      });
      expect(short.status).toBe(400);
      expect(short.body).toEqual({
        error: 'Password must be at least 12 characters long',
        code: 'WEAK_PASSWORD',
        message: 'Password must be at least 12 characters long',
        requestId: expect.any(String),
      });

      const tooLong = await asAdmin(request(server).post('/api/admin/users')).send({
        email, first_name: 'New', last_name: 'User', password: 'word '.repeat(15),
      });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.error).toMatch(/at most 72 bytes/);

      const withEmail = await asAdmin(request(server).post('/api/admin/users')).send({
        email, first_name: 'New', last_name: 'User', password: `${email}-mine`,
      });
      expect(withEmail.status).toBe(400);
      expect(withEmail.body.error).toBe('Password must not contain your email address');

      const created = await asAdmin(request(server).post('/api/admin/users')).send({
        email, first_name: 'New', last_name: 'User', password: 'correct horse battery staple',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
    });

    it('accepts any symbol when REQUIRE_PASSWORD_COMPLEXITY=true', async () => {
      process.env.REQUIRE_PASSWORD_COMPLEXITY = 'true';
      const res = await asAdmin(request(server).post('/api/admin/users')).send({
        email: newEmail('complex'), first_name: 'New', last_name: 'User', password: 'Hash#tag-7 words',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it('hashes new passwords at BCRYPT_ROUNDS', async () => {
      process.env.BCRYPT_ROUNDS = '11';
      const email = newEmail('rounds');
      const res = await asAdmin(request(server).post('/api/admin/users')).send({
        email, first_name: 'New', last_name: 'User', password: 'Eleven rounds of hashing 1!',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const row = await owner.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = $1', [email]);
      expect(row.rows[0].password_hash).toMatch(/^\$2[aby]\$11\$/);
    });

    it('publishes the policy the server enforces', async () => {
      process.env.MIN_PASSWORD_LENGTH = '16';
      process.env.REQUIRE_PASSWORD_COMPLEXITY = 'true';
      const res = await request(server).get('/api/auth/password-policy');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ minLength: 16, maxBytes: 72, requireComplexity: true });
    });

    it('refuses a breached password when PASSWORD_BREACH_CHECK=true, and allows it when the service is down', async () => {
      process.env.PASSWORD_BREACH_CHECK = 'true';
      const password = 'breached but long enough';
      const sha1 = (await import('crypto')).createHash('sha1').update(password).digest('hex').toUpperCase();
      const fetchMock = vi.fn(async (url: string) => {
        expect(url).toBe(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`);
        return new Response(`0000000000000000000000000000000000A:0\r\n${sha1.slice(5)}:42\r\n`, { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const refused = await asAdmin(request(server).post('/api/admin/users')).send({
        email: newEmail('breached'), first_name: 'New', last_name: 'User', password,
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/data breach/);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
      const allowed = await asAdmin(request(server).post('/api/admin/users')).send({
        email: newEmail('breach-down'), first_name: 'New', last_name: 'User', password,
      });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    });

    it('answers a wrong current password with 403, which keeps the session, not 401', async () => {
      const user = await addUser('wrong-current');
      const session = await signIn(user.id);
      const res = await withCookie(request(server).put('/api/auth/change-password'), session).send({
        currentPassword: WRONG,
        newPassword: 'A brand new passphrase 1!',
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CURRENT_PASSWORD_INCORRECT');
      expect((await withCookie(request(server).get('/api/auth/me'), session)).status).toBe(200);

      // The current password is checked first: a guess at it learns nothing about the
      // policy and sets off no breach-list lookup.
      process.env.PASSWORD_BREACH_CHECK = 'true';
      const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const weak = await withCookie(request(server).put('/api/auth/change-password'), session).send({
        currentPassword: WRONG,
        newPassword: 'short',
      });
      expect(weak.status).toBe(403);
      expect(weak.body.code).toBe('CURRENT_PASSWORD_INCORRECT');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('a password an admin set is replaced at first sign-in', () => {
    it('a new account reaches only change-password until its user picks their own', async () => {
      const email = newEmail('first-login');
      const created = await asAdmin(request(server).post('/api/admin/users')).send({
        email, first_name: 'New', last_name: 'User', password: 'The admin picked this 7!',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const userId = created.body.user.id as number;
      await owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [tenant.tenantId, userId]);
      await owner.query('UPDATE users SET last_tenant_id = $1 WHERE id = $2', [tenant.tenantId, userId]);

      const first = await login(email, 'The admin picked this 7!');
      expect(first.status).toBe(200);
      expect(first.body.user.must_change_password).toBe(true);
      const session = cookieValue(first, SESSION_COOKIE_NAME)!;

      const tenantRoute = await withCookie(request(server).get('/api/categories'), session);
      expect(tenantRoute.status).toBe(403);
      expect(tenantRoute.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
      expect((await withCookie(request(server).get('/api/auth/mcp-tokens'), session)).status).toBe(403);
      const me = await withCookie(request(server).get('/api/auth/me'), session);
      expect(me.status).toBe(200);
      expect(me.body.user.must_change_password).toBe(true);
      // Signing out takes the browser's push subscription off the account first.
      const unsubscribe = await withCookie(request(server).post('/api/push/subscriptions/remove'), session).send({
        endpoint: 'https://push.example.invalid/this-browser',
      });
      expect(unsubscribe.status, JSON.stringify(unsubscribe.body)).toBe(200);

      const same = await withCookie(request(server).put('/api/auth/change-password'), session).send({
        currentPassword: 'The admin picked this 7!',
        newPassword: 'The admin picked this 7!',
      });
      expect(same.status).toBe(400);

      const changed = await withCookie(request(server).put('/api/auth/change-password'), session).send({
        currentPassword: 'The admin picked this 7!',
        newPassword: 'Now one only I know 8!',
      });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);

      const again = await login(email, 'Now one only I know 8!');
      expect(again.status).toBe(200);
      expect(again.body.user.must_change_password).toBe(false);
      const fresh = cookieValue(again, SESSION_COOKIE_NAME)!;
      expect((await withCookie(request(server).get('/api/categories'), fresh)).status).toBe(200);
    });

    it("an admin's reset of someone else's password must be replaced; of their own, not", async () => {
      const user = await addUser('reset');
      const reset = await asAdmin(request(server).put(`/api/admin/users/${user.uuid}/change-password`)).send({
        newPassword: 'Reset by the admin 9!',
      });
      expect(reset.status, JSON.stringify(reset.body)).toBe(200);
      const flags = await owner.query<{ must_change_password: boolean }>(
        'SELECT must_change_password FROM users WHERE id = $1',
        [user.id]
      );
      expect(flags.rows[0].must_change_password).toBe(true);

      const own = await asAdmin(request(server).put(`/api/admin/users/${admin.uuid}/change-password`)).send({
        newPassword: 'The admin resets their own 9!',
      });
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      const adminFlags = await owner.query<{ must_change_password: boolean }>(
        'SELECT must_change_password FROM users WHERE id = $1',
        [admin.id]
      );
      expect(adminFlags.rows[0].must_change_password).toBe(false);
      adminToken = await signIn(admin.id); // the reset ended the admin's sessions
    });
  });

  describe('TRUST_PROXY', () => {
    async function signedInFrom(trustProxy: string | undefined, forwardedFor: string) {
      if (trustProxy === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = trustProxy;
      const proxied = await listen();
      try {
        const user = await addUser('proxy');
        const res = await request(proxied)
          .post('/api/auth/login')
          .set('X-Forwarded-For', forwardedFor)
          .send({ email: user.email, password: PASSWORD });
        expect(res.status).toBe(200);
        const sessions = await request(proxied)
          .get('/api/auth/sessions')
          .set('Cookie', `${SESSION_COOKIE_NAME}=${cookieValue(res, SESSION_COOKIE_NAME)}`);
        return sessions.body.sessions[0].ipAddress as string;
      } finally {
        delete process.env.TRUST_PROXY;
        await new Promise<void>((resolve) => proxied.close(() => resolve()));
      }
    }

    it('takes the client address from as many proxies as TRUST_PROXY names', async () => {
      // Four sign-ins, each making its user's cost-4 hash again: at the lowest cost the app allows.
      process.env.BCRYPT_ROUNDS = '10';
      // The app sees the test client as the nearest proxy: X-Forwarded-For is "client, cdn".
      expect(await signedInFrom('2', '203.0.113.7, 198.51.100.2')).toBe('203.0.113.7');
      expect(await signedInFrom('true', '203.0.113.7, 198.51.100.2')).toBe('198.51.100.2');
      expect(await signedInFrom('127.0.0.1/8, ::1', '203.0.113.7')).toBe('203.0.113.7');
      expect(await signedInFrom(undefined, '203.0.113.7')).toMatch(/127\.0\.0\.1|::1/);
    });
  });
});
