import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtemp, readdir, rename, rm, utimes, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Pool } from 'pg';
import { BackupService, BackupInProgressError, backupIdFromFileName, backupTimeFromFileName } from '../../services/BackupService.js';

/**
 * Overlapping backups and backup dates. Pure unit: the pool is a fake that grants (or
 * refuses) the advisory lock, and the dump/archive/encrypt steps are stubbed with small
 * files, so neither a database nor pg_dump is needed. The real advisory lock is covered
 * against Postgres in BackupService.advisoryLock.test.ts.
 */

/** A pool whose connections answer the advisory-lock queries; `locked` is what try-lock returns. */
function lockPool(locked = true) {
  const queries: string[] = [];
  // An emitter, as a pg client is: it emits 'error' when its session dies.
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: /pg_try_advisory_lock/.test(sql) ? [{ locked }] : [{}] };
    }),
    release: vi.fn(),
  });
  const pool = { connect: vi.fn(async () => client) };
  return { pool: pool as unknown as Pool, client, queries };
}

type Steps = Record<
  'createDatabaseDump' | 'writeManifest' | 'createArchiveWithUploads' | 'encryptBackup' | 'getActiveBackupKey' | 'listRecipients',
  (...args: never[]) => Promise<unknown>
>;

/** Stub the expensive steps of createBackup; the dump waits for `gate` when one is given. */
function stubSteps(service: BackupService, gate?: Promise<void>) {
  const steps = service as unknown as Steps & { encryptionService: { initialize: () => Promise<void> } };
  vi.spyOn(steps.encryptionService, 'initialize').mockResolvedValue();
  // An upgraded install with the old key and no backup key yet: it makes .enc backups.
  vi.spyOn(steps, 'listRecipients').mockResolvedValue([]);
  vi.spyOn(steps, 'getActiveBackupKey').mockResolvedValue('backup-key');
  vi.spyOn(steps, 'createDatabaseDump').mockImplementation((async (tempDir: string, backupId: string) => {
    await gate;
    const file = path.join(tempDir, `${backupId}.dump`);
    await writeFile(file, 'dump');
    return file;
  }) as never);
  vi.spyOn(steps, 'writeManifest').mockImplementation((async (tempDir: string) => {
    const file = path.join(tempDir, 'manifest.json');
    await writeFile(file, '{}');
    return file;
  }) as never);
  vi.spyOn(steps, 'createArchiveWithUploads').mockImplementation((async (tempDir: string, backupId: string) => {
    const file = path.join(tempDir, `${backupId}.zip`);
    await writeFile(file, 'zip');
    return file;
  }) as never);
  vi.spyOn(steps, 'encryptBackup').mockImplementation((async (archive: string) => {
    const file = archive.replace(/\.zip$/, '.enc');
    await rename(archive, file);
    return file;
  }) as never);
}

describe('BackupService', () => {
  let backupDir: string;

  beforeEach(async () => {
    backupDir = await mkdtemp(path.join(os.tmpdir(), 'backup-lock-'));
    vi.stubEnv('BACKUP_LOCATION', backupDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(backupDir, { recursive: true, force: true });
  });

  describe('overlapping backups', () => {
    it('refuses a second backup while one is running, from any BackupService in the process', async () => {
      // index.ts (for the scheduler) and routes/backup.ts (for manual backups) each build their own.
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const scheduled = new BackupService(lockPool().pool);
      const manual = new BackupService(lockPool().pool);
      stubSteps(scheduled, gate);
      stubSteps(manual);

      const first = scheduled.createBackup();
      try {
        expect(BackupService.isBackupInProgress()).toBe(true);
        await expect(manual.createBackup()).rejects.toBeInstanceOf(BackupInProgressError);
      } finally {
        open();
      }
      await expect(first).resolves.toMatchObject({ fileName: expect.stringMatching(/\.enc$/) });
      expect(BackupService.isBackupInProgress()).toBe(false);
      await expect(manual.createBackup()).resolves.toMatchObject({ fileName: expect.stringMatching(/\.enc$/) });
      expect(await readdir(backupDir)).toHaveLength(2);
    });

    it('refuses while another server holds the backup lock, and gives back its connection', async () => {
      const { pool, client, queries } = lockPool(false);
      const service = new BackupService(pool);
      stubSteps(service);

      await expect(service.createBackup()).rejects.toBeInstanceOf(BackupInProgressError);
      // Another process holds it: a scheduled backup tries again (BackupScheduler), as it
      // does for a verify, rather than skip the period as for this process's own backup.
      await expect(service.createBackup()).rejects.toMatchObject({ heldBy: 'elsewhere' });
      expect(queries.some((q) => /pg_try_advisory_lock/.test(q))).toBe(true);
      expect(client.release).toHaveBeenCalledTimes(2);
      expect(BackupService.isBackupInProgress()).toBe(false);
      expect(await readdir(backupDir)).toEqual([]);
    });

    it('releases the advisory lock once the backup is done', async () => {
      const { pool, client, queries } = lockPool(true);
      const service = new BackupService(pool);
      stubSteps(service);

      await service.createBackup();
      expect(queries.filter((q) => /pg_advisory_unlock/.test(q))).toHaveLength(1);
      expect(client.release).toHaveBeenCalledOnce();
      expect(client.release).toHaveBeenCalledWith();
      // Back in the pool without the backup's listener, which would pile up on reuse.
      expect(client.listenerCount('error')).toBe(0);
    });

    it('carries on when the lock connection dies mid-backup, and discards that connection', async () => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const { pool, client, queries } = lockPool(true);
      const service = new BackupService(pool);
      stubSteps(service, gate);

      const backup = service.createBackup();
      try {
        await vi.waitFor(() => expect(queries.some((q) => /pg_try_advisory_lock/.test(q))).toBe(true));
        // pg_terminate_backend, a Postgres restart or failover: pg emits 'error' on the
        // checked-out client. With no listener that throws, an uncaught exception in pg's
        // socket handler, and the server shuts down.
        const lost = new Error('terminating connection due to administrator command');
        expect(() => client.emit('error', lost)).not.toThrow();
      } finally {
        open();
        await backup.catch(() => undefined); // settled before the next test, whatever happened
      }

      await expect(backup).resolves.toMatchObject({ fileName: expect.stringMatching(/\.enc$/) });
      expect(queries.some((q) => /pg_advisory_unlock/.test(q))).toBe(false);
      expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/administrator command/) }));
      expect(BackupService.isBackupInProgress()).toBe(false);
    });

    it('gives two backups started in the same second their own files', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const service = new BackupService(lockPool().pool);
      stubSteps(service);

      vi.setSystemTime(new Date('2026-01-10T12:00:00.100Z'));
      const a = await service.createBackup();
      vi.setSystemTime(new Date('2026-01-10T12:00:00.600Z'));
      const b = await service.createBackup();

      expect(a.fileName).not.toBe(b.fileName);
      expect((await readdir(backupDir)).sort()).toEqual([a.fileName, b.fileName].sort());
    });
  });

  describe('listBackups dates', () => {
    it('reads the date from the file name, else the modification time, never birthtime', async () => {
      // birthtime is the epoch on filesystems that don't record it (NFS/SMB backup shares),
      // and here it is "now": either way it is not when the backup was made.
      const files = {
        legacy: 'nuggets_backup_20250102_030405.enc',
        current: 'nuggets_backup_20250103_030405_678.enc',
        renamed: 'copied-from-the-nas.enc',
      };
      const mtime = new Date('2024-06-01T00:00:00Z');
      for (const name of Object.values(files)) {
        await writeFile(path.join(backupDir, name), 'x');
        await utimes(path.join(backupDir, name), mtime, mtime);
      }

      const backups = await new BackupService({} as Pool).listBackups();
      const created = Object.fromEntries(backups.map((b) => [b.fileName, b.created.getTime()]));
      // File names carry UTC (BackupService.formatDate), whatever the process TZ.
      expect(created[files.legacy]).toBe(Date.UTC(2025, 0, 2, 3, 4, 5));
      expect(created[files.current]).toBe(Date.UTC(2025, 0, 3, 3, 4, 5, 678));
      expect(created[files.renamed]).toBe(mtime.getTime());
      expect(backups.map((b) => b.fileName)).toEqual([files.current, files.legacy, files.renamed]);
    });

    it('lists age backups and the older .enc ones, by their bytes, and never one still being written', async () => {
      await writeFile(path.join(backupDir, 'nuggets_backup_20261120_012958_362.tar.age'), 'age-encryption.org/v1\n-> X25519 x\n');
      await writeFile(path.join(backupDir, 'nuggets_backup_20261119_012958_362.enc'), Buffer.from([0x03, 1, 2, 3]));
      await writeFile(path.join(backupDir, 'nuggets_backup_20261121_012958_362.tar.age.partial'), 'age-encryption.org/v1\n');
      await writeFile(path.join(backupDir, 'renamed.age'), 'not age at all');
      const backups = await new BackupService({} as Pool).listBackups();
      expect(backups.map((b) => [b.fileName, b.format])).toEqual([
        ['nuggets_backup_20261120_012958_362.tar.age', 'age'],
        ['nuggets_backup_20261119_012958_362.enc', 'legacy'],
        ['renamed.age', 'unknown'],
      ]);
      expect(backupTimeFromFileName('nuggets_backup_20261120_012958_362.tar.age')?.toISOString()).toBe('2026-11-20T01:29:58.362Z');
    });

    it("reads a backup's id from its name: an age or .enc backup's, nothing else", () => {
      expect(backupIdFromFileName('nuggets_backup_20261120_012958_362.tar.age')).toBe('nuggets_backup_20261120_012958_362');
      expect(backupIdFromFileName('nuggets_backup_20261120_012958_362.enc')).toBe('nuggets_backup_20261120_012958_362');
      // A name without the milliseconds is an older .enc backup's, and not a signed id.
      for (const name of ['nuggets_backup_20261120_012958.enc', 'copied-from-the-nas.tar.age', 'nuggets_backup_20261120_012958_362.tar', 'nuggets_backup_20261120_012958_362.tar.age.partial']) {
        expect(backupIdFromFileName(name), name).toBeNull();
      }
    });

    // The stamp was the server's local time, so the same file read 4-5 hours apart
    // under TZ=America/New_York and TZ=UTC.
    it('reads a name the same whatever the process time zone', () => {
      try {
        for (const zone of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
          vi.stubEnv('TZ', zone);
          expect(backupTimeFromFileName('nuggets_backup_20261027_020000_000.enc')?.toISOString(), zone)
            .toBe('2026-10-27T02:00:00.000Z');
        }
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('falls back to the modification time for a name with an impossible date', async () => {
      const name = 'nuggets_backup_20251399_030405.enc';
      const mtime = new Date('2024-06-01T00:00:00Z');
      await writeFile(path.join(backupDir, name), 'x');
      await utimes(path.join(backupDir, name), mtime, mtime);

      const [backup] = await new BackupService({} as Pool).listBackups();
      expect(backup.created.getTime()).toBe(mtime.getTime());
    });
  });
});
