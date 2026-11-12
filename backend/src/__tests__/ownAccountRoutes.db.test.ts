import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// Refused requests log warnings; keep them out of the test output unless asked for.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import http from 'http';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../utils/session-cookie-config.js';
import { csrfTokenFor } from '../utils/csrfToken.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { png } from '../test/imageFixtures.js';
import { answerProblem, authMeResponseSchema, passkeyDeletedResponseSchema } from '@nuggets/shared';
import { resolveWebAuthnConfig } from '../utils/webauthnConfig.js';

/**
 * What a person's own account routes answer (/api/auth, /api/passkeys), through the real
 * app: the ones the other auth suites don't pin. Switching the active ledger, the profile
 * and its picture, signing out when ending the session fails, revoking one's own MCP token,
 * and renaming and removing one's own passkey. Sign-in, sessions, tokens and passkey
 * ceremonies are auth-sessions, login-abuse-resistance, personal-access-tokens and
 * passkey-ceremonies.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const PASSWORD = 'Own account passphrase Hv2!';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MISSING_UUID = '00000000-0000-7000-8000-000000000000';

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

interface TestUser {
  id: number;
  uuid: string;
  email: string;
}

describeDb("A person's own account through its routes", () => {
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
    previousRounds = process.env.BCRYPT_ROUNDS;
    process.env.BCRYPT_ROUNDS = '10';
    passwordHash = bcrypt.hashSync(PASSWORD, 10);
    process.env.ENCRYPTION_KEY ??= 'own-account-routes-test-encryption-key-0123456789';
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    owner = new Pool({ connectionString, max: 2 });
    a = await createTestTenant('Own account A');
    b = await createTestTenant('Own account B');
    const uuidOf = async (id: number) =>
      (await owner.query<{ uuid: string }>('SELECT uuid FROM tenants WHERE id = $1', [id])).rows[0].uuid;
    aUuid = await uuidOf(a.tenantId);
    bUuid = await uuidOf(b.tenantId);
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (previousRounds === undefined) delete process.env.BCRYPT_ROUNDS;
    else process.env.BCRYPT_ROUNDS = previousRounds;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!owner) return;
    try {
      // Their sessions, tokens, passkeys and pictures go with them (ON DELETE CASCADE).
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
  async function addUser(label: string, opts: { both?: boolean; deploymentAdmin?: boolean } = {}): Promise<TestUser> {
    const email = `own-account-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
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
    if (opts.deploymentAdmin) {
      await owner.query(
        `INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`,
        [row.id]
      );
    }
    return { id: row.id, uuid: row.uuid, email };
  }

  const setCookies = (res: request.Response): string[] => ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const sessionCookieFrom = (res: request.Response) => setCookies(res).filter((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)).at(-1);

  /** Sign in through POST /api/auth/login; the session token its cookie carries. */
  async function login(user: TestUser): Promise<string> {
    const res = await request(server).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const token = sessionCookieFrom(res)?.split(';')[0].slice(SESSION_COOKIE_NAME.length + 1);
    expect(token).toBeTruthy();
    return token!;
  }

  const withCookie = (req: request.Test, sessionToken: string) =>
    req
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}; csrf_token=${csrfTokenFor(sessionToken)}`)
      .set('X-CSRF-Token', csrfTokenFor(sessionToken));
  const as = (sessionToken: string) => ({
    get: (path: string) => withCookie(request(server).get(path), sessionToken),
    post: (path: string) => withCookie(request(server).post(path), sessionToken),
    put: (path: string) => withCookie(request(server).put(path), sessionToken),
    delete: (path: string) => withCookie(request(server).delete(path), sessionToken),
  });
  const one = async <T extends object>(query: string, params: unknown[]): Promise<T | undefined> =>
    (await owner.query<T>(query, params)).rows[0];

  async function addPasskey(user: TestUser, label: string): Promise<string> {
    const credentialId = `own-account-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await owner.query(
      `INSERT INTO passkey_credentials (user_id, credential_id, public_key, device_name) VALUES ($1, $2, 'x', $3)`,
      [user.id, credentialId, `${label} key`]
    );
    return credentialId;
  }
  const deviceNameOf = async (credentialId: string) =>
    (await one<{ device_name: string | null }>('SELECT device_name FROM passkey_credentials WHERE credential_id = $1', [credentialId]))
      ?.device_name;

  // As refusalAnswers.test.ts pins each refusal class: `{ ...details, error, code, message,
  // requestId }`, through the real middleware (these routes' refusals are AuthError,
  // PasskeyError and UserError, thrown and answered by the route wrapper).
  it("answers its refusals in the one error shape, the request's id included", async () => {
    const user = await addUser('refusal-shape');
    const session = await login(user);
    const answer = (res: request.Response) => {
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
      const { requestId: _requestId, ...body } = res.body as Record<string, unknown>;
      return { status: res.status, body };
    };
    expect(answer(await as(session).delete(`/api/auth/mcp-tokens/${MISSING_UUID}`))).toEqual({
      status: 404,
      body: { error: 'Token not found', code: 'TOKEN_NOT_FOUND', message: 'Token not found' },
    });
    // Checked by its shared schema: validateBody's answer, keeping the code it had.
    expect(answer(await as(session).put('/api/auth/change-password').send({ currentPassword: 'x' }))).toEqual({
      status: 400,
      body: {
        error: 'Validation failed',
        code: 'BAD_REQUEST',
        message: 'Current password and new password are required',
        details: [{ field: 'newPassword', message: 'Current password and new password are required' }],
      },
    });
    expect(answer(await as(session).put('/api/auth/change-password').send({ currentPassword: 'Wrong one Hv2!', newPassword: 'x' }))).toEqual({
      status: 403,
      body: { error: 'Current password is incorrect', code: 'CURRENT_PASSWORD_INCORRECT', message: 'Current password is incorrect' },
    });
    expect(answer(await as(session).delete('/api/passkeys/no-such-passkey'))).toEqual({
      status: 404,
      body: { error: 'Passkey not found', code: 'PASSKEY_NOT_FOUND', message: 'Passkey not found' },
    });
  });

  describe('GET /api/auth/me', () => {
    it('answers the account and its ledgers exactly as the shared schema names them', async () => {
      const user = await addUser('me', { both: true });
      const session = await login(user);
      const res = await as(session).get('/api/auth/me');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(answerProblem(authMeResponseSchema, res.body)).toBeNull();
      const me = authMeResponseSchema.parse(res.body);
      expect(me.user).toMatchObject({ id: user.id, email: user.email, must_change_password: false });
      expect(me.membership.tenants.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('POST /api/auth/active-tenant', () => {
    it('answers the ledger switched to, and remembers it as the one last used', async () => {
      const user = await addUser('switch', { both: true });
      const session = await login(user);
      const org = await one<{ uuid: string; name: string }>('SELECT uuid, name FROM organizations WHERE id = $1', [b.organizationId]);
      const tenantRow = await one<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [b.tenantId]);

      const res = await as(session).post('/api/auth/active-tenant').send({ tenantUuid: bUuid });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({
        activeTenant: { uuid: bUuid, name: tenantRow!.name, organizationUuid: org!.uuid, organizationName: org!.name },
      });
      expect(await one('SELECT last_tenant_id FROM users WHERE id = $1', [user.id])).toEqual({ last_tenant_id: b.tenantId });
      expect(
        await one('SELECT active_tenant_id FROM sessions WHERE session_token_hash = $1', [sessionService.hashSessionToken(session)])
      ).toEqual({ active_tenant_id: b.tenantId });
    });

    it('refuses a ledger nobody has, one the user may not open, and no ledger, changing nothing', async () => {
      const user = await addUser('switch-refused');
      const session = await login(user);

      const missing = await as(session).post('/api/auth/active-tenant').send({ tenantUuid: MISSING_UUID });
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ error: 'Tenant not found', code: 'TENANT_NOT_FOUND' });

      const forbidden = await as(session).post('/api/auth/active-tenant').send({ tenantUuid: bUuid });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body).toMatchObject({ error: 'No access to this tenant', code: 'TENANT_FORBIDDEN' });

      const none = await as(session).post('/api/auth/active-tenant').send({});
      expect(none.status).toBe(400);
      expect(none.body.code).toBe('VALIDATION_ERROR');

      expect(await one('SELECT last_tenant_id FROM users WHERE id = $1', [user.id])).toEqual({ last_tenant_id: a.tenantId });
    });
  });

  describe('PUT /api/auth/profile', () => {
    it('updates the names, colour and icon, and answers the account', async () => {
      const user = await addUser('profile');
      const session = await login(user);
      const res = await as(session)
        .put('/api/auth/profile')
        .send({ first_name: 'Robin', last_name: 'Profile', default_color: '#12AB34', icon: 'star' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({
        id: user.id,
        uuid: user.uuid,
        email: user.email,
        first_name: 'Robin',
        last_name: 'Profile',
        default_color: '#12AB34',
        icon: 'star',
        profile_image: null,
        created_at: expect.any(String),
      });
      // A field left out stays as it was.
      const again = await as(session).put('/api/auth/profile').send({ icon: 'moon' });
      expect(again.body).toMatchObject({ first_name: 'Robin', last_name: 'Profile', default_color: '#12AB34', icon: 'moon' });
    });

    // No schema checked the fields: a colour longer than the column's 7 characters, or a
    // name past 100, reached the UPDATE and failed with a 500.
    it('refuses a field longer than its column with a 400 naming it, and changes nothing', async () => {
      const user = await addUser('profile-refused');
      const session = await login(user);
      for (const [field, value] of [
        ['default_color', '#12AB34FF'],
        ['first_name', 'x'.repeat(101)],
        ['icon', 'i'.repeat(101)],
        ['remove_profile_image', 'yes'],
      ] as const) {
        const res = await as(session).put('/api/auth/profile').send({ [field]: value });
        expect({ field, status: res.status, code: res.body.code, at: res.body.details?.[0]?.field }).toEqual({
          field, status: 400, code: 'VALIDATION_ERROR', at: field,
        });
      }
      expect(await one('SELECT first_name, default_color, icon FROM users WHERE id = $1', [user.id])).toEqual({
        first_name: 'Test', default_color: '#3B82F6', icon: 'User',
      });
    });

    it('stores an uploaded picture, and removes it when asked', async () => {
      const user = await addUser('picture');
      const session = await login(user);
      const uploaded = await as(session)
        .put('/api/auth/profile')
        .field('first_name', 'Pictured')
        .attach('profile_image', png(), { filename: 'me.png', contentType: 'image/png' });
      expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
      const picture = await one<{ uuid: string }>('SELECT uuid FROM user_profile_images WHERE user_id = $1', [user.id]);
      expect(picture?.uuid).toMatch(UUID);
      expect(uploaded.body.profile_image).toBe(`/api/images/${picture!.uuid}`);
      expect(uploaded.body.first_name).toBe('Pictured');

      const removed = await as(session).put('/api/auth/profile').field('remove_profile_image', 'true');
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(removed.body.profile_image).toBeNull();
      expect(await one('SELECT uuid FROM user_profile_images WHERE user_id = $1', [user.id])).toBeUndefined();
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears the session cookie even when ending the session fails, and answers 500 without the error', async () => {
      const user = await addUser('logout-fails');
      const session = await login(user);
      vi.spyOn(sessionService, 'revokeSessionByToken').mockRejectedValueOnce(new Error('relation "logout_secret_xyz" does not exist'));
      const res = await as(session).post('/api/auth/logout');
      expect(res.status).toBe(500);
      // The route wrapper's answer (was LOGOUT_ERROR).
      expect(res.body).toMatchObject({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      expect(JSON.stringify(res.body)).not.toContain('logout_secret_xyz');
      // The cookie is cleared: set empty and expired.
      const cleared = sessionCookieFrom(res);
      expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=;`));
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it('ends the session and clears its cookie', async () => {
      const user = await addUser('logout');
      const session = await login(user);
      const res = await as(session).post('/api/auth/logout');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Logged out successfully' });
      expect(sessionCookieFrom(res)).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=;`));
      expect((await as(session).get('/api/auth/me')).status).toBe(401);
    });
  });

  describe('DELETE /api/auth/mcp-tokens/:uuid', () => {
    it("revokes the caller's own token once; another user's is not found and keeps working", async () => {
      const user = await addUser('token-owner');
      const other = await addUser('token-other');
      const session = await login(user);
      const otherSession = await login(other);
      const mint = async (sessionToken: string) => {
        const res = await as(sessionToken).post('/api/auth/mcp-token').send({ tenantUuid: aUuid, label: 'own-account' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body as { uuid: string; token: string };
      };
      const mine = await mint(session);
      const theirs = await mint(otherSession);

      const refused = await as(session).delete(`/api/auth/mcp-tokens/${theirs.uuid}`);
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
      const theirsStill = await request(server).get('/api/accounts').set('Authorization', `Bearer ${theirs.token}`);
      expect(theirsStill.status).toBe(200);

      const revoked = await as(session).delete(`/api/auth/mcp-tokens/${mine.uuid}`);
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      expect(revoked.body).toEqual({ message: 'Token revoked', uuid: mine.uuid });
      expect((await request(server).get('/api/accounts').set('Authorization', `Bearer ${mine.token}`)).status).toBe(401);

      const again = await as(session).delete(`/api/auth/mcp-tokens/${mine.uuid}`);
      expect(again.status).toBe(404);
      expect(again.body.code).toBe('TOKEN_NOT_FOUND');
      expect((await as(session).delete(`/api/auth/mcp-tokens/${MISSING_UUID}`)).status).toBe(404);
    });
  });

  describe("a person's own passkeys", () => {
    it("lists, renames and removes one's own passkey; another user's is not found and stays", async () => {
      const user = await addUser('passkey-owner');
      const other = await addUser('passkey-other');
      const session = await login(user);
      const mine = await addPasskey(user, 'mine');
      const theirs = await addPasskey(other, 'theirs');

      const listed = await as(session).get('/api/passkeys');
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([
        {
          id: mine,
          deviceName: 'mine key',
          backedUp: false,
          createdAt: expect.any(String),
          discoverable: null,
        },
      ]);

      const renamed = await as(session).put(`/api/passkeys/${mine}`).send({ deviceName: 'Work laptop' });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      expect(renamed.body).toEqual({ success: true, message: 'Device name updated' });
      expect(await deviceNameOf(mine)).toBe('Work laptop');

      const renameTheirs = await as(session).put(`/api/passkeys/${theirs}`).send({ deviceName: 'Hijacked' });
      expect(renameTheirs.status).toBe(404);
      expect(renameTheirs.body).toMatchObject({ error: 'Passkey not found', code: 'PASSKEY_NOT_FOUND' });
      const removeTheirs = await as(session).delete(`/api/passkeys/${theirs}`);
      expect(removeTheirs.status).toBe(404);
      expect(removeTheirs.body.code).toBe('PASSKEY_NOT_FOUND');
      expect(await deviceNameOf(theirs)).toBe('theirs key');

      const removed = await as(session).delete(`/api/passkeys/${mine}`);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      // The relying party, for the page to tell the browser this passkey is gone.
      expect(removed.body).toEqual({ success: true, message: 'Passkey deleted', rpId: resolveWebAuthnConfig().rpID });
      expect(answerProblem(passkeyDeletedResponseSchema, removed.body)).toBeNull();
      expect(await deviceNameOf(mine)).toBeUndefined();
      expect((await as(session).delete(`/api/passkeys/${mine}`)).status).toBe(404);
    });

    it('refuses a rename without a device name, or with one longer than the column takes', async () => {
      const user = await addUser('passkey-unnamed');
      const session = await login(user);
      const mine = await addPasskey(user, 'unnamed');
      // validateBody's refusal (a missing name was MISSING_DEVICE_NAME, a blank one was
      // stored, and one over 255 characters was a database error, a 500).
      for (const body of [{}, { deviceName: '' }, { deviceName: '   ' }, { deviceName: 7 }, { deviceName: 'x'.repeat(256) }]) {
        const res = await as(session).put(`/api/passkeys/${mine}`).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
      expect(await deviceNameOf(mine)).toBe('unnamed key');
      // Trimmed, up to 255 characters.
      expect((await as(session).put(`/api/passkeys/${mine}`).send({ deviceName: ` ${'y'.repeat(255)} ` })).status).toBe(200);
      expect(await deviceNameOf(mine)).toBe('y'.repeat(255));
    });

    // Postgres can't take a NUL byte in text, so an id holding one reached the query
    // and failed it (a 500). It names no passkey: 404, before any query.
    it('answers 404 for a credential id holding a NUL byte', async () => {
      const user = await addUser('passkey-nul');
      const session = await login(user);
      const mine = await addPasskey(user, 'nul');
      const renamed = await as(session).put(`/api/passkeys/${mine}%00`).send({ deviceName: 'Renamed' });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(404);
      expect(renamed.body).toMatchObject({ error: 'Passkey not found', code: 'PASSKEY_NOT_FOUND' });
      const removed = await as(session).delete(`/api/passkeys/${mine}%00`);
      expect(removed.status, JSON.stringify(removed.body)).toBe(404);
      expect(removed.body.code).toBe('PASSKEY_NOT_FOUND');
      expect(await deviceNameOf(mine)).toBe('nul key');
    });
  });

  // By design: beside the rest of a user's admin page, behind requireDeploymentAdmin.
  describe("a deployment admin's view of a user's passkeys (/api/admin/users/:uuid/passkeys)", () => {
    it('lists and removes the named passkey of the named user, for a deployment admin only', async () => {
      const admin = await addUser('passkey-admin', { deploymentAdmin: true });
      const member = await addUser('passkey-member');
      const user = await addUser('passkey-user');
      const other = await addUser('passkey-elsewhere');
      const lost = await addPasskey(user, 'lost');
      const theirs = await addPasskey(other, 'elsewhere');
      const adminSession = await login(admin);
      const memberSession = await login(member);

      const listed = await as(adminSession).get(`/api/admin/users/${user.uuid}/passkeys`);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(listed.body).toEqual([
        { id: lost, deviceName: 'lost key', backedUp: false, createdAt: expect.any(String), discoverable: null },
      ]);

      // Not a deployment admin: refused at the mount, before anything is read or removed.
      for (const res of [
        await as(memberSession).get(`/api/admin/users/${user.uuid}/passkeys`),
        await as(memberSession).delete(`/api/admin/users/${user.uuid}/passkeys/${lost}`),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('DEPLOYMENT_ADMIN_REQUIRED');
      }
      expect(await deviceNameOf(lost)).toBe('lost key');

      // Another user's passkey, named under this user, is not found and stays.
      const elsewhere = await as(adminSession).delete(`/api/admin/users/${user.uuid}/passkeys/${theirs}`);
      expect(elsewhere.status).toBe(404);
      expect(elsewhere.body.code).toBe('PASSKEY_NOT_FOUND');
      expect(await deviceNameOf(theirs)).toBe('elsewhere key');

      const unknownUser = await as(adminSession).get(`/api/admin/users/${MISSING_UUID}/passkeys`);
      expect(unknownUser.status).toBe(404);
      expect(unknownUser.body.code).toBe('USER_NOT_FOUND');
      expect((await as(adminSession).get('/api/admin/users/not-a-uuid/passkeys')).status).toBe(404);

      // A NUL byte names no passkey: 404 before any query, even for a uuid no user has.
      for (const uuid of [user.uuid, MISSING_UUID]) {
        const nul = await as(adminSession).delete(`/api/admin/users/${uuid}/passkeys/${lost}%00`);
        expect(nul.status, JSON.stringify(nul.body)).toBe(404);
        expect(nul.body.code).toBe('PASSKEY_NOT_FOUND');
      }

      const removed = await as(adminSession).delete(`/api/admin/users/${user.uuid}/passkeys/${lost}`);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(removed.body).toEqual({ success: true, message: 'Passkey deleted' });
      expect(await deviceNameOf(lost)).toBeUndefined();
      expect((await as(adminSession).get(`/api/admin/users/${user.uuid}/passkeys`)).body).toEqual([]);
    });

    it('no longer answers at /api/passkeys/admin/…', async () => {
      const admin = await addUser('passkey-old-paths', { deploymentAdmin: true });
      const user = await addUser('passkey-old-paths-user');
      const kept = await addPasskey(user, 'kept');
      const adminSession = await login(admin);
      for (const res of [
        await as(adminSession).get(`/api/passkeys/admin/user/${user.uuid}`),
        await as(adminSession).delete(`/api/passkeys/admin/user/${user.uuid}/${kept}`),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
      }
      expect(await deviceNameOf(kept)).toBe('kept key');
    });
  });
});
