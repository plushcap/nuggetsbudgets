import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/**
 * First-run setup, end to end: on a deployment with no users,
 * POST /api/auth/setup-admin with the token the server logs creates the first admin
 * (insertUser + bootstrapFirstAdmin), and that admin then signs in as a deployment admin.
 * setupAdminToken.test.ts covers the token itself, its single use and two setups racing.
 *
 * Setup only runs while there are no users, and the shared test database has users from
 * other files. So this file creates a database of its own, loads backend/init.sql into it
 * and migrates it with the migration runner (as migrationRunner.db.test.ts does), points
 * the app's pool at it, and drops it afterwards. The whole database is this file's, so it
 * needs no createTestTenant(): the ledger it checks is the one a fresh install seeds.
 * The app serves as DB_USER (nuggets_app in CI), under RLS, as in production.
 */
const { DATABASE, PREVIOUS_DB_NAME } = vi.hoisted(() => {
  const name = `nuggets_first_run_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const previous = process.env.DB_NAME;
  // Runs before the imports below: db.ts reads DB_NAME once, when it loads, so the app's
  // pool serves this database, which beforeAll creates before anything connects.
  process.env.DB_NAME = name;
  process.env.LOG_LEVEL ??= 'silent';
  return { DATABASE: name, PREVIOUS_DB_NAME: previous };
});

import http from 'http';
import path from 'path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Pool } from 'pg';
import appPool, { db } from '../db.js';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { MigrationService } from '../services/MigrationService.js';
import { announceSetupToken } from '../services/SetupTokenService.js';
import { sessionCookieName } from '../utils/session-cookie-config.js';
import { csrfTokenFor } from '../utils/csrfToken.js';
import { getDirname } from '../utils/esm-compat.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';

const ownerUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = ownerUrl ? describe : describe.skip;

const BACKEND = path.join(getDirname(import.meta.url), '../..');

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

/** The owner's connection string, on `database` (the same server the app's DB_HOST names). */
function urlFor(database: string): string {
  const url = new URL(ownerUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

describeDb('first-run setup on an empty deployment', () => {
  let admin: Pool;
  let owner: Pool;
  let created = false;
  let server: http.Server | undefined;

  const PASSWORD = 'First-Admin-Passw0rd!Kq7';

  beforeAll(async () => {
    admin = new Pool({ connectionString: ownerUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    created = true;
    owner = new Pool({ connectionString: urlFor(DATABASE), max: 4 });
    // An empty database: the runner loads the baseline, then applies every migration, as
    // a new install's first start does (docker-entrypoint.sh).
    await new MigrationService(owner, {
      migrationsDir: path.join(BACKEND, 'migrations'),
      baselinePath: path.join(BACKEND, 'init.sql'),
    }).migrate();

    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await appPool.end();
    await owner?.end();
    if (created) {
      // A pool's end() resolves before its connections have closed; one that DROP ... FORCE
      // ended instead would raise an error nothing listens for (as migrationRunner.db.test.ts).
      for (let i = 0; i < 50; i++) {
        const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [DATABASE]);
        if (rows[0].n === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    }
    await admin?.end();
    if (PREVIOUS_DB_NAME === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = PREVIOUS_DB_NAME;
  }, 120_000);

  const rows = async <T,>(text: string, params: unknown[] = []): Promise<T[]> => (await owner.query(text, params)).rows as T[];
  const one = async <T,>(text: string, params: unknown[] = []): Promise<T> => {
    const found = await rows<T>(text, params);
    expect(found, text).toHaveLength(1);
    return found[0];
  };

  /** The session token a response's Set-Cookie carries, if any. */
  function sessionTokenFrom(res: request.Response): string | undefined {
    const name = sessionCookieName();
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
    return cookie?.split(';')[0].slice(name.length + 1) || undefined;
  }
  const withSession = (req: request.Test, sessionToken: string) =>
    req.set('Cookie', `${sessionCookieName()}=${sessionToken}`).set('X-CSRF-Token', csrfTokenFor(sessionToken));

  it('creates the first admin, its organization, ledger and session, and the admin signs in as a deployment admin', async () => {
    // A fresh install: the deployment row, the seeded organization and ledger, no users.
    expect(await rows('SELECT id FROM users')).toEqual([]);
    const deployment = await one<{ id: number }>('SELECT id FROM deployment');
    const seededOrg = await one<{ id: number; uuid: string }>('SELECT id, uuid FROM organizations');
    const seededTenant = await one<{ id: number; uuid: string; organization_id: number }>(
      'SELECT id, uuid, organization_id FROM tenants'
    );
    expect(seededTenant.organization_id).toBe(seededOrg.id);

    const status = await request(server!).get('/api/auth/setup-status');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ setupComplete: false, requiresSetup: true });

    // The token the server logs at startup (index.ts calls announceSetupToken).
    const warn = vi.fn();
    await announceSetupToken(db, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const token = /create the first admin: ([0-9a-f]{64}) /.exec(warn.mock.calls[0][0] as string)?.[1];
    expect(token).toBeDefined();

    // --- Setup ---
    const setup = await request(server!).post('/api/auth/setup-admin').send({
      email: 'First.Admin@Example.com',
      password: PASSWORD,
      first_name: 'First',
      last_name: 'Admin',
      setup_token: token,
    });
    expect(setup.status, JSON.stringify(setup.body)).toBe(201);
    expect(setup.body.user).toMatchObject({ email: 'first.admin@example.com', first_name: 'First', last_name: 'Admin' });
    // Neither the password nor its hash comes back.
    expect(JSON.stringify(setup.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(setup.body)).not.toMatch(/\$2[aby]\$/);
    const setupCookie = ([] as string[])
      .concat(setup.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${sessionCookieName()}=`));
    expect(setupCookie).toMatch(/HttpOnly/i);
    const setupSession = sessionTokenFrom(setup)!;
    expect(setupSession).toBeTruthy();

    // The user row: a password they chose (no forced change), its change recorded.
    const user = await one<{
      id: number;
      uuid: string;
      email: string;
      password_hash: string;
      must_change_password: boolean;
      password_changed_at: Date | null;
      is_locked: boolean;
      login_disabled: boolean;
      last_tenant_id: number | null;
      fresh: boolean;
    }>(
      `SELECT id, uuid, email, password_hash, must_change_password, password_changed_at, is_locked, login_disabled,
              last_tenant_id, password_changed_at > now() - interval '5 minutes' AS fresh
         FROM users`
    );
    expect(user.id).toBe(setup.body.user.id);
    expect(user).toMatchObject({
      email: 'first.admin@example.com',
      must_change_password: false,
      is_locked: false,
      login_disabled: false,
      last_tenant_id: seededTenant.id,
      fresh: true,
    });
    expect(user.password_changed_at).toBeInstanceOf(Date);
    expect(await bcrypt.compare(PASSWORD, user.password_hash)).toBe(true);

    // Bootstrapped: the deployment's admin, and admin of the seeded organization and ledger,
    // which it adopted rather than creating new ones.
    expect(await rows('SELECT user_id, deployment_id, role, created_by FROM deployment_users')).toEqual([
      { user_id: user.id, deployment_id: deployment.id, role: 'admin', created_by: user.id },
    ]);
    expect(await rows('SELECT id FROM organizations')).toEqual([{ id: seededOrg.id }]);
    expect(await rows('SELECT user_id, organization_id, is_admin FROM organization_users')).toEqual([
      { user_id: user.id, organization_id: seededOrg.id, is_admin: true },
    ]);
    expect(await rows('SELECT id FROM tenants')).toEqual([{ id: seededTenant.id }]);
    expect(await rows('SELECT user_id, tenant_id, is_admin FROM tenant_users')).toEqual([
      { user_id: user.id, tenant_id: seededTenant.id, is_admin: true },
    ]);
    // The token is spent with the admin it created.
    expect(await rows('SELECT setup_token_hash FROM deployment')).toEqual([{ setup_token_hash: null }]);

    // The session the setup signed in with: its cookie's, on the bootstrapped ledger.
    const session = await one<{
      session_token_hash: string;
      active_tenant_id: number | null;
      is_revoked: boolean;
      matches_password_change: boolean;
      reauthenticated: boolean;
      live: boolean;
    }>(
      // The snapshot of the password change is the change itself, to the microsecond.
      `SELECT s.session_token_hash, s.active_tenant_id, s.is_revoked,
              s.created_after_password_change_at = u.password_changed_at AS matches_password_change,
              s.reauthenticated_at IS NOT NULL AS reauthenticated, s.expires_at > now() AS live
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`,
      [user.id]
    );
    expect(session).toEqual({
      session_token_hash: sessionService.hashSessionToken(setupSession),
      active_tenant_id: seededTenant.id,
      is_revoked: false,
      matches_password_change: true,
      reauthenticated: true,
      live: true,
    });

    const me = await withSession(request(server!).get('/api/auth/me'), setupSession);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.user).toMatchObject({ uuid: user.uuid, email: 'first.admin@example.com', must_change_password: false });
    expect(me.body.membership).toMatchObject({
      isDeploymentAdmin: true,
      activeTenant: { uuid: seededTenant.uuid, organizationUuid: seededOrg.uuid },
      tenantRole: 'admin',
      orgRole: 'admin',
    });

    // --- Setup is over ---
    expect((await request(server!).get('/api/auth/setup-status')).body).toEqual({ setupComplete: true, requiresSetup: false });
    const again = await request(server!).post('/api/auth/setup-admin').send({
      email: 'second@example.com',
      password: PASSWORD,
      first_name: 'Second',
      setup_token: token,
    });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('USERS_EXIST');
    await announceSetupToken(db, { warn });
    expect(warn).toHaveBeenCalledTimes(1); // a restart logs no new token

    // --- Sign in as that account ---
    const login = await request(server!).post('/api/auth/login').send({ email: 'first.admin@example.com', password: PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.user).toMatchObject({ id: user.id, must_change_password: false });
    const signedIn = sessionTokenFrom(login)!;
    expect(signedIn).toBeTruthy();
    expect(signedIn).not.toBe(setupSession);
    // Signing in restores the ledger the setup chose (users.last_tenant_id).
    expect(
      await rows('SELECT active_tenant_id FROM sessions WHERE session_token_hash = $1 AND NOT is_revoked', [
        sessionService.hashSessionToken(signedIn),
      ])
    ).toEqual([{ active_tenant_id: seededTenant.id }]);

    // Deployment-admin rights: the Users page lists the deployment's accounts, and the admin
    // can create one; the ledger's own routes answer too.
    const users = await withSession(request(server!).get('/api/admin/users'), signedIn);
    expect(users.status, JSON.stringify(users.body)).toBe(200);
    expect(users.body.users.map((u: { email: string }) => u.email)).toEqual(['first.admin@example.com']);
    const orgs = await withSession(request(server!).get('/api/admin/organizations'), signedIn);
    expect(orgs.status, JSON.stringify(orgs.body)).toBe(200);
    expect(JSON.stringify(orgs.body)).toContain(seededOrg.uuid);
    const createdUser = await withSession(request(server!).post('/api/admin/users'), signedIn).send({
      email: 'member@example.com',
      password: 'Another-Passw0rd!Kq7-x',
      first_name: 'Member',
    });
    expect(createdUser.status, JSON.stringify(createdUser.body)).toBe(201);
    expect(
      await rows('SELECT must_change_password FROM users WHERE email = $1', ['member@example.com'])
    ).toEqual([{ must_change_password: true }]);
    const categories = await withSession(request(server!).get('/api/categories'), signedIn);
    expect(categories.status, JSON.stringify(categories.body)).toBe(200);
  }, 60_000);
});
