import { describe, it, expect, vi } from 'vitest';

// The job's own pool is for a restore's role check, which a verify never runs.
vi.mock('../../db.js', () => ({ default: {}, db: {}, poolSettings: () => ({ max: 1, lockTimeoutMs: 0 }) }));

import { startVerifyJob, verifyJobSettled, getVerifyStatus } from '../../services/restoreJob.js';
import { RestoreFailedError, RestoreRefusedError, type BackupService } from '../../services/BackupService.js';
import { BackupWrongKeyError } from '../../utils/backupFormat.js';

/**
 * What a verify records on the Backup page (backup_runs): only a verify of the server's own
 * copy of a listed backup, passed or failed. An uploaded file is another copy, which proves
 * nothing about the listed one, and its name proves nothing at all; a wrong key is the
 * person's mistake, not the backup's.
 */
describe('a verify, as the record of backups keeps it', () => {
  const fileName = 'nuggets_backup_20261101_030000_000.tar.age';

  async function verify(outcome: 'pass' | Error, deleteAfter: boolean) {
    const recordVerify = vi.fn(async () => undefined);
    const restoreFromFile = vi.fn(async () => {
      if (outcome !== 'pass') throw outcome;
      return { manifest: { backupId: fileName.replace('.tar.age', ''), createdAt: '2026-11-01T03:00:00.000Z' }, rowCounts: {} };
    });
    const backupService = { recordVerify, restoreFromFile } as unknown as BackupService;
    startVerifyJob({ backupService }, { filePath: `/backups/${fileName}`, fileName, key: null, fileKey: null, deleteAfter, userId: 7 });
    await verifyJobSettled();
    return recordVerify;
  }

  const refused = () => new RestoreFailedError('Restore failed: damaged', false, { cause: new RestoreRefusedError('The backup is damaged') });
  const wrongKey = () => new RestoreFailedError('Restore failed: wrong key', false, { cause: new BackupWrongKeyError() });

  it('records a listed backup that passed, or failed', async () => {
    expect(await verify('pass', false)).toHaveBeenCalledWith(fileName, 7, 'passed', null);
    expect(getVerifyStatus().status).toBe('completed');
    expect(await verify(refused(), false)).toHaveBeenCalledWith(fileName, 7, 'failed', 'The backup is damaged');
  });

  it('records nothing for an uploaded copy, passed or failed', async () => {
    expect(await verify('pass', true)).not.toHaveBeenCalled();
    expect(await verify(refused(), true)).not.toHaveBeenCalled();
  });

  it('records nothing when the key was wrong: the person’s mistake, not the backup’s', async () => {
    expect(await verify(wrongKey(), false)).not.toHaveBeenCalled();
    expect(getVerifyStatus()).toMatchObject({ status: 'failed' });
  });
});
