import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createTagsRoutes } from '../tags.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Integration tests for report-namespace endpoints.
 *
 * Requires DATABASE_URL pointing at a database that has the
 * tag report namespaces (the baseline schema does).
 *
 * Input-validation tests run without fixtures. Happy-path tests
 * for namespace tagging create real fixtures and clean up after.
 */
describe('Tags: report namespaces', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Tags report namespaces');
    pool = tenant.pool;
    // The namespace tests tag a budget item, so the tenant needs an active one.
    await pool.query(`INSERT INTO budget_items (name, status) VALUES ('NS fixture item', 'active')`);

    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/tags', createTagsRoutes());
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  describe('PUT /api/tags/:uuid/report-root', () => {
    it('returns 400 when is_report_root is missing', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000000';
      const res = await request(app)
        .put(`/api/tags/${fakeUuid}/report-root`)
        .send({})
        .expect(400);
      expect(res.body.message).toContain('is_report_root');
    });

    it('returns 400 when report_flow_measure is invalid', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000000';
      const res = await request(app)
        .put(`/api/tags/${fakeUuid}/report-root`)
        .send({ is_report_root: true, report_flow_measure: 'bogus' })
        .expect(400);
      expect(res.body.message).toContain('report_flow_measure');
    });

    it('returns 404 for non-existent tag', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000000';
      await request(app)
        .put(`/api/tags/${fakeUuid}/report-root`)
        .send({ is_report_root: true })
        .expect(404);
    });

    it('marks a top-level tag as a report root and persists flow_measure', async () => {
      const created = await request(app)
        .post('/api/tags')
        .send({ name: 'NS Test Root', color: '#FF8800', icon: 'Layers' })
        .expect(201);
      const uuid = created.body.uuid;

      try {
        const res = await request(app)
          .put(`/api/tags/${uuid}/report-root`)
          .send({ is_report_root: true, report_flow_measure: 'actual' })
          .expect(200);
        expect(res.body.is_report_root).toBe(true);
        expect(res.body.report_flow_measure).toBe('actual');
      } finally {
        await request(app).delete(`/api/tags/${uuid}`);
      }
    });

    it('rejects marking a non-level-0 tag as report root', async () => {
      const parent = await request(app)
        .post('/api/tags')
        .send({ name: 'NS Parent', color: '#FF0000', icon: 'Tag' })
        .expect(201);
      const child = await request(app)
        .post('/api/tags')
        .send({ name: 'NS Child', color: '#00FF00', icon: 'Tag', parent_id: parent.body.id })
        .expect(201);

      try {
        await request(app)
          .put(`/api/tags/${child.body.uuid}/report-root`)
          .send({ is_report_root: true })
          .expect(400);
      } finally {
        await request(app).delete(`/api/tags/${child.body.uuid}`);
        await request(app).delete(`/api/tags/${parent.body.uuid}`);
      }
    });
  });

  describe('GET /api/tags/report-roots', () => {
    it('returns an array (possibly empty) without 500ing', async () => {
      const res = await request(app)
        .get('/api/tags/report-roots')
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('includes a tag after it is marked as a report root', async () => {
      const created = await request(app)
        .post('/api/tags')
        .send({ name: 'NS Discoverable', color: '#3366FF', icon: 'Compass' })
        .expect(201);
      const uuid = created.body.uuid;

      try {
        await request(app)
          .put(`/api/tags/${uuid}/report-root`)
          .send({ is_report_root: true })
          .expect(200);

        const res = await request(app)
          .get('/api/tags/report-roots')
          .expect(200);
        const found = res.body.find((t: { uuid: string }) => t.uuid === uuid);
        expect(found).toBeDefined();
        expect(found.report_flow_measure).toBe('effective');
      } finally {
        await request(app).delete(`/api/tags/${uuid}`);
      }
    });
  });

  describe('PUT /api/tags/budget-items/:uuid/namespace/:rootTagUuid', () => {
    it('returns 404 for non-existent budget item', async () => {
      const fakeBudgetUuid = '00000000-0000-0000-0000-000000000000';
      const fakeRootUuid = '00000000-0000-0000-0000-000000000001';
      await request(app)
        .put(`/api/tags/budget-items/${fakeBudgetUuid}/namespace/${fakeRootUuid}`)
        .send({ tag_uuid: null })
        .expect(404);
    });

    it('rejects when rootTagUuid is not a report root', async () => {
      // Create a tag but DON'T mark it as a report root, then try to use it as one.
      const nonRoot = await request(app)
        .post('/api/tags')
        .send({ name: 'NS Not A Root', color: '#888888', icon: 'Tag' })
        .expect(201);

      const budgetItem = await pool.query(
        "SELECT uuid FROM budget_items WHERE status = 'active' LIMIT 1"
      );

      try {
        await request(app)
          .put(`/api/tags/budget-items/${budgetItem.rows[0].uuid}/namespace/${nonRoot.body.uuid}`)
          .send({ tag_uuid: null })
          .expect(400);
      } finally {
        await request(app).delete(`/api/tags/${nonRoot.body.uuid}`);
      }
    });

    it('full round-trip: set, conflict, replace, clear', async () => {
      const budgetItem = await pool.query(
        "SELECT id, uuid FROM budget_items WHERE status = 'active' LIMIT 1"
      );
      const budgetItemUuid = budgetItem.rows[0].uuid;

      // Build a tiny namespace: root + two leaves
      const root = await request(app)
        .post('/api/tags')
        .send({ name: 'NS Roundtrip Root', color: '#AAAAAA', icon: 'Layers' })
        .expect(201);
      const leafA = await request(app)
        .post('/api/tags')
        .send({ name: 'NS Roundtrip A', color: '#BBBBBB', icon: 'Tag', parent_id: root.body.id })
        .expect(201);
      const leafB = await request(app)
        .post('/api/tags')
        .send({ name: 'NS Roundtrip B', color: '#CCCCCC', icon: 'Tag', parent_id: root.body.id })
        .expect(201);

      try {
        await request(app)
          .put(`/api/tags/${root.body.uuid}/report-root`)
          .send({ is_report_root: true, report_flow_measure: 'effective' })
          .expect(200);

        // Set leafA in the namespace
        const setRes = await request(app)
          .put(`/api/tags/budget-items/${budgetItemUuid}/namespace/${root.body.uuid}`)
          .send({ tag_uuid: leafA.body.uuid })
          .expect(200);
        expect(setRes.body.tagging).toBeTruthy();
        expect(setRes.body.tagging.tag_id).toBe(leafA.body.id);

        // Trying to POST leafB directly via the legacy endpoint must hit
        // the unique partial index and return structured NAMESPACE_CONFLICT.
        const conflictRes = await request(app)
          .post(`/api/tags/budget-items/${budgetItemUuid}/tags`)
          .send({ tag_id: leafB.body.id })
          .expect(409);
        expect(conflictRes.body.code).toBe('NAMESPACE_CONFLICT');

        // Re-adding the tag that already holds the namespace is a plain duplicate.
        const duplicateRes = await request(app)
          .post(`/api/tags/budget-items/${budgetItemUuid}/tags`)
          .send({ tag_id: leafA.body.id })
          .expect(409);
        expect(duplicateRes.body.error).toBe('Duplicate tag');

        // Replace via the namespace endpoint (this should NOT conflict)
        const replaceRes = await request(app)
          .put(`/api/tags/budget-items/${budgetItemUuid}/namespace/${root.body.uuid}`)
          .send({ tag_uuid: leafB.body.uuid })
          .expect(200);
        expect(replaceRes.body.tagging.tag_id).toBe(leafB.body.id);

        // Clear
        const clearRes = await request(app)
          .put(`/api/tags/budget-items/${budgetItemUuid}/namespace/${root.body.uuid}`)
          .send({ tag_uuid: null })
          .expect(200);
        expect(clearRes.body.tagging).toBeNull();
      } finally {
        // Clean up
        await pool.query(
          "DELETE FROM taggings WHERE taggable_type = 'budget_item' AND taggable_id = $1 AND tag_id IN ($2, $3)",
          [budgetItem.rows[0].id, leafA.body.id, leafB.body.id]
        );
        await request(app).delete(`/api/tags/${leafA.body.uuid}`);
        await request(app).delete(`/api/tags/${leafB.body.uuid}`);
        await request(app).delete(`/api/tags/${root.body.uuid}`);
      }
    });
  });
});
