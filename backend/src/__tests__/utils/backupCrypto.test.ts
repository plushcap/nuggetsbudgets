import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  BackupFormatError,
  BackupKeyError,
  backupSigningKey,
  decryptBackupFile,
  encryptBackupFile,
} from '../../utils/backupCrypto.js';
import { EncryptionService } from '../../services/EncryptionService.js';

/**
 * The backup file format: chunked AES-GCM, streamed, signed by the server. Small
 * chunk sizes make many chunks out of little data.
 */
describe('backup file format 3', () => {
  const key = randomBytes(32).toString('base64');
  const signing = backupSigningKey('this-servers-data-encryption-secret-xxxxxxxx');
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'backup-crypto-'));
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  const file = (name: string) => path.join(tmp, name);

  async function roundTrip(plain: Buffer, chunkSize: number) {
    await writeFile(file('in'), plain);
    await encryptBackupFile(file('in'), file('enc'), key, signing, chunkSize);
    const result = await decryptBackupFile(file('enc'), file('out'), key, signing);
    return { result, out: await readFile(file('out')), enc: await readFile(file('enc')) };
  }

  it.each([
    ['empty', 0, 16],
    ['shorter than a chunk', 10, 16],
    ['exactly one chunk', 16, 16],
    ['exactly several chunks', 64, 16],
    ['several chunks and a part', 70, 16],
    ['a megabyte in default chunks', 1024 * 1024 + 5, undefined],
  ])('decrypts what it encrypted: %s', async (_name, length, chunkSize) => {
    const plain = randomBytes(length);
    const { result, out, enc } = await roundTrip(plain, chunkSize ?? 1024 * 1024);
    expect(result).toEqual({ version: 3, signature: 'valid' });
    expect(out.equals(plain)).toBe(true);
    expect(enc[0]).toBe(0x03);
    expect((await stat(file('enc'))).mode & 0o777).toBe(0o600);
    expect((await stat(file('out'))).mode & 0o777).toBe(0o600);
  });

  it('says whose signature it is', async () => {
    await roundTrip(randomBytes(100), 16);
    const other = backupSigningKey('another-servers-data-encryption-secret-xxxxx');
    await expect(decryptBackupFile(file('enc'), file('out'), key, other)).resolves.toEqual({ version: 3, signature: 'invalid' });
    await expect(decryptBackupFile(file('enc'), file('out'), key, null)).resolves.toEqual({ version: 3, signature: 'unchecked' });
  });

  it('refuses a wrong key', async () => {
    await roundTrip(randomBytes(100), 16);
    await expect(decryptBackupFile(file('enc'), file('out'), randomBytes(32).toString('base64'), signing)).rejects.toBeInstanceOf(BackupKeyError);
  });

  it('notices a changed byte, a dropped chunk, swapped chunks and a cut-off file', async () => {
    const { enc } = await roundTrip(randomBytes(100), 16);
    const sealed = 16 + 16; // a chunk and its tag
    const header = 21;
    const attempts: Record<string, Buffer> = {
      changed: Buffer.from(enc).fill(enc[header + sealed + 3] ^ 1, header + sealed + 3, header + sealed + 4),
      dropped: Buffer.concat([enc.subarray(0, header + sealed), enc.subarray(header + 2 * sealed)]),
      swapped: Buffer.concat([
        enc.subarray(0, header + sealed),
        enc.subarray(header + 2 * sealed, header + 3 * sealed),
        enc.subarray(header + sealed, header + 2 * sealed),
        enc.subarray(header + 3 * sealed),
      ]),
      // The last chunk gone (with the signature re-attached): the one before isn't marked last.
      truncated: Buffer.concat([enc.subarray(0, header + 6 * sealed), enc.subarray(enc.length - 32)]),
    };
    for (const [name, bytes] of Object.entries(attempts)) {
      await writeFile(file(`${name}.enc`), bytes);
      await expect(decryptBackupFile(file(`${name}.enc`), file('out'), key, signing), name).rejects.toBeInstanceOf(BackupFormatError);
    }
  });

  it('refuses what is not a backup', async () => {
    await writeFile(file('junk.enc'), 'PGDMP not encrypted at all');
    await expect(decryptBackupFile(file('junk.enc'), file('out'), key, signing)).rejects.toBeInstanceOf(BackupFormatError);
  });

  it('still opens a format 2 backup (from before signed backups), as unsigned', async () => {
    const plain = randomBytes(1000);
    await writeFile(file('in'), plain);
    await new EncryptionService().encryptFileWithCustomKey(file('in'), file('v2.enc'), key);
    await expect(decryptBackupFile(file('v2.enc'), file('out'), key, signing)).resolves.toEqual({ version: 2, signature: 'unsigned' });
    expect((await readFile(file('out'))).equals(plain)).toBe(true);
    await expect(decryptBackupFile(file('v2.enc'), file('out'), randomBytes(32).toString('base64'), signing)).rejects.toBeInstanceOf(BackupKeyError);
  });
});
