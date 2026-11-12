import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createTagsRoutes } from '../tags.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

describe('Tags API', () => {
  let app: Express;
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Tags API');

    app = express();
    app.use(express.json());

    // Tenant context (stands in for authenticateToken + tenant middleware)
    app.use(tenant.context());

    app.use('/api/tags', createTagsRoutes());
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  describe('GET /api/tags', () => {
    it('should return all tags with hierarchy information', async () => {
      const response = await request(app)
        .get('/api/tags')
        .expect('Content-Type', /json/)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);

      // Check structure of returned tags
      if (response.body.length > 0) {
        const tag = response.body[0];
        expect(tag).toHaveProperty('id');
        expect(tag).toHaveProperty('uuid');
        expect(tag).toHaveProperty('name');
        expect(tag).toHaveProperty('color');
        expect(tag).toHaveProperty('icon');
        expect(tag).toHaveProperty('level');
        expect(tag).toHaveProperty('hierarchy_path');
      }
    });
  });

  describe('POST /api/tags', () => {
    it('should create a new tag with valid data', async () => {
      const newTag = {
        name: 'Test Tag',
        color: '#FF0000',
        icon: 'Tag',
        description: 'Test description',
        is_active: true,
      };

      const response = await request(app)
        .post('/api/tags')
        .send(newTag)
        .expect('Content-Type', /json/)
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('uuid');
      expect(response.body.name).toBe(newTag.name);
      expect(response.body.color).toBe(newTag.color);
      expect(response.body.icon).toBe(newTag.icon);
      expect(response.body.description).toBe(newTag.description);

      // Clean up: delete the created tag
      if (response.body.uuid) {
        await request(app).delete(`/api/tags/${response.body.uuid}`);
      }
    });

    it('should return 400 when name is missing', async () => {
      const invalidTag = {
        color: '#FF0000',
        icon: 'Tag',
      };

      const response = await request(app)
        .post('/api/tags')
        .send(invalidTag)
        .expect('Content-Type', /json/)
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.message).toContain('Name is required');
    });

    it('should return 409 when tag name already exists', async () => {
      const tagName = 'Duplicate Test Tag';

      // Create first tag
      const firstTag = await request(app)
        .post('/api/tags')
        .send({ name: tagName, color: '#FF0000', icon: 'Tag' })
        .expect(201);

      // Attempt to create duplicate
      const response = await request(app)
        .post('/api/tags')
        .send({ name: tagName, color: '#00FF00', icon: 'Tag' })
        .expect('Content-Type', /json/)
        .expect(409);

      expect(response.body).toHaveProperty('error');
      expect(response.body.message).toContain('already exists');

      // Clean up
      if (firstTag.body.uuid) {
        await request(app).delete(`/api/tags/${firstTag.body.uuid}`);
      }
    });

    it('should return 400 when name exceeds 100 characters', async () => {
      const longName = 'a'.repeat(101);

      const response = await request(app)
        .post('/api/tags')
        .send({ name: longName, color: '#FF0000', icon: 'Tag' })
        .expect('Content-Type', /json/)
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.message).toContain('100 characters or less');
    });
  });

  describe('GET /api/tags/:uuid', () => {
    it('should return tag by UUID', async () => {
      // First create a tag
      const newTag = await request(app)
        .post('/api/tags')
        .send({ name: 'Test Get Tag', color: '#FF0000', icon: 'Tag' })
        .expect(201);

      const uuid = newTag.body.uuid;

      // Get the tag
      const response = await request(app)
        .get(`/api/tags/${uuid}`)
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body.uuid).toBe(uuid);
      expect(response.body.name).toBe('Test Get Tag');

      // Clean up
      await request(app).delete(`/api/tags/${uuid}`);
    });

    it('should return 404 for non-existent UUID', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000000';

      const response = await request(app)
        .get(`/api/tags/${fakeUuid}`)
        .expect('Content-Type', /json/)
        .expect(404);

      expect(response.body).toHaveProperty('error');
      expect(response.body.message).toMatch(/no tag found/i);
    });
  });

  describe('GET /api/tags/:uuid/summary', () => {
    it("summarizes a tag's transactions", async () => {
      const tag = await request(app).post('/api/tags').send({ name: 'Summary Tag', color: '#00FF00', icon: 'Tag' }).expect(201);
      const response = await request(app).get(`/api/tags/${tag.body.uuid}/summary`).expect(200);
      expect(response.body).toMatchObject({ tag_uuid: tag.body.uuid, tag_name: 'Summary Tag', transaction_count: '0' });
      await request(app).delete(`/api/tags/${tag.body.uuid}`);
    });

    // The summary function raises for an unknown tag, which answered 500 with its message.
    it('answers 404 for a tag that does not exist', async () => {
      const response = await request(app).get('/api/tags/00000000-0000-0000-0000-000000000000/summary').expect(404);
      expect(response.body).toEqual({ error: 'Tag not found', code: 'TAG_NOT_FOUND', message: 'Tag not found' });
    });
  });

  describe('PUT /api/tags/:uuid', () => {
    it('should update tag successfully', async () => {
      // Create a tag
      const newTag = await request(app)
        .post('/api/tags')
        .send({ name: 'Original Name', color: '#FF0000', icon: 'Tag' })
        .expect(201);

      const uuid = newTag.body.uuid;

      // Update the tag
      const response = await request(app)
        .put(`/api/tags/${uuid}`)
        .send({ name: 'Updated Name', color: '#00FF00', icon: 'Star' })
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body.uuid).toBe(uuid);
      expect(response.body.name).toBe('Updated Name');
      expect(response.body.color).toBe('#00FF00');
      expect(response.body.icon).toBe('Star');

      // Clean up
      await request(app).delete(`/api/tags/${uuid}`);
    });

    it('should return 404 when updating non-existent tag', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000000';

      const response = await request(app)
        .put(`/api/tags/${fakeUuid}`)
        .send({ name: 'Updated Name', color: '#00FF00', icon: 'Star' })
        .expect('Content-Type', /json/)
        .expect(404);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('DELETE /api/tags/:uuid', () => {
    it('should delete tag successfully', async () => {
      // Create a tag
      const newTag = await request(app)
        .post('/api/tags')
        .send({ name: 'Tag to Delete', color: '#FF0000', icon: 'Tag' })
        .expect(201);

      const uuid = newTag.body.uuid;

      // Delete the tag
      const response = await request(app)
        .delete(`/api/tags/${uuid}`)
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify it's deleted
      await request(app)
        .get(`/api/tags/${uuid}`)
        .expect(404);
    });

    it('should return 404 when deleting non-existent tag', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000000';

      const response = await request(app)
        .delete(`/api/tags/${fakeUuid}`)
        .expect('Content-Type', /json/)
        .expect(404);

      expect(response.body).toHaveProperty('error');
    });

    it('should return 400 when deleting tag with children', async () => {
      // Create parent tag
      const parentTag = await request(app)
        .post('/api/tags')
        .send({ name: 'Parent Tag', color: '#FF0000', icon: 'Tag' })
        .expect(201);

      // Create child tag
      const childTag = await request(app)
        .post('/api/tags')
        .send({
          name: 'Child Tag',
          color: '#00FF00',
          icon: 'Tag',
          parent_id: parentTag.body.id
        })
        .expect(201);

      // Attempt to delete parent
      const response = await request(app)
        .delete(`/api/tags/${parentTag.body.uuid}`)
        .expect('Content-Type', /json/)
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.message).toContain('child tags');

      // Clean up (delete child first, then parent)
      await request(app).delete(`/api/tags/${childTag.body.uuid}`);
      await request(app).delete(`/api/tags/${parentTag.body.uuid}`);
    });
  });

  // The auto-tag routes: their 404s in tagsRoutesCharacterization.test.ts, applying the tags
  // in budgetAndGoalHistoryQueries.test.ts.
});
