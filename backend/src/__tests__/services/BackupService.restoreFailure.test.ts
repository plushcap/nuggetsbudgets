import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import os from 'os';
import path from 'path';
import type { Pool } from 'pg';
import { BackupService, RestoreRefusedError, parseTocListing } from '../../services/BackupService.js';
import { EncryptionService } from '../../services/EncryptionService.js';
import { backupSigningKey, encryptBackupFile, BackupKeyError } from '../../utils/backupCrypto.js';

/**
 * Which key a restore opens a backup with, and what it says when none does. Pure unit: no
 * database. The restore itself is covered against Postgres in BackupService.roundTrip.db.test.ts.
 */
describe('BackupService: opening a backup to restore', () => {
  const key = randomBytes(32).toString('base64');
  const dataSecret = 'a-data-encryption-secret-of-at-least-32-chars';
  let tmp: string;
  let signed: string;
  let legacy: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'restore-open-'));
    await writeFile(path.join(tmp, 'archive.zip'), 'zip bytes');
    signed = path.join(tmp, 'signed.enc');
    await encryptBackupFile(path.join(tmp, 'archive.zip'), signed, key, backupSigningKey(dataSecret));
    // A backup from before backups were signed (format 2).
    legacy = path.join(tmp, 'legacy.enc');
    await new EncryptionService().encryptFileWithCustomKey(path.join(tmp, 'archive.zip'), legacy, key);
  });

  afterAll(() => rm(tmp, { recursive: true, force: true }));
  afterEach(() => vi.restoreAllMocks());

  type Internals = {
    getActiveBackupKey: () => Promise<string | null>;
    decryptForRestore: (file: string, out: string, key: string | null) => Promise<string>;
    encryptionService: EncryptionService;
  };

  function service(ownKey: string | null | Error, signingSecret: string | null = dataSecret) {
    const svc = new BackupService({} as Pool, { tempDir: tmp, backupLocation: tmp });
    const internals = svc as unknown as Internals;
    const stored = vi.spyOn(internals, 'getActiveBackupKey');
    if (ownKey instanceof Error) stored.mockRejectedValue(ownKey);
    else stored.mockResolvedValue(ownKey);
    const signing = vi.spyOn(internals.encryptionService, 'getBackupSigningKey');
    if (signingSecret) signing.mockResolvedValue(backupSigningKey(signingSecret));
    else signing.mockRejectedValue(new Error('no data encryption secret'));
    return internals;
  }

  const out = () => path.join(tmp, `out-${randomBytes(4).toString('hex')}.zip`);

  it('opens it with the typed key, and checks the signature', async () => {
    const target = out();
    await expect(service(null).decryptForRestore(signed, target, key)).resolves.toBe('valid');
    expect(await readFile(target, 'utf8')).toBe('zip bytes');
    await expect(service(null, 'another-servers-data-encryption-secret').decryptForRestore(signed, out(), key)).resolves.toBe('invalid');
    await expect(service(null, null).decryptForRestore(signed, out(), key)).resolves.toBe('unchecked');
  });

  it("opens it with this server's backup key when no key is typed", async () => {
    await expect(service(key).decryptForRestore(signed, out(), null)).resolves.toBe('valid');
  });

  it('says a typed key is wrong', async () => {
    await expect(service(key).decryptForRestore(signed, out(), randomBytes(32).toString('base64'))).rejects.toBeInstanceOf(BackupKeyError);
  });

  // The stored key is itself encrypted; when it can't be read (the Docker secret changed),
  // the Docker-secret key is still tried, as for a backup made before backup keys existed.
  it("falls back to the Docker-secret key when this server's backup key can't be read", async () => {
    const internals = service(new Error('Unsupported state or unable to authenticate data'));
    const dockerSecret = vi
      .spyOn(internals.encryptionService, 'decryptFile')
      .mockImplementation((from: string, to: string) => internals.encryptionService.decryptFileWithCustomKey(from, to, key));
    await expect(internals.decryptForRestore(legacy, out(), null)).resolves.toBe('unsigned');
    expect(dockerSecret).toHaveBeenCalledOnce();
  });

  it("says to enter the backup's key when neither of this server's keys opens it", async () => {
    const internals = service(randomBytes(32).toString('base64'));
    vi.spyOn(internals.encryptionService, 'decryptFile').mockRejectedValue(new Error('Unsupported state or unable to authenticate data'));
    const failure = internals.decryptForRestore(signed, out(), null);
    await expect(failure).rejects.toBeInstanceOf(RestoreRefusedError);
    await expect(failure).rejects.toThrow(/server's backup key can't open this backup\. Enter the key it was made with/);
  });

  // A path that names no file went on to be decrypted, and was refused as a backup
  // this server's key can't open.
  it('refuses a backup file that is not there before it connects or decrypts anything', async () => {
    const internals = service(key);
    const svc = internals as unknown as BackupService;
    const connect = vi.spyOn(internals as unknown as { connect: () => Promise<never> }, 'connect').mockRejectedValue(new Error('the restore connected'));
    const decrypt = vi.spyOn(internals, 'decryptForRestore');
    for (const missing of [path.join(tmp, 'no-such-backup.enc'), path.join(tmp, 'archive.zip', 'below-a-file.enc'), tmp]) {
      const failure = svc.restoreFromFile(missing);
      await expect(failure).rejects.toThrow('Restore failed: The backup file was not found: there is no file at that path');
      await expect(failure).rejects.toMatchObject({ databaseChanged: false, cause: { code: 'BACKUP_FILE_NOT_FOUND' } });
    }
    expect(connect).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });
});

describe('parseTocListing', () => {
  it('reads each entry type and schema of a pg_restore listing', () => {
    const listing = [
      ';',
      '; Archive created at 2026-11-02 00:23:42 UTC',
      '5389; 0 0 ACL - SCHEMA public pg_database_owner',
      '3; 3079 951621 EXTENSION - pg_trgm ',
      '356; 1259 954966 VIEW public net_worth_accounts test_user',
      '2506; 826 952302 DEFAULT ACL public DEFAULT PRIVILEGES FOR SEQUENCES test_user',
      '5600; 0 954966 TABLE DATA public tags test_user',
      '5700; 2606 1 FK CONSTRAINT public tags tags_parent_id_fkey test_user',
      '9; 3466 1 EVENT TRIGGER - e test_user',
      '10; 1259 2 TABLE other t test_user',
    ].join('\n');
    expect(parseTocListing(listing).map(({ type, schema }) => [type, schema])).toEqual([
      ['ACL', '-'],
      ['EXTENSION', '-'],
      ['VIEW', 'public'],
      ['DEFAULT ACL', 'public'],
      ['TABLE DATA', 'public'],
      ['FK CONSTRAINT', 'public'],
      ['EVENT TRIGGER - e test_user', ''],
      ['TABLE', 'other'],
    ]);
  });
});
