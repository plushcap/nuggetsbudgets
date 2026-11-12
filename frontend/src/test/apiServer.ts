/**
 * A stand-in for the backend at the network edge, for page tests.
 *
 * The page under test runs its real React Query hooks and `services/api` calls;
 * only `fetch` is replaced. So a test sees what the page actually requests (method,
 * path, query and body) and what it does with what the API answers, and survives a
 * refactor of the hooks or components in between.
 *
 * Routes are `'METHOD /path'` keys, the path as the page calls it after `/api`, with
 * `:name` segments matching one path segment. A request no route answers is a 404 and
 * is kept in `unhandled`, so a test can say the page asked for nothing unexpected.
 *
 * Answers are fixtures checked against the `@nuggets/shared` schemas (`./fixtures`),
 * so a fixture can't say something the API's contract doesn't.
 *
 * Like the backend, it refuses a write without the session's CSRF token: it
 * sets the CSRF cookie the API helpers read, and answers a non-GET request whose
 * `X-CSRF-Token` header doesn't match with 403 `CSRF_INVALID`, except the sign-in
 * endpoints, which are exempt (`csrfExempt`).
 */
import { vi } from 'vitest';

export interface ApiRequest {
  method: string;
  /** The path after `/api`, e.g. `/budgets/periods`. */
  path: string;
  query: URLSearchParams;
  /** The parsed JSON body, else the raw body, else undefined. */
  body: unknown;
  params: Record<string, string>;
  /** The request's headers (names lower-cased by `Headers`). */
  headers: Headers;
  credentials: RequestCredentials | undefined;
}

/** The token the stand-in puts in the CSRF cookie and expects back on a write. */
export const TEST_CSRF_TOKEN = 'test-csrf-token';
const CSRF_EXEMPT = ['POST /auth/login', 'POST /auth/setup-admin'];

/** What a route answers: a JSON body (status 200), or a status with one. */
export type ApiReply = { status: number; body?: unknown } | unknown;
export type ApiRoute = ApiReply | ((req: ApiRequest) => ApiReply | Promise<ApiReply>);

const isReply = (value: unknown): value is { status: number; body?: unknown } =>
  typeof value === 'object' && value !== null && 'status' in value && typeof (value as { status: unknown }).status === 'number'
  && Object.keys(value).every((k) => k === 'status' || k === 'body');

/** An error answer in the API's shape (`ApiErrorBody`). */
export const apiError = (status: number, error: string, code: string) => ({
  status,
  body: { error, code, requestId: `req-${status}` },
});

const match = (pattern: string, path: string): Record<string, string> | null => {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) params[want[i].slice(1)] = decodeURIComponent(got[i]);
    else if (want[i] !== got[i]) return null;
  }
  return params;
};

const readBody = (body: BodyInit | null | undefined): unknown => {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

/**
 * Replace `fetch` with `routes`. Returns the requests made (`requests`, `unhandled`)
 * and `calls(key)` for the requests one route answered. `vi.unstubAllGlobals()`
 * (or a new `mockApi`) puts it back.
 */
export function mockApi(routes: Record<string, ApiRoute>, { csrfExempt = CSRF_EXEMPT }: { csrfExempt?: string[] } = {}) {
  document.cookie = `csrf_token=${TEST_CSRF_TOKEN}; path=/`;
  const requests: ApiRequest[] = [];
  const unhandled: string[] = [];
  const answered = new Map<string, ApiRequest[]>();
  const table = Object.entries(routes).map(([key, route]) => {
    const [method, pattern] = key.split(' ');
    return { key, method, pattern, route };
  });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api/, '');
    for (const { key, method: m, pattern, route } of table) {
      if (m !== method) continue;
      const params = match(pattern, path);
      if (!params) continue;
      const headers = new Headers(init?.headers);
      const req: ApiRequest = { method, path, query: url.searchParams, body: readBody(init?.body), params, headers, credentials: init?.credentials };
      requests.push(req);
      answered.set(key, [...(answered.get(key) ?? []), req]);
      const write = method !== 'GET' && method !== 'HEAD';
      if (write && !csrfExempt.includes(key) && headers.get('X-CSRF-Token') !== TEST_CSRF_TOKEN) {
        return new Response(JSON.stringify({ error: 'Invalid CSRF token', code: 'CSRF_INVALID', requestId: 'req-403' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const reply = typeof route === 'function' ? await route(req) : route;
      const { status, body } = isReply(reply) ? reply : { status: 200, body: reply };
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    unhandled.push(`${method} ${path}${url.search}`);
    return new Response(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND', requestId: 'req-404' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    fetch: fetchMock,
    requests,
    unhandled,
    /** The requests the route `key` answered, in order. */
    calls: (key: string) => answered.get(key) ?? [],
  };
}

/**
 * The text of the line a label starts: the label with its figure, read from the
 * nearest element around the label that holds more than the label itself (so an
 * extra wrapper around either doesn't matter).
 */
export function labelledLine(label: HTMLElement): string {
  const own = label.textContent ?? '';
  let node: HTMLElement | null = label;
  while (node && (node.textContent ?? '') === own) node = node.parentElement;
  return node?.textContent ?? own;
}
