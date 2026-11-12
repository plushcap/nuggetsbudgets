import { describe, it, expect, afterEach, vi } from 'vitest';
import { mockApi } from '../../../test/apiServer';

// As a production build reads an answer: a mismatch is logged and read as it came, not thrown.
vi.mock('../parseAnswer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parseAnswer')>();
  return { ...actual, parseAnswer: (schema: never, raw: unknown, answer: string) => actual.parseAnswer(schema, raw, answer, false) };
});
import { deletePasskey } from '../passkeys';
import { logger } from '../../../utils/logger';

/**
 * In a production build, a deleted passkey's answer that doesn't match its schema is read as it
 * came: the passkey is deleted all the same, so the delete resolves, and the browser is told
 * nothing (no relying party to name).
 */
describe('deletePasskey in a production build', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves, telling the browser nothing, when the answer is no object or has no relying party', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const signal = vi.fn(async () => undefined);
    vi.stubGlobal('PublicKeyCredential', Object.assign(function PublicKeyCredential() {}, { signalUnknownCredential: signal }));
    for (const answer of [null, { success: true, message: 'Passkey deleted' }]) {
      mockApi({ 'DELETE /passkeys/:credentialId': answer });
      await expect(deletePasskey('cmVtb3ZlZA')).resolves.toBeUndefined();
    }
    expect(signal).not.toHaveBeenCalled();
  });
});
