import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import http from 'http';
import { createHash, randomBytes } from 'crypto';
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
import { acceptInvitation } from '../services/InvitationService.js';
import { removeOrgMember, setOrgMemberAdmin } from '../services/OrganizationService.js';

/**
 * Organization membership through the real app. Organizations are families:
 * an admin of one must not reach the people of another. Two organizations, A and B,
 * each with a ledger and an admin, and people around them:
 * - people join an organization by accepting an invitation sent to their email, and
 *   nothing an admin does tells them whether an address has an account;
 * - a ledger takes only members of its organization;
 * - an org admin may change the global account flags only of someone the organization
 *   alone answers for;
 * - the user directories show only the active ledger's people, or are deployment-admin only;
 * - removing someone from an organization takes away the ledger access it gave them.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const CSRF_TOKEN = 'organization-membership-csrf-token';
const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** An error answer without its requestId, which is each request's own: the rest is what must match. */
const answer = (body: Record<string, unknown>) => {
  const { requestId, ...rest } = body;
  expect(requestId).toEqual(expect.any(String));
  return rest;
};

interface Person {
  id: number;
  uuid: string;
  email: string;
}

describeDb('Organization membership', () => {
  let server: http.Server;
  let owner: Pool;
  let a: TestTenant;
  let b: TestTenant;
  let aOrg: string;
  let bOrg: string;
  let aTenant: string;
  let bTenant: string;
  let deploymentAdmin: Person;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const extraUsers: number[] = [];
  const extraTenants: number[] = [];
  const sessions = new Map<number, { token: string; id: number }>();

  const first = async <T>(query: string, params: unknown[] = []): Promise<T> => (await owner.query(query, params)).rows[0];

  async function addUser(label: string, email = `membership-${label.toLowerCase()}-${stamp}@test.local`): Promise<Person> {
    const row = await first<{ id: number; uuid: string }>(
      `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Membership', $2) RETURNING id, uuid`,
      [email, label]
    );
    extraUsers.push(row.id);
    return { id: row.id, uuid: row.uuid, email };
  }
  const joinOrg = async (orgId: number, userId: number, isAdmin = false): Promise<string> =>
    (
      await first<{ uuid: string }>(
        'INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, $3) RETURNING uuid',
        [orgId, userId, isAdmin]
      )
    ).uuid;
  const joinTenant = async (tenantId: number, userId: number, isAdmin = false): Promise<string> =>
    (
      await first<{ uuid: string }>(
        'INSERT INTO tenant_users (tenant_id, user_id, is_admin) VALUES ($1, $2, $3) RETURNING uuid',
        [tenantId, userId, isAdmin]
      )
    ).uuid;
  const orgMemberUuid = async (orgId: number, userId: number) =>
    (await first<{ uuid: string }>('SELECT uuid FROM organization_users WHERE organization_id = $1 AND user_id = $2', [orgId, userId]))
      .uuid;

  /** A browser session for `userId`, acting in `tenantId` (or no ledger). */
  async function signIn(userId: number, tenantId: number | null) {
    const { token, sessionId } = await sessionService.createSession({ userId });
    await owner.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenantId, sessionId]);
    sessions.set(userId, { token, id: sessionId });
  }

  function as(userId: number) {
    const session = sessions.get(userId);
    if (!session) throw new Error(`No session for user ${userId}`);
    const send = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: object) => {
      const req = request(server)[method](url)
        .set('Cookie', `${SESSION_COOKIE_NAME}=${session.token}; csrf_token=${CSRF_TOKEN}`)
        .set('X-CSRF-Token', csrfTokenFor(session.token))
        .timeout(15_000);
      return body ? req.send(body) : req;
    };
    return {
      get: (url: string) => send('get', url),
      post: (url: string, body: object = {}) => send('post', url, body),
      patch: (url: string, body: object) => send('patch', url, body),
      delete: (url: string) => send('delete', url),
    };
  }
  const bearer = (token: string, url: string) => request(server).get(url).set('Authorization', `Bearer ${token}`);

  const invite = (adminId: number, orgUuid: string, email: string, isAdmin = false) =>
    as(adminId).post(`/api/organizations/${orgUuid}/invitations`, { email, isAdmin });
  const lockedState = async (userId: number) =>
    first<{ is_locked: boolean; login_disabled: boolean }>('SELECT is_locked, login_disabled FROM users WHERE id = $1', [userId]);

  beforeAll(async () => {
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    owner = new Pool({ connectionString, max: 2 });
    a = await createTestTenant('Membership A');
    b = await createTestTenant('Membership B');
    aOrg = (await first<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [a.organizationId])).uuid;
    bOrg = (await first<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [b.organizationId])).uuid;
    aTenant = (await first<{ uuid: string }>('SELECT uuid FROM tenants WHERE id = $1', [a.tenantId])).uuid;
    bTenant = (await first<{ uuid: string }>('SELECT uuid FROM tenants WHERE id = $1', [b.tenantId])).uuid;
    // Each fixture user administers their own organization.
    await joinOrg(a.organizationId, a.userId, true);
    await joinOrg(b.organizationId, b.userId, true);
    await signIn(a.userId, a.tenantId);
    await signIn(b.userId, b.tenantId);

    deploymentAdmin = await addUser('DeploymentAdmin');
    const made = await owner.query(
      `INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`,
      [deploymentAdmin.id]
    );
    if (made.rowCount !== 1) throw new Error('No deployment row to make the deployment admin a member of');
    await signIn(deploymentAdmin.id, a.tenantId);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!owner) return;
    try {
      const everyone = [...extraUsers, a?.userId, b?.userId].filter((id) => id != null);
      await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [everyone]);
      await owner.query('DELETE FROM personal_access_tokens WHERE user_id = ANY($1)', [everyone]);
      await owner.query('DELETE FROM deployment_users WHERE user_id = ANY($1)', [extraUsers]);
      await owner.query('DELETE FROM organization_users WHERE user_id = ANY($1)', [everyone]);
      await owner.query('DELETE FROM tenant_users WHERE user_id = ANY($1) OR tenant_id = ANY($2)', [extraUsers, extraTenants]);
      await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [extraTenants]);
      const settled = await Promise.allSettled([a?.cleanup(), b?.cleanup()]);
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [extraUsers]);
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      await owner.end();
    }
  }, 60_000);

  it("doesn't let another organization's admin add, look up or lock a user", async () => {
    // Before: B's admin added A's admin to B's organization by email (an unknown address
    // answered 404, so the call also told B which addresses have accounts), then locked
    // them out of the whole deployment. Adding directly is now for deployment admins.
    const added = await as(b.userId).post(`/api/organizations/${bOrg}/members`, { email: a.userEmail });
    const unknown = await as(b.userId).post(`/api/organizations/${bOrg}/members`, { email: `nobody-${stamp}@test.local` });
    expect([added.status, unknown.status]).toEqual([403, 403]);
    expect(answer(added.body)).toEqual(answer(unknown.body));
    // The directories that listed everyone: the import user list is now the ledger's
    // people only.
    const importUsers = await as(b.userId).get('/api/import/users').expect(200);
    expect((importUsers.body.users as Array<{ id: number }>).map((u) => u.id)).not.toContain(a.userId);
    expect(importUsers.text).not.toContain(a.userEmail);
    const users = await as(b.userId).get('/api/tenants/current/users').expect(200);
    const ids = (users.body as Array<{ id: number }>).map((u) => u.id);
    expect(ids).toContain(b.userId);
    expect(ids).not.toContain(a.userId);

    // Inviting is allowed, and joining B is A's own choice. Even then B can't lock A,
    // whose account A's organization answers for too.
    const invitation = await invite(b.userId, bOrg, a.userEmail).expect(201);
    expect(await first('SELECT 1 AS x FROM organization_users WHERE organization_id = $1 AND user_id = $2', [b.organizationId, a.userId]))
      .toBeUndefined();
    await as(a.userId).post('/api/invitations/accept', { token: invitation.body.token }).expect(200);
    const aInB = await orgMemberUuid(b.organizationId, a.userId);
    const lock = await as(b.userId).patch(`/api/organizations/${bOrg}/members/${aInB}/flags`, { isLocked: true });
    expect(lock.status).toBe(403);
    expect(lock.body.code).toBe('USER_OUTSIDE_ORG');
    expect(await lockedState(a.userId)).toEqual({ is_locked: false, login_disabled: false });
    await as(b.userId).delete(`/api/organizations/${bOrg}/members/${aInB}`).expect(200);
  });

  it('answers an invitation the same whatever the address, and keeps only a hash of its token', async () => {
    const outsider = await addUser('InviteOutsider');
    const answers = [
      await invite(a.userId, aOrg, `nobody-${stamp}@test.local`), // no account
      await invite(a.userId, aOrg, outsider.email), // an account in no organization of A's
      await invite(a.userId, aOrg, a.userEmail), // already a member
      await invite(a.userId, aOrg, `Mixed-Case-${stamp}@Test.Local`),
    ];
    const shape = (res: request.Response) => ({
      status: res.status,
      keys: Object.keys(res.body).sort(),
      invitationKeys: Object.keys(res.body.invitation ?? {}).sort(),
      invitation: { ...res.body.invitation, uuid: undefined, email: undefined, createdAt: undefined, expiresAt: undefined },
    });
    for (const res of answers) expect(shape(res)).toEqual(shape(answers[0]));
    expect(answers[0].status).toBe(201);
    expect(answers[0].body.invitation).toMatchObject({ status: 'pending', isAdmin: false, invitedBy: { lastName: 'Membership A' } });
    expect(answers.map((r) => r.body.invitation.email)).toEqual([
      `nobody-${stamp}@test.local`,
      outsider.email,
      a.userEmail,
      `mixed-case-${stamp}@test.local`,
    ]);
    const expires = new Date(answers[0].body.invitation.expiresAt).getTime() - Date.now();
    expect(expires).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(expires).toBeLessThan(7.1 * 24 * 3600 * 1000);

    for (const res of answers) {
      const { token, invitation } = res.body as { token: string; invitation: { uuid: string } };
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const row = await first<Record<string, unknown>>('SELECT * FROM organization_invitations WHERE uuid = $1', [invitation.uuid]);
      expect(row.token_hash).toBe(sha256(token));
      expect(JSON.stringify(row)).not.toContain(token);
    }

    // Listed for A's admins, without tokens; not for B's.
    const list = await as(a.userId).get(`/api/organizations/${aOrg}/invitations`).expect(200);
    const listed = (list.body as Array<{ uuid: string }>).map((i) => i.uuid);
    for (const res of answers) {
      expect(listed).toContain(res.body.invitation.uuid);
      expect(list.text).not.toContain(res.body.token);
    }
    expect((await as(b.userId).get(`/api/organizations/${aOrg}/invitations`)).status).toBe(403);

    // Inviting the same address again replaces the open invitation and its link.
    const again = await invite(a.userId, aOrg, outsider.email).expect(201);
    const relisted = (await as(a.userId).get(`/api/organizations/${aOrg}/invitations`)).body as Array<{ uuid: string; email: string }>;
    expect(relisted.filter((i) => i.email === outsider.email).map((i) => i.uuid)).toEqual([again.body.invitation.uuid]);
    await signIn(outsider.id, null);
    expect((await as(outsider.id).post('/api/invitations/inspect', { token: answers[1].body.token })).status).toBe(404);
    expect((await as(outsider.id).post('/api/invitations/inspect', { token: again.body.token })).status).toBe(200);

    // Revoking: gone from the list, its link stops working, and it can't be revoked twice.
    const revokeUrl = `/api/organizations/${aOrg}/invitations/${again.body.invitation.uuid}`;
    expect((await as(b.userId).delete(`/api/organizations/${bOrg}/invitations/${again.body.invitation.uuid}`)).status).toBe(404);
    await as(a.userId).delete(revokeUrl).expect(200);
    const afterRevoke = (await as(a.userId).get(`/api/organizations/${aOrg}/invitations`)).body as Array<{ uuid: string }>;
    expect(afterRevoke.map((i) => i.uuid)).not.toContain(again.body.invitation.uuid);
    expect((await as(outsider.id).post('/api/invitations/accept', { token: again.body.token })).status).toBe(404);
    expect((await as(a.userId).delete(revokeUrl)).status).toBe(404);
    expect(await first('SELECT 1 AS x FROM organization_users WHERE user_id = $1', [outsider.id])).toBeUndefined();
  });

  it('lets the invited person, signed in with that email, see the invitation and accept it once', async () => {
    // Stored with capitals: the address is compared without regard to case.
    const invitee = await addUser('Invitee', `Membership-Invitee-${stamp}@Test.Local`);
    await signIn(invitee.id, null); // no ledger yet
    const created = await invite(a.userId, aOrg, invitee.email, true).expect(201);
    expect(created.body.invitation.email).toBe(invitee.email.toLowerCase());
    const { token } = created.body as { token: string };

    const preview = await as(invitee.id).post('/api/invitations/inspect', { token }).expect(200);
    expect(preview.body).toMatchObject({
      organization: { uuid: aOrg },
      email: invitee.email.toLowerCase(),
      isAdmin: true,
      alreadyMember: false,
      invitedBy: { lastName: 'Membership A' },
    });
    expect(preview.body.organization.name).toMatch(/^Membership A org/);
    // Looking changes nothing.
    expect(await first('SELECT 1 AS x FROM organization_users WHERE user_id = $1', [invitee.id])).toBeUndefined();

    const accepted = await as(invitee.id).post('/api/invitations/accept', { token }).expect(200);
    expect(accepted.body).toEqual({ organization: { uuid: aOrg, name: preview.body.organization.name }, isAdmin: true });
    expect(
      await first('SELECT is_admin FROM organization_users WHERE organization_id = $1 AND user_id = $2', [a.organizationId, invitee.id])
    ).toEqual({ is_admin: true });
    const row = await first<{ accepted_at: Date | null; accepted_by: number | null; revoked_at: Date | null }>(
      'SELECT accepted_at, accepted_by, revoked_at FROM organization_invitations WHERE uuid = $1',
      [created.body.invitation.uuid]
    );
    expect(row.accepted_at).not.toBeNull();
    expect(row.accepted_by).toBe(invitee.id);
    expect(row.revoked_at).toBeNull();
    // An org admin now, so A's ledger is open to them; the invitation is no longer listed.
    const tenants = await as(invitee.id).get('/api/auth/tenants').expect(200);
    expect(tenants.text).toContain(aTenant);
    const list = (await as(a.userId).get(`/api/organizations/${aOrg}/invitations`)).body as Array<{ uuid: string }>;
    expect(list.map((i) => i.uuid)).not.toContain(created.body.invitation.uuid);

    // Once only.
    const reused = await as(invitee.id).post('/api/invitations/accept', { token });
    expect(reused.status).toBe(404);
    expect(reused.body.code).toBe('INVITATION_INVALID');
  });

  it('refuses an invitation for another email, expired, revoked, used, unknown or of a suspended organization alike', async () => {
    const target = await addUser('RefusalTarget');
    const other = await addUser('RefusalOther');
    await signIn(target.id, null);
    await signIn(other.id, null);
    const fresh = async () => (await invite(a.userId, aOrg, target.email).expect(201)).body as { token: string; invitation: { uuid: string } };

    const refusals: Array<[string, request.Response]> = [];
    // Another signed-in user, with a valid token.
    const forTarget = await fresh();
    refusals.push(['inspect, another email', await as(other.id).post('/api/invitations/inspect', { token: forTarget.token })]);
    refusals.push(['accept, another email', await as(other.id).post('/api/invitations/accept', { token: forTarget.token })]);
    // Expired.
    await owner.query("UPDATE organization_invitations SET expires_at = now() - interval '1 minute' WHERE uuid = $1", [
      forTarget.invitation.uuid,
    ]);
    refusals.push(['accept, expired', await as(target.id).post('/api/invitations/accept', { token: forTarget.token })]);
    // Revoked.
    const revoked = await fresh();
    await as(a.userId).delete(`/api/organizations/${aOrg}/invitations/${revoked.invitation.uuid}`).expect(200);
    refusals.push(['accept, revoked', await as(target.id).post('/api/invitations/accept', { token: revoked.token })]);
    // Unknown.
    const unknownToken = randomBytes(32).toString('base64url');
    refusals.push(['accept, unknown', await as(target.id).post('/api/invitations/accept', { token: unknownToken })]);
    // Its organization suspended by a deployment admin.
    const suspended = await fresh();
    await owner.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [a.organizationId]);
    try {
      refusals.push(['accept, suspended organization', await as(target.id).post('/api/invitations/accept', { token: suspended.token })]);
    } finally {
      await owner.query("UPDATE organizations SET status = 'active' WHERE id = $1", [a.organizationId]);
    }
    expect(await first('SELECT 1 AS x FROM organization_users WHERE user_id = ANY($1)', [[target.id, other.id]])).toBeUndefined();
    // Used: accepted once, then again.
    await as(target.id).post('/api/invitations/accept', { token: suspended.token }).expect(200);
    refusals.push(['accept, used', await as(target.id).post('/api/invitations/accept', { token: suspended.token })]);

    for (const [what, res] of refusals) {
      expect({ what, status: res.status, body: answer(res.body) }).toEqual({ what, status: 404, body: answer(refusals[0][1].body) });
    }
    expect(refusals[0][1].body.code).toBe('INVITATION_INVALID');
    // A token that can't be one is refused before any lookup.
    const malformed = await as(target.id).post('/api/invitations/accept', { token: 'not-a-token' });
    expect(malformed.status).toBe(400);
  });

  it("ends an invitation with its sender's admin rights", async () => {
    // b2 administers B, sends invitations, then is demoted.
    const b2 = await addUser('DemotedAdmin');
    await joinOrg(b.organizationId, b2.id, true);
    await signIn(b2.id, b.tenantId);
    const friend = await addUser('DemotedAdminsFriend');
    await signIn(friend.id, null);
    const selfInvite = (await invite(b2.id, bOrg, b2.email, true).expect(201)).body.token as string;
    const friendInvite = (await invite(b2.id, bOrg, friend.email, true).expect(201)).body.token as string;
    await as(b.userId).patch(`/api/organizations/${bOrg}/members/${await orgMemberUuid(b.organizationId, b2.id)}`, { isAdmin: false }).expect(200);

    // Neither invitation works any more: b2 can't make themselves an admin again, nor
    // bring anyone in.
    for (const [userId, token] of [[b2.id, selfInvite], [friend.id, friendInvite]] as const) {
      const res = await as(userId).post('/api/invitations/accept', { token });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INVITATION_INVALID');
    }
    expect(await first('SELECT is_admin FROM organization_users WHERE organization_id = $1 AND user_id = $2', [b.organizationId, b2.id])).toEqual({
      is_admin: false,
    });
    expect(await first('SELECT 1 AS x FROM organization_users WHERE user_id = $1', [friend.id])).toBeUndefined();
  });

  it('refuses an invitation whose sender is demoted while it is being accepted', async () => {
    const b3 = await addUser('DemotedMidAccept');
    await joinOrg(b.organizationId, b3.id, true);
    await signIn(b3.id, b.tenantId);
    const token = (await invite(b3.id, bOrg, b3.email, true).expect(201)).body.token as string;

    // Hold the invitation row, so the accept stops after its first check of the sender.
    const holder = await owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM organization_invitations WHERE token_hash = $1 FOR UPDATE', [sha256(token)]);
      const accepting = as(b3.id).post('/api/invitations/accept', { token }).then((r) => r);
      await new Promise((r) => setTimeout(r, 300));
      await as(b.userId).patch(`/api/organizations/${bOrg}/members/${await orgMemberUuid(b.organizationId, b3.id)}`, { isAdmin: false }).expect(200);
      await holder.query('COMMIT');
      const accepted = await accepting;
      expect(accepted.status).toBe(404);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await first('SELECT is_admin FROM organization_users WHERE organization_id = $1 AND user_id = $2', [b.organizationId, b3.id])).toEqual({
      is_admin: false,
    });
  });

  it('removes someone who is accepting an invitation at that moment, without a deadlock', async () => {
    // Straight to the services, so the two transactions overlap as closely as they can.
    const failures: string[] = [];
    for (let i = 0; i < 20; i++) {
      const x = await addUser(`RemoveWhileAccepting${i}`);
      await joinOrg(b.organizationId, x.id, false);
      const token = (await invite(b.userId, bOrg, x.email, true).expect(201)).body.token as string;
      const memberUuid = await orgMemberUuid(b.organizationId, x.id);
      const results = await Promise.allSettled([acceptInvitation(token, x.id), removeOrgMember(b.organizationId, memberUuid)]);
      for (const r of results) {
        // Losing the race is fine (the invitation is gone, or so is the member); a deadlock isn't.
        const code = r.status === 'rejected' ? (r.reason as { code?: string }).code : undefined;
        if (r.status === 'rejected' && code !== 'INVITATION_INVALID' && code !== 'MEMBER_NOT_FOUND') {
          failures.push(String(code ?? r.reason));
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps one admin when both admins of an organization are removed or demoted at once, without a deadlock', async () => {
    const failures: string[] = [];
    for (let i = 0; i < 20; i++) {
      // A fresh two-admin organization each time.
      const org = (
        await owner.query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`Two admins ${stamp} ${i}`])
      ).rows[0].id as number;
      const [x, y] = [await addUser(`TwoAdminsX${i}`), await addUser(`TwoAdminsY${i}`)];
      const [xm, ym] = [await joinOrg(org, x.id, true), await joinOrg(org, y.id, true)];
      const change = i % 2 === 0
        ? [removeOrgMember(org, xm), removeOrgMember(org, ym)]
        : [setOrgMemberAdmin(org, xm, false), setOrgMemberAdmin(org, ym, false)];
      for (const r of await Promise.allSettled(change)) {
        const code = r.status === 'rejected' ? (r.reason as { code?: string }).code : undefined;
        if (r.status === 'rejected' && code !== 'LAST_ADMIN') failures.push(String(code ?? r.reason));
      }
      const admins = await first<{ n: number }>('SELECT COUNT(*)::int AS n FROM organization_users WHERE organization_id = $1 AND is_admin', [org]);
      if (admins.n !== 1) failures.push(`round ${i}: ${admins.n} admins`);
      await owner.query('DELETE FROM organization_users WHERE organization_id = $1', [org]);
      await owner.query('DELETE FROM organizations WHERE id = $1', [org]);
    }
    expect(failures).toEqual([]);
  });

  it("rate-limits the invited person's side", async () => {
    const guesser = await addUser('Guesser');
    await signIn(guesser.id, null);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await as(guesser.id).post(i % 2 ? '/api/invitations/accept' : '/api/invitations/inspect', {
        token: randomBytes(32).toString('base64url'),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(404));
    expect(statuses[20]).toBe(429);
    // Per person: someone else isn't held back by it.
    expect((await as(a.userId).post('/api/invitations/inspect', { token: randomBytes(32).toString('base64url') })).status).toBe(404);
  });

  it('adds to a ledger only members of its organization, with one answer for everyone else', async () => {
    const candidate = await addUser('LedgerCandidate');
    await signIn(candidate.id, null);
    const notMember = await as(a.userId).post('/api/tenants/current/members', { email: candidate.email });
    const noAccount = await as(a.userId).post('/api/tenants/current/members', { email: `nobody-ledger-${stamp}@test.local` });
    expect(notMember.status).toBe(404);
    expect(answer(notMember.body)).toEqual(answer(noAccount.body));
    expect(notMember.body.code).toBe('NOT_ORG_MEMBER');
    // B's admin is in another organization: not addable to A's ledger either.
    expect(answer((await as(a.userId).post('/api/tenants/current/members', { email: b.userEmail })).body)).toEqual(answer(noAccount.body));
    const emailsOf = (res: request.Response) => (res.body as Array<{ email: string }>).map((c) => c.email);
    const before = await as(a.userId).get('/api/tenants/current/member-candidates').expect(200);
    expect(emailsOf(before)).not.toContain(candidate.email);
    expect(emailsOf(before)).not.toContain(b.userEmail);
    expect(emailsOf(before)).not.toContain(a.userEmail); // already in the ledger

    const { token } = (await invite(a.userId, aOrg, candidate.email).expect(201)).body as { token: string };
    await as(candidate.id).post('/api/invitations/accept', { token }).expect(200);
    const offered = await as(a.userId).get('/api/tenants/current/member-candidates').expect(200);
    expect(offered.body).toContainEqual({ userUuid: candidate.uuid, email: candidate.email, firstName: 'Membership', lastName: 'LedgerCandidate' });
    // The address is matched without regard to case.
    const added = await as(a.userId).post('/api/tenants/current/members', { email: candidate.email.toUpperCase() }).expect(201);
    expect(added.body.user.uuid).toBe(candidate.uuid);
    expect(emailsOf(await as(a.userId).get('/api/tenants/current/member-candidates'))).not.toContain(candidate.email);
    const twice = await as(a.userId).post('/api/tenants/current/members', { email: candidate.email });
    expect([twice.status, twice.body.code]).toEqual([409, 'ALREADY_MEMBER']);
  });

  it("doesn't add someone to a ledger while they're being removed from its organization", async () => {
    const racer = await addUser('Racer');
    const racerInA = await joinOrg(a.organizationId, racer.id);
    // A removal in progress: it holds the membership row, as removeOrgMember does.
    const removal = await owner.connect();
    try {
      await removal.query('BEGIN');
      await removal.query('SELECT id FROM organization_users WHERE uuid = $1 FOR UPDATE', [racerInA]);
      const adding = as(a.userId).post('/api/tenants/current/members', { email: racer.email }).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await removal.query('DELETE FROM organization_users WHERE uuid = $1', [racerInA]);
      await removal.query('COMMIT');
      const res = await adding;
      expect([res.status, res.body.code]).toEqual([404, 'NOT_ORG_MEMBER']);
    } finally {
      await removal.query('ROLLBACK').catch(() => undefined);
      removal.release();
    }
    expect(await first('SELECT 1 AS x FROM tenant_users WHERE user_id = $1', [racer.id])).toBeUndefined();
  });

  it('lets an org admin change sign-in only for someone the organization alone answers for', async () => {
    const solo = await addUser('FlagsSolo'); // in A's organization and ledger only
    const dual = await addUser('FlagsDual'); // in A's and B's organizations
    const crossTenant = await addUser('FlagsCrossLedger'); // in A's organization, and a member of B's ledger
    const alsoAdmin = await addUser('FlagsDeploymentAdmin'); // a deployment admin, in A's organization
    const members: Record<string, string> = {};
    for (const [name, person] of Object.entries({ solo, dual, crossTenant, alsoAdmin })) {
      members[name] = await joinOrg(a.organizationId, person.id);
    }
    const soloTenantMember = await joinTenant(a.tenantId, solo.id);
    const dualTenantMember = await joinTenant(a.tenantId, dual.id);
    await joinOrg(b.organizationId, dual.id);
    await joinTenant(b.tenantId, crossTenant.id);
    await owner.query(
      `INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`,
      [alsoAdmin.id]
    );
    const orgFlags = (actor: number, member: string, body: object) =>
      as(actor).patch(`/api/organizations/${aOrg}/members/${member}/flags`, body);

    for (const name of ['dual', 'crossTenant', 'alsoAdmin']) {
      for (const body of [{ isLocked: true }, { loginDisabled: true }, { isLocked: false }]) {
        const res = await orgFlags(a.userId, members[name], body);
        expect({ name, body, status: res.status, code: res.body.code }).toEqual({ name, body, status: 403, code: 'USER_OUTSIDE_ORG' });
      }
    }
    // The same through the ledger's member list.
    const viaTenant = await as(a.userId).patch(`/api/tenants/current/members/${dualTenantMember}/flags`, { isLocked: true });
    expect([viaTenant.status, viaTenant.body.code]).toEqual([403, 'USER_OUTSIDE_ORG']);
    for (const person of [dual, crossTenant, alsoAdmin]) {
      expect(await lockedState(person.id)).toEqual({ is_locked: false, login_disabled: false });
    }

    // Never one's own account.
    const self = await orgFlags(a.userId, await orgMemberUuid(a.organizationId, a.userId), { isLocked: true });
    expect([self.status, self.body.code]).toEqual([400, 'CANNOT_RESTRICT_SELF']);

    // Someone only A's organization answers for: allowed, and their sessions end.
    await signIn(solo.id, a.tenantId);
    await as(solo.id).get('/api/tenants/current').expect(200);
    await orgFlags(a.userId, members.solo, { isLocked: true }).expect(200);
    expect(await lockedState(solo.id)).toEqual({ is_locked: true, login_disabled: false });
    expect((await as(solo.id).get('/api/tenants/current')).status).toBe(401);
    await as(a.userId).patch(`/api/tenants/current/members/${soloTenantMember}/flags`, { isLocked: false }).expect(200);
    expect(await lockedState(solo.id)).toEqual({ is_locked: false, login_disabled: false });

    // A deployment admin may, for anyone.
    await orgFlags(deploymentAdmin.id, members.dual, { loginDisabled: true }).expect(200);
    expect(await lockedState(dual.id)).toEqual({ is_locked: false, login_disabled: true });
    await orgFlags(deploymentAdmin.id, members.dual, { loginDisabled: false }).expect(200);
  });

  it('lists for a ledger only the people who can open it', async () => {
    const tenantMember = await addUser('ListLedgerMember');
    const orgAdmin = await addUser('ListOrgAdmin');
    const orgOnly = await addUser('ListOrgOnly');
    await joinTenant(a.tenantId, tenantMember.id);
    await joinOrg(a.organizationId, orgAdmin.id, true);
    await joinOrg(a.organizationId, orgOnly.id); // an org member grants no ledger access
    const res = await as(a.userId).get('/api/tenants/current/users').expect(200);
    const ids = (res.body as Array<{ id: number }>).map((u) => u.id);
    expect(ids).toEqual(expect.arrayContaining([a.userId, tenantMember.id, orgAdmin.id]));
    for (const outside of [orgOnly.id, b.userId, deploymentAdmin.id]) expect(ids).not.toContain(outside);
    expect(res.text).not.toContain('@'); // no emails here
    // The import user is picked from the same people, by the organization's admins.
    const importUsers = await as(a.userId).get('/api/import/users').expect(200);
    const importIds = (importUsers.body.users as Array<{ id: number }>).map((u) => u.id);
    expect(importIds).toEqual(expect.arrayContaining([a.userId, tenantMember.id, orgAdmin.id]));
    for (const outside of [orgOnly.id, b.userId, deploymentAdmin.id]) expect(importIds).not.toContain(outside);
    await signIn(tenantMember.id, a.tenantId);
    expect((await as(tenantMember.id).get('/api/import/users')).status).toBe(403);
  });

  it("removes someone's ledger memberships and tokens in the organization along with them", async () => {
    const leaver = await addUser('Leaver');
    const leaverInA = await joinOrg(a.organizationId, leaver.id);
    const secondTenant = (
      await first<{ id: number }>('INSERT INTO tenants (organization_id, name) VALUES ($1, $2) RETURNING id', [
        a.organizationId,
        `Membership A second ${stamp}`,
      ])
    ).id;
    extraTenants.push(secondTenant);
    await joinTenant(a.tenantId, leaver.id);
    await joinTenant(secondTenant, leaver.id);
    await joinTenant(b.tenantId, leaver.id); // another organization's ledger: not A's to take away
    await signIn(leaver.id, a.tenantId);
    const mint = async (tenantUuid: string) =>
      (await as(leaver.id).post('/api/auth/mcp-token', { tenantUuid, label: 'membership' }).expect(201)).body as {
        token: string;
        uuid: string;
      };
    const tokenA = await mint(aTenant);
    const tokenB = await mint(bTenant);
    await bearer(tokenA.token, '/api/accounts').expect(200);
    // An invitation still open in A's organization can't bring them back.
    const reinvite = (await invite(a.userId, aOrg, leaver.email).expect(201)).body as { token: string };

    await as(a.userId).delete(`/api/organizations/${aOrg}/members/${leaverInA}`).expect(200);

    const memberships = await owner.query<{ tenant_id: number }>('SELECT tenant_id FROM tenant_users WHERE user_id = $1', [leaver.id]);
    expect(memberships.rows.map((r) => r.tenant_id)).toEqual([b.tenantId]);
    const tokens = await owner.query<{ uuid: string; revoked_at: Date | null; revoked_reason: string | null }>(
      'SELECT uuid, revoked_at, revoked_reason FROM personal_access_tokens WHERE user_id = $1',
      [leaver.id]
    );
    const byUuid = Object.fromEntries(tokens.rows.map((t) => [t.uuid, t]));
    expect(byUuid[tokenA.uuid].revoked_at).not.toBeNull();
    expect(byUuid[tokenA.uuid].revoked_reason).toBe('removed_from_organization');
    expect(byUuid[tokenB.uuid].revoked_at).toBeNull();
    expect((await bearer(tokenA.token, '/api/accounts')).status).toBe(401);
    await bearer(tokenB.token, '/api/accounts').expect(200);
    expect((await as(leaver.id).post('/api/invitations/accept', { token: reinvite.token })).status).toBe(404);
    // Their browser session still points at A's ledger: the next request is refused and
    // clears it (requireTenantMember), rather than the removal touching sessions.
    expect((await as(leaver.id).get('/api/accounts')).status).toBe(403);
    const session = await first<{ active_tenant_id: number | null }>('SELECT active_tenant_id FROM sessions WHERE id = $1', [
      sessions.get(leaver.id)!.id,
    ]);
    expect(session.active_tenant_id).toBeNull();
  });

  // Removing someone from an organization deletes their ledger memberships in it: refused,
  // as removing or demoting a ledger's last admin is, while they're the only admin of one
  // (a deleted ledger needs none, and another organization's isn't touched).
  it('refuses to remove the only admin of one of its ledgers, naming them', async () => {
    const keeper = await addUser('SoleLedgerAdmin');
    const other = await addUser('OtherLedgerAdmin');
    const keeperInA = await joinOrg(a.organizationId, keeper.id);
    await joinOrg(a.organizationId, other.id);
    const newTenant = async (label: string, status = 'active') => {
      const tenant = await first<{ id: number; uuid: string; name: string }>(
        'INSERT INTO tenants (organization_id, name, status) VALUES ($1, $2, $3) RETURNING id, uuid, name',
        [a.organizationId, `Membership A ${label} ${stamp}`, status]
      );
      extraTenants.push(tenant.id);
      return tenant;
    };
    const soleOne = await newTenant('sole one');
    const soleTwo = await newTenant('sole two');
    const shared = await newTenant('shared');
    const deleted = await newTenant('deleted', 'deleted');
    await joinTenant(soleOne.id, keeper.id, true);
    await joinTenant(soleOne.id, other.id); // a member, not an admin
    await joinTenant(soleTwo.id, keeper.id, true);
    await joinTenant(shared.id, keeper.id, true);
    await joinTenant(shared.id, other.id, true);
    await joinTenant(deleted.id, keeper.id, true);
    await joinTenant(b.tenantId, keeper.id, true); // another organization's ledger
    const tenantsOf = async (userId: number) =>
      (await owner.query<{ tenant_id: number }>('SELECT tenant_id FROM tenant_users WHERE user_id = $1 ORDER BY tenant_id', [userId])).rows.map(
        (r) => r.tenant_id
      );
    const before = await tenantsOf(keeper.id);

    const refused = await as(a.userId).delete(`/api/organizations/${aOrg}/members/${keeperInA}`);
    expect(refused.status, refused.text).toBe(409);
    const reason = `This member is the only admin of the tenants "${soleOne.name}", "${soleTwo.name}" in this organization. Make someone else an admin of each first.`;
    expect(answer(refused.body)).toEqual({
      code: 'LAST_ADMIN',
      error: reason,
      message: reason,
      tenants: [
        { uuid: soleOne.uuid, name: soleOne.name },
        { uuid: soleTwo.uuid, name: soleTwo.name },
      ],
    });
    expect(await orgMemberUuid(a.organizationId, keeper.id)).toBe(keeperInA);
    expect(await tenantsOf(keeper.id)).toEqual(before);

    // One left: named alone.
    await owner.query('UPDATE tenant_users SET is_admin = true WHERE tenant_id = $1 AND user_id = $2', [soleOne.id, other.id]);
    const oneLeft = await as(a.userId).delete(`/api/organizations/${aOrg}/members/${keeperInA}`);
    expect([oneLeft.status, oneLeft.body.code, oneLeft.body.tenants]).toEqual([409, 'LAST_ADMIN', [{ uuid: soleTwo.uuid, name: soleTwo.name }]]);
    expect(oneLeft.body.error).toBe(
      `This member is the only admin of the tenant "${soleTwo.name}" in this organization. Make someone else an admin of it first.`
    );

    await joinTenant(soleTwo.id, other.id, true);
    await as(a.userId).delete(`/api/organizations/${aOrg}/members/${keeperInA}`).expect(200);
    expect(await tenantsOf(keeper.id)).toEqual([b.tenantId]);
  });

  it('still lets a deployment admin add an existing user to an organization directly', async () => {
    const direct = await addUser('DirectAdd');
    const res = await as(deploymentAdmin.id).post(`/api/organizations/${bOrg}/members`, { email: direct.email }).expect(201);
    expect(res.body.user.uuid).toBe(direct.uuid);
    expect(await first('SELECT is_admin FROM organization_users WHERE organization_id = $1 AND user_id = $2', [b.organizationId, direct.id]))
      .toEqual({ is_admin: false });
  });
});
