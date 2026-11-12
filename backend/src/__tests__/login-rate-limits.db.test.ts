import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The sign-in limiters are built when middleware/security.ts loads, and are no-ops under
// NODE_ENV=test. Build the real ones, with small budgets, then go back to 'test'.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
  process.env.NODE_ENV = 'development';
  process.env.RATE_LIMIT_AUTH_MAX = '5';
  process.env.RATE_LIMIT_PASSKEY_OPTIONS_MAX = '3';
});

import http from 'http';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { accountThrottleKey } from '../services/LoginThrottleService.js';

/**
 * The per-address sign-in limiters: password sign-in, passkey sign-in
 * and first-run setup each have their own bucket, and the sign-in ones count only failed
 * attempts, so a household behind one address can sign in as often as it likes.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const PASSWORD = 'Rate limit passphrase Lx4!';

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

describeDb('Sign-in rate limits per address', () => {
  let owner: Pool;
  let server: http.Server;
  let userId: number;
  const email = `rate-limits-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const strangers: string[] = [];

  let previousRounds: string | undefined;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    // These tests sign in a dozen times each; bcrypt at the lowest cost the app allows keeps
    // them inside their timeout on a loaded machine (the cost itself is tested elsewhere).
    previousRounds = process.env.BCRYPT_ROUNDS;
    process.env.BCRYPT_ROUNDS = '10';
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    owner = new Pool({ connectionString, max: 2 });
    userId = (
      await owner.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, $2, 'Rate', 'Limits') RETURNING id`,
        [email, bcrypt.hashSync(PASSWORD, 4)]
      )
    ).rows[0].id;
  }, 60_000);

  afterAll(async () => {
    if (previousRounds === undefined) delete process.env.BCRYPT_ROUNDS;
    else process.env.BCRYPT_ROUNDS = previousRounds;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!owner) return;
    try {
      await owner.query('DELETE FROM users WHERE id = $1', [userId]);
      await owner.query('DELETE FROM login_throttles WHERE throttle_key = ANY($1)', [[email, ...strangers].map(accountThrottleKey)]);
    } finally {
      await owner.end();
    }
  });

  const stranger = () => {
    const e = `rate-limits-nobody-${strangers.length}-${Date.now()}@test.local`;
    strangers.push(e);
    return e;
  };

  it("doesn't count sign-ins the per-account throttle refused against the address", async () => {
    // Someone's account is throttled; they retry while it is, from the household's address.
    const throttled = stranger();
    await owner.query(
      `INSERT INTO login_throttles (throttle_key, attempts, locked_until) VALUES ($1, 9, now() + interval '10 minutes')`,
      [accountThrottleKey(throttled)]
    );
    for (let i = 0; i < 8; i++) {
      const res = await request(server).post('/api/auth/login').send({ email: throttled, password: 'Wrong guess here 1!' });
      expect(res.body.code).toBe('LOGIN_THROTTLED');
    }
    // Everyone else behind the address can still sign in, and still has their failures.
    expect((await request(server).post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  });

  it('counts only failed password sign-ins', { timeout: 30_000 }, async () => {
    for (let i = 0; i < 8; i++) {
      const ok = await request(server).post('/api/auth/login').send({ email, password: PASSWORD });
      expect(ok.status, `sign-in ${i + 1}: ${JSON.stringify(ok.body)}`).toBe(200);
    }
    // Different addresses each time, so the per-account throttle doesn't step in first.
    for (let i = 0; i < 5; i++) {
      expect((await request(server).post('/api/auth/login').send({ email: stranger(), password: 'Wrong guess here 1!' })).status).toBe(401);
    }
    const limited = await request(server).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });

  it('keeps passkey sign-in and first-run setup in buckets of their own', async () => {
    // The password bucket is used up (above); passkey sign-in and setup still answer.
    const verify = await request(server).post('/api/passkeys/auth/verify').send({});
    expect(verify.status).toBe(400);
    // validateBody's refusal of a body without a passkey response (was MISSING_RESPONSE).
    expect(verify.body.code).toBe('VALIDATION_ERROR');
    const setup = await request(server).post('/api/auth/setup-admin').send({});
    expect(setup.status).toBe(403);

    // Starting a passkey ceremony always succeeds, so every start counts, against its own budget.
    for (let i = 0; i < 3; i++) {
      expect((await request(server).post('/api/passkeys/auth/options').send({})).status).toBe(200);
    }
    expect((await request(server).post('/api/passkeys/auth/options').send({})).status).toBe(429);
  });
});
