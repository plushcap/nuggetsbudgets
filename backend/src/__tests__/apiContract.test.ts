import { describe, it, expect, beforeAll, vi } from 'vitest';
import path from 'path';
import { buildApp, type Endpoint } from '../test/routeTable.js';
import { routeTakes, scanDirectory, scanSource, type ApiCall } from '../test/apiCallScanner.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
  // The backup and OneDrive routers build their services when mounted; without the Docker
  // secret they take the development key. This test never encrypts anything.
  process.env.ENCRYPTION_KEY ??= 'unit-test-encryption-key-of-at-least-32-bytes';
});

/**
 * The API contract between the frontend, the MCP tools and the backend, checked from the
 * source: every path and verb the frontend's api helpers (apiGet, apiPost,
 * …), its raw fetch calls to API_BASE_URL, and the MCP tools' client (client.get, …) call
 * resolves to a route that routes.ts mounts. The route table is the live one, read from the app mountRoutes builds,
 * so renaming or removing a route the UI or a tool still calls fails here, not in use.
 *
 * It checks paths and verbs only, not bodies or answers (left for a later phase).
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

/** The routes a call could reach. The `/api` catch-all answers 404, so it doesn't count. */
function routesFor(endpoints: Endpoint[], method: string, callPath: string): Endpoint[] {
  return endpoints.filter(
    (e) => e.path !== '/api' && (e.method === method || e.method === 'ALL') && routeTakes(e.path, callPath)
  );
}

function unresolvedCalls(endpoints: Endpoint[], calls: ApiCall[]): string[] {
  const out: string[] = [];
  for (const call of calls) {
    for (const p of call.paths ?? []) {
      if (routesFor(endpoints, call.method, p).length === 0) {
        out.push(`${call.file}:${call.line}  ${call.method} ${p.replaceAll('{}', ':?')}`);
      }
    }
  }
  return out;
}

const unreadable = (calls: ApiCall[]) =>
  calls.filter((c) => c.paths === undefined || c.method === '?').map((c) => `${c.file}:${c.line}  ${c.text}`);

describe('API contract: frontend and MCP calls resolve to mounted routes', () => {
  let endpoints: Endpoint[];
  let frontendCalls: ApiCall[];
  let mcpCalls: ApiCall[];

  // Builds the app and parses every frontend and MCP source file: about a second on an idle
  // machine, and past the default 10 s hook timeout in a loaded full run. The work is
  // fixed; only the machine's speed varies, so the hook gets a minute.
  beforeAll(() => {
    endpoints = buildApp(lifecycleStub).endpoints;
    frontendCalls = scanDirectory(path.join(REPO_ROOT, 'frontend/src'), 'frontend', REPO_ROOT);
    mcpCalls = scanDirectory(path.join(REPO_ROOT, 'mcp/src'), 'mcp', REPO_ROOT);
  }, 60_000);

  it('finds the calls (a scanner that finds nothing would pass everything)', () => {
    expect(endpoints.length).toBeGreaterThan(300);
    expect(frontendCalls.length).toBeGreaterThan(250); // the helpers' calls and the raw fetches
    expect(mcpCalls.length).toBeGreaterThan(100);
  });

  it('reads the path of every call', () => {
    // A path built some other way (a parameter, a helper's result) can't be checked.
    // Build it in the call (a template, a const in the same file) instead.
    expect(unreadable(frontendCalls), 'frontend calls whose path this test cannot read').toEqual([]);
    expect(unreadable(mcpCalls), 'MCP calls whose path this test cannot read').toEqual([]);
  });

  it('every frontend call resolves to a route with its method', () => {
    expect(unresolvedCalls(endpoints, frontendCalls), 'frontend calls no route answers').toEqual([]);
  });

  it('every MCP tool call resolves to a route with its method', () => {
    expect(unresolvedCalls(endpoints, mcpCalls), 'MCP calls no route answers').toEqual([]);
  });

  it('refuses a call to a route that does not exist, or with the wrong method', () => {
    const calls = scanSource(
      [
        "apiGet('/accounts/no-such-route/really');",
        'apiPatch(`/accounts/${uuid}`);',
        "apiGet('/api/accounts');", // base.ts adds /api: this is /api/api/accounts
        // A uuid where a route has a fixed segment: /accounts/zero-balance/:periodUuid
        // must not take it.
        'apiGet(`/accounts/${uuid}/no-such-thing`);',
        "fetch(`${API_BASE_URL}/accounts/${uuid}/balanzz`, { method: 'GET' });",
        "fetch(`${API_BASE_URL}/accounts/${uuid}`, { method: 'PATCH' });",
      ].join('\n'),
      'frontend/src/fake.ts',
      'frontend'
    );
    expect(unresolvedCalls(endpoints, calls)).toHaveLength(6);
    const ok = scanSource('apiGet(`/accounts/${uuid}`);', 'frontend/src/fake.ts', 'frontend');
    expect(unresolvedCalls(endpoints, ok)).toEqual([]);
  });
});

describe('apiCallScanner', () => {
  const pathsOf = (source: string, kind: 'frontend' | 'mcp' = 'frontend') =>
    scanSource(source, 'x.ts', kind).map((c) => [c.method, c.paths]);

  it('reads strings, templates, conditionals, consts and drops the query', () => {
    expect(
      pathsOf(
        [
          "apiGet('/a/b');",
          'apiPost(`/a/${id}/c`, body);',
          "apiGet(`/r${account ? `?account=${account}` : ''}`);",
          "const suffix = qs.toString() ? `?${qs}` : '';",
          'apiGet(`/t${suffix}`);',
          "apiDelete(flag ? '/x' : `/y/${id}`);",
          "apiGet('/a' + '/b?x=1');",
        ].join('\n')
      )
    ).toEqual([
      ['GET', ['/api/a/b']],
      ['POST', ['/api/a/{}/c']],
      ['GET', ['/api/r']],
      ['GET', ['/api/t']],
      ['DELETE', ['/api/x', '/api/y/{}']],
      ['GET', ['/api/a/b']],
    ]);
  });

  it("reads @nuggets/shared's queryString as the query, and no other function of that name", () => {
    const shared = "import { holdingsQuery, queryString } from '@nuggets/shared';";
    expect(pathsOf(`${shared} apiGet(\`/investments/holdings\${queryString(holdingsQuery, { account })}\`);`)).toEqual([['GET', ['/api/investments/holdings']]]);
    expect(pathsOf(`${shared} apiGet(\`/h/\${id}/lots\${queryString(holdingsQuery, {})}\`);`)).toEqual([['GET', ['/api/h/{}/lots']]]);
    // Not shared's: a function of the same name could return a path.
    expect(pathsOf('const queryString = (q: string) => q; apiGet(`/h${queryString(x)}`);')).toEqual([['GET', undefined]]);
    expect(pathsOf("import { queryString } from './mine'; apiGet(`/h${queryString(x)}`);")).toEqual([['GET', undefined]]);
    expect(pathsOf("import { other as queryString } from '@nuggets/shared'; apiGet(`/h${queryString(x)}`);")).toEqual([['GET', undefined]]);
    // A name bound nearer than the import: a function expression's own, a catch variable.
    expect(pathsOf(`${shared} export const f = function queryString(x: string): string { return apiGet(\`/h\${queryString(x)}\`); };`)).toEqual([['GET', undefined]]);
    expect(pathsOf(`${shared} try { x(); } catch (queryString) { apiGet(\`/h\${queryString(1)}\`); }`)).toEqual([['GET', undefined]]);
    expect(pathsOf("import type { queryString } from '@nuggets/shared'; apiGet(`/h${queryString(x)}`);")).toEqual([['GET', undefined]]);
    expect(pathsOf("import { type queryString } from '@nuggets/shared'; apiGet(`/h${queryString(x)}`);")).toEqual([['GET', undefined]]);
    // A query only ends a path: one with more after it, or the whole of it, can't be read.
    expect(pathsOf(`${shared} apiGet(\`/h\${queryString(holdingsQuery, {})}/more\`);`)).toEqual([['GET', undefined]]);
    expect(pathsOf(`${shared} apiGet(queryString(holdingsQuery, {}));`)).toEqual([['GET', undefined]]);
  });

  it("drops a query shared's queryString builds, in the call or in a const", () => {
    expect(
      pathsOf(
        [
          "import { merchantPageQuery, queryString, tagReportQuery } from '@nuggets/shared';",
          'apiGet(`/merchants/paginated${queryString(merchantPageQuery, { page })}`);',
          'const q = queryString(tagReportQuery, { start_date });',
          'fetch(`${API_BASE_URL}/tags/${uuid}/breakdown${q}`, { headers });',
          // Glued to a segment's text it is still a placeholder: unreadable.
          'apiGet(`/merchants/x-${other(merchantPageQuery)}`);',
        ].join('\n')
      )
    ).toEqual([
      ['GET', ['/api/merchants/paginated']],
      ['GET', ['/api/tags/{}/breakdown']],
      ['GET', undefined],
    ]);
  });

  it('reports a path it cannot read', () => {
    expect(pathsOf('function f(url: string) { return apiGet(url); }')).toEqual([['GET', undefined]]);
    // A parameter shadows a const of the same name outside, default or not.
    expect(pathsOf("const url = '/a'; function f(url: string) { return apiGet(url); }")).toEqual([['GET', undefined]]);
    expect(pathsOf("const url = '/a'; function f(url = '/b') { return apiGet(url); }")).toEqual([['GET', undefined]]);
    expect(pathsOf("const url = '/a'; function f() { let url = '/b'; return apiGet(url); }")).toEqual([['GET', undefined]]);
    // A placeholder glued to text can't be matched by segment.
    expect(pathsOf('apiGet(`/a/x-${id}`);')).toEqual([['GET', undefined]]);
    // Too many possible paths: unreadable, not a loose placeholder.
    const many = Array.from({ length: 7 }, (_, i) => `\${f${i} ? '/a${i}' : '/b${i}'}`).join('');
    expect(pathsOf(`apiGet(\`/x\${many}\`);`.replace('${many}', many))).toEqual([['GET', undefined]]);
  });

  it('reports a call it cannot follow instead of missing it', () => {
    const file = 'frontend/src/services/api/accounts.ts';
    const scanned = (source: string) => scanSource(source, file, 'frontend').map((c) => [c.method, c.paths]);
    // fetch through something other than a const
    expect(scanned('let url = `${API_BASE_URL}/accountz`; fetch(url);')).toEqual([['GET', undefined]]);
    expect(scanned('fetch(`${window.location.origin}/api/x`);')).toEqual([['GET', undefined]]);
    expect(scanned('fetch(new Request(u));')).toEqual([['GET', undefined]]);
    // fetch or a helper as a value, renamed, or through a namespace
    expect(scanned('const f = fetch; f(`${API_BASE_URL}/x`);')).toEqual([['?', undefined]]);
    // A member named fetch is not the global one (frontend/src/test/apiServer.ts returns { fetch: fetchMock }).
    expect(scanned('const server = { fetch: fetchMock }; interface S { fetch: typeof fetch }')).toEqual([]);
    expect(scanned('const o = { fetch };')).toEqual([['?', undefined]]); // shorthand: the global fetch as a value
    expect(scanned('fetch.call(null, `${API_BASE_URL}/x`);')).toEqual([['?', undefined]]);
    expect(scanned('(cond ? apiPut : apiPost)(`/zzz/${id}`, body);')).toEqual([['?', undefined], ['?', undefined]]);
    expect(scanned("import { apiGet as get } from './base';")).toEqual([['?', undefined]]);
    expect(scanned("import * as api from '../services/api'; api.apiGet('/x');")).toEqual([['?', undefined]]);
    // a non-API fetch it can read is not a call to check; a plain import is fine
    expect(scanned("import { apiGet } from './base'; fetch('/manifest.json');")).toEqual([]);
    // MCP tools: a client passed on, destructured or indexed
    const tool = (source: string) => scanSource(source, 'mcp/src/tools/x.ts', 'mcp').map((c) => [c.method, c.paths]);
    expect(tool("handler: async (a, { client }) => client.get('/api/accounts')")).toEqual([['GET', ['/api/accounts']]]);
    expect(tool("handler: async (a, { client }) => client['get']('/api/x')")).toEqual([['?', undefined], ['?', undefined]]);
    expect(tool('handler: async (a, { client }) => { const { get } = client; return get(1); }')).toEqual([['?', undefined]]);
    expect(tool('handler: async (a, { client }) => helper(client)')).toEqual([['?', undefined]]);
    // Reached as ctx.client, by a string key, or through window.fetch.
    expect(tool("handler: async (a, ctx) => ctx.client.get('/api/accounts')")).toEqual([['GET', ['/api/accounts']]]);
    expect(tool("handler: async (a, ctx) => { const c = ctx.client; return c.get('/api/x'); }")).toEqual([['?', undefined]]);
    expect(tool('handler: async (a, ctx) => { const { get } = ctx.client; return get(1); }')).toEqual([['?', undefined]]);
    expect(tool("handler: async () => fetch('http://127.0.0.1:5000/api/nope')")).toEqual([['?', undefined]]);
    expect(scanned("window['fetch'](`${API_BASE_URL}/x`);")).toEqual([['?', undefined]]);
    expect(scanned('window.fetch.call(window, `${API_BASE_URL}/x`);')).toEqual([['?', undefined]]);
    expect(scanned('(0, window.fetch)(`${API_BASE_URL}/x`);')).toEqual([['?', undefined]]);
    expect(scanned('const f = self.fetch;')).toEqual([['?', undefined]]);
    expect(scanned("import * as B from './base'; B['apiDelete']('/x');")).toEqual([['?', undefined]]);
    // Not uses of a helper: a type, an interface member, a method.
    expect(scanned('type G = typeof apiGet; interface I { apiGet(): void; apiPost: () => void } const o = { apiGet() {} };')).toEqual([]);
    // A .js file is scanned like a .ts one.
    expect(scanSource("apiGet('/no-such-route');", 'frontend/src/zz.js', 'frontend').map((c) => c.paths)).toEqual([['/api/no-such-route']]);
  });

  it('resolves names through destructuring with $ and hoisted var', () => {
    expect(pathsOf("const $p = '/accounts'; function f({ $p }) { return apiGet($p); }")).toEqual([['GET', undefined]]);
    expect(pathsOf("const $p = '/accounts'; const { $p: q, ...$r } = o; function f() { const { $p } = o; return apiGet($p); }")).toEqual([
      ['GET', undefined],
    ]);
    expect(pathsOf("const p = '/accounts'; function f() { if (x) { var p = '/nope'; } return apiGet(p); }")).toEqual([['GET', undefined]]);
  });

  it('reads a parameter typed as a union of strings as its values', () => {
    expect(pathsOf("function f(action: 'start' | 'stop') { return apiPost(`/s/${action}`); }")).toEqual([
      ['POST', ['/api/s/start', '/api/s/stop']],
    ]);
    // Optional, it can also be undefined: an unknown value, which only a :param takes.
    expect(pathsOf("function f(action?: 'start' | 'stop') { return apiPost(`/s/${action}`); }")).toEqual([['POST', ['/api/s/{}']]]);
  });

  it('reads raw fetch calls to API_BASE_URL, with their method', () => {
    expect(
      pathsOf(
        [
          'fetch(`${API_BASE_URL}/a/${id}`);',
          "fetch(`${API_BASE_URL}/a`, { method: 'POST', body });",
          "window.fetch(`${API_BASE_URL}/a?x=1`, { method: 'delete' });",
          'fetch(`${API_BASE_URL}/a`, init);',
          "fetch(`${API_BASE_URL}/a`, { ...init, method: 'PUT' });",
          'fetch(`${API_BASE_URL}/a`, { "method": "PATCH" });',
          "fetch(`${API_BASE_URL}/a`, { [key]: 'DELETE' });",
          "self.fetch(`${API_BASE_URL}/a`);",
          "fetch('/manifest.json');", // not the API: not a call to check
        ].join('\n')
      )
    ).toEqual([
      ['GET', ['/api/a/{}']],
      ['POST', ['/api/a']],
      ['DELETE', ['/api/a']],
      ['?', ['/api/a']],
      ['?', ['/api/a']],
      ['PATCH', ['/api/a']],
      ['?', ['/api/a']],
      ['GET', ['/api/a']],
    ]);
  });

  it("skips a helper's own fetch, and reads a listed forwarder's callers", () => {
    const helper = 'export const apiGet = async (endpoint: string) => fetch(`${API_BASE_URL}${endpoint}`);';
    const inFile = (source: string, file: string) => scanSource(source, file, 'frontend').map((c) => [c.method, c.paths]);
    expect(inFile(helper, 'frontend/src/services/api/base.ts')).toEqual([]);
    // Anywhere else, or with a readable path, or in a callback inside it: checked.
    // (and a helper defined outside its home is itself reported)
    expect(inFile(helper, 'frontend/src/services/api/accounts.ts')).toEqual([['?', undefined], ['GET', undefined]]);
    // The skipped call must be exactly the helper's shape, with its method.
    const base = 'frontend/src/services/api/base.ts';
    expect(inFile("export const apiPatch = async (endpoint: string) => fetch(`${API_BASE_URL}${endpoint}`, { method: 'PUT' });", base)).toEqual([
      ['PUT', undefined],
    ]);
    expect(inFile('export const apiGet = async (endpoint: string) => fetch(`${API_BASE_URL}/v2${endpoint}`);', base)).toEqual([
      ['GET', undefined],
    ]);
    expect(
      inFile(
        'const exportCsv = async (endpoint: string) => { await apiDelete(endpoint); };',
        'frontend/src/pages/InvestmentTaxPage.tsx'
      )
    ).toEqual([['DELETE', undefined]]);
    // A reassigned parameter, or an exported forwarder (its callers elsewhere would be missed).
    expect(inFile('export const apiGet = async (endpoint: string) => { endpoint = `/v2${endpoint}`; return fetch(`${API_BASE_URL}${endpoint}`); };', base)).toEqual([
      ['GET', undefined],
    ]);
    expect(
      inFile('export const exportCsv = async (endpoint: string) => { await downloadCsv(endpoint); };', 'frontend/src/pages/InvestmentTaxPage.tsx')
    ).toEqual([['?', undefined]]);
    expect(
      inFile("export const apiDelete = () => fetch(`${API_BASE_URL}/no-such-route`, { method: 'DELETE' });", 'frontend/src/services/api/base.ts')
    ).toEqual([['DELETE', ['/api/no-such-route']]]);
    expect(
      inFile(
        "export const zz = () => { const apiDelete = () => fetch(`${API_BASE_URL}/no-such-route`, { method: 'DELETE' }); return apiDelete; };",
        'frontend/src/services/api/accounts.ts'
      )
    ).toEqual([
      ['?', undefined], // a helper's name defined outside its home
      ['DELETE', ['/api/no-such-route']],
      ['?', undefined], // and returned as a value
    ]);
    expect(
      inFile('export const apiGet = (endpoint: string) => [1].map(() => fetch(`${API_BASE_URL}${endpoint}`));', 'frontend/src/services/api/base.ts')
    ).toEqual([['GET', undefined]]);
    const forwarded = scanSource(
      [
        'const exportCsv = async (endpoint: string) => { await downloadCsv(endpoint); };',
        "exportCsv('/investments/export/dividends.csv');",
      ].join('\n'),
      'frontend/src/pages/InvestmentTaxPage.tsx',
      'frontend'
    ).map((c) => [c.method, c.paths]);
    expect(forwarded).toEqual([['GET', ['/api/investments/export/dividends.csv']]]);
  });

  it('reads the MCP client, apiPath and request(method, path)', () => {
    expect(
      pathsOf(
        [
          "client.get('/api/accounts', { limit: 1 });",
          'ctx.client.put(apiPath`/api/accounts/${uuid}/instructions`, {});',
          "client.request('PATCH', '/api/x');",
          "other.get('/api/not-a-client');",
        ].join('\n'),
        'mcp'
      )
    ).toEqual([
      ['GET', ['/api/accounts']],
      ['PUT', ['/api/accounts/{}/instructions']],
      ['PATCH', ['/api/x']],
    ]);
  });

  it('matches route paths segment by segment', () => {
    expect(routeTakes('/api/accounts/:uuid', '/api/accounts/{}')).toBe(true);
    // A placeholder is a value the scanner can't know: only a parameter takes it.
    expect(routeTakes('/api/accounts/paginated', '/api/accounts/{}')).toBe(false);
    expect(routeTakes('/api/accounts/zero-balance/:periodUuid', '/api/accounts/{}/typo')).toBe(false);
    expect(routeTakes('/api/accounts/:uuid', '/api/accounts')).toBe(false);
    expect(routeTakes('/api/accounts', '/api/accounts/')).toBe(true);
    expect(routeTakes('/api/a/*', '/api/a/{}')).toBe(true);
  });

  // The contract test's known limits, each fixed:
  it('takes fixed text at a parameter only when it is a value of its kind', () => {
    // A typo in a fixed segment matched the route's parameter at that position.
    expect(routeTakes('/api/accounts/:uuid', '/api/accounts/summray')).toBe(false);
    expect(routeTakes('/api/accounts/:uuid', '/api/accounts/0190a000-0001-7000-8000-000000000001')).toBe(true);
    expect(routeTakes('/api/tags/budget-items/:budgetItemUuid/tags/:tagId', '/api/tags/budget-items/{}/tags/42')).toBe(true);
    expect(routeTakes('/api/tags/budget-items/:budgetItemUuid/tags/:tagId', '/api/tags/budget-items/{}/tags/x42')).toBe(false);
    // A free-form parameter takes any text.
    expect(routeTakes('/api/admin/notifications/preview/:templateType', '/api/admin/notifications/preview/digest')).toBe(true);
    const calls = scanSource("apiGet('/accounts/summray');", 'frontend/src/fake.ts', 'frontend');
    expect(unresolvedCalls(buildApp(lifecycleStub).endpoints, calls)).toHaveLength(1);
  });

  it('reports a value in a path that could hold several segments, until it is encoded', () => {
    // A string could hold a `/` and reach another route: a placeholder was one segment.
    expect(pathsOf('function f(name: string) { return apiGet(`/files/${name}`); }')).toEqual([['GET', undefined]]);
    expect(pathsOf('function f(name: string) { return apiGet(`/files/${encodeURIComponent(name)}`); }')).toEqual([['GET', ['/api/files/{}']]]);
    // Something named for an id or a uuid is one segment, and so is a number; in the query it doesn't matter.
    expect(pathsOf('apiGet(`/a/${account.uuid}/b/${budgetItemId}/c/${String(n.id)}`);')).toEqual([['GET', ['/api/a/{}/b/{}/c/{}']]]);
    expect(pathsOf('apiGet(`/a?q=${search}`);')).toEqual([['GET', ['/api/a']]]);
  });

  it('reads the links the browser opens itself: window.open and href', () => {
    const linksOf = (source: string) => scanSource(source, 'x.tsx', 'frontend').map((c) => [c.method, c.paths]);
    expect(
      linksOf(
        [
          "window.open(`${API_BASE_URL}/attachments/file/${encodeURIComponent(a.uuid)}`, '_blank');",
          'const link = <a href={`${API_BASE_URL}/backup/download/${encodeURIComponent(file)}`}>x</a>;',
          'const raw = <a href="/api/export/transactions.csv">x</a>;',
          "window.open('https://login.example.com/authorize');", // another site: not a call
          'window.open(authUrl);', // an address the server sent: not visibly the API
          'const site = <a href="https://example.com">x</a>;',
          'function f(t: string) { window.open(`/api/admin/notifications/preview/${t}`); }', // the API, unreadable
        ].join('\n'),
      ),
    ).toEqual([
      ['GET', ['/api/attachments/file/{}']],
      ['GET', ['/api/backup/download/{}']],
      ['GET', ['/api/export/transactions.csv']],
      ['GET', undefined],
    ]);
    const calls = scanSource("const l = <a href={`${API_BASE_URL}/no-such/route`}>x</a>;", 'frontend/src/fake.tsx', 'frontend');
    expect(unresolvedCalls(buildApp(lifecycleStub).endpoints, calls)).toHaveLength(1);
  });
});
