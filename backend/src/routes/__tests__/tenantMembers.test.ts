import { answerProblem, tenantUserListResponseSchema } from '@nuggets/shared';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';

/**
 * Ledger and organization membership through the real app:
 * /api/tenants/current/* (renaming the ledger, its members and their admin flag, the
 * people who may be added, account flags, the balance-adjustment merchant),
 * /api/organizations/:uuid/members and /api/tenants/current/users, as the roles that call them.
 *
 * The key rules: a ledger and an organization keep at least one admin; only a member of
 * the ledger's organization can be added, with one answer for everyone else; a change
 * reaches only the ledger in the session, never another ledger's membership rows.
 * (That roles below each route's level are refused is route-authorization.test.ts; the
 * invitation flow and concurrent removals are organization-membership.test.ts.)
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('Ledger and organization membership routes', () => {
  let h: RouteHarness;
  let a: TestTenant;
  let b: TestTenant;
  let tenantAdmin: string; // a's own user, admin of ledger A
  let member: { id: number; uuid: string; email: string; session: string; membership: string };
  let candidate: { id: number; uuid: string; email: string };
  let orgAdmin: { id: number; session: string; membership: string };
  let outsider: { id: number; email: string; membershipInB: string };
  let tenantAdminMembership: string;

  const membershipOf = async (tenantId: number, userId: number) =>
    (
      await h.owner.query<{ uuid: string; is_admin: boolean }>(
        'SELECT uuid, is_admin FROM tenant_users WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, userId]
      )
    ).rows[0];

  beforeAll(async () => {
    h = await startRouteHarness('Ledger members');
    a = await createTestTenant('Ledger members A');
    b = await createTestTenant('Ledger members B');
    const { owner } = h;

    await owner.query('UPDATE tenant_users SET is_admin = true WHERE tenant_id = $1 AND user_id = $2', [a.tenantId, a.userId]);
    await owner.query('INSERT INTO organization_users (organization_id, user_id) VALUES ($1, $2)', [a.organizationId, a.userId]);
    tenantAdmin = await h.signIn(a.userId, a.tenantId);
    tenantAdminMembership = (await membershipOf(a.tenantId, a.userId)).uuid;

    const m = await h.addUser('member');
    await owner.query('INSERT INTO organization_users (organization_id, user_id) VALUES ($1, $2)', [a.organizationId, m.id]);
    await owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [a.tenantId, m.id]);
    member = { ...m, session: await h.signIn(m.id, a.tenantId), membership: (await membershipOf(a.tenantId, m.id)).uuid };

    candidate = await h.addUser('candidate');
    await owner.query('INSERT INTO organization_users (organization_id, user_id) VALUES ($1, $2)', [a.organizationId, candidate.id]);

    // The organization's only admin; not a member of ledger A, which org admins can open anyway.
    const oa = await h.addUser('org-admin');
    const oaMembership = (
      await owner.query<{ uuid: string }>(
        'INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true) RETURNING uuid',
        [a.organizationId, oa.id]
      )
    ).rows[0].uuid;
    orgAdmin = { id: oa.id, session: await h.signIn(oa.id, a.tenantId), membership: oaMembership };

    // Someone of the other family: in B's organization and ledger.
    const x = await h.addUser('outsider');
    await owner.query('INSERT INTO organization_users (organization_id, user_id) VALUES ($1, $2)', [b.organizationId, x.id]);
    await owner.query('INSERT INTO tenant_users (tenant_id, user_id, is_admin) VALUES ($1, $2, true)', [b.tenantId, x.id]);
    outsider = { id: x.id, email: x.email, membershipInB: (await membershipOf(b.tenantId, x.id)).uuid };
  }, 60_000);

  afterAll(async () => {
    const settled = await Promise.allSettled([h?.close(), a?.cleanup(), b?.cleanup()]);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, 60_000);

  // Each test starts from the people beforeAll set up, whatever the others changed, so any
  // one passes alone (`-t`, `.only`) or in another order: ledger A has its
  // admin and the member; its organization those two, the candidate and the org admin (its
  // only admin); the member's account flags are clear and they are signed in.
  beforeEach(async () => {
    const { owner } = h;
    await owner.query('DELETE FROM tenant_users WHERE tenant_id = $1 AND NOT (user_id = ANY($2))', [a.tenantId, [a.userId, member.id]]);
    await owner.query('UPDATE tenant_users SET is_admin = (user_id = $2) WHERE tenant_id = $1', [a.tenantId, a.userId]);
    await owner.query('DELETE FROM organization_users WHERE organization_id = $1 AND NOT (user_id = ANY($2))', [
      a.organizationId,
      [a.userId, member.id, candidate.id, orgAdmin.id],
    ]);
    await owner.query('UPDATE organization_users SET is_admin = (user_id = $2) WHERE organization_id = $1', [a.organizationId, orgAdmin.id]);
    await owner.query('UPDATE users SET is_locked = false, login_disabled = false WHERE id = $1', [member.id]);
    await owner.query('UPDATE tenants SET balance_adjustment_merchant_id = NULL WHERE id = $1', [a.tenantId]);
    member.session = await h.signIn(member.id, a.tenantId);
  });

  it('renames only the ledger in the session, and only for its admins', async () => {
    const before = (await h.owner.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [b.tenantId])).rows[0].name;

    const refused = await h.call(member.session, 'patch', '/api/tenants/current', { name: 'Renamed by a member' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('TENANT_ADMIN_REQUIRED');

    const renamed = await h.call(tenantAdmin, 'patch', '/api/tenants/current', { name: 'Household A' });
    expect(renamed.status, renamed.text).toBe(200);
    expect(renamed.body.name).toBe('Household A');

    const current = await h.call(member.session, 'get', '/api/tenants/current');
    expect(current.status).toBe(200);
    expect(current.body.name).toBe('Household A');
    const names = await h.owner.query<{ id: number; name: string }>('SELECT id, name FROM tenants WHERE id = ANY($1)', [[a.tenantId, b.tenantId]]);
    expect(Object.fromEntries(names.rows.map((r) => [r.id, r.name]))).toEqual({ [a.tenantId]: 'Household A', [b.tenantId]: before });
  });

  it("lists the ledger's own members, and as candidates only its organization's people not in it yet", async () => {
    const members = await h.call(member.session, 'get', '/api/tenants/current/members');
    expect(members.status).toBe(200);
    const memberUuids = (members.body as Array<{ uuid: string }>).map((m) => m.uuid).sort();
    expect(memberUuids).toEqual([tenantAdminMembership, member.membership].sort());

    const candidates = await h.call(tenantAdmin, 'get', '/api/tenants/current/member-candidates');
    expect(candidates.status).toBe(200);
    expect((candidates.body as Array<{ email: string }>).map((c) => c.email).sort()).toEqual(
      // The org admin is in the organization but not the ledger, so may be added too.
      [candidate.email, (await h.owner.query('SELECT email FROM users WHERE id = $1', [orgAdmin.id])).rows[0].email].sort()
    );
  });

  it("adds only a member of the ledger's organization, answering an outsider like an unknown address", async () => {
    const outsiderAnswer = await h.call(tenantAdmin, 'post', '/api/tenants/current/members', { email: outsider.email });
    const unknownAnswer = await h.call(tenantAdmin, 'post', '/api/tenants/current/members', { email: `nobody-${Date.now()}@test.local` });
    expect(outsiderAnswer.status).toBe(404);
    expect(outsiderAnswer.body.code).toBe('NOT_ORG_MEMBER');
    expect({ ...outsiderAnswer.body, requestId: undefined }).toEqual({ ...unknownAnswer.body, requestId: undefined });
    expect(await membershipOf(a.tenantId, outsider.id)).toBeUndefined();

    const byMember = await h.call(member.session, 'post', '/api/tenants/current/members', { email: candidate.email });
    expect(byMember.status).toBe(403);
    expect(await membershipOf(a.tenantId, candidate.id)).toBeUndefined();

    // Any case of the address finds the person.
    const added = await h.call(tenantAdmin, 'post', '/api/tenants/current/members', { email: candidate.email.toUpperCase() });
    expect(added.status, added.text).toBe(201);
    expect(added.body.isAdmin).toBe(false);
    const row = await membershipOf(a.tenantId, candidate.id);
    expect(row).toEqual({ uuid: added.body.uuid, is_admin: false });

    const again = await h.call(tenantAdmin, 'post', '/api/tenants/current/members', { email: candidate.email });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_MEMBER');
  });

  it('keeps at least one admin: the only admin can be neither demoted nor removed', async () => {
    const demote = await h.call(tenantAdmin, 'patch', `/api/tenants/current/members/${tenantAdminMembership}`, { isAdmin: false });
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe('LAST_ADMIN');
    const remove = await h.call(tenantAdmin, 'delete', `/api/tenants/current/members/${tenantAdminMembership}`);
    expect(remove.status).toBe(409);
    expect(remove.body.code).toBe('LAST_ADMIN');
    expect(await membershipOf(a.tenantId, a.userId)).toEqual({ uuid: tenantAdminMembership, is_admin: true });

    // With a second admin, the first can step down.
    const promote = await h.call(tenantAdmin, 'patch', `/api/tenants/current/members/${member.membership}`, { isAdmin: true });
    expect(promote.status, promote.text).toBe(200);
    const stepDown = await h.call(tenantAdmin, 'patch', `/api/tenants/current/members/${tenantAdminMembership}`, { isAdmin: false });
    expect(stepDown.status, stepDown.text).toBe(200);
    expect((await membershipOf(a.tenantId, a.userId)).is_admin).toBe(false);
    expect((await membershipOf(a.tenantId, member.id)).is_admin).toBe(true);

    // Now the member is the only admin, and the old one, no longer admin, is refused.
    const lastAgain = await h.call(member.session, 'delete', `/api/tenants/current/members/${member.membership}`);
    expect(lastAgain.status).toBe(409);
    expect(lastAgain.body.code).toBe('LAST_ADMIN');
    const notAdmin = await h.call(tenantAdmin, 'patch', `/api/tenants/current/members/${tenantAdminMembership}`, { isAdmin: true });
    expect(notAdmin.status).toBe(403);

    // The new admin can make the old one admin again, who can then step the new one down.
    expect((await h.call(member.session, 'patch', `/api/tenants/current/members/${tenantAdminMembership}`, { isAdmin: true })).status).toBe(200);
    expect((await h.call(tenantAdmin, 'patch', `/api/tenants/current/members/${member.membership}`, { isAdmin: false })).status).toBe(200);
    expect(await membershipOf(a.tenantId, member.id)).toEqual({ uuid: member.membership, is_admin: false });
  });

  it("removes one membership of this ledger, never another ledger's", async () => {
    const elsewhere = await h.call(tenantAdmin, 'delete', `/api/tenants/current/members/${outsider.membershipInB}`);
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.body.code).toBe('MEMBER_NOT_FOUND');
    expect(await membershipOf(b.tenantId, outsider.id)).toEqual({ uuid: outsider.membershipInB, is_admin: true });
    const promoteElsewhere = await h.call(tenantAdmin, 'patch', `/api/tenants/current/members/${outsider.membershipInB}`, { isAdmin: false });
    expect(promoteElsewhere.status).toBe(404);
    expect((await membershipOf(b.tenantId, outsider.id)).is_admin).toBe(true);

    // The candidate joins the ledger, then is removed from it.
    const candidateMembership = (
      await h.owner.query<{ uuid: string }>('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2) RETURNING uuid', [a.tenantId, candidate.id])
    ).rows[0].uuid;
    const removed = await h.call(tenantAdmin, 'delete', `/api/tenants/current/members/${candidateMembership}`);
    expect(removed.status, removed.text).toBe(200);
    expect(await membershipOf(a.tenantId, candidate.id)).toBeUndefined();
    // Still in the organization, and every other membership of the ledger stays.
    const inOrg = await h.owner.query('SELECT 1 FROM organization_users WHERE organization_id = $1 AND user_id = $2', [a.organizationId, candidate.id]);
    expect(inOrg.rowCount).toBe(1);
    const left = await h.owner.query<{ user_id: number }>('SELECT user_id FROM tenant_users WHERE tenant_id = $1', [a.tenantId]);
    expect(left.rows.map((r) => r.user_id).sort()).toEqual([a.userId, member.id].sort());
  });

  it('answers a member uuid that is not one as an unknown member', async () => {
    for (const [verb, body] of [['patch', { isAdmin: true }], ['delete', undefined]] as const) {
      const res = await h.call(tenantAdmin, verb, '/api/tenants/current/members/not-a-uuid', body);
      // Refused before SQL sees it (a 500 otherwise).
      expect(res.status, res.text).toBe(404);
    }
  });

  it("sets a member's account flags for an organization admin, not for a ledger admin", async () => {
    const byTenantAdmin = await h.call(tenantAdmin, 'patch', `/api/tenants/current/members/${member.membership}/flags`, { loginDisabled: true });
    expect(byTenantAdmin.status).toBe(403);
    expect(byTenantAdmin.body.code).toBe('ORG_ADMIN_REQUIRED');

    const byOrgAdmin = await h.call(orgAdmin.session, 'patch', `/api/tenants/current/members/${member.membership}/flags`, { loginDisabled: true });
    expect(byOrgAdmin.status, byOrgAdmin.text).toBe(200);
    const flags = await h.owner.query('SELECT is_locked, login_disabled FROM users WHERE id = $1', [member.id]);
    expect(flags.rows[0]).toEqual({ is_locked: false, login_disabled: true });

    // Disabling sign-in ended the member's sessions.
    expect((await h.call(member.session, 'get', '/api/tenants/current')).status).toBe(401);

    const back = await h.call(orgAdmin.session, 'patch', `/api/tenants/current/members/${member.membership}/flags`, { loginDisabled: false });
    expect(back.status).toBe(200);
    member.session = await h.signIn(member.id, a.tenantId);
  });

  it("sets the balance-adjustment merchant only to one of this ledger's merchants", async () => {
    const own = (await a.pool.query<{ id: number; uuid: string }>(`INSERT INTO merchants (name) VALUES ('Adjustments A') RETURNING id, uuid`)).rows[0];
    const theirs = (await b.pool.query<{ uuid: string }>(`INSERT INTO merchants (name) VALUES ('Adjustments B') RETURNING uuid`)).rows[0];
    const adjustment = async () =>
      (await h.owner.query<{ m: number | null }>('SELECT balance_adjustment_merchant_id AS m FROM tenants WHERE id = $1', [a.tenantId])).rows[0].m;

    const foreign = await h.call(tenantAdmin, 'patch', '/api/tenants/current/balance-adjustment-merchant', { merchantUuid: theirs.uuid });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('MERCHANT_NOT_FOUND');
    expect(await adjustment()).toBeNull();

    const set = await h.call(tenantAdmin, 'patch', '/api/tenants/current/balance-adjustment-merchant', { merchantUuid: own.uuid });
    expect(set.status, set.text).toBe(200);
    expect(await adjustment()).toBe(own.id);

    const cleared = await h.call(tenantAdmin, 'patch', '/api/tenants/current/balance-adjustment-merchant', { merchantUuid: null });
    expect(cleared.status).toBe(200);
    expect(await adjustment()).toBeNull();
  });

  it('lists as the ledger\'s users its members and its organization\'s admins, nobody else', async () => {
    const res = await h.call(member.session, 'get', '/api/tenants/current/users');
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((u) => u.id).sort((x, y) => x - y);
    expect(ids).toEqual([a.userId, member.id, orgAdmin.id].sort((x, y) => x - y));
    // No addresses for a dropdown.
    expect(res.body[0]).not.toHaveProperty('email');
    // Exactly what the shared schema names.
    expect(answerProblem(tenantUserListResponseSchema, res.body)).toBeNull();
  });

  describe('organization members', () => {
    const orgPath = async () =>
      `/api/organizations/${(await h.owner.query<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [a.organizationId])).rows[0].uuid}`;

    it('keeps the organization at least one admin', async () => {
      const base = await orgPath();
      const demote = await h.call(orgAdmin.session, 'patch', `${base}/members/${orgAdmin.membership}`, { isAdmin: false });
      expect(demote.status).toBe(409);
      expect(demote.body.code).toBe('LAST_ADMIN');
      const remove = await h.call(orgAdmin.session, 'delete', `${base}/members/${orgAdmin.membership}`);
      expect(remove.status).toBe(409);
      expect(remove.body.code).toBe('LAST_ADMIN');
      const row = await h.owner.query('SELECT is_admin FROM organization_users WHERE uuid = $1', [orgAdmin.membership]);
      expect(row.rows[0]).toEqual({ is_admin: true });
    });

    it("lists the organization's own members, and refuses a ledger admin who isn't its admin", async () => {
      const base = await orgPath();
      const list = await h.call(orgAdmin.session, 'get', `${base}/members`);
      expect(list.status, list.text).toBe(200);
      const emails = (list.body as Array<{ user: { email: string } }>).map((m) => m.user.email);
      expect(emails).toContain(candidate.email);
      expect(emails).not.toContain(outsider.email);
      expect(emails).toHaveLength(4); // a's user, the member, the candidate, the org admin

      const asTenantAdmin = await h.call(tenantAdmin, 'get', `${base}/members`);
      expect(asTenantAdmin.status).toBe(403);
    });

    it("removes a member from the organization together with their ledger memberships in it", async () => {
      const base = await orgPath();
      const target = await h.addUser('leaving');
      const orgRow = (
        await h.owner.query<{ uuid: string }>(
          'INSERT INTO organization_users (organization_id, user_id) VALUES ($1, $2) RETURNING uuid',
          [a.organizationId, target.id]
        )
      ).rows[0];
      await h.owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [a.tenantId, target.id]);
      // Also in the other family's ledger, which this organization doesn't answer for.
      await h.owner.query('INSERT INTO organization_users (organization_id, user_id) VALUES ($1, $2)', [b.organizationId, target.id]);
      await h.owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [b.tenantId, target.id]);

      const res = await h.call(orgAdmin.session, 'delete', `${base}/members/${orgRow.uuid}`);
      expect(res.status, res.text).toBe(200);
      const left = await h.owner.query<{ tenant_id: number }>('SELECT tenant_id FROM tenant_users WHERE user_id = $1', [target.id]);
      expect(left.rows.map((r) => r.tenant_id)).toEqual([b.tenantId]);
      const orgs = await h.owner.query<{ organization_id: number }>('SELECT organization_id FROM organization_users WHERE user_id = $1', [target.id]);
      expect(orgs.rows.map((r) => r.organization_id)).toEqual([b.organizationId]);
    });
  });
});
