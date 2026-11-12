import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createMerchantsRoutes } from '../merchants.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A merchant written with an auto-tag that is being deleted. Create checked the
 * tag under a lock; update didn't, so its UPDATE's foreign key check met the deleted tag and
 * answered 500. Both now lock the tag as the foreign key would, wait for the delete, and answer
 * 400 INVALID_REFERENCE, nothing written. And an auto-tag of '' on update is none, not a 500.
 */
describe("A merchant's auto-tag deleted while it is written", () => {
  let tenant: TestTenant;
  let app: Express;

  beforeAll(async () => {
    tenant = await createTestTenant('Merchant auto-tag race');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/merchants', createMerchantsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  /** Waits until some request waits on a lock (the held delete's), at most 3 s. */
  const someoneWaits = async () => {
    for (let i = 0; i < 30; i++) {
      if ((await tenant.pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`)).rows[0].n > 0) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  for (const mode of ['create', 'update'] as const) {
    it(`answers a ${mode} 400 INVALID_REFERENCE, nothing written`, async () => {
      const tagId = (await tenant.pool.query(`INSERT INTO tags (name) VALUES ($1) RETURNING id`, [`Doomed ${mode}`])).rows[0].id;
      const name = `Racer ${mode}`;
      const uuid = mode === 'update' ? (await request(app).post('/api/merchants').send({ name }).expect(201)).body.uuid : '';
      const holder = await tenant.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('DELETE FROM tags WHERE id = $1', [tagId]);
        const pending =
          mode === 'create'
            ? request(app).post('/api/merchants').send({ name, transaction_auto_tag_id: tagId }).then((r) => r)
            : request(app).put(`/api/merchants/${uuid}`).send({ name, notes: 'changed', transaction_auto_tag_id: tagId }).then((r) => r);
        expect(await someoneWaits()).toBe(true);
        await holder.query('COMMIT');
        const res = await pending;
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'INVALID_REFERENCE', field: 'transaction_auto_tag_id' });
      } finally {
        holder.release();
      }
      const rows = (await tenant.pool.query(`SELECT notes, transaction_auto_tag_id FROM merchants WHERE name = $1`, [name])).rows;
      expect(rows).toEqual(mode === 'create' ? [] : [{ notes: null, transaction_auto_tag_id: null }]);
    });
  }

  it("reads an auto-tag of '' on update as none", async () => {
    const created = await request(app).post('/api/merchants').send({ name: 'Blank tag' }).expect(201);
    const res = await request(app).put(`/api/merchants/${created.body.uuid}`).send({ name: 'Blank tag', transaction_auto_tag_id: '' });
    expect(res.status).toBe(200);
    expect(res.body.transaction_auto_tag_id).toBeNull();
  });
});
