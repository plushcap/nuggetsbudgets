import { describe, it, expect, vi, afterEach } from 'vitest';
import { exportAccountTransactions } from '../export';
import { downloadBackup } from '../backup';
import { deleteTag } from '../tags';
import { deleteTransaction } from '../transactions';
import { updateAccountImportSettings } from '../simplefin';

/**
 * The calls that read a response themselves (a file download, a DELETE with no body)
 * threw their own text — "Failed to export account transactions", "HTTP error! status:
 * 409" — and dropped the server's reason, code and request id. They reject
 * as the shared helpers do now.
 */
describe('API calls outside the shared helpers reject with the server’s reason', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const serverAnswers = (status: number, body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
    );

  it.each([
    ['exportAccountTransactions', () => exportAccountTransactions('acc-uuid')],
    ['downloadBackup', () => downloadBackup('nuggets_backup.enc')],
    ['deleteTag', () => deleteTag('tag-uuid')],
    ['deleteTransaction', () => deleteTransaction('tx-uuid')],
    ['updateAccountImportSettings', () => updateAccountImportSettings('acc-uuid', { import_enabled: true })],
  ])('%s', async (_name, call) => {
    serverAnswers(409, { error: 'That tenant can’t do this yet', code: 'CONFLICT', requestId: 'req-409' });
    await expect(call()).rejects.toMatchObject({
      message: 'That ledger can’t do this yet',
      status: 409,
      code: 'CONFLICT',
      requestId: 'req-409',
    });
  });
});
