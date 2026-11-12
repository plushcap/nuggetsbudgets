import { describe, it, expect, beforeAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { asyncHandler } from '../utils/routeHandler.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
  // The backup and OneDrive routers build their services when mounted (see apiContract.test.ts).
  process.env.ENCRYPTION_KEY ??= 'unit-test-encryption-key-of-at-least-32-bytes';
});

/**
 * What changed from Express 4 to 5 that the app relies on, through the real
 * middleware stack (createApp) and error handlers (mountRoutes). The probe routes are
 * registered between the two, as a router is.
 * - A request without a body has `req.body` {} (Express 5 leaves it undefined), so a
 *   handler that reads a field of it answers rather than throws.
 * - The query parser is Express 5's default, `simple`: a bracketed key is just a key, a
 *   repeated one an array. No client of the API sends brackets.
 * - A rejected promise from a handler outside the route wrappers reaches the error
 *   handler, which answers it in the error shape, once.
 * - An /api path no route answers is a JSON 404, whatever characters it holds.
 */

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Express 5 behaviour the app relies on', () => {
  let app: express.Application;
  const lateRejections: unknown[] = [];

  beforeAll(() => {
    app = createApp();
    const probe = express.Router();
    // A handler that reads a field of the body, as most of the routes do.
    probe.all('/body', (req, res) => {
      const { name } = req.body as { name?: unknown };
      res.json({ isObject: typeof req.body === 'object' && req.body !== null, keys: Object.keys(req.body), name: name ?? null });
    });
    probe.patch('/validated', validateBody(z.object({ name: z.string().optional() })), (req, res) => {
      res.json({ body: req.body });
    });
    probe.get('/query', (req, res) => {
      res.json({ query: req.query });
    });
    probe.get('/validated-query', validateQuery(z.object({ page: z.coerce.number().int().default(1) })), (req, res) => {
      res.json({ page: (req.query as unknown as { page: number }).page });
    });
    probe.post('/wrapped-throws', asyncHandler(async (req) => {
      void (req.body as { name?: string }).name;
      throw new Error('relation "secret_table" does not exist');
    }));
    probe.get('/async-rejects', async () => {
      throw new Error('relation "secret_table" does not exist');
    });
    probe.get('/answers-then-rejects', async (_req, res) => {
      res.json({ ok: true });
      lateRejections.push('rejected');
      throw new Error('after the answer');
    });
    app.use('/api/probe', probe);
    mountRoutes(app, { lifecycleService: lifecycleStub });
  });

  const expectErrorShape = (res: request.Response, status: number, code: string) => {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const requestId = res.headers['x-request-id'];
    expect(requestId).toMatch(UUID);
    expect(res.body).toMatchObject({ code, requestId });
    expect(typeof res.body.error).toBe('string');
    return requestId as string;
  };

  describe('a request without a body', () => {
    it.each(['get', 'delete', 'post', 'put', 'patch'] as const)('%s: the handler reads {} and answers', async (verb) => {
      const res = await request(app)[verb]('/api/probe/body');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ isObject: true, keys: [], name: null });
    });

    it('a body no parser takes (text/plain) reads as {} too', async () => {
      const res = await request(app).post('/api/probe/body').set('Content-Type', 'text/plain').send('name=x');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ isObject: true, keys: [], name: null });
    });

    it('a JSON or form body is still parsed', async () => {
      expect((await request(app).post('/api/probe/body').send({ name: 'json' })).body).toEqual({ isObject: true, keys: ['name'], name: 'json' });
      expect((await request(app).post('/api/probe/body').type('form').send('name=form')).body).toEqual({ isObject: true, keys: ['name'], name: 'form' });
      // An empty JSON body is {} (body-parser's special case), as before.
      const empty = await request(app).post('/api/probe/body').set('Content-Type', 'application/json').send('');
      expect(empty.body).toEqual({ isObject: true, keys: [], name: null });
    });

    it('passes a schema whose fields are all optional, as {} did on Express 4', async () => {
      const res = await request(app).patch('/api/probe/validated');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ body: {} });
    });

    it('a malformed JSON body is still a 400 in the error shape', async () => {
      const res = await request(app).post('/api/probe/body').set('Content-Type', 'application/json').send('{"name":');
      expectErrorShape(res, 400, 'INVALID_BODY');
    });

    it("a wrapped handler's failure is answered 500, its text kept out", async () => {
      const res = await request(app).post('/api/probe/wrapped-throws');
      const requestId = expectErrorShape(res, 500, 'INTERNAL_ERROR');
      expect(res.body).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId });
    });
  });

  describe('the query parser', () => {
    it('is simple: a bracketed key stays a key, a repeated key is an array', async () => {
      const res = await request(app).get('/api/probe/query?a[b]=1&list[]=x&c=1&c=2&plain=y');
      expect(res.status).toBe(200);
      expect(res.body.query).toEqual({ 'a[b]': '1', 'list[]': 'x', c: ['1', '2'], plain: 'y' });
    });

    it('validateQuery replaces the req.query getter with the parsed value', async () => {
      expect((await request(app).get('/api/probe/validated-query?page=3')).body).toEqual({ page: 3 });
      expect((await request(app).get('/api/probe/validated-query')).body).toEqual({ page: 1 });
      expectErrorShape(await request(app).get('/api/probe/validated-query?page=x'), 400, 'VALIDATION_ERROR');
    });
  });

  describe('a rejected promise from a handler outside the route wrappers', () => {
    it('reaches the error handler and is answered 500 in the error shape, without its text', async () => {
      const res = await request(app).get('/api/probe/async-rejects');
      const requestId = expectErrorShape(res, 500, 'INTERNAL_ERROR');
      expect(res.body).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId });
      expect(JSON.stringify(res.body)).not.toContain('secret_table');
    });

    it('after an answer, leaves that answer alone', async () => {
      const res = await request(app).get('/api/probe/answers-then-rejects');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(lateRejections).toEqual(['rejected']);
      // The server goes on answering.
      expect((await request(app).get('/api/health')).status).toBe(200);
    });
  });

  describe('an /api path no route answers', () => {
    it.each([
      ['get', '/api/no-such-route'],
      ['post', '/api/no/such/route'],
      ['delete', '/api/no-such-route/0192f0c4-0000-7000-8000-000000000000'],
      // Characters path-to-regexp 8 gives a meaning in a route's path, here in a request's.
      ['get', '/api/a*b'],
      ['get', '/api/(x)'],
      ['get', '/api/:param'],
      ['get', '/api/{x}'],
      ['get', '/api/x+y'],
      ['get', '/api/%2A'],
      ['get', '/api'],
    ] as const)('%s %s is a JSON 404', async (verb, url) => {
      const res = await request(app)[verb](url);
      const requestId = expectErrorShape(res, 404, 'NOT_FOUND');
      expect(res.body).toEqual({ error: 'No such API route', code: 'NOT_FOUND', requestId });
    });

    it('a ledger route without a session is still 401, not the 404', async () => {
      const res = await request(app).get('/api/accounts');
      expectErrorShape(res, 401, 'MISSING_SESSION');
    });
  });
});
