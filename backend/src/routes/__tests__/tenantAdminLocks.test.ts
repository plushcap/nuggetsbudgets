import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createHash, randomBytes } from 'crypto';
import type request from 'supertest';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';

/**
 * Two changes at once to a ledger's admins. Demoting or removing an admin locked
 * that member's row, then the ledger's other admins, in no order: two such changes to two
 * admins each held their own row and waited for the other's, and Postgres broke the
 * deadlock (40P01) by failing one with a 500. They lock the ledger's admins in id order
 * now, with the member, as an organization's are (lockMember), and so does deleting a
 * user: the second change waits for the first, then decides on what it left, and only a
 * change that would leave the ledger without an admin is refused (LAST_ADMIN).
 *
 * Each case holds the lowest admin's row from the test, so both changes queue on it in a
 * known order and overlap exactly there; then lets go.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('concurrent changes to a ledger’s admins', () => {
  let h: RouteHarness;
  let deploymentAdmin: number;
  const tenants: TestTenant[] = [];

  beforeAll(async () => {
    h = await startRouteHarness('Ledger admin locks');
    deploymentAdmin = (await h.addUser('deployment-admin')).id;
    await h.makeDeploymentAdmin(deploymentAdmin);
  }, 60_000);

  afterAll(async () => {
    const closed = await Promise.allSettled([h?.close()]);
    const settled = await Promise.allSettled(tenants.map((l) => l.cleanup()));
    const failed = [...closed, ...settled].find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, 60_000);

  type Admin = { userId: number; userUuid: string; membershipId: number; membership: string };

  /** A ledger with `count` admins besides its own (plain) member, in id order, and a deployment admin's session in it. */
  async function tenantWithAdmins(label: string, count: number) {
    const tenant = await createTestTenant(`Ledger admin locks ${label}`);
    tenants.push(tenant);
    const admins: Admin[] = [];
    for (let i = 0; i < count; i++) {
      const u = await h.addUser(`${label}-admin-${i}`);
      const row = (
        await h.owner.query<{ id: number; uuid: string }>(
          'INSERT INTO tenant_users (tenant_id, user_id, is_admin) VALUES ($1, $2, true) RETURNING id, uuid',
          [tenant.tenantId, u.id]
        )
      ).rows[0];
      admins.push({ userId: u.id, userUuid: u.uuid, membershipId: row.id, membership: row.uuid });
    }
    return { tenant, admins, session: await h.signIn(deploymentAdmin, tenant.tenantId) };
  }

  const adminsOf = async (tenantId: number) =>
    (await h.owner.query<{ user_id: number }>('SELECT user_id FROM tenant_users WHERE tenant_id = $1 AND is_admin ORDER BY id', [tenantId])).rows.map(
      (r) => r.user_id
    );

  /** The backends waiting on any of `pids`. */
  const waitingOn = async (pids: number[]) =>
    (await h.owner.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) && $1::int[]', [pids])).rows.map(
      (r) => r.pid
    );

  /**
   * Run `first`, then `second`, while the test holds `heldMembershipId`'s row (a ledger
   * membership, or with `table` an organization one, or a ledger's or organization's row): `first`
   * queues on it, then `second` (on it, or on `first`). Then let go; both answers.
   *
   * With `hold: 'promote'` the test holds the membership by making it an admin's, and lets
   * go by committing that: a promotion in flight while the two wait.
   */
  async function race(
    heldMembershipId: number,
    first: () => request.Test,
    second: () => request.Test,
    table: 'tenant_users' | 'organization_users' | 'tenants' | 'organizations' = 'tenant_users',
    hold: 'lock' | 'promote' = 'lock'
  ) {
    const holder = await h.owner.connect();
    try {
      await holder.query('BEGIN');
      if (hold === 'promote') await holder.query(`UPDATE ${table} SET is_admin = true WHERE id = $1`, [heldMembershipId]);
      else await holder.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [heldMembershipId]);
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;

      const one = first().then((r) => r);
      const [firstPid] = await vi.waitFor(
        async () => {
          const pids = await waitingOn([holderPid]);
          expect(pids).toHaveLength(1);
          return pids;
        },
        { timeout: 10_000, interval: 20 }
      );
      let secondDone = false;
      const two = second().then((r) => {
        secondDone = true;
        return r;
      });
      await vi.waitFor(
        async () => {
          if (!secondDone) expect((await waitingOn([holderPid, firstPid])).filter((pid) => pid !== firstPid)).toHaveLength(1);
        },
        { timeout: 10_000, interval: 20 }
      );

      await holder.query(hold === 'promote' ? 'COMMIT' : 'ROLLBACK');
      return await Promise.all([one, two]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }

  const demote = (session: string, admin: Admin) => () =>
    h.call(session, 'patch', `/api/tenants/current/members/${admin.membership}`, { isAdmin: false });
  const remove = (session: string, admin: Admin) => () => h.call(session, 'delete', `/api/tenants/current/members/${admin.membership}`);

  it('demotes one of its two admins and refuses the other, the second', async () => {
    const { tenant, admins, session } = await tenantWithAdmins('demote-two', 2);
    const [x, y] = admins;
    const [first, second] = await race(x.membershipId, demote(session, x), demote(session, y));
    expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 409]);
    expect(second.body.code).toBe('LAST_ADMIN');
    expect(await adminsOf(tenant.tenantId)).toEqual([y.userId]);
  });

  it('removes one of its two admins and refuses demoting the other', async () => {
    const { tenant, admins, session } = await tenantWithAdmins('remove-two', 2);
    const [x, y] = admins;
    const [first, second] = await race(x.membershipId, remove(session, x), demote(session, y));
    expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 409]);
    expect(second.body.code).toBe('LAST_ADMIN');
    expect(await adminsOf(tenant.tenantId)).toEqual([y.userId]);
    expect((await h.owner.query('SELECT 1 FROM tenant_users WHERE id = $1', [x.membershipId])).rowCount).toBe(0);
  });

  it('demotes two of its three admins at once', async () => {
    const { tenant, admins, session } = await tenantWithAdmins('demote-of-three', 3);
    const [stays, x, y] = admins;
    const [first, second] = await race(stays.membershipId, demote(session, x), demote(session, y));
    expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
    expect(await adminsOf(tenant.tenantId)).toEqual([stays.userId]);
  });

  // Deleting a user locks the same rows in the same order (UserService).
  it('deletes a user who is one of its two admins and refuses demoting the other', async () => {
    const { tenant, admins, session } = await tenantWithAdmins('delete-user', 2);
    const [x, y] = admins;
    const deleteUser = () => h.call(session, 'delete', `/api/admin/users/${x.userUuid}`);
    const [first, second] = await race(x.membershipId, deleteUser, demote(session, y));
    expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 409]);
    expect(second.body.code).toBe('LAST_ADMIN');
    expect((await h.owner.query('SELECT 1 FROM users WHERE id = $1', [x.userId])).rowCount).toBe(0);
    expect(await adminsOf(tenant.tenantId)).toEqual([y.userId]);
  });

  /**
   * Deleting a user and removing someone from the organization at once. The delete locked
   * the user's ledger admin rows and then, deleting the user, their organization membership
   * (and the ones they created, and the invitations they sent); the removal locked that
   * membership (or the invitation) first and then deleted the ledger memberships: each held
   * a row the other wanted, and Postgres failed one with a 500 (40P01). Both lock
   * invitations, then organization memberships, then ledger memberships now.
   */
  describe('while someone is removed from the organization', () => {
    const orgOf = async (tenant: TestTenant) =>
      (await h.owner.query<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [tenant.organizationId])).rows[0].uuid;
    const joinOrg = async (tenant: TestTenant, userId: number, opts: { isAdmin?: boolean; createdBy?: number } = {}) =>
      (
        await h.owner.query<{ uuid: string }>(
          'INSERT INTO organization_users (organization_id, user_id, is_admin, created_by) VALUES ($1, $2, $3, $4) RETURNING uuid',
          [tenant.organizationId, userId, opts.isAdmin ?? false, opts.createdBy ?? null]
        )
      ).rows[0].uuid;
    const removeFromOrg = (session: string, org: string, member: string) => () =>
      h.call(session, 'delete', `/api/organizations/${org}/members/${member}`);
    const deleteUser = (session: string, admin: Admin) => () => h.call(session, 'delete', `/api/admin/users/${admin.userUuid}`);
    const userExists = async (userId: number) => ((await h.owner.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount ?? 0) > 0;

    // This case: a plain member of the organization who is one of a ledger's two admins.
    it('deletes them while they are removed from it, the removal second', async () => {
      const { tenant, admins, session } = await tenantWithAdmins('delete-then-leave', 2);
      const [x, y] = admins;
      const org = await orgOf(tenant);
      const xInOrg = await joinOrg(tenant, x.userId);
      await joinOrg(tenant, y.userId);
      const [first, second] = await race(x.membershipId, deleteUser(session, x), removeFromOrg(session, org, xInOrg));
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 404]);
      expect(second.body.code).toBe('MEMBER_NOT_FOUND');
      expect(await userExists(x.userId)).toBe(false);
      expect(await adminsOf(tenant.tenantId)).toEqual([y.userId]);
    });

    it('removes them from it while they are deleted, the delete second', async () => {
      const { tenant, admins, session } = await tenantWithAdmins('leave-then-delete', 2);
      const [x, y] = admins;
      const org = await orgOf(tenant);
      const xInOrg = await joinOrg(tenant, x.userId);
      await joinOrg(tenant, y.userId);
      const [first, second] = await race(x.membershipId, removeFromOrg(session, org, xInOrg), deleteUser(session, x));
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
      expect(await userExists(x.userId)).toBe(false);
      expect(await adminsOf(tenant.tenantId)).toEqual([y.userId]);
    });

    // Removing X from the organization deletes X's ledger membership: refused once the
    // ledger's other admin is demoted, as removing X from the ledger would be.
    it("refuses to remove one of a ledger's two admins once the other is demoted", async () => {
      const { tenant, admins, session } = await tenantWithAdmins('demote-then-leave', 2);
      const [x, y] = admins;
      const org = await orgOf(tenant);
      const xInOrg = await joinOrg(tenant, x.userId);
      await joinOrg(tenant, y.userId);
      const [first, second] = await race(x.membershipId, demote(session, y), removeFromOrg(session, org, xInOrg));
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 409]);
      expect(second.body.code).toBe('LAST_ADMIN');
      expect(await adminsOf(tenant.tenantId)).toEqual([x.userId]);
    });

    // Deleting X sets created_by to null on the membership X created: Y's, which removing Y locks.
    it('deletes a user while someone whose membership they created is removed', async () => {
      const tenant = await createTestTenant('Ledger admin locks created-by');
      tenants.push(tenant);
      const [x, y, z] = [await h.addUser('created-by-x'), await h.addUser('created-by-y'), await h.addUser('created-by-z')];
      const tenantAdmin = async (userId: number) =>
        (
          await h.owner.query<{ id: number }>('INSERT INTO tenant_users (tenant_id, user_id, is_admin) VALUES ($1, $2, true) RETURNING id', [
            tenant.tenantId,
            userId,
          ])
        ).rows[0].id;
      // Y's ledger row before X's, so the delete holds it while it waits on X's.
      await tenantAdmin(y.id);
      const xMembership = await tenantAdmin(x.id);
      await tenantAdmin(z.id);
      const org = await orgOf(tenant);
      await joinOrg(tenant, x.id);
      const yInOrg = await joinOrg(tenant, y.id, { createdBy: x.id });
      const session = await h.signIn(deploymentAdmin, tenant.tenantId);
      const [first, second] = await race(
        xMembership,
        () => h.call(session, 'delete', `/api/admin/users/${x.uuid}`),
        removeFromOrg(session, org, yInOrg)
      );
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
      expect(await userExists(x.id)).toBe(false);
      expect(await adminsOf(tenant.tenantId)).toEqual([z.id]);
    });

    // Deleting X sets invited_by to null on X's invitations: one to Y, which removing Y revokes.
    it('deletes a user while someone they invited is removed', async () => {
      const { tenant, admins, session } = await tenantWithAdmins('invited-by', 2);
      const [x] = admins;
      const [y, z] = [await h.addUser('invited-by-y'), await h.addUser('invited-by-z')];
      const org = await orgOf(tenant);
      await joinOrg(tenant, x.userId, { isAdmin: true });
      const yInOrg = await joinOrg(tenant, y.id, { isAdmin: true });
      await joinOrg(tenant, z.id, { isAdmin: true });
      await h.owner.query(
        `INSERT INTO organization_invitations (organization_id, email, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day')`,
        [tenant.organizationId, y.email.toLowerCase(), randomBytes(32).toString('hex'), x.userId]
      );
      const [first, second] = await race(x.membershipId, deleteUser(session, x), removeFromOrg(session, org, yInOrg));
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
      expect(await userExists(x.userId)).toBe(false);
      const orgAdmins = await h.owner.query('SELECT user_id FROM organization_users WHERE organization_id = $1 AND is_admin', [
        tenant.organizationId,
      ]);
      expect(orgAdmins.rows).toEqual([{ user_id: z.id }]);
    });
  });

  /**
   * Accepting an invitation while the organization's people change. Accepting locked the
   * sender's membership (to keep them an admin while it counts their invitation), then, for
   * someone already a member, their own (the upsert): by role, not in id order, so with a
   * demotion, a removal or a user's delete that locks the organization's admins in id order
   * each held a row the other wanted (40P01, a 500). It locks both in id order now, after
   * the invitation and the two users' rows, and a deployment admin's row after them.
   */
  describe('while an invitation is accepted', () => {
    type Member = { id: number; uuid: string };
    const joinOrg = async (tenant: TestTenant, userId: number, isAdmin: boolean, createdBy: number | null = null) =>
      (
        await h.owner.query<Member>(
          'INSERT INTO organization_users (organization_id, user_id, is_admin, created_by) VALUES ($1, $2, $3, $4) RETURNING id, uuid',
          [tenant.organizationId, userId, isAdmin, createdBy]
        )
      ).rows[0];
    const invite = async (tenant: TestTenant, email: string, invitedBy: number) => {
      const token = randomBytes(32).toString('base64url');
      await h.owner.query(
        `INSERT INTO organization_invitations (organization_id, email, token_hash, invited_by, is_admin, expires_at)
         VALUES ($1, $2, $3, $4, true, NOW() + INTERVAL '1 day')`,
        [tenant.organizationId, email.toLowerCase(), createHash('sha256').update(token).digest('hex'), invitedBy]
      );
      return token;
    };
    const orgAdmins = async (tenant: TestTenant) =>
      (
        await h.owner.query<{ user_id: number }>('SELECT user_id FROM organization_users WHERE organization_id = $1 AND is_admin ORDER BY id', [
          tenant.organizationId,
        ])
      ).rows.map((r) => r.user_id);
    const accepted = async (tenant: TestTenant) =>
      (
        await h.owner.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM organization_invitations WHERE organization_id = $1 AND accepted_at IS NOT NULL',
          [tenant.organizationId]
        )
      ).rows[0].n;

    /** An organization where U, an admin (the lower id), is invited again as one by S, another admin. */
    async function memberInvited(label: string) {
      const tenant = await createTestTenant(`Ledger admin locks accept ${label}`);
      tenants.push(tenant);
      const u = await h.addUser(`${label}-accepter`);
      const s = await h.addUser(`${label}-sender`);
      const uRow = await joinOrg(tenant, u.id, true);
      const sRow = await joinOrg(tenant, s.id, true);
      return {
        tenant,
        u,
        s,
        uRow,
        sRow,
        token: await invite(tenant, u.email, s.id),
        accepterSession: await h.signIn(u.id),
        session: await h.signIn(deploymentAdmin, tenant.tenantId),
        org: (await h.owner.query<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [tenant.organizationId])).rows[0].uuid,
      };
    }
    const accept = (session: string, token: string) => () => h.call(session, 'post', '/api/invitations/accept', { token });

    it('accepts while the sender is demoted', async () => {
      const { tenant, u, sRow, token, accepterSession, session, org } = await memberInvited('demote');
      const [first, second] = await race(
        sRow.id,
        accept(accepterSession, token),
        () => h.call(session, 'patch', `/api/organizations/${org}/members/${sRow.uuid}`, { isAdmin: false }),
        'organization_users'
      );
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
      expect(await orgAdmins(tenant)).toEqual([u.id]);
      expect(await accepted(tenant)).toBe(1);
    });

    it('accepts while the sender is removed from the organization', async () => {
      const { tenant, u, sRow, token, accepterSession, session, org } = await memberInvited('remove');
      const [first, second] = await race(
        sRow.id,
        accept(accepterSession, token),
        () => h.call(session, 'delete', `/api/organizations/${org}/members/${sRow.uuid}`),
        'organization_users'
      );
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
      expect(await orgAdmins(tenant)).toEqual([u.id]);
    });

    it("accepts while another of the organization's admins is deleted", async () => {
      const { tenant, u, s, sRow, token, accepterSession, session } = await memberInvited('delete-other');
      const v = await h.addUser('delete-other-v');
      await joinOrg(tenant, v.id, true);
      const [first, second] = await race(
        sRow.id,
        accept(accepterSession, token),
        () => h.call(session, 'delete', `/api/admin/users/${v.uuid}`),
        'organization_users'
      );
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
      expect(await orgAdmins(tenant)).toEqual([u.id, s.id]);
    });

    // U, a plain member whose membership V created, accepts S's admin invitation while V is
    // deleted: the delete locks the memberships V created (it clears their created_by).
    it('accepts an admin invitation while the admin who added them is deleted', async () => {
      const tenant = await createTestTenant('Ledger admin locks accept promotion');
      tenants.push(tenant);
      const [v, u, s] = [await h.addUser('promotion-v'), await h.addUser('promotion-u'), await h.addUser('promotion-s')];
      await joinOrg(tenant, v.id, true);
      await joinOrg(tenant, u.id, false, v.id);
      const sRow = await joinOrg(tenant, s.id, true);
      const token = await invite(tenant, u.email, s.id);
      const session = await h.signIn(deploymentAdmin, tenant.tenantId);
      const [first, second] = await race(
        sRow.id,
        accept(await h.signIn(u.id), token),
        () => h.call(session, 'delete', `/api/admin/users/${v.uuid}`),
        'organization_users'
      );
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
      expect(await orgAdmins(tenant)).toEqual([u.id, s.id]);
    });

    // S, a deployment admin outside the organization whom V made one, invites U, an admin
    // of it; V, another, is deleted, which clears created_by on S's deployment_users row.
    // Accepting share-locks that row to keep S a deployment admin while it counts the
    // invitation, then locked U's membership, which the delete had locked first.
    it("accepts a deployment admin's invitation while the user who made them one is deleted", async () => {
      const tenant = await createTestTenant('Ledger admin locks accept deployment');
      tenants.push(tenant);
      const [u, v, s] = [await h.addUser('deployment-u'), await h.addUser('deployment-v'), await h.addUser('deployment-s')];
      await joinOrg(tenant, u.id, true);
      const vRow = await joinOrg(tenant, v.id, true);
      await h.owner.query(
        `INSERT INTO deployment_users (user_id, deployment_id, role, created_by)
         SELECT $1, id, 'admin', $2 FROM deployment ORDER BY id LIMIT 1`,
        [s.id, v.id]
      );
      const token = await invite(tenant, u.email, s.id);
      const session = await h.signIn(deploymentAdmin, tenant.tenantId);
      // The delete holds U's membership while it waits on V's; the accept then queues behind it.
      const [first, second] = await race(
        vRow.id,
        () => h.call(session, 'delete', `/api/admin/users/${v.uuid}`),
        accept(await h.signIn(u.id), token),
        'organization_users'
      );
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
      expect(await orgAdmins(tenant)).toEqual([u.id]);
      expect(await accepted(tenant)).toBe(1);
    });
  });

  /**
   * Adding someone to a ledger while they're deleted. The add share-locked their
   * organization membership, then its insert's foreign key share-locked their `users` row;
   * deleting them locks that row first (FOR UPDATE) and their memberships after: each held
   * a row the other wanted (40P01, a 500). The add takes their `users` row first now, as
   * accepting an invitation does.
   *
   * Holding the ledger's `tenants` row stops the add at its insert's foreign key check on
   * tenant_id, which runs before the one on user_id: it then held the membership and not
   * yet the users row, which is when a delete in between deadlocked with it.
   */
  describe('while someone is added to the ledger', () => {
    const MEMBER_ADDED_TO_TENANT = 201;
    /** A ledger with no admin, and M, a member of its organization who isn't in it. */
    async function memberToAdd(label: string) {
      const tenant = await createTestTenant(`Ledger admin locks add ${label}`);
      tenants.push(tenant);
      const m = await h.addUser(`${label}-m`);
      const inOrg = (
        await h.owner.query<{ id: number }>('INSERT INTO organization_users (organization_id, user_id) VALUES ($1, $2) RETURNING id', [
          tenant.organizationId,
          m.id,
        ])
      ).rows[0].id;
      return { tenant, m, inOrg, session: await h.signIn(deploymentAdmin, tenant.tenantId) };
    }
    const add = (session: string, email: string, isAdmin: boolean) => () =>
      h.call(session, 'post', '/api/tenants/current/members', { email, isAdmin });
    const deleteUser = (session: string, uuid: string) => () => h.call(session, 'delete', `/api/admin/users/${uuid}`);
    const userExists = async (userId: number) => ((await h.owner.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount ?? 0) > 0;
    const inTenant = async (tenant: TestTenant, userId: number) =>
      (
        await h.owner.query<{ is_admin: boolean }>('SELECT is_admin FROM tenant_users WHERE tenant_id = $1 AND user_id = $2', [
          tenant.tenantId,
          userId,
        ])
      ).rows;

    it('adds them while they are deleted, the delete second', async () => {
      const { tenant, m, session } = await memberToAdd('then-delete');
      const [first, second] = await race(tenant.tenantId, add(session, m.email, false), deleteUser(session, m.uuid), 'tenants');
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([MEMBER_ADDED_TO_TENANT, 200]);
      expect(await userExists(m.id)).toBe(false);
      expect(await inTenant(tenant, m.id)).toEqual([]);
    });

    // The delete counts the admin the add made: the ledger's only one.
    it("refuses to delete them once they're added as the ledger's only admin", async () => {
      const { tenant, m, session } = await memberToAdd('admin-then-delete');
      const [first, second] = await race(tenant.tenantId, add(session, m.email, true), deleteUser(session, m.uuid), 'tenants');
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([MEMBER_ADDED_TO_TENANT, 409]);
      expect(second.body.code).toBe('LAST_ADMIN');
      expect(await userExists(m.id)).toBe(true);
      expect(await inTenant(tenant, m.id)).toEqual([{ is_admin: true }]);
    });

    it('deletes them while they are added, the add second', async () => {
      const { tenant, m, inOrg, session } = await memberToAdd('delete-then-add');
      const [first, second] = await race(inOrg, deleteUser(session, m.uuid), add(session, m.email, true), 'organization_users');
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 404]);
      expect(second.body.code).toBe('NOT_ORG_MEMBER');
      expect(await userExists(m.id)).toBe(false);
      expect(await inTenant(tenant, m.id)).toEqual([]);
    });
  });

  /**
   * A demotion or removal of M while M is promoted. It read whether M was an admin
   * without a lock, to choose whether to lock the place's admins first (in id order) or
   * only M. Read before the promotion committed, it locked M alone, then found M an admin
   * and locked the admins after M, out of id order: with a user's delete of M, which locks
   * the admins and M in id order, each held a row the other wanted (40P01, a 500). It
   * locks M and the admins in one statement in id order now, and decides on them as they
   * then stand. Each case has an admin A, with a lower id than M, and holds M's row with
   * the promotion in flight; both orders of the two requests.
   */
  describe('while the member is promoted', () => {
    const deleteUser = (session: string, uuid: string) => () => h.call(session, 'delete', `/api/admin/users/${uuid}`);
    const userExists = async (userId: number) => ((await h.owner.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount ?? 0) > 0;

    describe('in a ledger', () => {
      /** A ledger with an admin, A, and a plain member M after it. */
      async function tenantWithMember(label: string) {
        const { tenant, admins, session } = await tenantWithAdmins(`promote-${label}`, 1);
        const m = await h.addUser(`promote-${label}-m`);
        const row = (
          await h.owner.query<{ id: number; uuid: string }>(
            'INSERT INTO tenant_users (tenant_id, user_id, is_admin) VALUES ($1, $2, false) RETURNING id, uuid',
            [tenant.tenantId, m.id]
          )
        ).rows[0];
        const member: Admin = { userId: m.id, userUuid: m.uuid, membershipId: row.id, membership: row.uuid };
        return { tenant, a: admins[0], m: member, session };
      }

      it('demotes them, then deletes them', async () => {
        const { tenant, a, m, session } = await tenantWithMember('demote-then-delete');
        const [first, second] = await race(m.membershipId, demote(session, m), deleteUser(session, m.userUuid), 'tenant_users', 'promote');
        expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
        expect(await userExists(m.userId)).toBe(false);
        expect(await adminsOf(tenant.tenantId)).toEqual([a.userId]);
      });

      it('deletes them, then finds no one to demote', async () => {
        const { tenant, a, m, session } = await tenantWithMember('delete-then-demote');
        const [first, second] = await race(m.membershipId, deleteUser(session, m.userUuid), demote(session, m), 'tenant_users', 'promote');
        expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 404]);
        expect(second.body.code).toBe('MEMBER_NOT_FOUND');
        expect(await adminsOf(tenant.tenantId)).toEqual([a.userId]);
      });

      it('removes them, then deletes them', async () => {
        const { tenant, a, m, session } = await tenantWithMember('remove-then-delete');
        const [first, second] = await race(m.membershipId, remove(session, m), deleteUser(session, m.userUuid), 'tenant_users', 'promote');
        expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
        expect(await userExists(m.userId)).toBe(false);
        expect(await adminsOf(tenant.tenantId)).toEqual([a.userId]);
      });

      // Without the user's delete: the promotion and the demotion each happen, in turn.
      it('demotes them once the promotion is in', async () => {
        const { tenant, a, m, session } = await tenantWithMember('promote-demote');
        const promote = () => h.call(session, 'patch', `/api/tenants/current/members/${m.membership}`, { isAdmin: true });
        const [first, second] = await race(m.membershipId, promote, demote(session, m));
        expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
        expect(await adminsOf(tenant.tenantId)).toEqual([a.userId]);
      });
    });

    describe('in an organization', () => {
      /** An organization with an admin, A, and a plain member M after it, and a deployment admin's session. */
      async function orgWithMember(label: string) {
        const tenant = await createTestTenant(`Ledger admin locks org promote ${label}`);
        tenants.push(tenant);
        const [a, m] = [await h.addUser(`org-promote-${label}-a`), await h.addUser(`org-promote-${label}-m`)];
        const join = async (userId: number, isAdmin: boolean) =>
          (
            await h.owner.query<{ id: number; uuid: string }>(
              'INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, $3) RETURNING id, uuid',
              [tenant.organizationId, userId, isAdmin]
            )
          ).rows[0];
        await join(a.id, true);
        const mRow = await join(m.id, false);
        const org = (await h.owner.query<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [tenant.organizationId])).rows[0].uuid;
        const orgAdmins = async () =>
          (
            await h.owner.query<{ user_id: number }>('SELECT user_id FROM organization_users WHERE organization_id = $1 AND is_admin ORDER BY id', [
              tenant.organizationId,
            ])
          ).rows.map((r) => r.user_id);
        return { a, m, mRow, org, orgAdmins, session: await h.signIn(deploymentAdmin, tenant.tenantId) };
      }
      const demoteInOrg = (session: string, org: string, member: string) => () =>
        h.call(session, 'patch', `/api/organizations/${org}/members/${member}`, { isAdmin: false });
      const removeFromOrg = (session: string, org: string, member: string) => () =>
        h.call(session, 'delete', `/api/organizations/${org}/members/${member}`);

      it('demotes them, then deletes them', async () => {
        const { a, m, mRow, org, orgAdmins, session } = await orgWithMember('demote-then-delete');
        const [first, second] = await race(mRow.id, demoteInOrg(session, org, mRow.uuid), deleteUser(session, m.uuid), 'organization_users', 'promote');
        expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
        expect(await userExists(m.id)).toBe(false);
        expect(await orgAdmins()).toEqual([a.id]);
      });

      it('deletes them, then finds no one to demote', async () => {
        const { a, m, mRow, org, orgAdmins, session } = await orgWithMember('delete-then-demote');
        const [first, second] = await race(mRow.id, deleteUser(session, m.uuid), demoteInOrg(session, org, mRow.uuid), 'organization_users', 'promote');
        expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 404]);
        expect(second.body.code).toBe('MEMBER_NOT_FOUND');
        expect(await orgAdmins()).toEqual([a.id]);
      });

      it('removes them, then deletes them', async () => {
        const { a, m, mRow, org, orgAdmins, session } = await orgWithMember('remove-then-delete');
        const [first, second] = await race(mRow.id, removeFromOrg(session, org, mRow.uuid), deleteUser(session, m.uuid), 'organization_users', 'promote');
        expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
        expect(await userExists(m.id)).toBe(false);
        expect(await orgAdmins()).toEqual([a.id]);
      });

      it('demotes them once the promotion is in', async () => {
        const { a, mRow, org, orgAdmins, session } = await orgWithMember('promote-demote');
        const promote = () => h.call(session, 'patch', `/api/organizations/${org}/members/${mRow.uuid}`, { isAdmin: true });
        const [first, second] = await race(mRow.id, promote, demoteInOrg(session, org, mRow.uuid), 'organization_users');
        expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 200]);
        expect(await orgAdmins()).toEqual([a.id]);
      });
    });
  });

  /**
   * A deployment admin adding someone to an organization while they're deleted. The
   * add read the person without a lock and inserted the membership, whose foreign key check
   * then share-locked their `users` row. A delete in between went through first, and the
   * insert failed its foreign key (23503, a 500). The add takes the adder's and the person's
   * `users` rows first now (FOR KEY SHARE, in id order), as adding a ledger member does.
   */
  describe('while someone is added to an organization', () => {
    async function personToAdd(label: string) {
      const tenant = await createTestTenant(`Ledger admin locks org add ${label}`);
      tenants.push(tenant);
      // M is a member of another organization, whose row the delete locks after M's users row.
      const elsewhere = await createTestTenant(`Ledger admin locks org add ${label} elsewhere`);
      tenants.push(elsewhere);
      const m = await h.addUser(`org-add-${label}-m`);
      const otherMembership = (
        await h.owner.query<{ id: number }>('INSERT INTO organization_users (organization_id, user_id) VALUES ($1, $2) RETURNING id', [
          elsewhere.organizationId,
          m.id,
        ])
      ).rows[0].id;
      const org = (await h.owner.query<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [tenant.organizationId])).rows[0].uuid;
      const inOrg = async () =>
        (
          await h.owner.query<{ is_admin: boolean }>('SELECT is_admin FROM organization_users WHERE organization_id = $1 AND user_id = $2', [
            tenant.organizationId,
            m.id,
          ])
        ).rows;
      return { tenant, m, otherMembership, org, inOrg, session: await h.signIn(deploymentAdmin, tenant.tenantId) };
    }
    const addToOrg = (session: string, org: string, email: string, isAdmin: boolean) => () =>
      h.call(session, 'post', `/api/organizations/${org}/members`, { email, isAdmin });
    const deleteUser = (session: string, uuid: string) => () => h.call(session, 'delete', `/api/admin/users/${uuid}`);
    const userExists = async (userId: number) => ((await h.owner.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount ?? 0) > 0;

    it('deletes them while they are added, the add second', async () => {
      const { m, otherMembership, org, inOrg, session } = await personToAdd('delete-then-add');
      const [first, second] = await race(otherMembership, deleteUser(session, m.uuid), addToOrg(session, org, m.email, false), 'organization_users');
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([200, 404]);
      expect(second.body.code).toBe('USER_NOT_FOUND');
      expect(await userExists(m.id)).toBe(false);
      expect(await inOrg()).toEqual([]);
    });

    // Holding the organization's row stops the add at its insert's foreign key check on
    // organization_id, which runs before the one on user_id.
    it('adds them while they are deleted, the delete second', async () => {
      const { tenant, m, org, inOrg, session } = await personToAdd('add-then-delete');
      const [first, second] = await race(tenant.organizationId, addToOrg(session, org, m.email, false), deleteUser(session, m.uuid), 'organizations');
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([201, 200]);
      expect(await userExists(m.id)).toBe(false);
      expect(await inOrg()).toEqual([]);
    });

    it("refuses to delete them once they're added as the organization's only admin", async () => {
      const { tenant, m, org, inOrg, session } = await personToAdd('admin-then-delete');
      const [first, second] = await race(tenant.organizationId, addToOrg(session, org, m.email, true), deleteUser(session, m.uuid), 'organizations');
      expect([first.status, second.status], `${first.text} ${second.text}`).toEqual([201, 409]);
      expect(second.body.code).toBe('LAST_ADMIN');
      expect(await userExists(m.id)).toBe(true);
      expect(await inOrg()).toEqual([{ is_admin: true }]);
    });
  });
});
