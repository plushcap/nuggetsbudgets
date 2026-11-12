import { describe, it, expect, afterEach, vi } from 'vitest';
import { TEST_CSRF_TOKEN, mockApi } from '../../../test/apiServer';
import { logger } from '../../../utils/logger';
import { deleteAdminUserPasskey, deletePasskey, getAdminUserPasskeys } from '../passkeys';

/**
 * A deployment admin's view of a user's passkeys moved beside the rest of the user's admin
 * page, under /api/admin/users/:uuid; /api/passkeys/admin/… answers 404 now.
 */
describe("the admin's passkey calls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const passkey = { id: 'cred-1', deviceName: 'Laptop', createdAt: '2026-11-01T00:00:00.000Z', discoverable: true };

  it("list a user's passkeys at /api/admin/users/:uuid/passkeys", async () => {
    const api = mockApi({ 'GET /admin/users/:uuid/passkeys': [passkey] });
    await expect(getAdminUserPasskeys('user-uuid')).resolves.toEqual([passkey]);
    expect(api.calls('GET /admin/users/:uuid/passkeys').map((r) => r.params)).toEqual([{ uuid: 'user-uuid' }]);
    expect(api.unhandled).toEqual([]);
  });

  it('remove one at /api/admin/users/:uuid/passkeys/:credentialId, with the CSRF token', async () => {
    const api = mockApi({
      'DELETE /admin/users/:uuid/passkeys/:credentialId': { success: true, message: 'Passkey deleted' },
    });
    await deleteAdminUserPasskey('user-uuid', 'cred-1');
    expect(api.calls('DELETE /admin/users/:uuid/passkeys/:credentialId').map((r) => r.params)).toEqual([
      { uuid: 'user-uuid', credentialId: 'cred-1' },
    ]);
    expect(api.unhandled).toEqual([]);
  });

  it("reject with the server's reason", async () => {
    mockApi({
      'DELETE /admin/users/:uuid/passkeys/:credentialId': { status: 404, body: { error: 'Passkey not found', code: 'PASSKEY_NOT_FOUND', requestId: 'req-1' } },
    });
    await expect(deleteAdminUserPasskey('user-uuid', 'gone')).rejects.toMatchObject({ status: 404, code: 'PASSKEY_NOT_FOUND' });
  });
});

/**
 * After a passkey is deleted, the browser is told that one is gone (WebAuthn's Signal API,
 * signalUnknownCredential), so it stops offering it in autofill. Only that passkey is named,
 * by the id the server listed and deleted: a list of the ones that remain could miss one being
 * added in another tab, which the browser would then drop. Most browsers have no such call, and a
 * missing or failing one never fails the delete.
 */
describe('deletePasskey tells the browser the deleted passkey is gone', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const deleted = { success: true, message: 'Passkey deleted', rpId: 'nuggets.example' };
  /** A browser with the Signal API: its signalUnknownCredential is `signal`. */
  const withSignals = (signal: (...args: unknown[]) => unknown = vi.fn(async () => undefined)) => {
    const PublicKeyCredential = Object.assign(function PublicKeyCredential() {}, { signalUnknownCredential: signal });
    vi.stubGlobal('PublicKeyCredential', PublicKeyCredential);
    return signal;
  };

  it('deletes it, with the CSRF token, then names that passkey alone to the browser', async () => {
    const signal = withSignals();
    const api = mockApi({ 'DELETE /passkeys/:credentialId': deleted });
    await deletePasskey('cmVtb3ZlZA');
    const [request] = api.calls('DELETE /passkeys/:credentialId');
    expect(request.params).toEqual({ credentialId: 'cmVtb3ZlZA' });
    expect(request.headers.get('X-CSRF-Token')).toBe(TEST_CSRF_TOKEN);
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith({ rpId: 'nuggets.example', credentialId: 'cmVtb3ZlZA' });
    expect(api.unhandled).toEqual([]);
  });

  it('reads the answer with its shared schema: one the schema refuses is a contract error, and tells the browser nothing', async () => {
    const signal = withSignals();
    for (const answer of [{ success: true, message: 'Passkey deleted' }, { ...deleted, rpId: '' }, { ...deleted, acceptedCredentials: null }]) {
      mockApi({ 'DELETE /passkeys/:credentialId': answer });
      await expect(deletePasskey('cmVtb3ZlZA')).rejects.toMatchObject({ name: 'AnswerContractError' });
    }
    expect(signal).not.toHaveBeenCalled();
  });

  it('tells the browser nothing when the delete is refused, or for an id that is no passkey’s', async () => {
    const signal = withSignals();
    mockApi({
      'DELETE /passkeys/:credentialId': { status: 404, body: { error: 'Passkey not found', code: 'PASSKEY_NOT_FOUND', requestId: 'req-1' } },
    });
    await expect(deletePasskey('gone')).rejects.toMatchObject({ status: 404, code: 'PASSKEY_NOT_FOUND' });
    mockApi({ 'DELETE /passkeys/:credentialId': deleted });
    await deletePasskey('not%20base64url');
    expect(signal).not.toHaveBeenCalled();
  });

  it('deletes all the same in a browser without the Signal API, or without WebAuthn', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    mockApi({ 'DELETE /passkeys/:credentialId': deleted });
    await expect(deletePasskey('cmVtb3ZlZA')).resolves.toBeUndefined();
    vi.stubGlobal('PublicKeyCredential', undefined);
    mockApi({ 'DELETE /passkeys/:credentialId': deleted });
    await expect(deletePasskey('cmVtb3ZlZA')).resolves.toBeUndefined();
  });

  it('deletes all the same when the browser throws or refuses, and logs it', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      withSignals(() => {
        throw new TypeError('Invalid rpId');
      });
      mockApi({ 'DELETE /passkeys/:credentialId': deleted });
      await expect(deletePasskey('cmVtb3ZlZA')).resolves.toBeUndefined();
      withSignals(async () => {
        throw new DOMException('Not allowed for this origin', 'SecurityError');
      });
      mockApi({ 'DELETE /passkeys/:credentialId': deleted });
      await expect(deletePasskey('cmVtb3ZlZA')).resolves.toBeUndefined();
      await new Promise((settle) => setTimeout(settle, 0));
      expect(warn.mock.calls.filter((call) => call[1] === 'The browser refused the deleted passkey')).toHaveLength(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it("doesn't tell an admin's browser about another user's passkey", async () => {
    const signal = withSignals();
    mockApi({ 'DELETE /admin/users/:uuid/passkeys/:credentialId': { success: true, message: 'Passkey deleted' } });
    await deleteAdminUserPasskey('user-uuid', 'cmVtb3ZlZA');
    expect(signal).not.toHaveBeenCalled();
  });
});
