import { describe, it, expect, afterEach, vi } from 'vitest';
import { mockApi } from '../../../test/apiServer';
import { logger } from '../../../utils/logger';

vi.mock('@simplewebauthn/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simplewebauthn/browser')>()),
  startAuthentication: vi.fn(),
}));
import { startAuthentication } from '@simplewebauthn/browser';
import { authenticateWithPasskey } from '../passkeys';

// The passkey sign-in endpoints are CSRF-exempt, as the backend's are: no session yet.
const EXEMPT = { csrfExempt: ['POST /passkeys/auth/options', 'POST /passkeys/auth/verify'] };
const options = { challenge: 'challenge-text', rpId: 'localhost', timeout: 60000, userVerification: 'required' };
const assertion = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: '', signature: '' }, clientExtensionResults: {} };

/**
 * A passkey sign-in logs where it failed: the browser's ceremony, or the server's check
 * after it. A refusal from the server logged "WebAuthn ceremony failed" too, which sent a
 * reader to the authenticator for what the server had answered.
 */
describe('authenticateWithPasskey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const messages = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => call[1]);
  // A browser with WebAuthn; the ceremony itself is the mock above.
  const withWebAuthn = () => vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});

  it("doesn't call a refused verification a failed ceremony", async () => {
    withWebAuthn();
    vi.mocked(startAuthentication).mockResolvedValue(assertion as never);
    mockApi({
      'POST /passkeys/auth/options': options,
      'POST /passkeys/auth/verify': { status: 401, body: { error: 'Authentication verification failed', code: 'VERIFICATION_FAILED', requestId: 'req-1' } },
    }, EXEMPT);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await expect(authenticateWithPasskey()).rejects.toMatchObject({ status: 401, code: 'VERIFICATION_FAILED' });
    expect(messages(error)).toContain('Verification failed on server');
    expect(messages(error)).not.toContain('WebAuthn ceremony failed');
  });

  it('still says so when the ceremony itself fails', async () => {
    withWebAuthn();
    vi.mocked(startAuthentication).mockRejectedValue(Object.assign(new Error('The operation timed out'), { name: 'NotAllowedError' }));
    mockApi({ 'POST /passkeys/auth/options': options }, EXEMPT);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await expect(authenticateWithPasskey()).rejects.toThrow('Passkey authentication was cancelled');
    expect(messages(error)).toContain('WebAuthn ceremony failed');
  });
});
