import { describe, it, expect, afterEach, vi } from 'vitest';
import { backupStarted, settingsAction } from '../../../test/fixtures';
import { mockApi } from '../../../test/apiServer';
import { deleteBackup, downloadBackup, restoreBackupFromServer } from '../backup';

/**
 * A backup's name goes in the URL as one path segment. Any .enc file in the backup
 * directory is listed, and download and delete put its name in the URL as it was, so a
 * `#` cut the path at a fragment, a `?` started a query and a `%` read as an escape: the
 * server got another name, or none. Restore already encoded it.
 */
describe('backup file names in URLs', () => {
  afterEach(() => vi.unstubAllGlobals());

  const names = ['nuggets_backup_20261101_030000_000.enc', 'before #2 move.enc', 'what?.enc', '100% done.enc'];

  it.each(names)('downloads, deletes and restores %s by its own name', async (name) => {
    const api = mockApi({
      'GET /backup/download/:fileName': { ok: true },
      'DELETE /backup/:fileName': settingsAction('Backup deleted successfully'),
      'POST /backup/restore/:fileName': { status: 202, body: backupStarted('Restore started') },
    });

    await downloadBackup(name);
    await deleteBackup(name);
    await restoreBackupFromServer(name, {});

    expect(api.unhandled).toEqual([]);
    expect(api.calls('GET /backup/download/:fileName').map((r) => r.params.fileName)).toEqual([name]);
    expect(api.calls('DELETE /backup/:fileName').map((r) => r.params.fileName)).toEqual([name]);
    expect(api.calls('POST /backup/restore/:fileName').map((r) => r.params.fileName)).toEqual([name]);
    for (const request of api.requests) expect([...request.query.keys()]).toEqual([]);
  });
});
