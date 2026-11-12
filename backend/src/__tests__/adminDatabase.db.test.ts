import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import http from 'http';
import os from 'os';
import path from 'path';
import { chmod, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../utils/session-cookie-config.js';
import { csrfTokenFor } from '../utils/csrfToken.js';
import { runningPgTools } from '../utils/pgTools.js';
import { stopSchemaDownloads } from '../services/databaseDiagnostics.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * Settings → Utilities through the real app: the database's schema (a real
 * pg_dump, PG_BIN_DIR's or PATH's) and its applied migrations, for deployment admins in a
 * signed-in browser only.
 */

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

const RUN = `admin-database-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// A ledger's row the schema must not carry.
const MERCHANT = `Distinctive merchant ${RUN}`;
const SCHEMA = '/api/admin/database/schema';
const MIGRATIONS = '/api/admin/database/migrations';

type Role = 'member' | 'tenantAdmin' | 'orgAdmin' | 'deploymentAdmin';

describe('Deployment admin: Settings → Utilities downloads', () => {
  let owner: Pool;
  let tenant: TestTenant;
  let server: http.Server;
  let bin: string;
  let adminToken: string; // the deployment admin's personal access token
  const tokens = new Map<Role, string>();
  const userIds: number[] = [];

  const as = (role: Role, req: request.Test) => {
    const token = tokens.get(role)!;
    return req.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`).set('X-CSRF-Token', csrfTokenFor(token));
  };

  /** A stand-in pg_dump in its own PG_BIN_DIR. */
  async function standIn(script: string): Promise<void> {
    await writeFile(path.join(bin, 'pg_dump'), `#!/bin/sh\n${script}\n`);
    await chmod(path.join(bin, 'pg_dump'), 0o755);
    vi.stubEnv('PG_BIN_DIR', bin);
  }

  beforeAll(async () => {
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 4 });
    tenant = await createTestTenant('Admin database');
    bin = await mkdtemp(path.join(os.tmpdir(), 'admin-database-'));
    await tenant.pool.query('INSERT INTO merchants (name) VALUES ($1)', [MERCHANT]);

    const addUser = async (label: string) => {
      const id = (
        await owner.query<{ id: number }>(
          `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Test', $2) RETURNING id`,
          [`${RUN}-${label.toLowerCase()}@test.local`, label]
        )
      ).rows[0].id;
      userIds.push(id);
      return id;
    };
    const tenantAdminId = await addUser('TenantAdmin');
    await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, false)', [tenant.organizationId, tenantAdminId]);
    await owner.query('INSERT INTO tenant_users (tenant_id, user_id, is_admin) VALUES ($1, $2, true)', [tenant.tenantId, tenantAdminId]);
    const orgAdminId = await addUser('OrgAdmin');
    await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true)', [tenant.organizationId, orgAdminId]);
    const deploymentAdminId = await addUser('DeploymentAdmin');
    await owner.query(
      `INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`,
      [deploymentAdminId]
    );
    await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, false)', [tenant.organizationId, tenant.userId]);

    const ids: Record<Role, number> = { member: tenant.userId, tenantAdmin: tenantAdminId, orgAdmin: orgAdminId, deploymentAdmin: deploymentAdminId };
    for (const [role, userId] of Object.entries(ids) as Array<[Role, number]>) {
      const { token, sessionId } = await sessionService.createSession({ userId });
      await owner.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenant.tenantId, sessionId]);
      tokens.set(role, token);
    }

    // The deployment admin's own read-and-write token: the strongest a token gets.
    const tenantUuid = (await owner.query<{ uuid: string }>('SELECT uuid FROM tenants WHERE id = $1', [tenant.tenantId])).rows[0].uuid;
    const minted = await as('deploymentAdmin', request(server).post('/api/auth/mcp-token')).send({
      label: 'admin-database',
      tenantUuid,
      scope: 'read_write',
      expiresIn: '30d',
    });
    if (minted.status !== 201) throw new Error(`Minting the admin's token failed: ${minted.status} ${JSON.stringify(minted.body)}`);
    adminToken = minted.body.token;
  }, 60_000);

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (bin) await rm(bin, { recursive: true, force: true });
    if (!owner) return;
    try {
      const all = [...userIds, tenant?.userId].filter((id) => id != null);
      await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [all]);
      await owner.query('DELETE FROM personal_access_tokens WHERE user_id = ANY($1)', [all]);
      await owner.query('DELETE FROM deployment_users WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM organization_users WHERE user_id = ANY($1)', [all]);
      await owner.query('DELETE FROM tenant_users WHERE user_id = ANY($1)', [userIds]);
      await tenant?.cleanup();
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    } finally {
      await owner.end();
    }
  }, 60_000);

  describe('who may download', () => {
    it.each([SCHEMA, MIGRATIONS])('refuses %s without a session (401)', async (url) => {
      const res = await request(server).get(url);
      expect(res.status).toBe(401);
    });

    it.each([SCHEMA, MIGRATIONS])('refuses %s to a ledger member, a ledger admin and an organization admin (403)', async (url) => {
      for (const role of ['member', 'tenantAdmin', 'orgAdmin'] as const) {
        const res = await as(role, request(server).get(url));
        expect(res.status, role).toBe(403);
        expect(res.body.code, role).toBe('DEPLOYMENT_ADMIN_REQUIRED');
        expect(res.headers['content-disposition'], role).toBeUndefined();
      }
    });

    it.each([SCHEMA, MIGRATIONS])("refuses %s to a deployment admin's personal access token (403)", async (url) => {
      const res = await request(server).get(url).set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INTERACTIVE_SESSION_REQUIRED');
      expect(res.headers['content-disposition']).toBeUndefined();
    });
  });

  describe('the schema', () => {
    it('is pg_dump --schema-only of the database, named for this version and today, with no rows', async () => {
      const res = await as('deploymentAdmin', request(server).get(SCHEMA)).buffer(true).parse((r, done) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (chunk: string) => (text += chunk));
        r.on('end', () => done(null, text));
      });
      expect(res.status, String(res.body).slice(0, 500)).toBe(200);
      expect(res.headers['content-type']).toBe('application/sql; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      const today = (await owner.query<{ today: string }>('SELECT app_today()::text AS today')).rows[0].today;
      const name = /^attachment; filename="(nuggets-schema-[A-Za-z0-9._-]+-(\d{4}-\d{2}-\d{2})\.sql)"/.exec(res.headers['content-disposition']);
      expect(name, res.headers['content-disposition']).not.toBeNull();
      expect(name![2]).toBe(today);

      const text = res.body as string;
      expect(text.startsWith('-- Nuggets database schema: pg_dump --schema-only, with no rows.\n')).toBe(true);
      expect(text).toContain('PostgreSQL database dump complete');
      expect(text).toContain('CREATE TABLE public.transactions (');
      expect(text).toContain('CREATE TABLE public.schema_migrations (');
      expect(text).toMatch(/^CREATE TRIGGER /m);
      expect(text).toMatch(/^CREATE FUNCTION public\.calculate_account_balance\(/m);
      expect(text).toMatch(/^CREATE POLICY /m);
      expect(text).toContain('ENABLE ROW LEVEL SECURITY');
      // No rows, and no statistics (they hold sample values from the rows).
      expect(text).not.toMatch(/^COPY /m);
      expect(text).not.toMatch(/^INSERT INTO /m);
      expect(text).not.toMatch(/pg_restore_(?:attribute|relation)_stats/);
      expect(text).not.toContain(MERCHANT);
      expect(text).not.toContain(`${RUN}-member`);
      expect(runningPgTools('download')).toBe(0);
    }, 60_000);

    it('answers a failed pg_dump in the error shape, without its stderr', async () => {
      await standIn('echo "pg_dump: error: connection to server at \\"db.internal\\" failed: FATAL: password=$PGPASSWORD" >&2; exit 1');
      const res = await as('deploymentAdmin', request(server).get(SCHEMA));
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: "The database schema couldn't be exported. The server log has the details.",
        code: 'SCHEMA_EXPORT_FAILED',
        requestId: res.headers['x-request-id'],
      });
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.text).not.toMatch(/pg_dump|FATAL|db\.internal|password/);
    });

    it('runs one schema dump at a time', async () => {
      await standIn('sleep 1; echo "CREATE TABLE public.t (id integer);"');
      const first = as('deploymentAdmin', request(server).get(SCHEMA)).then((r) => r);
      await vi.waitFor(() => expect(runningPgTools('download')).toBe(1), { timeout: 5_000 });
      const second = await as('deploymentAdmin', request(server).get(SCHEMA));
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('SCHEMA_EXPORT_IN_PROGRESS');
      expect((await first).status).toBe(200);
    });

    it('runs no pg_dump for a HEAD request', async () => {
      const marker = path.join(bin, 'started');
      await standIn(`touch ${marker}; echo "CREATE TABLE public.t (id integer);"`);
      const res = await as('deploymentAdmin', request(server).head(SCHEMA));
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('GET');
      await expect(stat(marker)).rejects.toThrow();
    });

    // Last: once a shutdown has begun, this module starts no dump again.
    it('stops a running dump when a shutdown begins, and answers 503 after', async () => {
      await standIn('sleep 30');
      const running = as('deploymentAdmin', request(server).get(SCHEMA)).then((r) => r);
      await vi.waitFor(() => expect(runningPgTools('download')).toBe(1), { timeout: 5_000 });
      expect(stopSchemaDownloads()).toBe(1);
      const stopped = await running;
      expect(stopped.status).toBe(503);
      expect(stopped.body).toEqual({
        error: 'The server is shutting down. Download the schema again once it has restarted.',
        code: 'SHUTTING_DOWN',
        requestId: stopped.headers['x-request-id'],
      });
      await vi.waitFor(() => expect(runningPgTools('download')).toBe(0), { timeout: 10_000 });
      const later = await as('deploymentAdmin', request(server).get(SCHEMA));
      expect(later.status).toBe(503);
      expect(later.body.code).toBe('SHUTTING_DOWN');
    });
  });

  describe('the applied migrations', () => {
    it('lists every schema_migrations row, oldest first, as INSERTs', async () => {
      const res = await as('deploymentAdmin', request(server).get(MIGRATIONS));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/sql; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="nuggets-migrations-[A-Za-z0-9._-]+-\d{4}-\d{2}-\d{2}\.sql"/);

      const rows = (
        await owner.query<{ version: string; name: string; checksum: string; micros: string }>(
          `SELECT version, name, checksum, (extract(epoch FROM applied_at) * 1000000)::bigint::text AS micros
             FROM schema_migrations ORDER BY version`
        )
      ).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(res.text).toContain(`-- Migrations applied: ${rows.length} (oldest ${rows[0].version}, newest ${rows[rows.length - 1].version}).`);

      const listed = res.text
        .split('\n')
        .filter((line) => line.startsWith('INSERT'))
        .map((line) => {
          const m = /^INSERT INTO public\.schema_migrations \(version, name, checksum, applied_at\) VALUES \('(\d{14})', '((?:[^']|'')*)', '([0-9a-f]{64})', '(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{6})\+00'\);$/.exec(line);
          expect(m, line).not.toBeNull();
          const [, version, name, checksum, day, time, fraction] = m!;
          const micros = BigInt(Date.parse(`${day}T${time}Z`)) * 1000n + BigInt(fraction);
          return { version, name: name.replace(/''/g, "'"), checksum, micros: micros.toString() };
        });
      expect(listed).toEqual(rows);
    });
  });
});
