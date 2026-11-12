import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

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

/**
 * The deployment admin's Users page through the real app: what creating, editing
 * and deleting an account answers and stores. Locking, disabling sign-in and password
 * resets ending credentials are credential-revocation.test.ts; the password policy and
 * must_change_password, login-abuse-resistance.db.test.ts.
 */

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

const RUN = `admin-users-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = 'a passphrase for the admin users test';

describe('Deployment admin: the Users page', () => {
  let owner: Pool;
  let tenant: TestTenant;
  let server: http.Server;
  let admin: { id: number; uuid: string; token: string };
  const userIds: number[] = [];

  async function addUser(label: string) {
    const row = (
      await owner.query<{ id: number; uuid: string }>(
        `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, $2, 'Test', $3) RETURNING id, uuid`,
        [`${RUN}-${label}@test.local`, bcrypt.hashSync(PASSWORD, 4), label]
      )
    ).rows[0];
    userIds.push(row.id);
    await owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [tenant.tenantId, row.id]);
    await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, false)', [tenant.organizationId, row.id]);
    const { token, sessionId } = await sessionService.createSession({ userId: row.id });
    await owner.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenant.tenantId, sessionId]);
    return { ...row, token };
  }

  const as = (req: request.Test, token = admin.token) =>
    req.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`).set('X-CSRF-Token', csrfTokenFor(token));
  const userRow = async (id: number) =>
    (await owner.query('SELECT first_name, last_name, is_locked, login_disabled, default_color, icon, must_change_password FROM users WHERE id = $1', [id])).rows[0];
  const MISSING = '00000000-0000-7000-8000-000000000000';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= 'admin-users-test-encryption-key-0123456789abcdef';
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 4 });
    tenant = await createTestTenant('Admin users');
    admin = await addUser('admin');
    await owner.query(
      `INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`,
      [admin.id]
    );
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!owner) return;
    try {
      await owner.query('DELETE FROM deployment_users WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM organization_users WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM tenant_users WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}%`]);
      await tenant?.cleanup();
    } finally {
      await owner.end();
    }
  }, 60_000);

  describe('creating an account', () => {
    const create = (body: object) => as(request(server).post('/api/admin/users')).send(body);

    it('refuses missing fields, a bad email and a weak password, each with its code, and creates nothing', async () => {
      const email = `${RUN}-refused@test.local`;
      const missing = await create({ email });
      expect(missing.status).toBe(400);
      expect(missing.body).toMatchObject({ code: 'MISSING_FIELDS', error: 'Email, password, and first name are required' });
      // A refusal's answer carries its text as `message` too, which the clients show first.
      expect(missing.body.message).toBe('Email, password, and first name are required');

      const badEmail = await create({ email: 'not-an-email', password: PASSWORD, first_name: 'N' });
      expect(badEmail.status).toBe(400);
      expect(badEmail.body).toMatchObject({ code: 'INVALID_EMAIL', error: 'Please provide a valid email address' });

      const weak = await create({ email, password: 'short', first_name: 'N' });
      expect(weak.status).toBe(400);
      expect(weak.body.code).toBe('WEAK_PASSWORD');

      expect((await owner.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount).toBe(0);
    });

    it('creates one with a lower-cased email and trimmed names, no membership, that must change its password', async () => {
      const res = await create({ email: `${RUN}-NEW@test.local`, password: PASSWORD, first_name: ' <b>Ada</b> ', last_name: 'Lovelace ' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.message).toBe('User created successfully');
      expect(Object.keys(res.body.user).sort()).toEqual(['created_at', 'email', 'first_name', 'id', 'last_name']);
      expect(res.body.user.email).toBe(`${RUN}-new@test.local`);
      // Stored as typed, trimmed: the pages show a name as text, never as HTML, so its angle
      // brackets are no threat (sanitizeInput, which dropped them, is gone).
      expect(res.body.user.first_name).toBe('<b>Ada</b>');
      expect(res.body.user.last_name).toBe('Lovelace');
      userIds.push(res.body.user.id);

      const row = (await owner.query('SELECT must_change_password, password_changed_at IS NOT NULL AS changed FROM users WHERE id = $1', [res.body.user.id])).rows[0];
      expect(row).toEqual({ must_change_password: true, changed: true });
      // Membership takes consent: an invitation, or an admin adding them.
      const memberships = await owner.query(
        `SELECT 1 FROM tenant_users WHERE user_id = $1 UNION ALL SELECT 1 FROM organization_users WHERE user_id = $1`,
        [res.body.user.id]
      );
      expect(memberships.rowCount).toBe(0);

      const duplicate = await create({ email: `${RUN}-new@test.local`, password: PASSWORD, first_name: 'Again' });
      expect(duplicate.status).toBe(400);
      expect(duplicate.body).toMatchObject({ code: 'USER_EXISTS', error: 'User already exists with this email' });
    });
  });

  describe('editing an account', () => {
    const edit = (uuid: string, body: object) => as(request(server).put(`/api/admin/users/${uuid}`)).send(body);

    it('changes the profile fields sent, and answers the account', async () => {
      const user = await addUser('profile');
      const res = await edit(user.uuid, { first_name: 'Grace', last_name: '', default_color: '#A1B2C3', icon: 'star' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.message).toBe('User updated successfully');
      expect(res.body.user).toMatchObject({ uuid: user.uuid, first_name: 'Grace', last_name: '', default_color: '#A1B2C3', icon: 'star', is_locked: false });
      expect(Object.keys(res.body.user).sort()).toEqual(
        ['created_at', 'default_color', 'email', 'first_name', 'icon', 'id', 'is_locked', 'last_name', 'login_disabled', 'profile_image', 'uuid']
      );
    });

    it('ignores an invalid colour and string flags, and refuses an edit with nothing valid in it', async () => {
      const user = await addUser('nothing');
      const res = await edit(user.uuid, { default_color: 'red', is_locked: 'true' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'NO_FIELDS_PROVIDED', error: 'No valid fields provided for update' });
      expect(await userRow(user.id)).toMatchObject({ is_locked: false, default_color: '#3B82F6' });
    });

    it("refuses to lock or disable the admin's own account", async () => {
      const lock = await edit(admin.uuid, { is_locked: true });
      expect(lock.status).toBe(400);
      expect(lock.body).toMatchObject({ code: 'CANNOT_LOCK_OWN_ACCOUNT', error: 'Cannot lock your own account' });
      const disable = await edit(admin.uuid, { login_disabled: true });
      expect(disable.status).toBe(400);
      expect(disable.body).toMatchObject({ code: 'CANNOT_DISABLE_OWN_LOGIN', error: 'Cannot disable login on your own account' });
      expect(await userRow(admin.id)).toMatchObject({ is_locked: false, login_disabled: false });
    });

    it('locks with a profile change in the same save, and unlocks', async () => {
      // There's no deployment-wide import user to refuse to unlock any more: each ledger
      // has its own, used only while unlocked.
      const user = await addUser('import-user');
      const locked = await edit(user.uuid, { is_locked: true, first_name: 'Locked' });
      expect(locked.status, JSON.stringify(locked.body)).toBe(200);
      expect(locked.body.user).toMatchObject({ is_locked: true, first_name: 'Locked' });

      const unlocked = await edit(user.uuid, { is_locked: false });
      expect(unlocked.status).toBe(200);
      expect(unlocked.body.user.is_locked).toBe(false);
    });

    it('answers 404 USER_NOT_FOUND for a uuid no user has', async () => {
      const res = await edit(MISSING, { first_name: 'x' });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'USER_NOT_FOUND', error: 'User not found' });
    });
  });

  describe('resetting a password and deleting an account', () => {
    it('refuses a missing or weak password, each with its code', async () => {
      const user = await addUser('reset');
      const missing = await as(request(server).put(`/api/admin/users/${user.uuid}/change-password`)).send({});
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('PASSWORD_REQUIRED');
      const weak = await as(request(server).put(`/api/admin/users/${user.uuid}/change-password`)).send({ newPassword: 'short' });
      expect(weak.status).toBe(400);
      expect(weak.body.code).toBe('WEAK_PASSWORD');
      const unknown = await as(request(server).put(`/api/admin/users/${MISSING}/change-password`)).send({ newPassword: PASSWORD });
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('USER_NOT_FOUND');
    });

    it("deletes another account, and refuses the admin's own", async () => {
      const self = await as(request(server).delete(`/api/admin/users/${admin.uuid}`));
      expect(self.status).toBe(400);
      expect(self.body).toMatchObject({ code: 'CANNOT_DELETE_OWN_ACCOUNT', error: 'Cannot delete your own account' });

      const user = await addUser('deleted');
      await owner.query('DELETE FROM tenant_users WHERE user_id = $1', [user.id]);
      await owner.query('DELETE FROM organization_users WHERE user_id = $1', [user.id]);
      const res = await as(request(server).delete(`/api/admin/users/${user.uuid}`));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({
        message: 'User deleted successfully',
        deletedUser: { id: user.id, email: `${RUN}-deleted@test.local` },
      });
      expect((await owner.query('SELECT 1 FROM users WHERE id = $1', [user.id])).rowCount).toBe(0);

      const again = await as(request(server).delete(`/api/admin/users/${user.uuid}`));
      expect(again.status).toBe(404);
    });
  });

  it("lists the ledger's people for a member, and every account for a deployment admin only", async () => {
    const member = await addUser('member');
    const memberList = await as(request(server).get('/api/tenants/current/users'), member.token);
    expect(memberList.status).toBe(200);
    expect(memberList.body.map((u: { uuid: string }) => u.uuid)).toEqual(expect.arrayContaining([admin.uuid, member.uuid]));
    expect(memberList.body[0]).not.toHaveProperty('email');

    expect((await as(request(server).get('/api/admin/users'), member.token)).status).toBe(403);
    const all = await as(request(server).get('/api/admin/users'));
    expect(all.status).toBe(200);
    const mine = all.body.users.find((u: { uuid: string }) => u.uuid === admin.uuid);
    expect(mine).toMatchObject({ is_deployment_admin: true, is_locked: false });
  });
});
