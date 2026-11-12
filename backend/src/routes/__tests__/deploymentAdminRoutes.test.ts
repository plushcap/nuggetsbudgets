import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import {
  adminUserListResponseSchema,
  answerProblem,
  deploymentAdminChangedResponseSchema,
  memberDtoSchema,
  organizationDetailSchema,
  organizationListResponseSchema,
  userDeletedResponseSchema,
} from '@nuggets/shared';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';

/**
 * The deployment admin's console through the real app: the user list,
 * granting and revoking deployment admin, deleting a user, and the organization list,
 * creation and status. The users and organizations tables are deployment-wide, so these
 * assert on the rows this file made, never on counts of everything.
 *
 * Elsewhere: the Users page's create, edit, password reset, self-delete refusal and lists
 * (adminUsers.db.test.ts), creating users and resetting passwords (login-abuse-resistance.db.test.ts),
 * locking and disabling sign-in and its credential revocation (credential-revocation.test.ts),
 * a deployment-admin toggle without its flag (mcp-client-hardening.db.test.ts), and that
 * everyone below a deployment admin is refused (route-authorization.test.ts).
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('Deployment admin routes', () => {
  let h: RouteHarness;
  let a: TestTenant;
  let admin: { id: number; uuid: string; session: string };
  const orgIds: number[] = [];

  const isDeploymentAdmin = async (userId: number) =>
    ((await h.owner.query(`SELECT 1 FROM deployment_users WHERE user_id = $1 AND role = 'admin'`, [userId])).rowCount ?? 0) > 0;

  beforeAll(async () => {
    h = await startRouteHarness('Deployment admin');
    a = await createTestTenant('Deployment admin A');
    const u = await h.addUser('admin');
    await h.makeDeploymentAdmin(u.id);
    admin = { id: u.id, uuid: u.uuid, session: await h.signIn(u.id) };
  }, 60_000);

  afterAll(async () => {
    const settled = await Promise.allSettled([
      (async () => {
        if (orgIds.length === 0) return;
        await h.owner.query('DELETE FROM organization_users WHERE organization_id = ANY($1)', [orgIds]);
        await h.owner.query('DELETE FROM organizations WHERE id = ANY($1)', [orgIds]);
      })(),
      a?.cleanup(),
    ]);
    await h?.close();
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, 60_000);

  it('lists users without a password hash, flagging only the deployment admins', async () => {
    const plain = await h.addUser('listed');
    const res = await h.call(admin.session, 'get', '/api/admin/users');
    expect(res.status, res.text).toBe(200);
    expect(answerProblem(adminUserListResponseSchema, res.body)).toBeNull();
    const users = res.body.users as Array<Record<string, unknown>>;
    expect(users.find((u) => u.id === plain.id)).toMatchObject({ uuid: plain.uuid, is_deployment_admin: false });
    for (const u of users) expect(u).not.toHaveProperty('password_hash');
  });

  it('grants and revokes deployment admin, but never lets an admin demote themself', async () => {
    const target = await h.addUser('promoted');
    const grant = await h.call(admin.session, 'patch', `/api/admin/users/${target.uuid}/deployment-admin`, { is_deployment_admin: true });
    expect(grant.status, grant.text).toBe(200);
    expect(answerProblem(deploymentAdminChangedResponseSchema, grant.body)).toBeNull();
    expect(await isDeploymentAdmin(target.id)).toBe(true);
    // Granting again changes nothing.
    expect((await h.call(admin.session, 'patch', `/api/admin/users/${target.uuid}/deployment-admin`, { is_deployment_admin: true })).status).toBe(200);
    expect((await h.owner.query('SELECT 1 FROM deployment_users WHERE user_id = $1', [target.id])).rowCount).toBe(1);

    const revoke = await h.call(admin.session, 'patch', `/api/admin/users/${target.uuid}/deployment-admin`, { is_deployment_admin: false });
    expect(revoke.status, revoke.text).toBe(200);
    expect(await isDeploymentAdmin(target.id)).toBe(false);

    const self = await h.call(admin.session, 'patch', `/api/admin/users/${admin.uuid}/deployment-admin`, { is_deployment_admin: false });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('CANNOT_DEMOTE_SELF');
    expect(await isDeploymentAdmin(admin.id)).toBe(true);

    const unknown = await h.call(admin.session, 'patch', '/api/admin/users/00000000-0000-7000-8000-000000000000/deployment-admin', { is_deployment_admin: true });
    expect(unknown.status).toBe(404);
  });

  it("deletes another user with their sessions and memberships, keeping the ledger's rows", async () => {
    const leaving = await h.addUser('deleted');
    await h.owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [a.tenantId, leaving.id]);
    const leavingSession = await h.signIn(leaving.id, a.tenantId);
    const account = (
      await a.pool.query<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Joint', 'checking', 'cash', 'Asset') RETURNING id`)
    ).rows[0].id;
    const txn = (
      await a.pool.query<{ id: number }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, assigned_to) VALUES ($1, -5.00, '2026-10-01', 'expense', $2) RETURNING id`,
        [account, leaving.id]
      )
    ).rows[0].id;
    // A bystander's membership stays.
    const bystander = await h.addUser('bystander');
    await h.owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [a.tenantId, bystander.id]);

    expect((await h.call(leavingSession, 'get', '/api/tenants/current')).status).toBe(200);
    const res = await h.call(admin.session, 'delete', `/api/admin/users/${leaving.uuid}`);
    expect(res.status, res.text).toBe(200);
    expect(answerProblem(userDeletedResponseSchema, res.body)).toBeNull();
    expect(res.body.deletedUser).toEqual({ id: leaving.id, email: leaving.email });

    expect((await h.owner.query('SELECT 1 FROM users WHERE id = $1', [leaving.id])).rowCount).toBe(0);
    expect((await h.owner.query('SELECT 1 FROM sessions WHERE user_id = $1', [leaving.id])).rowCount).toBe(0);
    expect((await h.call(leavingSession, 'get', '/api/tenants/current')).status).toBe(401);
    const members = await h.owner.query<{ user_id: number }>('SELECT user_id FROM tenant_users WHERE tenant_id = $1 ORDER BY user_id', [a.tenantId]);
    expect(members.rows.map((r) => r.user_id)).toEqual([a.userId, bystander.id].sort((x, y) => x - y));
    // Their transaction stays in the ledger, assigned to nobody.
    expect((await a.pool.query('SELECT assigned_to FROM transactions WHERE id = $1', [txn])).rows).toEqual([{ assigned_to: null }]);
  });

  // Deleting a user removed their memberships with them, so an organization or ledger they
  // were the only admin of was left with none; removing or demoting a member refuses that
  // (LAST_ADMIN), and now so does this.
  describe('deleting the only admin of an organization or ledger', () => {
    const one = async <T,>(text: string, params: unknown[]) => (await h.owner.query(text, params)).rows[0] as T;
    const exists = async (userId: number) => ((await h.owner.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount ?? 0) > 0;
    const newOrg = async (label: string, status = 'active') => {
      const org = await one<{ id: number; uuid: string; name: string }>(
        'INSERT INTO organizations (name, status) VALUES ($1, $2) RETURNING id, uuid, name',
        [`${label} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`, status]
      );
      orgIds.push(org.id);
      return org;
    };

    it('refuses, naming them, until someone else is an admin of each', async () => {
      const sole = await h.addUser('sole-admin');
      const other = await h.addUser('other-member');
      const org = await newOrg('Only admin org');
      await h.owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true), ($1, $3, false)', [
        org.id,
        sole.id,
        other.id,
      ]);
      // A deleted organization needs no admin.
      const gone = await newOrg('Deleted org', 'deleted');
      await h.owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true)', [gone.id, sole.id]);
      // Ledger A's only admin (its own user is a plain member).
      await h.owner.query('INSERT INTO tenant_users (tenant_id, user_id, is_admin) VALUES ($1, $2, true)', [a.tenantId, sole.id]);
      const tenant = await one<{ uuid: string; name: string }>('SELECT uuid, name FROM tenants WHERE id = $1', [a.tenantId]);

      const refused = await h.call(admin.session, 'delete', `/api/admin/users/${sole.uuid}`);
      expect(refused.status, refused.text).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'LAST_ADMIN',
        organizations: [{ uuid: org.uuid, name: org.name }],
        tenants: [{ uuid: tenant.uuid, name: tenant.name }],
      });
      expect(refused.body.error).toBe(
        `This user is the only admin of the organization "${org.name}" and of the tenant "${tenant.name}". Make someone else an admin of each first.`
      );
      expect(await exists(sole.id)).toBe(true);

      // Another admin of the organization: the ledger is still theirs alone.
      await h.owner.query('UPDATE organization_users SET is_admin = true WHERE organization_id = $1 AND user_id = $2', [org.id, other.id]);
      const tenantOnly = await h.call(admin.session, 'delete', `/api/admin/users/${sole.uuid}`);
      expect(tenantOnly.status, tenantOnly.text).toBe(409);
      expect(tenantOnly.body).toMatchObject({ code: 'LAST_ADMIN', organizations: [], tenants: [{ uuid: tenant.uuid }] });

      await h.owner.query('UPDATE tenant_users SET is_admin = true WHERE tenant_id = $1 AND user_id = $2', [a.tenantId, a.userId]);
      const deleted = await h.call(admin.session, 'delete', `/api/admin/users/${sole.uuid}`);
      expect(deleted.status, deleted.text).toBe(200);
      expect(await exists(sole.id)).toBe(false);
      const admins = await h.owner.query('SELECT user_id FROM organization_users WHERE organization_id = $1 AND is_admin', [org.id]);
      expect(admins.rows).toEqual([{ user_id: other.id }]);
    });

    // Two deletes at once, of an organization's two admins: each would see the other as the
    // admin who stays. The first is held after its check (on the session row its delete
    // removes) while the second runs, so they overlap exactly there.
    it('lets only one of two deletes of its last two admins through', async () => {
      const first = await h.addUser('first-admin');
      const second = await h.addUser('second-admin');
      const org = await newOrg('Two admins org');
      await h.owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true), ($1, $3, true)', [
        org.id,
        first.id,
        second.id,
      ]);
      await h.signIn(first.id);

      const holder = await h.owner.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM sessions WHERE user_id = $1 FOR UPDATE', [first.id]);
        const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const blockedBy = async (pid: number) =>
          (await h.owner.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map(
            (r) => r.pid
          );

        const deleteFirst = h.call(admin.session, 'delete', `/api/admin/users/${first.uuid}`).then((r) => r);
        // Past its check, deleting the user, waiting on their session row.
        const [firstPid] = await vi.waitFor(async () => {
          const pids = await blockedBy(holderPid);
          expect(pids).toHaveLength(1);
          return pids;
        }, { timeout: 10_000, interval: 20 });

        let secondDone = false;
        const deleteSecond = h.call(admin.session, 'delete', `/api/admin/users/${second.uuid}`).then((r) => {
          secondDone = true;
          return r;
        });
        // Waiting on the first (the organization's admins it locked), or already answered.
        await vi.waitFor(async () => {
          if (!secondDone) expect(await blockedBy(firstPid)).toHaveLength(1);
        }, { timeout: 10_000, interval: 20 });

        await holder.query('ROLLBACK');
        const [firstAnswer, secondAnswer] = await Promise.all([deleteFirst, deleteSecond]);
        expect([firstAnswer.status, secondAnswer.status], `${firstAnswer.text} ${secondAnswer.text}`).toEqual([200, 409]);
        expect(secondAnswer.body).toMatchObject({ code: 'LAST_ADMIN', organizations: [{ uuid: org.uuid }] });
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      expect(await exists(first.id)).toBe(false);
      expect(await exists(second.id)).toBe(true);
      const admins = await h.owner.query('SELECT user_id FROM organization_users WHERE organization_id = $1 AND is_admin', [org.id]);
      expect(admins.rows).toEqual([{ user_id: second.id }]);
    });
  });

  describe('organizations', () => {
    it('creates an organization with the named user as its admin, or nothing for an unknown user', async () => {
      const founder = await h.addUser('founder');
      const name = `Deployment admin org ${Date.now()}`;
      const created = await h.call(admin.session, 'post', '/api/admin/organizations', { name, adminEmail: founder.email.toUpperCase() });
      expect(created.status, created.text).toBe(201);
      expect(answerProblem(organizationDetailSchema, created.body)).toBeNull();
      const org = (await h.owner.query<{ id: number; uuid: string }>('SELECT id, uuid FROM organizations WHERE uuid = $1', [created.body.uuid])).rows[0];
      orgIds.push(org.id);
      expect(created.body.name).toBe(name);
      const admins = await h.owner.query('SELECT user_id, is_admin FROM organization_users WHERE organization_id = $1', [org.id]);
      expect(admins.rows).toEqual([{ user_id: founder.id, is_admin: true }]);

      const listed = await h.call(admin.session, 'get', '/api/admin/organizations');
      expect(listed.status).toBe(200);
      expect(answerProblem(organizationListResponseSchema, listed.body)).toBeNull();
      expect(listed.body).toContainEqual({ uuid: org.uuid, name, status: 'active', tenantCount: 0, memberCount: 1 });

      const orphanName = `Orphan org ${Date.now()}`;
      const unknown = await h.call(admin.session, 'post', '/api/admin/organizations', { name: orphanName, adminEmail: `nobody-${Date.now()}@test.local` });
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('USER_NOT_FOUND');
      expect((await h.owner.query('SELECT 1 FROM organizations WHERE name = $1', [orphanName])).rowCount).toBe(0);
    });

    // The body's email is lowercased (emailField), and the lookup compared it exactly, so an
    // account stored with capitals answered 404 USER_NOT_FOUND.
    it('finds the admin or member named whatever the case of the stored email', async () => {
      const founder = await h.addUser('capital-founder');
      const capitalised = founder.email.replace(/^./, (c) => c.toUpperCase()).replace('@test.local', '@Test.Local');
      await h.owner.query('UPDATE users SET email = $1 WHERE id = $2', [capitalised, founder.id]);

      const name = `Capitalised admin org ${Date.now()}`;
      const created = await h.call(admin.session, 'post', '/api/admin/organizations', { name, adminEmail: capitalised });
      expect(created.status, created.text).toBe(201);
      const org = (await h.owner.query<{ id: number }>('SELECT id FROM organizations WHERE uuid = $1', [created.body.uuid])).rows[0];
      orgIds.push(org.id);
      expect((await h.owner.query('SELECT user_id, is_admin FROM organization_users WHERE organization_id = $1', [org.id])).rows).toEqual([
        { user_id: founder.id, is_admin: true },
      ]);

      const joiner = await h.addUser('capital-member');
      const joinerEmail = joiner.email.toUpperCase();
      await h.owner.query('UPDATE users SET email = $1 WHERE id = $2', [joinerEmail, joiner.id]);
      const added = await h.call(admin.session, 'post', `/api/organizations/${created.body.uuid}/members`, { email: joinerEmail });
      expect(added.status, added.text).toBe(201);
      expect(answerProblem(memberDtoSchema, added.body)).toBeNull();
      expect(added.body).toMatchObject({ isAdmin: false, user: { uuid: joiner.uuid, email: joinerEmail } });

      // Still nobody for an address no account has.
      const unknown = await h.call(admin.session, 'post', `/api/organizations/${created.body.uuid}/members`, { email: `Nobody-${Date.now()}@test.local` });
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('USER_NOT_FOUND');
    });

    it('takes the exact address of two that differ only in case, and refuses to guess between two others', async () => {
      const lower = await h.addUser('twin');
      const twin = await h.addUser('twin-capital');
      await h.owner.query('UPDATE users SET email = $1 WHERE id = $2', [lower.email.toUpperCase(), twin.id]);

      const exact = await h.call(admin.session, 'post', '/api/admin/organizations', { name: `Exact twin org ${Date.now()}`, adminEmail: lower.email });
      expect(exact.status, exact.text).toBe(201);
      const org = (await h.owner.query<{ id: number }>('SELECT id FROM organizations WHERE uuid = $1', [exact.body.uuid])).rows[0];
      orgIds.push(org.id);
      expect((await h.owner.query('SELECT user_id FROM organization_users WHERE organization_id = $1', [org.id])).rows).toEqual([{ user_id: lower.id }]);

      // Neither stored as the lowercased address is: which one is meant can't be told.
      await h.owner.query('UPDATE users SET email = $1 WHERE id = $2', [lower.email.replace(/^./, (c) => c.toUpperCase()), lower.id]);
      const guessName = `Ambiguous twin org ${Date.now()}`;
      const ambiguous = await h.call(admin.session, 'post', '/api/admin/organizations', { name: guessName, adminEmail: lower.email });
      expect(ambiguous.status, ambiguous.text).toBe(409);
      expect(ambiguous.body.code).toBe('EMAIL_AMBIGUOUS');
      expect((await h.owner.query('SELECT 1 FROM organizations WHERE name = $1', [guessName])).rowCount).toBe(0);
      const member = await h.call(admin.session, 'post', `/api/organizations/${exact.body.uuid}/members`, { email: lower.email });
      expect(member.status, member.text).toBe(409);
      expect(member.body.code).toBe('EMAIL_AMBIGUOUS');
    });

    it("suspends and restores an organization, and leaves deleted ones out of the list", async () => {
      const name = `Status org ${Date.now()}`;
      const created = await h.call(admin.session, 'post', '/api/admin/organizations', { name });
      expect(created.status, created.text).toBe(201);
      const orgId = (await h.owner.query<{ id: number }>('SELECT id FROM organizations WHERE uuid = $1', [created.body.uuid])).rows[0].id;
      orgIds.push(orgId);
      const status = async () => (await h.owner.query<{ status: string }>('SELECT status FROM organizations WHERE id = $1', [orgId])).rows[0].status;

      const suspended = await h.call(admin.session, 'patch', `/api/admin/organizations/${created.body.uuid}`, { status: 'suspended' });
      expect(answerProblem(organizationDetailSchema, suspended.body)).toBeNull();
      expect(suspended.status, suspended.text).toBe(200);
      expect(await status()).toBe('suspended');
      expect((await h.call(admin.session, 'patch', `/api/admin/organizations/${created.body.uuid}`, { status: 'active' })).status).toBe(200);
      expect(await status()).toBe('active');
      expect((await h.call(admin.session, 'patch', `/api/admin/organizations/${created.body.uuid}`, { status: 'gone' })).status).toBe(400);

      expect((await h.call(admin.session, 'patch', `/api/admin/organizations/${created.body.uuid}`, { status: 'deleted' })).status).toBe(200);
      const listed = await h.call(admin.session, 'get', '/api/admin/organizations');
      expect((listed.body as Array<{ uuid: string }>).map((o) => o.uuid)).not.toContain(created.body.uuid);

      const unknown = await h.call(admin.session, 'patch', '/api/admin/organizations/00000000-0000-7000-8000-000000000000', { status: 'active' });
      expect(unknown.status).toBe(404);
    });
  });
});
