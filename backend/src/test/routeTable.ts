import type express from 'express';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';

/**
 * The live route table: every route mountRoutes registers, read from Express's own router
 * stack. route-authorization.test.ts checks each one's guards; apiContract.test.ts checks
 * that every path the frontend and the MCP tools call resolves to one.
 */

export interface Endpoint {
  method: string; // upper case; 'ALL' for app.all / router.all and bare handlers
  path: string; // as declared, with `:params`
  /**
   * Names of the middleware a request passes through, in order. A router.param callback
   * the route's path runs (an org-admin check on `:uuid`, say) is `param:<name>`, with
   * `(<function name>)` when it has one, just before the route's own handlers.
   */
  chain: string[];
}

/** A router's router.param callbacks, by parameter name (the `router` package's `params`). */
type ParamCallbacks = Record<string, Array<{ name: string }>>;

/**
 * The parts of Express 5's router internals (the `router` package, 2.x) this file reads.
 * `slash` is true for a layer mounted at '/' that matches every path below it
 * (`router.use(fn)`); Express 4 kept the same flag as `regexp.fast_slash`.
 */
interface Layer {
  name: string;
  method?: string; // a route's layer: the method it handles, lower case; none for route.all
  route?: { path: unknown; methods: Record<string, boolean>; stack: Layer[] };
  handle: { stack?: Layer[]; params?: ParamCallbacks };
  slash?: boolean;
}

/** The parameters (`:name`, `*name`) of an Express 5 route path, in the order they appear. */
function pathParams(path: string): string[] {
  return [...path.matchAll(/[:*]([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
}

/**
 * The router.param callbacks a request to `path` runs before the route's handlers: each
 * parameter's in path order, as the router calls them once the route matches. They answer
 * for the route as much as its middleware does (organizations.ts checks org admins in one).
 */
function paramChain(params: ParamCallbacks | undefined, path: string): string[] {
  if (!params) return [];
  return pathParams(path).flatMap((name) =>
    (params[name] ?? []).map((fn) => (fn.name ? `param:${name}(${fn.name})` : `param:${name}`))
  );
}

/** An Express app (rather than a router or middleware) mounted with app.use. */
const isExpressApp = (handler: unknown) =>
  typeof handler === 'function' && 'handle' in handler && 'set' in handler;
function routerStack(app: express.Application): Layer[] {
  const stack = (app as unknown as { router?: { stack?: unknown } }).router?.stack;
  if (!Array.isArray(stack)) throw new Error("Can't read the app's router stack (app.router.stack); update buildApp for this Express");
  return stack as Layer[];
}

function joinPath(base: string, sub: string): string {
  return `${base}/${sub}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
}

function routePath(route: { path: unknown }): string {
  if (typeof route.path !== 'string') {
    throw new Error(`Route path ${String(route.path)} is not a string; extend buildApp to list it`);
  }
  return route.path;
}

function methodsOf(route: { methods: Record<string, boolean> }): string[] {
  return Object.keys(route.methods).map((m) => (m === '_all' ? 'ALL' : m.toUpperCase()));
}

/**
 * The handlers a route runs for `method`: as the router dispatches, its layers for that
 * method and those for every method (route.all). A `router.route(path).get(a).post(b, c)`
 * runs a for a GET and b, c for a POST, not all three for both. For 'ALL' (route.all),
 * only the layers every method runs.
 */
function routeChain(route: { stack: Layer[] }, method: string): string[] {
  const m = method.toLowerCase();
  return route.stack.filter((l) => l.method === undefined || l.method === m).map((l) => l.name);
}

/**
 * Build the app as index.ts does and list every route mountRoutes registers. Express
 * doesn't keep a router's mount path (a layer's `path` is set only while it matches a
 * request), so app.use is wrapped while mountRoutes runs to record it. Anything this can't
 * list (a router mounted without a path or twice, a nested router, middleware on a
 * sub-path) throws, so no route goes unchecked.
 */
export function buildApp(lifecycleService: ApplicationLifecycleService) {
  const app = createApp();
  const middlewareLayers = routerStack(app).length;
  const createAppRoutes = routerStack(app).filter((layer) => layer.route).length;

  const mountPaths = new Map<unknown, string>();
  const mountChains = new Map<unknown, string[]>(); // the middleware mounted in front of each router
  const use = app.use.bind(app);
  app.use = ((...args: unknown[]) => {
    const handlers = args.flat(Infinity);
    if (handlers.some(isExpressApp)) throw new Error('A sub-app is mounted with app.use; extend buildApp to list its routes');
    if (typeof args[0] === 'string') {
      const handler = handlers.at(-1);
      if (mountPaths.has(handler)) throw new Error(`A handler mounted at ${args[0]} is mounted twice; extend buildApp`);
      mountPaths.set(handler, args[0]);
      mountChains.set(handler, handlers.slice(1, -1).map((fn) => (fn as { name: string }).name));
    } else if (typeof args[0] !== 'function') {
      throw new Error(`app.use with a ${typeof args[0]} path; extend buildApp to list its routes`);
    }
    return (use as (...a: unknown[]) => express.Application)(...args);
  }) as typeof app.use;
  try {
    mountRoutes(app, { lifecycleService });
  } finally {
    app.use = use;
  }

  const endpoints: Endpoint[] = [];
  const appParams = (app as unknown as { router?: { params?: ParamCallbacks } }).router?.params;
  for (const layer of routerStack(app).slice(middlewareLayers)) {
    if (layer.route) {
      const { route } = layer;
      const path = routePath(route);
      for (const method of methodsOf(route)) {
        endpoints.push({ method, path, chain: [...paramChain(appParams, path), ...routeChain(route, method)] });
      }
      continue;
    }
    const base = mountPaths.get(layer.handle);
    const sub = layer.handle.stack;
    if (base === undefined) {
      if (sub || layer.name === 'mounted_app') {
        throw new Error('A router or sub-app was mounted without a path; extend buildApp to list its routes');
      }
      continue; // middleware in front of a router, or the error handler
    }
    // The app's param callbacks for the mount path's parameters, if it has any, run first.
    const mountChain = [...paramChain(appParams, base), ...(mountChains.get(layer.handle) ?? [])];
    if (!sub) {
      endpoints.push({ method: 'ALL', path: base, chain: mountChain }); // a bare handler mounted with app.use
      continue;
    }
    const routerMiddleware: string[] = []; // router.use(fn) runs before the routes declared after it
    for (const subLayer of sub) {
      if (subLayer.route) {
        const { route } = subLayer;
        // This router's callbacks, for the parameters of the route's own path: the router
        // calls them for the keys of the layer that matched.
        const params = paramChain(layer.handle.params, routePath(route));
        for (const method of methodsOf(route)) {
          const chain = [...mountChain, ...routerMiddleware, ...params, ...routeChain(route, method)];
          endpoints.push({ method, path: joinPath(base, routePath(route)), chain });
        }
      } else if (subLayer.handle.stack) {
        throw new Error(`A router mounted at ${base} nests another router; extend buildApp to list its routes`);
      } else if (isExpressApp(subLayer.handle)) {
        throw new Error(`A router mounted at ${base} mounts a sub-app; extend buildApp to list its routes`);
      } else if (subLayer.slash !== true) {
        throw new Error(`A router mounted at ${base} has middleware on a sub-path; extend buildApp to list it`);
      } else {
        routerMiddleware.push(subLayer.name);
      }
    }
  }
  return { app, endpoints, createAppRoutes };
}

