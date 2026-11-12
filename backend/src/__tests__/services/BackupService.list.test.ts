import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { Pool } from 'pg';

const errors = vi.hoisted(() => [] as string[]);
vi.mock('../../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/logger.js')>();
  const quiet = () => {};
  const fake = {
    trace: quiet, debug: quiet, info: quiet, warn: quiet, fatal: quiet,
    error: (...args: unknown[]) => void errors.push(String(args.find((a) => typeof a === 'string') ?? '')),
    child: () => fake,
  };
  return { ...actual, createLogger: () => fake };
});

import { BackupService } from '../../services/BackupService.js';

/**
 * The backup list is what upload, restore and retention act on, so it holds only the
 * regular `.enc` files in the backup folder. It used to follow symlinks (so `evil.enc`
 * pointing at /etc/hostname was offered for upload) and a dangling one emptied the
 * whole list.
 */
describe('BackupService.listBackups', () => {
  let dir: string;
  let service: BackupService;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'nuggets-list-'));
    await writeFile(path.join(dir, 'nuggets-backup-2026-10-01T00-00-00-000Z.enc'), 'real');
    await writeFile(path.join(dir, 'notes.txt'), 'not a backup');
    await symlink('/etc/hostname', path.join(dir, 'evil.enc'));
    await symlink(path.join(dir, 'gone'), path.join(dir, 'dangling.enc'));
    await mkdir(path.join(dir, 'folder.enc'));
    vi.stubEnv('BACKUP_LOCATION', dir);
    service = new BackupService({} as unknown as Pool);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('lists only regular .enc files, and survives the rest', async () => {
    expect((await service.listBackups()).map((b) => b.fileName)).toEqual(['nuggets-backup-2026-10-01T00-00-00-000Z.enc']);
  });

  // The constructor used to start creating the folder without waiting for it, so a test's
  // cleanup could meet that mkdir mid-removal. A backup makes it now, when it needs it.
  it('lists nothing, quietly, before the folder exists, and a backup makes it', async () => {
    const backups = path.join(dir, 'not-yet');
    const later = new BackupService({} as unknown as Pool, { backupLocation: backups, tempDir: path.join(dir, 'temp') });
    expect(await later.listBackups()).toEqual([]);
    expect(errors).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(backups)).toBe(false);

    const encrypted = path.join(dir, 'made.enc');
    await writeFile(encrypted, 'encrypted');
    const move = (later as unknown as { moveToBackupLocation(file: string, id: string): Promise<string> }).moveToBackupLocation;
    expect(await move.call(later, encrypted, 'nuggets_backup_20261104_010000_000')).toBe(
      path.join(backups, 'nuggets_backup_20261104_010000_000.enc')
    );
    expect((await later.listBackups()).map((b) => b.fileName)).toEqual(['nuggets_backup_20261104_010000_000.enc']);
  });
});
