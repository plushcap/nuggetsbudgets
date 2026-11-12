import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { REVIEW_STATUSES } from '@nuggets/shared';
import { validateBody, validateQuery } from '../middleware/validate.js';

// validateQuery: the query-string counterpart of validateBody.
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  review_status: z.enum(REVIEW_STATUSES).optional(),
  account: z.uuid().optional(),
  tag: z.union([z.string(), z.array(z.string())]).optional(),
});

function appWith() {
  const app = express();
  app.use(express.json());
  app.get('/items', validateQuery(listQuery), (req, res) => {
    res.json({ query: req.query, types: Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, typeof v])) });
  });
  app.post('/items', validateQuery(z.object({ dry_run: z.stringbool().default(false) })), validateBody(z.object({ name: z.string() })), (req, res) => {
    res.json({ query: req.query, body: req.body });
  });
  return app;
}

describe('validateQuery', () => {
  it('hands the handler the parsed query: numbers coerced, defaults applied', async () => {
    const res = await request(appWith()).get('/items?page=3&review_status=needs%20review');
    expect(res.status).toBe(200);
    expect(res.body.query).toEqual({ page: 3, limit: 25, review_status: 'needs review' });
    expect(res.body.types).toEqual({ page: 'number', limit: 'number', review_status: 'string' });
  });

  it('keeps a repeated parameter as an array when the schema takes one', async () => {
    const res = await request(appWith()).get('/items?tag=a&tag=b');
    expect(res.status).toBe(200);
    expect(res.body.query.tag).toEqual(['a', 'b']);
  });

  it('drops parameters the schema does not name', async () => {
    const res = await request(appWith()).get('/items?sneaky=1');
    expect(res.status).toBe(200);
    expect(res.body.query).toEqual({ page: 1, limit: 25 });
  });

  it('answers 400 VALIDATION_ERROR naming each bad field, and the handler does not run', async () => {
    const res = await request(appWith()).get('/items?page=0&limit=abc&review_status=Reviewed&account=not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.query).toBeUndefined();
    expect(res.body.details.map((d: { field: string }) => d.field).sort()).toEqual(['account', 'limit', 'page', 'review_status']);
    expect(typeof res.body.message).toBe('string');
  });

  it('refuses a scalar parameter sent twice', async () => {
    const res = await request(appWith()).get('/items?page=1&page=2');
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('page');
  });

  it('takes an empty value as not given when the schema maps it so (the documented pattern)', async () => {
    const app = express();
    const schema = z.object({ offset: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().optional()) });
    app.get('/x', validateQuery(schema), (req, res) => res.json(req.query));
    expect((await request(app).get('/x?offset=')).body).toEqual({});
    expect((await request(app).get('/x?offset=5')).body).toEqual({ offset: 5 });
  });

  it('runs alongside validateBody', async () => {
    const ok = await request(appWith()).post('/items?dry_run=true').send({ name: 'x' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ query: { dry_run: true }, body: { name: 'x' } });
    const bad = await request(appWith()).post('/items?dry_run=maybe').send({ name: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.details[0].field).toBe('dry_run');
  });
});
