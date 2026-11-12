import { describe, it, expect, vi, afterEach } from 'vitest';
import { authMe, ownAccount } from '../../../test/fixtures';
import { getCurrentUser, logoutRequest } from '../auth';

describe('logoutRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  // Without the header the server refused the logout (403 CSRF_TOKEN_INVALID) and kept
  // the session alive, so the next page load signed the last person back in.
  it('sends the CSRF token, so the server ends the session', async () => {
    document.cookie = 'csrf_token=token-123';
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await logoutRequest();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/auth\/logout$/);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('token-123');
  });
});

// A server that is restarting or failing is not "signed out": only a 401 is.
describe('getCurrentUser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is null for a 401 and the user for a 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"No session"}', { status: 401 })));
    await expect(getCurrentUser()).resolves.toBeNull();
    const me = authMe(ownAccount({ id: 3 }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(me), { status: 200 })));
    await expect(getCurrentUser()).resolves.toEqual(me.user);
  });

  it('rejects with the status and request id for a server error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"Internal error","code":"INTERNAL","requestId":"r-1"}', { status: 503 })),
    );
    await expect(getCurrentUser()).rejects.toMatchObject({ status: 503, requestId: 'r-1' });
  });

  it('rejects when the server is unreachable, and for a gateway page that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(getCurrentUser()).rejects.toThrow('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })));
    await expect(getCurrentUser()).rejects.toMatchObject({ status: 502 });
  });
});
