import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Pool } from 'pg';
import { BackupService } from '../../services/BackupService.js';

/**
 * A restore replaces the upload files with the backup's. In the image, /app/uploads
 * and /app/temp are separate mounts, so nothing can be renamed from one to the other (and
 * /app/uploads itself can't be renamed at all): files move by copy and delete. Here the
 * temp directory is on /dev/shm and the uploads on the OS temp directory, when those are
 * two file systems. Pure unit: no database.
 */
const SHM = '/dev/shm';

async function sameDevice(a: string, b: string): Promise<boolean> {
  try {
    return (await stat(a)).dev === (await stat(b)).dev;
  } catch {
    return true;
  }
}

const crossDevice = !(await sameDevice(SHM, os.tmpdir()));

describe.skipIf(!crossDevice)('BackupService: replacing the upload files across file systems', () => {
  let tempDir: string;
  let uploadsDir: string;
  let incoming: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(SHM, 'restore-temp-'));
    uploadsDir = await mkdtemp(path.join(os.tmpdir(), 'restore-uploads-'));
    incoming = path.join(tempDir, 'extracted', 'uploads');
    await mkdir(path.join(incoming, 'statements'), { recursive: true });
    await writeFile(path.join(incoming, 'statements', 'march.pdf'), 'from the backup');
    // A backup could carry a symlink to a host file; it must not come across.
    await symlink('/etc/passwd', path.join(incoming, 'statements', 'passwd'));
    await mkdir(path.join(uploadsDir, 'statements'), { recursive: true });
    await writeFile(path.join(uploadsDir, 'statements', 'march.pdf'), 'current');
    await writeFile(path.join(uploadsDir, 'later.pdf'), 'made after the backup');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(uploadsDir, { recursive: true, force: true });
  });

  const replace = (service: BackupService) =>
    (service as unknown as { replaceUploads: (from: string) => Promise<{ previous: string; restored: number }> }).replaceUploads(incoming);

  it("puts the backup's files in place and keeps the current ones aside", async () => {
    const service = new BackupService({} as Pool, { tempDir, uploadsDir, backupLocation: tempDir });
    const result = await replace(service);
    expect(result).toEqual({ previous: path.join(tempDir, 'before-restore', 'uploads'), restored: 1 });
    expect(await readFile(path.join(uploadsDir, 'statements', 'march.pdf'), 'utf8')).toBe('from the backup');
    expect(await readdir(path.join(uploadsDir, 'statements'))).toEqual(['march.pdf']);
    expect(await readdir(uploadsDir)).toEqual(['statements']);
    expect(await readFile(path.join(result.previous, 'later.pdf'), 'utf8')).toBe('made after the backup');
    expect(await readFile(path.join(result.previous, 'statements', 'march.pdf'), 'utf8')).toBe('current');
  });

  it('puts the current files back when it fails part-way', async () => {
    const service = new BackupService({} as Pool, { tempDir, uploadsDir, backupLocation: tempDir });
    const internals = service as unknown as { moveEntry: (from: string, to: string) => Promise<void> };
    const real = internals.moveEntry.bind(service);
    let calls = 0;
    internals.moveEntry = async (from: string, to: string) => {
      // The current files go aside (2 entries), then the first incoming one fails.
      if (++calls === 3) throw new Error('disk full');
      return real(from, to);
    };
    await expect(replace(service)).rejects.toThrow('disk full');
    expect(await readFile(path.join(uploadsDir, 'statements', 'march.pdf'), 'utf8')).toBe('current');
    expect(await readFile(path.join(uploadsDir, 'later.pdf'), 'utf8')).toBe('made after the backup');
  });
});
