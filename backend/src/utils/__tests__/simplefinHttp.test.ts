import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  assertSimpleFinUrl,
  simplefinRequest,
  SimpleFinResponseTooLargeError,
  SimpleFinUrlError,
} from '../simplefinHttp.js';

/**
 * SimpleFin requests go only to SimpleFin bridge hosts over https, without following
 * redirects, with a timeout and a size cap. Before, a setup token pasted by any
 * org admin made the server POST to whatever URL it held, the router or a cloud
 * metadata endpoint included, and the access URL in the answer was fetched as given.
 */
describe('SimpleFin requests', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('SIMPLEFIN_ALLOWED_HOSTS', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    'https://bridge.simplefin.org/simplefin/claim/abc',
    'https://beta-bridge.simplefin.org/simplefin',
    'https://BRIDGE.simplefin.org:443/x',
  ])('allows %s', (url) => {
    expect(() => assertSimpleFinUrl(url)).not.toThrow();
  });

  it.each([
    'http://bridge.simplefin.org/claim',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost:5000/api/admin',
    'https://127.0.0.1/',
    'https://10.0.0.5:8080/api/v1',
    'https://nas.internal:8080/api/webhook/x',
    'https://bridge.simplefin.org.attacker.example/',
    'https://bridge.simplefin.org:8443/',
    'https://attacker.example/?bridge.simplefin.org',
    'file:///etc/passwd',
    'not a url',
  ])('refuses %s without connecting', async (url) => {
    expect(() => assertSimpleFinUrl(url)).toThrow(SimpleFinUrlError);
    await expect(simplefinRequest(url)).rejects.toThrow(SimpleFinUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows the hosts an operator adds, with a port only when it is named', () => {
    vi.stubEnv('SIMPLEFIN_ALLOWED_HOSTS', 'simplefin.example.net, bridge.home.example:8443');
    expect(() => assertSimpleFinUrl('https://simplefin.example.net/x')).not.toThrow();
    expect(() => assertSimpleFinUrl('https://bridge.home.example:8443/x')).not.toThrow();
    expect(() => assertSimpleFinUrl('https://simplefin.example.net:8443/x')).toThrow(SimpleFinUrlError);
    expect(() => assertSimpleFinUrl('https://bridge.home.example/x')).toThrow(SimpleFinUrlError);
  });

  it("doesn't follow redirects and gives up after the timeout", async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    const res = await simplefinRequest('https://bridge.simplefin.org/simplefin/info', { timeoutMs: 1234 });
    expect(res).toEqual({ status: 200, ok: true, text: 'ok' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://bridge.simplefin.org/simplefin/info');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('connects to the allowed host as the allowlist spells it, with only the path and query of the URL given', async () => {
    vi.stubEnv('SIMPLEFIN_ALLOWED_HOSTS', 'bridge.home.example:8443');
    fetchMock.mockImplementation(async () => new Response('ok', { status: 200 }));
    for (const [given, requested] of [
      ['https://BRIDGE.simplefin.org:443/simplefin/accounts?version=2#frag', 'https://bridge.simplefin.org/simplefin/accounts?version=2'],
      ['https://bridge.home.example:8443/simplefin', 'https://bridge.home.example:8443/simplefin'],
      // A path that starts with `//` stays a path on the allowed host.
      ['https://bridge.simplefin.org//attacker.example/x', 'https://bridge.simplefin.org//attacker.example/x'],
    ]) {
      fetchMock.mockClear();
      await simplefinRequest(given);
      const [url] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(requested);
      expect(new URL(String(url)).host).toBe(new URL(requested).host);
    }
  });

  it('refuses an answer larger than the cap, declared or streamed', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(100), { headers: { 'content-length': '100' } }));
    await expect(simplefinRequest('https://bridge.simplefin.org/a', { maxBytes: 10 })).rejects.toThrow(
      SimpleFinResponseTooLargeError
    );
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new TextEncoder().encode('xxxx'));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream));
    await expect(simplefinRequest('https://bridge.simplefin.org/a', { maxBytes: 10 })).rejects.toThrow(
      SimpleFinResponseTooLargeError
    );
  });
});
