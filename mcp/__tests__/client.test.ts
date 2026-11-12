import { describe, it, expect } from 'vitest';
import { merchantPageQuery, queryString } from '@nuggets/shared';
import { NuggetsApiClient, RefusedPathError, apiPath } from '../src/client.js';
import { callTool, makeFetchStub } from './harness.js';

/**
 * The API client calls only the API's own routes, exactly as written:
 * the URL parser would otherwise resolve `..` (also as %2e) or a backslash into another
 * route, or send the caller's token to another host.
 */
describe('NuggetsApiClient paths', () => {
  const client = (fetchImpl: typeof fetch, baseUrl = 'http://api.local:5000') =>
    new NuggetsApiClient({ baseUrl, authorization: 'Bearer secret-token', fetchImpl });

  it('calls an /api path on its base URL with the token', async () => {
    const stub = makeFetchStub();
    await client(stub.fetchImpl).get('/api/accounts', { limit: 5, skip: undefined });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe('http://api.local:5000/api/accounts?limit=5');
    expect(stub.calls[0].headers.authorization).toBe('Bearer secret-token');
  });

  it('keeps a base URL’s own path', async () => {
    const stub = makeFetchStub();
    await client(stub.fetchImpl, 'https://example.test/nuggets/').get('/api/accounts');
    expect(stub.calls[0].url).toBe('https://example.test/nuggets/api/accounts');
  });

  it.each([
    ['an absolute URL', 'https://attacker.example/steal'],
    ['an absolute http URL', 'http://api.local:5000/api/accounts'],
    ['a protocol-relative URL', '//attacker.example/api/accounts'],
    ['a path outside /api', '/uploads/user-profiles/x.png'],
    ['a relative path', 'api/accounts'],
    ['a dot-dot segment', '/api/annotations/../admin/users/u/deployment-admin'],
    ['a dot segment', '/api/./accounts'],
    ['a percent-encoded dot-dot', '/api/annotations/%2e%2e/admin/users/u/deployment-admin'],
    ['a mixed-case encoded dot-dot', '/api/annotations/.%2E/admin'],
    ['a backslash', '/api/annotations/..\\admin\\users'],
    ['a query in the path', '/api/accounts?limit=1'],
    ['a fragment in the path', '/api/accounts#x'],
    ['an empty segment', '/api//accounts'],
    ['a trailing slash', '/api/accounts/'],
  ])('refuses %s without sending the token anywhere', async (_label, path) => {
    const stub = makeFetchStub();
    for (const send of [
      () => client(stub.fetchImpl).get(path),
      () => client(stub.fetchImpl).patch(path, { status: 'resolved' }),
      () => client(stub.fetchImpl).request('DELETE', path),
    ]) {
      await expect(send()).rejects.toThrow(RefusedPathError);
    }
    expect(stub.calls).toHaveLength(0);
  });

  it('sends the request id it was given as x-request-id', async () => {
    const stub = makeFetchStub();
    await new NuggetsApiClient({ baseUrl: 'http://api.local', authorization: 'Bearer t', fetchImpl: stub.fetchImpl, requestId: 'req-42' }).get('/api/accounts');
    expect(stub.calls[0].headers['x-request-id']).toBe('req-42');
  });
});

describe('apiPath', () => {
  const uuid = '019a3b2c-1d2e-7f00-8a00-000000000001';

  it('interpolates an id as is', () => {
    expect(apiPath`/api/annotations/${uuid}`).toBe(`/api/annotations/${uuid}`);
    expect(apiPath`/api/tags/budget-items/${uuid}/tags/${12}`).toBe(`/api/tags/budget-items/${uuid}/tags/12`);
  });

  it('encodes a value as one segment, so it can’t add segments or a query', () => {
    expect(apiPath`/api/annotations/${'../admin/users/x/deployment-admin'}`).toBe(
      '/api/annotations/..%2Fadmin%2Fusers%2Fx%2Fdeployment-admin'
    );
    expect(apiPath`/api/merchants/${'a?b=c#d'}`).toBe('/api/merchants/a%3Fb%3Dc%23d');
    expect(apiPath`/api/merchants/${'%2e%2e'}`).toBe('/api/merchants/%252e%252e');
    expect(apiPath`/api/merchants/${'a\\b'}`).toBe('/api/merchants/a%5Cb');
  });

  it.each(['', '.', '..'])('refuses %j, which no encoding keeps a segment', (value) => {
    expect(() => apiPath`/api/annotations/${value}`).toThrow(RefusedPathError);
  });

  it('builds paths the client sends as written', async () => {
    const stub = makeFetchStub();
    const c = new NuggetsApiClient({ baseUrl: 'http://api.local', authorization: 'Bearer t', fetchImpl: stub.fetchImpl });
    await c.patch(apiPath`/api/annotations/${'../admin/users/x/deployment-admin'}`, { status: 'resolved' });
    expect(new URL(stub.calls[0].url).pathname).toBe('/api/annotations/..%2Fadmin%2Fusers%2Fx%2Fdeployment-admin');
  });
});

/**
 * The tools write each query with the route's own schema from @nuggets/shared:
 * a value the route would refuse is refused here, with the route's message, before any
 * request goes, and the values go as the route reads them.
 */
describe('queryString in the tools', () => {
  it('writes the values set, once each, as text, and leaves out the empty ones', () => {
    expect(queryString(merchantPageQuery, { page: 2, limit: 50, search: '', fields: undefined })).toBe('?page=2&limit=50');
  });

  it('refuses a filter the route would refuse, before the request goes', async () => {
    const stub = makeFetchStub();
    // The tool's own schema takes any positive id; the route's takes ids that fit an int4.
    const result = (await callTool(stub.fetchImpl, 'list_transactions', { merchantId: 2147483648 })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(stub.calls).toEqual([]);
    expect(result.isError).toBe(true);
    // Answered as the route would: its 400, with its own message (helpers.ts).
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({ status: 400, code: 'VALIDATION_ERROR', message: 'merchant_id must be a whole number' });
  });
});
