import http from 'http';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../../app.js';
import { mountRoutes, type MountDependencies } from '../../routes.js';
import { sessionService } from '../../middleware/auth.js';
import { sessionCookieName } from '../../utils/session-cookie-config.js';
import { csrfCookieName, csrfTokenFor } from '../../utils/csrfToken.js';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';

/**
 * The real app (createApp + mountRoutes, the app's own pool) on a port, and signed-in
 * browser sessions to call it with, for the route tests. Fixtures come from
 * createTestTenant(); this adds the people around a ledger (members, admins of its
 * organization, deployment admins) and removes them again in `close()`.
 *
 * Requests go through HTTP only, carrying the session cookie and, for writes, the
 * session's CSRF token as the SPA sends them, so authentication, the tenant middleware,
 * CSRF and the route's own transaction all run as in production.
 */

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

export type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteHarness {
  server: http.Server;
  /** The schema owner: for control-plane fixtures (users, memberships) and checks across ledgers. */
  owner: Pool;
  /** A user (with no memberships); close() deletes it with its memberships. */
  addUser(label: string): Promise<{ id: number; uuid: string; email: string }>;
  /** A session for `userId` with `tenantId` active (none for a user who belongs to no ledger). */
  signIn(userId: number, tenantId?: number): Promise<string>;
  /** Make `userId` a deployment admin; close() takes it back (and deletes the user). */
  makeDeploymentAdmin(userId: number): Promise<void>;
  /** A request as the browser holding `session`. */
  call(session: string, verb: Verb, path: string, body?: object): request.Test;
  close(): Promise<void>;
}

/** `deps`: services to mount the routes with in place of the stubs and new ones (a lifecycle that fails, say). */
export async function startRouteHarness(label: string, deps: Partial<MountDependencies> = {}): Promise<RouteHarness> {
  const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  const app = createApp();
  mountRoutes(app, { lifecycleService: lifecycleStub, ...deps });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const owner = new Pool({ connectionString, max: 3 });
  const userIds: number[] = [];
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  return {
    server,
    owner,
    async addUser(userLabel) {
      const email = `${slug}-${userLabel}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
      const row = (
        await owner.query<{ id: number; uuid: string }>(
          `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Test', $2) RETURNING id, uuid`,
          [email, userLabel]
        )
      ).rows[0];
      userIds.push(row.id);
      return { ...row, email };
    },
    async signIn(userId, tenantId) {
      const { token, sessionId } = await sessionService.createSession({ userId });
      if (tenantId !== undefined) {
        await owner.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenantId, sessionId]);
      }
      return token;
    },
    async makeDeploymentAdmin(userId) {
      await owner.query(
        `INSERT INTO deployment_users (user_id, deployment_id, role)
         SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1 ON CONFLICT DO NOTHING`,
        [userId]
      );
      if (!userIds.includes(userId)) userIds.push(userId);
    },
    call(session, verb, path, body) {
      let req = request(server)[verb](path).set('Cookie', `${sessionCookieName()}=${session}; ${csrfCookieName()}=${csrfTokenFor(session)}`);
      if (verb !== 'get') req = req.set('X-CSRF-Token', csrfTokenFor(session));
      return body === undefined ? req : req.send(body);
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        if (userIds.length > 0) {
          await owner.query('DELETE FROM deployment_users WHERE user_id = ANY($1)', [userIds]);
          await owner.query('DELETE FROM organization_users WHERE user_id = ANY($1)', [userIds]);
          await owner.query('DELETE FROM tenant_users WHERE user_id = ANY($1)', [userIds]);
          // References from ledger rows (audit columns) are SET NULL or CASCADE.
          await owner.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
        }
      } finally {
        await owner.end();
      }
    },
  };
}
