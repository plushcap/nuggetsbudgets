import { describe, it, expect, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

/**
 * The route table walker (test/routeTable.ts) that route-authorization.test.ts and
 * apiContract.test.ts read every route from. It reads Express's router internals, which
 * Express 5 changed, so this pins what it must do on the Express that runs: list a
 * router's routes with the middleware in front of each, and throw on any shape it can't
 * list, so no route goes unchecked. mountRoutes is replaced with each shape in turn.
 */

const shape = vi.hoisted(() => ({ name: '', ran: [] as string[] }));

vi.mock('../routes.js', () => ({
  mountRoutes: (app: express.Application) => {
    const guard = function guard(_req: unknown, _res: unknown, next: () => void) {
      next();
    };
    const router = express.Router();
    router.get('/x', (_req, res) => {
      res.json({});
    });
    const inner = express.Router();
    inner.get('/z', (_req, res) => {
      res.json({});
    });
    switch (shape.name) {
      case 'listable':
        router.use(guard); // runs before the routes declared after it
        router.post('/y', (_req, res) => {
          res.json({});
        });
        app.use('/api/listed', guard, router);
        app.get('/api/plain', guard, (_req, res) => {
          res.json({});
        });
        break;
      case 'one route, several methods': {
        const open = function open(_req: unknown, res: express.Response) {
          res.json({});
        };
        // A GET without the guard beside a POST with it: the GET must not be credited with it.
        router.route('/shared').get(open).post(guard, open);
        router.route('/every').all(guard).put(open);
        app.use('/api/multi', router);
        break;
      }
      case 'a nested router on a sub-path':
        router.use('/inner', inner);
        app.use('/api/nested', router);
        break;
      case 'a nested router':
        router.use(inner);
        app.use('/api/nested', router);
        break;
      case 'a sub-app':
        app.use('/api/sub', express());
        break;
      case 'a sub-app in a router':
        router.use(express());
        app.use('/api/sub', router);
        break;
      case 'a router without a mount path':
        app.use(router);
        break;
      case 'a router mounted twice':
        app.use('/api/a', router);
        app.use('/api/b', router);
        break;
      case 'router middleware on a sub-path':
        router.use('/sub', guard);
        app.use('/api/mw', router);
        break;
      case 'param callbacks': {
        // Each records itself, so the test can compare what Express ran with what the walker lists.
        const ran = (label: string) => (_req: unknown, _res: unknown, next: () => void) => {
          shape.ran.push(label);
          next();
        };
        const checkOrg = function checkOrg(req: unknown, res: unknown, next: () => void) {
          ran('checkOrg')(req, res, next);
        };
        router.param('uuid', checkOrg);
        router.param('uuid', ran('anonymous'));
        router.param('memberUuid', checkOrg);
        router.get('/:uuid/members/:memberUuid', (_req, res) => {
          shape.ran.push('route');
          res.json({});
        });
        app.param('id', checkOrg);
        app.get('/api/things/:id', (_req, res) => {
          shape.ran.push('route');
          res.json({});
        });
        app.use('/api/orgs', guard, router);
        break;
      }
    }
  },
}));

const { buildApp } = await import('../test/routeTable.js');
const lifecycleStub = {} as Parameters<typeof buildApp>[0];

describe('the route table walker', () => {
  it("lists each route with the middleware in front of it, in order", () => {
    shape.name = 'listable';
    expect(buildApp(lifecycleStub).endpoints).toEqual([
      { method: 'GET', path: '/api/listed/x', chain: ['guard', '<anonymous>'] },
      { method: 'POST', path: '/api/listed/y', chain: ['guard', 'guard', '<anonymous>'] },
      { method: 'GET', path: '/api/plain', chain: ['guard', '<anonymous>'] },
    ]);
  });

  it('gives each method of one route only the handlers that run for it', () => {
    shape.name = 'one route, several methods';
    expect(buildApp(lifecycleStub).endpoints).toEqual([
      { method: 'GET', path: '/api/multi/x', chain: ['<anonymous>'] },
      { method: 'GET', path: '/api/multi/shared', chain: ['open'] },
      { method: 'POST', path: '/api/multi/shared', chain: ['guard', 'open'] },
      { method: 'ALL', path: '/api/multi/every', chain: ['guard'] },
      { method: 'PUT', path: '/api/multi/every', chain: ['guard', 'open'] },
    ]);
  });

  it("lists a path's router.param callbacks, in the order Express runs them, before the route's handlers", async () => {
    shape.name = 'param callbacks';
    const { app, endpoints } = buildApp(lifecycleStub);
    expect(endpoints).toEqual([
      { method: 'GET', path: '/api/things/:id', chain: ['param:id(checkOrg)', '<anonymous>'] },
      { method: 'GET', path: '/api/orgs/x', chain: ['guard', '<anonymous>'] },
      {
        method: 'GET',
        path: '/api/orgs/:uuid/members/:memberUuid',
        chain: ['guard', 'param:uuid(checkOrg)', 'param:uuid', 'param:memberUuid(checkOrg)', '<anonymous>'],
      },
    ]);
    // What Express runs for a request, in that order.
    const { default: request } = await import('supertest');
    shape.ran = [];
    await request(app).get('/api/orgs/u1/members/m1').expect(200);
    expect(shape.ran).toEqual(['checkOrg', 'anonymous', 'checkOrg', 'route']);
    shape.ran = [];
    await request(app).get('/api/things/7').expect(200);
    expect(shape.ran).toEqual(['checkOrg', 'route']);
  });

  it.each([
    'a nested router on a sub-path',
    'a nested router',
    'a sub-app',
    'a sub-app in a router',
    'a router without a mount path',
    'a router mounted twice',
    'router middleware on a sub-path',
  ])("throws on %s rather than leave its routes out", (name) => {
    shape.name = name;
    expect(() => buildApp(lifecycleStub)).toThrow(/extend buildApp/);
  });
});
