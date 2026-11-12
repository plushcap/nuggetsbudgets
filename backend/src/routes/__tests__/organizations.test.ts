import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { answerProblem, createdTenantResponseSchema } from '@nuggets/shared';
import { createOrganizationRoutes } from '../organizations.js';
import { rejectMalformedIds } from '../../middleware/routeParams.js';
import { assertOrgAdmin } from '../../services/OrganizationService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

vi.mock('../../services/OrganizationService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/OrganizationService.js')>();
  return { ...actual, assertOrgAdmin: vi.fn(actual.assertOrgAdmin) };
});

/**
 * The organization routes authorize in the router's `uuid` param handler, which runs
 * before each route's own body validation. Who may call each route is covered by
 * route-authorization.test.ts; this checks that the check comes before validation and
 * always answers, that the handlers act on the organization in the URL, and that an
 * org admin can't reach another organization's members through their own org's URL.
 */
describe('Organization routes', () => {
  let app: Express;
  let tenant: TestTenant;
  let otherOrg: TestTenant;
  let owner: Pool;
  let orgUuid: string;
  let otherMemberUuid: string;

  const setOrgAdmin = (isAdmin: boolean) =>
    owner.query('UPDATE organization_users SET is_admin = $1 WHERE organization_id = $2 AND user_id = $3', [
      isAdmin,
      tenant.organizationId,
      tenant.userId,
    ]);

  beforeAll(async () => {
    tenant = await createTestTenant('Organization routes');
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
    await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true)', [
      tenant.organizationId,
      tenant.userId,
    ]);
    orgUuid = (
      await owner.query<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [tenant.organizationId])
    ).rows[0].uuid;
    // An admin of another organization, whose membership the tests try to reach.
    otherOrg = await createTestTenant('Organization routes other org');
    otherMemberUuid = (
      await owner.query<{ uuid: string }>(
        'INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true) RETURNING uuid',
        [otherOrg.organizationId, otherOrg.userId]
      )
    ).rows[0].uuid;

    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/organizations', rejectMalformedIds(createOrganizationRoutes())); // as routes.ts mounts it
  });

  afterAll(async () => {
    if (!owner) return; // createTestTenant failed and cleaned up after itself
    try {
      // Ledgers the tests created in the organization, then the membership added above.
      const created = `SELECT id FROM tenants WHERE organization_id = $1 AND id <> $2`;
      await owner.query(`DELETE FROM tenant_users WHERE tenant_id IN (${created})`, [tenant.organizationId, tenant.tenantId]);
      await owner.query(`DELETE FROM tenants WHERE id IN (${created})`, [tenant.organizationId, tenant.tenantId]);
      await owner.query('DELETE FROM organization_users WHERE organization_id = ANY($1)', [
        [tenant.organizationId, otherOrg?.organizationId],
      ]);
      // Clean up both ledgers even if one fails, then report the failure.
      const settled = await Promise.allSettled([otherOrg?.cleanup(), tenant.cleanup()]);
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      await owner.end();
    }
  });

  it('renames the organization in the URL for its admin', async () => {
    await request(app).patch(`/api/organizations/${orgUuid}`).send({ name: 'Renamed org' }).expect(200);
    const row = await owner.query('SELECT name FROM organizations WHERE id = $1', [tenant.organizationId]);
    expect(row.rows[0].name).toBe('Renamed org');
  });

  it("doesn't let an org admin change the organization's status", async () => {
    for (const body of [{ status: 'active' }, { name: 'Renamed again', status: 'suspended' }]) {
      const res = await request(app).patch(`/api/organizations/${orgUuid}`).send(body).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    const row = await owner.query('SELECT name, status FROM organizations WHERE id = $1', [tenant.organizationId]);
    expect(row.rows[0]).toEqual({ name: 'Renamed org', status: 'active' });
  });

  it('closes an organization a deployment admin suspended or deleted to its own admins', async () => {
    try {
      for (const status of ['suspended', 'deleted']) {
        await owner.query('UPDATE organizations SET status = $1 WHERE id = $2', [status, tenant.organizationId]);
        for (const [method, path, body] of [
          ['get', `/api/organizations/${orgUuid}`, undefined],
          ['patch', `/api/organizations/${orgUuid}`, { name: 'Back again' }],
          ['post', `/api/organizations/${orgUuid}/tenants`, { name: 'Another ledger' }],
        ] as const) {
          const res = await request(app)[method](path).send(body).expect(403);
          expect(res.body.code).toBe('ORG_NOT_ACTIVE');
        }
        const row = await owner.query('SELECT name, status FROM organizations WHERE id = $1', [tenant.organizationId]);
        expect(row.rows[0]).toEqual({ name: 'Renamed org', status });
      }
      // Someone who isn't its admin learns nothing about its status.
      await setOrgAdmin(false);
      const res = await request(app).get(`/api/organizations/${orgUuid}`).expect(403);
      expect(res.body.code).toBe('ORG_ADMIN_REQUIRED');
    } finally {
      await setOrgAdmin(true);
      await owner.query("UPDATE organizations SET status = 'active' WHERE id = $1", [tenant.organizationId]);
    }
  });

  it('creates a ledger in the organization in the URL', async () => {
    const res = await request(app).post(`/api/organizations/${orgUuid}/tenants`).send({ name: 'Second ledger' }).expect(201);
    expect(answerProblem(createdTenantResponseSchema, res.body)).toBeNull();
    const row = await owner.query('SELECT organization_id FROM tenants WHERE uuid = $1', [res.body.uuid]);
    expect(row.rows[0].organization_id).toBe(tenant.organizationId);
  });

  it('answers 404 for an unknown organization before validating the body', async () => {
    const res = await request(app)
      .post('/api/organizations/00000000-0000-0000-0000-000000000000/tenants')
      .send({})
      .expect(404);
    expect(res.body.code).toBe('ORG_NOT_FOUND');
  });

  it('answers 403 to a caller who is not an admin before validating the body', async () => {
    await setOrgAdmin(false);
    try {
      const res = await request(app).post(`/api/organizations/${orgUuid}/tenants`).send({}).expect(403);
      expect(res.body.code).toBe('ORG_ADMIN_REQUIRED');
    } finally {
      await setOrgAdmin(true);
    }
  });

  it('answers 404 for a malformed organization uuid', async () => {
    const res = await request(app).get('/api/organizations/not-a-uuid').timeout(5000).expect(404);
    expect(res.body.code).toBe('ORG_NOT_FOUND');
  });

  it('answers an unexpected failure of the check with a 500 rather than leaving the request open', async () => {
    vi.mocked(assertOrgAdmin).mockRejectedValueOnce(new Error('connection terminated'));
    await request(app).get(`/api/organizations/${orgUuid}`).timeout(5000).expect(500);
  });

  it('answers a falsy rejection from the check with a 500 rather than running the route', async () => {
    vi.mocked(assertOrgAdmin).mockRejectedValueOnce(undefined);
    await request(app).get(`/api/organizations/${orgUuid}/members`).timeout(5000).expect(500);
  });

  it("doesn't let an org admin change or remove another organization's member", async () => {
    const base = `/api/organizations/${orgUuid}/members/${otherMemberUuid}`;
    const attempts = [
      request(app).patch(base).send({ isAdmin: false }),
      request(app).patch(`${base}/flags`).send({ isLocked: true }),
      request(app).delete(base),
    ];
    for (const attempt of attempts) {
      const res = await attempt.expect(404);
      expect(res.body.code).toBe('MEMBER_NOT_FOUND');
    }
    const member = await owner.query(
      `SELECT ou.is_admin, u.is_locked FROM organization_users ou JOIN users u ON u.id = ou.user_id WHERE ou.uuid = $1`,
      [otherMemberUuid]
    );
    expect(member.rows).toEqual([{ is_admin: true, is_locked: false }]);
  });

  // These reached SQL, which refused the uuid: a 500.
  it('answers 404 MEMBER_NOT_FOUND for a malformed member uuid', async () => {
    const base = `/api/organizations/${orgUuid}/members/not-a-uuid`;
    for (const attempt of [
      request(app).patch(base).send({ isAdmin: false }),
      request(app).patch(`${base}/flags`).send({ isLocked: true }),
      request(app).delete(base),
    ]) {
      const res = await attempt.timeout(5000).expect(404);
      expect(res.body.code).toBe('MEMBER_NOT_FOUND');
    }
  });

  it('checks the caller is an admin before it looks at the member uuid', async () => {
    await setOrgAdmin(false);
    try {
      const res = await request(app).delete(`/api/organizations/${orgUuid}/members/not-a-uuid`).expect(403);
      expect(res.body.code).toBe('ORG_ADMIN_REQUIRED');
    } finally {
      await setOrgAdmin(true);
    }
  });

  it('still validates the body for an admin', async () => {
    const res = await request(app).post(`/api/organizations/${orgUuid}/tenants`).send({}).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
