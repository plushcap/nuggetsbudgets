import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { runWithRequestContext } from '../../context/requestContext.js';
import { circuitBreakerService } from '../../services/CircuitBreakerService.js';

/**
 * What the SimpleFin client sends and how it reads the answer, with `fetch` stubbed under
 * simplefinRequest: the request (path, query, credentials moved into a Basic header), the
 * failures it turns into SimpleFinUpstreamError, v1 errors folded into errlist, and the
 * connection test. Written against ImportService before it was split, so the split
 * is held to the same requests.
 */

const access = vi.hoisted(() => ({ url: 'https://user:secret@bridge.simplefin.org/simplefin' as string | null }));
vi.mock('../../services/OrganizationSimpleFinService.js', () => ({
  getAccessUrlForTenant: vi.fn(async () => access.url),
  getConnectionForTenant: vi.fn(async () => null),
  markSynced: vi.fn(async () => {}),
}));

import { ImportService, NoSimpleFinConnectionError, SimpleFinUpstreamError } from '../../services/ImportService.js';

const TENANT = 4242;
const asTenant = <T>(fn: () => Promise<T>) => runWithRequestContext({ userId: 1, tenantId: TENANT, isDeploymentAdmin: false }, fn);

describe('The SimpleFin client', () => {
  const service = new ImportService({} as Pool);
  let answer: () => Response | Promise<Response>;
  const fetchStub = vi.fn(async (_url: string | URL, _init?: RequestInit) => answer());

  beforeEach(() => {
    access.url = 'https://user:secret@bridge.simplefin.org/simplefin';
    answer = () => new Response(JSON.stringify({ errlist: [], connections: [], accounts: [] }), { status: 200 });
    fetchStub.mockClear();
    vi.stubGlobal('fetch', fetchStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    circuitBreakerService.clearAll();
  });

  const fetchAccounts = (options: Parameters<ImportService['fetchAccounts']>[0]) => asTenant(() => service.fetchAccounts(options));

  it('asks for /accounts with the options as query parameters, and the credentials in a Basic header', async () => {
    const startDate = new Date('2026-10-01T00:00:00Z');
    const endDate = new Date('2026-10-31T00:00:00Z');
    await fetchAccounts({ startDate, endDate, includePending: true, balancesOnly: true, accountId: 'ACT-1' });

    expect(fetchStub).toHaveBeenCalledOnce();
    const [url, init] = fetchStub.mock.calls[0];
    const sent = new URL(String(url));
    expect(sent.origin + sent.pathname).toBe('https://bridge.simplefin.org/simplefin/accounts');
    expect(sent.username).toBe('');
    expect(sent.password).toBe('');
    expect([...sent.searchParams]).toEqual([
      ['start-date', String(startDate.getTime() / 1000)],
      ['end-date', String(endDate.getTime() / 1000)],
      ['pending', '1'],
      ['balances-only', '1'],
      ['account', 'ACT-1'],
      ['version', '2'],
      ['fields', 'balance,available-balance,balance-date'],
    ]);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({
      Authorization: `Basic ${Buffer.from('user:secret').toString('base64')}`,
      'Content-Type': 'application/json',
    });
  });

  it('folds v1 error strings into errlist, and keeps a v2 errlist as it is', async () => {
    answer = () => new Response(JSON.stringify({ errors: ['Bank is down'], accounts: [] }), { status: 200 });
    expect((await fetchAccounts({ startDate: new Date() })).errlist).toEqual([{ code: 'gen.', msg: 'Bank is down' }]);

    const errlist = [{ code: 'con.auth', msg: 'Sign in again', conn_id: 'C1' }];
    answer = () => new Response(JSON.stringify({ errlist, errors: ['ignored'], accounts: [] }), { status: 200 });
    expect((await fetchAccounts({ startDate: new Date() })).errlist).toEqual(errlist);
  });

  it.each([
    ['a refusal', () => new Response('no', { status: 403 }), 502, 'SIMPLEFIN_ACCESS_DENIED'],
    ['a server error', () => new Response('oops', { status: 500 }), 502, 'SIMPLEFIN_ERROR'],
    ['an answer that is not JSON', () => new Response('<html>', { status: 200 }), 502, 'SIMPLEFIN_BAD_RESPONSE'],
    ['a timeout', () => Promise.reject(new DOMException('The operation timed out', 'TimeoutError')), 504, 'SIMPLEFIN_TIMEOUT'],
  ] as const)('answers %s as SimpleFinUpstreamError %i %s', async (_what, reply, status, code) => {
    answer = reply;
    const err = await fetchAccounts({ startDate: new Date() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimpleFinUpstreamError);
    expect(err).toMatchObject({ status, code });
  });

  it('refuses without a connection, before any request', async () => {
    access.url = null;
    await expect(fetchAccounts({ startDate: new Date() })).rejects.toBeInstanceOf(NoSimpleFinConnectionError);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  describe('connection test', () => {
    const testConnection = () => asTenant(() => service.testConnection());

    it('asks /info, and passes when the answer lists versions', async () => {
      answer = () => new Response(JSON.stringify({ versions: ['1.0', '2.0'] }), { status: 200 });
      expect(await testConnection()).toBe(true);
      const [url, init] = fetchStub.mock.calls[0];
      expect(String(url)).toBe('https://bridge.simplefin.org/simplefin/info');
      expect(init?.headers).toEqual({
        Authorization: `Basic ${Buffer.from('user:secret').toString('base64')}`,
        'User-Agent': 'Nuggets-Finance-App/1.0',
      });
    });

    it.each([
      ['an error status', () => new Response('{}', { status: 500 })],
      ['no versions', () => new Response(JSON.stringify({ ok: true }), { status: 200 })],
      ['not JSON', () => new Response('<html>', { status: 200 })],
      ['a timeout', () => Promise.reject(new DOMException('The operation timed out', 'TimeoutError'))],
    ] as const)('fails on %s, without throwing', async (_what, reply) => {
      answer = reply;
      expect(await testConnection()).toBe(false);
    });

    it('fails without a connection, without throwing', async () => {
      access.url = null;
      expect(await testConnection()).toBe(false);
      expect(fetchStub).not.toHaveBeenCalled();
    });
  });
});
