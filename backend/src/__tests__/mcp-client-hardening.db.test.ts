import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// Refused requests log warnings; keep them out of the test output unless asked for.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import crypto from 'crypto';
import http from 'http';
import express, { type Request } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { apiRateLimitKey, createApiRateLimiter } from '../middleware/security.js';
import { signPersonalAccessToken } from '../utils/jwt-helper.js';
import { SESSION_COOKIE_NAME } from '../utils/session-cookie-config.js';
// The CSRF token is bound to the session.
import { csrfTokenFor } from '../utils/csrfToken.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * MCP client hardening, on the backend's side: the API rate limiter counts each
 * personal access token on its own, and the deployment-admin toggle takes only an explicit boolean, so a request that
 * reaches it by accident (the annotation tools' path traversal) can't demote anyone.
 */

const pat = (jti: string = crypto.randomUUID()) =>
  signPersonalAccessToken({ userId: 1, email: 'limit@test.local', tenantId: 1, scope: 'read' }, { expiresIn: '1h', jwtid: jti });

describe('the API rate limiter counts each personal access token on its own', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Every MCP tool call comes back into the API from 127.0.0.1 with the caller's token, as
  // supertest's requests here do.
  function limitedApp(max: number) {
    vi.stubEnv('RATE_LIMIT_MAX_REQUESTS', String(max));
    const app = express();
    app.use(createApiRateLimiter(true));
    app.get('/api/probe', (_req, res) => res.json({ ok: true }));
    return app;
  }
  const send = (app: express.Express, token?: string) => {
    const req = request(app).get('/api/probe');
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('lets one token use up its own bucket without touching another token’s, from the same address', async () => {
    const app = limitedApp(2);
    const busy = pat();
    const other = pat();
    expect((await send(app, busy)).status).toBe(200);
    expect((await send(app, busy)).status).toBe(200);
    expect((await send(app, busy)).status).toBe(429);
    expect((await send(app, other)).status).toBe(200);
    // Nor the address's own bucket, which requests without a token count in.
    expect((await send(app)).status).toBe(200);
  });

  it('counts a token whose signature doesn’t verify by address, so made-up tokens get no buckets', async () => {
    const app = limitedApp(2);
    const forged = () =>
      jwt.sign({ userId: 1, email: 'x', tenantId: 1 }, 'not-the-server-secret', { audience: 'mcp', jwtid: crypto.randomUUID(), expiresIn: '1h' });
    expect((await send(app, forged())).status).toBe(200);
    expect((await send(app, forged())).status).toBe(200);
    expect((await send(app, forged())).status).toBe(429);
    expect((await send(app)).status).toBe(429);
  });

  it('keys by the token’s jti, else the address', () => {
    const asRequest = (headers: Record<string, string>) => ({ headers, ip: '203.0.113.9' }) as unknown as Request;
    expect(apiRateLimitKey(asRequest({ authorization: `Bearer ${pat('jti-1')}` }))).toBe('pat:jti-1');
    expect(apiRateLimitKey(asRequest({}))).toBe('ip:203.0.113.9');
    expect(apiRateLimitKey(asRequest({ authorization: 'Bearer not-a-jwt' }))).toBe('ip:203.0.113.9');
    expect(apiRateLimitKey(asRequest({ authorization: 'Basic dXNlcjpwYXNz' }))).toBe('ip:203.0.113.9');
  });
});

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const CSRF_TOKEN = 'mcp-client-hardening-csrf-token';
const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

describeDb('a request that reaches the deployment-admin toggle by accident demotes no one', () => {
  let server: http.Server;
  let owner: Pool;
  let tenant: TestTenant;
  let tenantUuid: string;
  let actor: { id: number; session: string };
  let victim: { id: number; uuid: string };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= 'mcp-client-hardening-test-encryption-key-0123456789';
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // The MCP tools call the REST API at this address with the caller's own token.
    process.env.MCP_API_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server.on('request', app);

    owner = new Pool({ connectionString, max: 2 });
    tenant = await createTestTenant('MCP hardening');
    tenantUuid = (await owner.query<{ uuid: string }>('SELECT uuid FROM tenants WHERE id = $1', [tenant.tenantId])).rows[0].uuid;

    const addAdmin = async (label: string) => {
      const email = `mcp-hardening-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
      const { id, uuid } = (
        await owner.query<{ id: number; uuid: string }>(
          `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Test', $2) RETURNING id, uuid`,
          [email, label]
        )
      ).rows[0];
      const made = await owner.query(
        `INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`,
        [id]
      );
      if (made.rowCount !== 1) throw new Error('No deployment row to make the admin a member of');
      return { id, uuid };
    };
    const actorUser = await addAdmin('actor');
    victim = await addAdmin('victim');
    const { token, sessionId } = await sessionService.createSession({ userId: actorUser.id });
    await owner.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenant.tenantId, sessionId]);
    actor = { id: actorUser.id, session: token };
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    delete process.env.MCP_API_BASE_URL;
    if (!owner) return;
    try {
      const ids = [actor?.id, victim?.id].filter((id) => id != null);
      await owner.query('DELETE FROM personal_access_tokens WHERE user_id = ANY($1)', [ids]);
      await owner.query('DELETE FROM deployment_users WHERE user_id = ANY($1)', [ids]);
      await tenant?.cleanup();
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
    } finally {
      await owner.end();
    }
  }, 60_000);

  const isDeploymentAdmin = async (userId: number) =>
    (await owner.query('SELECT 1 FROM deployment_users WHERE user_id = $1', [userId])).rowCount === 1;

  const toggle = (body: unknown) =>
    request(server)
      .patch(`/api/admin/users/${victim.uuid}/deployment-admin`)
      .set('Cookie', `${SESSION_COOKIE_NAME}=${actor.session}; csrf_token=${CSRF_TOKEN}`)
      .set('X-CSRF-Token', csrfTokenFor(actor.session))
      .send(body as object);

  it('refuses a body without the flag, as the annotation tools sent ({"status":"resolved"}), and keeps the admin', async () => {
    for (const body of [{ status: 'resolved' }, {}, { feedback: 'incorrect' }, { learning_status: 'applied' }]) {
      const res = await toggle(body);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(await isDeploymentAdmin(victim.id)).toBe(true);
    }
  });

  it('refuses a flag that isn’t a boolean', async () => {
    for (const flag of ['false', 'true', 0, null]) {
      const res = await toggle({ is_deployment_admin: flag });
      expect(res.status, `${JSON.stringify(flag)}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(await isDeploymentAdmin(victim.id)).toBe(true);
    }
  });

  it('still grants and revokes on an explicit boolean', async () => {
    const revoked = await toggle({ is_deployment_admin: false });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.is_deployment_admin).toBe(false);
    expect(await isDeploymentAdmin(victim.id)).toBe(false);
    const granted = await toggle({ is_deployment_admin: true });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(await isDeploymentAdmin(victim.id)).toBe(true);
  });

  it('can’t be reached through the MCP tools: an injected "resolve annotation ../admin/…" is refused', async () => {
    const minted = await request(server)
      .post('/api/auth/mcp-token')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${actor.session}; csrf_token=${CSRF_TOKEN}`)
      .set('X-CSRF-Token', csrfTokenFor(actor.session))
      .send({ label: 'mcp-hardening', tenantUuid, scope: 'read_write', expiresIn: '30d' });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const token = minted.body.token as string;

    for (const name of ['resolve_annotation', 'set_annotation_feedback', 'apply_annotation_learning']) {
      const res = await request(server)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: { uuid: `../admin/users/${victim.uuid}/deployment-admin`, feedback: 'incorrect' } },
        });
      expect(res.status).toBe(200);
      expect(res.body.result.isError).toBe(true);
      // Refused by the tool's input schema, before any request, rather than by the
      // token's route list further in.
      expect(res.body.result.content[0].text).toMatch(/Input validation error[\s\S]*uuid/i);
      expect(await isDeploymentAdmin(victim.id)).toBe(true);
    }
  });
});
