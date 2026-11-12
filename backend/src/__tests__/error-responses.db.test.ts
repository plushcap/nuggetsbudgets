import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// The test reads the error lines the app logs; another file in this worker may have
// silenced the logger.
vi.hoisted(() => {
  process.env.LOG_LEVEL = 'warn';
});

import request from 'supertest';
import express from 'express';
import multer from 'multer';
import pino from 'pino';
import { sql } from 'kysely';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import pool from '../db.js';
import { getDb } from '../db/withTenant.js';
import { tenantHandler } from '../utils/routeHandler.js';
import { ControlPlaneError } from '../services/controlPlaneErrors.js';
import logger from '../utils/logger.js';
import * as loggerModule from '../utils/logger.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';

/**
 * Error answers and their request ids, through the real middleware stack and error
 * handlers (createApp + mountRoutes):
 * - every answer carries X-Request-Id, and every error body `{ error, code, requestId }`
 *   with that id;
 * - a database error answers 500 INTERNAL_ERROR "Internal server error", never its SQL
 *   text, from a route wrapper and from the global error handler alike, and the log line
 *   that records it carries the same request id;
 * - client errors keep their 4xx (a ControlPlaneError, a file too large), and an /api
 *   path no route answers is a JSON 404.
 *
 * The probe routes are registered between createApp and mountRoutes, as a router is.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

// A real database error, whose text names the table.
const MISSING_TABLE = 'no_such_table_xyz';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describeDb('Error answers and request ids', () => {
  let tenant: TestTenant;
  let app: express.Application;
  // Every line the app logs, as JSON, from the stream the root logger and its children share.
  let lines: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    tenant = await createTestTenant('Error responses');
    app = createApp();
    const probe = express.Router();
    probe.get('/db-error', tenant.context(), tenantHandler(async () => {
      await sql`SELECT broken FROM no_such_table_xyz`.execute(getDb());
    }));
    probe.get('/db-error-next', (_req, res, next) => {
      pool.query(`SELECT broken FROM ${MISSING_TABLE}`).then(() => res.json({}), next);
    });
    probe.get('/context', tenant.context(), tenantHandler(async (_req, res) => {
      await sql`SELECT 1`.execute(getDb()); // after a query, inside the request's transaction
      res.json(loggerModule.logContext());
    }));
    probe.get('/conflict', (_req, res) => {
      res.status(409).json({ error: 'Already there' });
    });
    probe.get('/refused', (_req, _res, next) => {
      next(new ControlPlaneError(409, 'PROBE_REFUSED', 'Refused, for a reason the caller can fix'));
    });
    probe.get('/thrown', (_req, _res, next) => {
      next(new Error(`relation "${MISSING_TABLE}" does not exist`));
    });
    probe.post('/upload', multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 } }).single('file'), (_req, res) => {
      res.json({ ok: true });
    });
    app.use('/api/probe', probe);
    mountRoutes(app, { lifecycleService: lifecycleStub });

    const stream = (logger as unknown as Record<symbol, { write: (line: string) => unknown }>)[pino.symbols.streamSym];
    const write = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation((line: string) => {
      try {
        lines.push(JSON.parse(line));
      } catch {
        // not a JSON line
      }
      return write(line);
    });
  });

  afterEach(() => {
    lines = [];
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await tenant.cleanup();
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

  it('answers a database error in a route with a generic message, a code and the request id', async () => {
    const res = await request(app).get('/api/probe/db-error');
    const requestId = expectErrorShape(res, 500, 'INTERNAL_ERROR');
    expect(res.body).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId });
    expect(JSON.stringify(res.body)).not.toContain(MISSING_TABLE);
    expect(JSON.stringify(res.body)).not.toMatch(/relation|SELECT/i);

    // The log line that records it has the database's text, and the same request id.
    const logged = lines.find((line) => line.msg === 'Unhandled error in request');
    expect(logged).toMatchObject({ requestId, tenantId: tenant.tenantId, userId: tenant.userId });
    expect(JSON.stringify(logged)).toContain(MISSING_TABLE);
    // ...as does the request's access line.
    expect(lines.some((line) => line.requestId === requestId && (line.response as { statusCode?: number })?.statusCode === 500)).toBe(true);
  });

  it('answers a database error passed to the global error handler the same way', async () => {
    const res = await request(app).get('/api/probe/db-error-next');
    const requestId = expectErrorShape(res, 500, 'INTERNAL_ERROR');
    expect(res.body).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId });
    expect(JSON.stringify(res.body)).not.toContain(MISSING_TABLE);
    expect(lines.find((line) => line.msg === 'Unhandled error in request')).toMatchObject({ requestId });
  });

  it("doesn't echo the error's text in development either", async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const res = await request(app).get('/api/probe/thrown');
      expectErrorShape(res, 500, 'INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toContain(MISSING_TABLE);
    } finally {
      process.env.NODE_ENV = env;
    }
  });

  it('answers a ControlPlaneError passed to the global error handler with its own status and code', async () => {
    const res = await request(app).get('/api/probe/refused');
    expectErrorShape(res, 409, 'PROBE_REFUSED');
    expect(res.body.error).toBe('Refused, for a reason the caller can fix');
  });

  it('answers a file over the size limit 413', async () => {
    const res = await request(app).post('/api/probe/upload').attach('file', Buffer.alloc(64, 1), 'big.bin');
    expectErrorShape(res, 413, 'UPLOAD_REJECTED');
  });

  it('completes a hand-written error body with a code and the request id', async () => {
    const res = await request(app).get('/api/probe/conflict');
    const requestId = expectErrorShape(res, 409, 'CONFLICT');
    expect(res.body).toEqual({ error: 'Already there', code: 'CONFLICT', requestId });
  });

  it('answers an /api path no route answers with a JSON 404', async () => {
    const res = await request(app).get('/api/no-such-route');
    const requestId = expectErrorShape(res, 404, 'NOT_FOUND');
    expect(res.body).toEqual({ error: 'No such API route', code: 'NOT_FOUND', requestId });
    expect((await request(app).post('/api/no/such/route').send({})).status).toBe(404);
  });

  it('gives a guard refusal the shape too', async () => {
    const res = await request(app).get('/api/accounts');
    expectErrorShape(res, 401, 'MISSING_SESSION');
  });

  it('sends X-Request-Id on a success, and puts it, the user and the tenant on log lines', async () => {
    const res = await request(app).get('/api/probe/context');
    expect(res.status).toBe(200);
    const requestId = res.headers['x-request-id'];
    expect(requestId).toMatch(UUID);
    expect(res.body).toEqual({ requestId, userId: tenant.userId, tenantId: tenant.tenantId });
    expect((await request(app).get('/api/health')).headers['x-request-id']).toMatch(UUID);
    // Each request its own.
    expect((await request(app).get('/api/probe/context')).headers['x-request-id']).not.toBe(requestId);
  });

  it('keeps a well-formed inbound X-Request-Id (the MCP tools send theirs) and replaces anything else', async () => {
    const forwarded = 'mcp-3f2a9c1e_7.b:1';
    const kept = await request(app).get('/api/probe/context').set('X-Request-Id', forwarded);
    expect(kept.headers['x-request-id']).toBe(forwarded);
    expect(kept.body.requestId).toBe(forwarded);

    for (const bad of ['x'.repeat(65), 'two words', '-leading-dash', '<script>']) {
      const replaced = await request(app).get('/api/probe/context').set('X-Request-Id', bad);
      expect(replaced.headers['x-request-id'], bad).toMatch(UUID);
      expect(replaced.body.requestId, bad).toBe(replaced.headers['x-request-id']);
    }
  });

  it('exposes X-Request-Id to the browser across origins', async () => {
    const res = await request(app).get('/api/health').set('Origin', process.env.CLIENT_URL || 'http://localhost:3000');
    expect(res.headers['access-control-expose-headers']).toMatch(/X-Request-Id/i);
  });
});
