import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { answerProblem, createdUserResponseSchema } from '@nuggets/shared';

/**
 * First-run admin setup needs the operator's one-time setup token, and two setups at once
 * can't both create an admin. Runs on a real Postgres, as the app's own role.
 *
 * Setup only runs while the deployment has no users, and other test files add users to the
 * shared database while this one runs. So this file copies the tables setup touches into a
 * schema of its own and points the app's pool at it with search_path: there, "no users yet"
 * is up to this file. The copies have the real columns, defaults and unique indexes (setup's
 * ON CONFLICTs need them); foreign keys and triggers are left out. Setup writes deployment_users
 * through grant_deployment_admin, copied here pointing at this schema's tables
 * (test/schemaCopy.ts).
 */
const { SCHEMA } = vi.hoisted(() => ({ SCHEMA: `setup_admin_test_${process.pid}_${Date.now()}` }));

vi.mock('../../db.js', async () => {
  const pg = await import('pg');
  const { Kysely, PostgresDialect } = await import('kysely');
  const { initializeSecrets } = await import('../../utils/docker-secrets.js');
  const { servingRolePassword } = await import('../../db/servingRole.js');
  // db.ts's settings, plus a search_path that reaches only this file's schema.
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'nuggets_db',
    user: process.env.DB_USER || 'postgres',
    password: servingRolePassword(initializeSecrets()),
    options: `-c search_path=${SCHEMA}`,
    // Lets the lock test count only this file's connections: the setup lock is one key for
    // the whole database, which another run of this file may be using at the same time.
    application_name: SCHEMA,
    max: 10,
  });
  return {
    default: pool,
    db: new Kysely({ dialect: new PostgresDialect({ pool }) }),
    testConnection: async () => true,
  };
});

import appPool, { db } from '../../db.js';
import { copyFunctionToSchema } from '../../test/schemaCopy.js';
import { createAuthPublicRoutes } from '../auth.js';
import {
  FIRST_RUN_SETUP_LOCK_KEY,
  announceSetupToken,
  hashSetupToken,
  issueSetupToken,
} from '../../services/SetupTokenService.js';

// What first-run setup and the session it signs in with touch.
const TABLES = [
  'users',
  'deployment',
  'deployment_users',
  'organizations',
  'organization_users',
  'tenants',
  'tenant_users',
  'sessions',
];
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

describe('POST /api/auth/setup-admin needs the setup token', () => {
  let app: Express;
  let owner: Pool;
  const password = 'Very-Strong-Passw0rd!x';
  const body = (extra: Record<string, unknown> = {}) => ({
    email: 'owner@example.com',
    password,
    first_name: 'Owner',
    ...extra,
  });
  const setup = (payload: Record<string, unknown>) => request(app).post('/api/auth/setup-admin').send(payload);

  const scalar = async (query: string, params: unknown[] = []): Promise<number> =>
    Number((await owner.query<{ n: string }>(query, params)).rows[0].n);
  const userCount = () => scalar(`SELECT count(*) AS n FROM ${SCHEMA}.users`);
  const adminCount = () => scalar(`SELECT count(*) AS n FROM ${SCHEMA}.deployment_users WHERE role = 'admin'`);
  const storedHash = async () =>
    (await owner.query<{ h: string | null }>(`SELECT setup_token_hash AS h FROM ${SCHEMA}.deployment`)).rows[0].h;

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 3 });
    const appRole = quoteIdent(process.env.DB_USER || 'postgres');
    await owner.query(`CREATE SCHEMA ${SCHEMA}`);
    for (const table of TABLES) {
      await owner.query(`CREATE TABLE ${SCHEMA}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await owner.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${appRole}`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${appRole}`);
    await copyFunctionToSchema(owner, 'grant_deployment_admin(integer, integer)', SCHEMA, appRole);
    // A fresh install: the deployment row and the seeded organization and ledger, no users.
    await owner.query(`INSERT INTO ${SCHEMA}.deployment (name) VALUES ('Nuggets')`);
    const org = await owner.query<{ id: number }>(`INSERT INTO ${SCHEMA}.organizations (name) VALUES ('Home') RETURNING id`);
    await owner.query(`INSERT INTO ${SCHEMA}.tenants (organization_id, name) VALUES ($1, 'My Ledger')`, [org.rows[0].id]);

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthPublicRoutes());
  });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE ${SCHEMA}.sessions, ${SCHEMA}.tenant_users, ${SCHEMA}.organization_users,
                ${SCHEMA}.deployment_users, ${SCHEMA}.users`
    );
    await owner.query(`UPDATE ${SCHEMA}.deployment SET setup_token_hash = NULL`);
  });

  afterAll(async () => {
    await appPool.end();
    await owner?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await owner?.end();
  });

  it('refuses setup without a setup token', async () => {
    await issueSetupToken(db);
    const res = await setup(body()).expect(403);
    expect(res.body.code).toBe('INVALID_SETUP_TOKEN');
    expect(await userCount()).toBe(0);
  });

  it('refuses a wrong setup token', async () => {
    const token = (await issueSetupToken(db))!;
    const nearMiss = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    for (const wrong of [nearMiss, token.toUpperCase(), 'x', '', '   ', 12345, [token], { token }, null]) {
      const res = await setup(body({ setup_token: wrong }));
      expect({ wrong, status: res.status, code: res.body.code }).toEqual({
        wrong,
        status: 403,
        code: 'INVALID_SETUP_TOKEN',
      });
    }
    expect(await userCount()).toBe(0);
  });

  it('refuses every token until one is issued', async () => {
    const res = await setup(body({ setup_token: 'a'.repeat(64) })).expect(403);
    expect(res.body.code).toBe('INVALID_SETUP_TOKEN');
    expect(await userCount()).toBe(0);
  });

  it('checks the token before the rest of the body', async () => {
    const res = await setup({ setup_token: 'wrong' }).expect(403);
    expect(res.body.code).toBe('INVALID_SETUP_TOKEN');
  });

  it('creates the first admin with the token, once', async () => {
    const token = (await issueSetupToken(db))!;
    // Pasted from a log line, with whitespace around it.
    const res = await setup(body({ setup_token: ` ${token}\n` })).expect(201);
    expect(res.body.user).toMatchObject({ email: 'owner@example.com' });
    expect(answerProblem(createdUserResponseSchema, res.body)).toBeNull();
    expect(res.headers['set-cookie']).toBeDefined();
    expect(await userCount()).toBe(1);
    expect(await adminCount()).toBe(1);
    expect(await storedHash()).toBeNull();

    const again = await setup(body({ email: 'second@example.com', setup_token: token })).expect(403);
    expect(again.body.code).toBe('USERS_EXIST');
    expect(await userCount()).toBe(1);
    // And no new token can be issued.
    expect(await issueSetupToken(db)).toBeNull();
  });

  it('accepts only the newest token', async () => {
    const first = (await issueSetupToken(db))!;
    const second = (await issueSetupToken(db))!;
    expect(second).not.toBe(first);
    expect((await setup(body({ setup_token: first })).expect(403)).body.code).toBe('INVALID_SETUP_TOKEN');
    await setup(body({ setup_token: second })).expect(201);
  });

  it('creates exactly one admin when setups race', async () => {
    const token = (await issueSetupToken(db))!;
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((name) => setup(body({ email: `${name}@example.com`, setup_token: token })))
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403, 403]);
    // A loser that checked the token after the winner cleared it is refused for the token
    // instead; either way it creates nothing.
    for (const res of results.filter((r) => r.status === 403)) {
      expect(['USERS_EXIST', 'INVALID_SETUP_TOKEN']).toContain(res.body.code);
    }
    expect(await userCount()).toBe(1);
    expect(await adminCount()).toBe(1);
  });

  it('makes a setup wait for one in progress, then refuses it', async () => {
    const token = (await issueSetupToken(db))!;
    // Another setup holds the lock and has inserted its (not yet committed) user.
    const other = await owner.connect();
    let settled = false;
    let pending: Promise<request.Response> | undefined;
    try {
      await other.query('BEGIN');
      await other.query('SELECT pg_advisory_xact_lock($1::bigint)', [FIRST_RUN_SETUP_LOCK_KEY]);
      await other.query(`INSERT INTO ${SCHEMA}.users (email, password_hash, first_name) VALUES ('other@example.com', 'x', 'Other')`);

      pending = setup(body({ setup_token: token })).then((res) => {
        settled = true;
        return res;
      });
      // It sees no users yet, so it gets as far as the lock, and waits there.
      const deadline = Date.now() + 8000;
      for (;;) {
        const waiting = await scalar(
          `SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND NOT l.granted AND l.classid = 0 AND l.objid = $1 AND l.objsubid = 1
              AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND a.application_name = $2`,
          [FIRST_RUN_SETUP_LOCK_KEY, SCHEMA]
        );
        if (waiting === 1) break;
        if (settled) throw new Error(`setup finished without waiting for the lock: ${(await pending).status}`);
        if (Date.now() > deadline) throw new Error('setup never waited for the lock');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(settled).toBe(false);
      await other.query('COMMIT');
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      other.release();
    }

    const res = await pending!;
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('USERS_EXIST');
    expect(await userCount()).toBe(1);
    expect(await adminCount()).toBe(0);
  });

  it('logs a token at startup while there are no users, and stores only its hash', async () => {
    const warn = vi.fn();
    await announceSetupToken(db, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const message: string = warn.mock.calls[0][0];
    const token = /setup token on the app's setup page to create the first admin: ([0-9a-f]{64}) /.exec(message)?.[1];
    expect(token).toBeDefined();
    expect(await storedHash()).toBe(hashSetupToken(token!));
    const leaked = await scalar(`SELECT count(*) AS n FROM ${SCHEMA}.deployment d WHERE position($1 IN d::text) > 0`, [
      token,
    ]);
    expect(leaked).toBe(0);

    await setup(body({ setup_token: token })).expect(201);

    // Once an admin exists, a restart logs no token.
    await announceSetupToken(db, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('clears a leftover token at startup once a user exists', async () => {
    await issueSetupToken(db);
    await owner.query(`INSERT INTO ${SCHEMA}.users (email, password_hash, first_name) VALUES ('restored@example.com', 'x', 'Restored')`);
    const warn = vi.fn();
    await announceSetupToken(db, { warn });
    expect(warn).not.toHaveBeenCalled();
    expect(await storedHash()).toBeNull();
  });
});
