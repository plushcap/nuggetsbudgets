import { describe, it, expect, vi, afterEach } from 'vitest';
import { syncAccount } from '../../services/api/import';
import { syncFailureMessage, syncOutcomeNotice } from '../importSyncMessages';

/** A fetch that answers `status` with `body`, as the server would. */
const serverAnswers = (status: number, body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  );

describe('bank sync messages', () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the server's 409 reason for a one-account sync, in Ledger wording", async () => {
    const reason = 'A bank sync of this tenant is already running. Try again when it has finished.';
    serverAnswers(409, { error: reason, code: 'SYNC_IN_PROGRESS', message: reason });

    const error = await syncAccount('a-uuid').catch((e: unknown) => e);
    expect(syncFailureMessage(error, 'Failed to sync account')).toBe(
      'A bank sync of this ledger is already running. Try again when it has finished.'
    );
  });

  it('keeps the general message for a server error or a network failure', async () => {
    serverAnswers(500, { error: 'Internal server error' });
    expect(syncFailureMessage(await syncAccount('a-uuid').catch((e: unknown) => e), 'Failed to sync account')).toBe('Failed to sync account');
    expect(syncFailureMessage(new TypeError('Failed to fetch'), 'Failed to sync account')).toBe('Failed to sync account');
  });

  // AuthContext already says the session expired; the sync's
  // general failure toast repeated it.
  it('adds nothing for an expired session', async () => {
    serverAnswers(401, { error: 'Session expired' });
    expect(syncFailureMessage(await syncAccount('a-uuid').catch((e: unknown) => e), 'Failed to sync account')).toBeNull();
    expect(syncFailureMessage(Object.assign(new Error('Your session has expired'), { status: 401 }), 'x')).toBeNull();
  });

  it('calls a partial sync a warning, with what went wrong', () => {
    expect(syncOutcomeNotice({ success: true, status: 'partial', message: 'Sync completed with problems: 1 transaction could not be imported' }, 'ok')).toEqual({
      tone: 'warning',
      text: 'Sync completed with problems: 1 transaction could not be imported',
    });
    expect(syncOutcomeNotice({ success: true, status: 'completed', message: 'Account sync completed successfully' }, 'ok')).toEqual({
      tone: 'success',
      text: 'Account sync completed successfully',
    });
    expect(syncOutcomeNotice({ success: false, status: 'failed', message: 'Sync failed', error: 'Account not found in SimpleFin response' }, 'ok')).toEqual({
      tone: 'error',
      text: 'Account not found in SimpleFin response',
    });
  });
});
