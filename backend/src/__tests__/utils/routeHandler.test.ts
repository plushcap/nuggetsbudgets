import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { authHandler, tenantHandler, tenantNetworkHandler, SIGNED_IN_HANDLERS } from '../../utils/routeHandler.js';
import { rejectMalformedIds } from '../../middleware/routeParams.js';

/**
 * authHandler, tenantHandler and tenantNetworkHandler hand their handler a request whose
 * `user` is set. They run behind authenticateToken at every mount (routes.ts;
 * route-authorization.test.ts checks the chains), and they check it themselves too: a
 * router mounted without it answers 401 AUTH_REQUIRED rather than run the handler.
 */
describe('the signed-in route wrappers', () => {
  const signIn: RequestHandler = (req, _res, next) => {
    req.user = { userId: 7, email: 'someone@test.local' };
    next();
  };

  /** An app with the three wrappers under /probe, signed in or not; `ran` records each handler that ran. */
  function appWith(signedIn: boolean) {
    const ran: string[] = [];
    const router = express.Router();
    router.get('/auth', authHandler(async (req, res) => {
      ran.push('auth');
      res.json({ userId: req.user.userId });
    }));
    router.get('/tenant', tenantHandler(async (_req, res) => {
      ran.push('tenant');
      res.json({});
    }));
    router.get('/network', tenantNetworkHandler(async (_req, res) => {
      ran.push('network');
      res.json({});
    }));
    router.get('/auth/:uuid', authHandler(async (_req, res) => {
      ran.push('auth/:uuid');
      res.json({});
    }));
    const app = express();
    if (signedIn) app.use(signIn);
    app.use('/probe', rejectMalformedIds(router));
    return { app, ran };
  }

  it('answer 401 AUTH_REQUIRED and run nothing without a signed-in user', async () => {
    const { app, ran } = appWith(false);
    for (const path of ['/probe/auth', '/probe/tenant', '/probe/network']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
      expect(res.body, path).toEqual({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    expect(ran).toEqual([]);
  });

  it('check the user before answering a malformed id, as a guard does', async () => {
    const anonymous = appWith(false);
    expect((await request(anonymous.app).get('/probe/auth/not-a-uuid')).status).toBe(401);
    const signedIn = appWith(true);
    expect((await request(signedIn.app).get('/probe/auth/not-a-uuid')).status).toBe(404);
    expect([...anonymous.ran, ...signedIn.ran]).toEqual([]);
  });

  it('run the handler for a signed-in user', async () => {
    const { app, ran } = appWith(true);
    expect((await request(app).get('/probe/auth').expect(200)).body).toEqual({ userId: 7 });
    // No ledger is selected here: the tenant wrappers answer that, after the user check.
    for (const path of ['/probe/tenant', '/probe/network']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(400);
      expect(res.body.code, path).toBe('NO_ACTIVE_TENANT');
    }
    expect(ran).toEqual(['auth']);
  });

  it('carry their names, which the route table reads', () => {
    const handlers = [authHandler(async () => {}), tenantHandler(async () => {}), tenantNetworkHandler(async () => {})];
    expect(handlers.map((h) => h.name)).toEqual([...SIGNED_IN_HANDLERS]);
  });
});
