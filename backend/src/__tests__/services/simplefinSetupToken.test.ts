import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exchangeSetupToken } from '../../services/OrganizationSimpleFinService.js';
import { ControlPlaneError } from '../../services/controlPlaneErrors.js';

/**
 * A SimpleFin setup token is a base64 URL the server POSTs to. Any org admin can paste
 * one, so it, and the access URL that comes back, must be on a SimpleFin bridge host.
 * Before, the server POSTed to whatever URL the token held.
 */
describe('Claiming a SimpleFin setup token', () => {
  const fetchMock = vi.fn();
  const token = (url: string) => Buffer.from(url).toString('base64');

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
    'http://169.254.169.254/latest/meta-data/',
    'http://nas.internal:8080/api/webhook/abc',
    'https://localhost:5000/api/admin/users',
    'https://attacker.example/claim',
  ])('refuses a token for %s without sending anything', async (url) => {
    const err = await exchangeSetupToken(token(url)).catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).toMatchObject({ status: 400, code: 'SIMPLEFIN_BAD_TOKEN' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('claims a token on the SimpleFin bridge and returns the access URL', async () => {
    fetchMock.mockResolvedValue(new Response('https://user:pass@bridge.simplefin.org/simplefin\n'));
    await expect(exchangeSetupToken(token('https://bridge.simplefin.org/simplefin/claim/abc'))).resolves.toBe(
      'https://user:pass@bridge.simplefin.org/simplefin'
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error' });
  });

  it.each(['http://u:p@10.0.0.5:8080/api/v1', 'https://u:p@internal.example/simplefin', 'not a url'])(
    'refuses an answer that points the access URL at %s',
    async (accessUrl) => {
      fetchMock.mockResolvedValue(new Response(accessUrl));
      await expect(exchangeSetupToken(token('https://bridge.simplefin.org/simplefin/claim/abc'))).rejects.toMatchObject({
        status: 502,
        code: 'SIMPLEFIN_EXCHANGE_FAILED',
      });
    }
  );

  it("answers 502 without the upstream's details when the bridge can't be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed: redirect mode is set to error'));
    const err = await exchangeSetupToken(token('https://bridge.simplefin.org/simplefin/claim/abc')).catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: 'SIMPLEFIN_EXCHANGE_FAILED' });
    expect(err.message).not.toMatch(/redirect/);
  });
});
