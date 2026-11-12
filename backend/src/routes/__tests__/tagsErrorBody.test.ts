import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// From call `failFrom.at` on, getDb() fails with a database message that names internals.
const SECRET = 'relation "internal_tag_index" does not exist';
const failFrom = vi.hoisted(() => ({ at: Infinity, calls: 0 }));
vi.mock('../../db/withTenant.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/withTenant.js')>();
  return {
    ...actual,
    getDb: () => {
      if (failFrom.calls++ >= failFrom.at) throw new Error(SECRET);
      return actual.getDb();
    },
  };
});
const { createTagsRoutes } = await import('../tags.js');

/**
 * A tags route that fails answers a plain 500. It used to put the error's message in
 * the body, which could name tables, constraints or other internals (CLAUDE.md:
 * don't leak internals in error responses).
 */
describe('tags routes: a failure answers without the error text', () => {
  let app: Express;
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Tags error body');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: { userId: number; email: string } }).user = { userId: 1, email: 'member@example.com' };
      next();
    });
    app.use(tenant.context());
    app.use('/api/tags', createTagsRoutes());
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  // Creating a tag reads (does the name exist?), then inserts; a catch around the insert
  // used to answer with the error's message: fail the insert. The route wrapper answers
  // it (the app's requestScope adds the request id).
  it('POST /api/tags', async () => {
    failFrom.calls = 0;
    failFrom.at = 1;
    const res = await request(app).post('/api/tags').send({ name: `Groceries ${Date.now()}` });
    failFrom.at = Infinity;
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('internal_tag_index');
    expect(res.body).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });
});
