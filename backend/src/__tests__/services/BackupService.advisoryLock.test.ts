import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { Pool, type PoolClient } from 'pg';
import appPool from '../../db.js';
import { BackupService, BackupInProgressError } from '../../services/BackupService.js';

/**
 * Two backend instances must not back up at once: createBackup takes a Postgres advisory
 * lock, which works across servers sharing the database. Here a second pool plays the
 * other server; the BackupService under test gets the app's own pool.
 */
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('BackupService advisory lock (Postgres)', () => {
  const otherServer = new Pool({ connectionString, max: 1 });
  const key = BackupService.BACKUP_LOCK_KEY;
  let backupDir: string;

  beforeAll(async () => {
    backupDir = await mkdtemp(path.join(os.tmpdir(), 'backup-advisory-lock-'));
    vi.stubEnv('BACKUP_LOCATION', backupDir);
  });

  afterAll(async () => {
    await otherServer.end();
    vi.unstubAllEnvs();
    await rm(backupDir, { recursive: true, force: true });
  });

  it('refuses to back up while another server holds the lock, and releases its own', async () => {
    const service = new BackupService(appPool);

    const holder = await otherServer.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [key]);
      await expect(service.createBackup()).rejects.toBeInstanceOf(BackupInProgressError);
      expect(BackupService.isBackupInProgress()).toBe(false);
      await holder.query('SELECT pg_advisory_unlock($1)', [key]);

      // With the lock free the backup gets past it. It fails later here (no Docker secret or
      // backup key in the test environment), and must not keep the lock when it does.
      const failure = await service.createBackup().then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(BackupInProgressError);
      expect((failure as Error).message).toMatch(/encryption key/i);

      const { rows } = await holder.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
      expect(rows[0].locked).toBe(true);
      await holder.query('SELECT pg_advisory_unlock($1)', [key]);
    } finally {
      holder.release();
    }
  });

  it('carries on, without taking the server down, when the lock session is killed mid-backup', async () => {
    // pg_terminate_backend here; a Postgres restart or failover does the same. pg emits
    // 'error' on the checked-out lock client, which used to be an uncaught exception, and the
    // server shuts down on those.
    const service = new BackupService(appPool);
    const connect = vi.spyOn(appPool, 'connect');
    const holderPid = async () =>
      (
        await otherServer.query<{ pid: number }>(
          // This database's: advisory locks are per database, and pg_locks lists the cluster's
          // (the restore round trip holds the same key on a database of its own).
          `SELECT pid FROM pg_locks
            WHERE locktype = 'advisory' AND granted AND ((classid::bigint << 32) | objid::bigint) = $1
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
          [key]
        )
      ).rows[0]?.pid;

    vi.spyOn(service as unknown as { createBackupLocked: () => Promise<unknown> }, 'createBackupLocked').mockImplementation(
      async () => {
        const lockClient = (await connect.mock.results[0].value) as PoolClient;
        const ended = new Promise((resolve) => lockClient.once('end', resolve));
        const pid = await holderPid();
        expect(pid).toBeDefined();
        await otherServer.query('SELECT pg_terminate_backend($1)', [pid]);
        await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 5000))]);
        return { filePath: path.join(backupDir, 'probe.enc'), fileName: 'probe.enc', fileSize: 1 };
      }
    );

    // What reaches these would reach the server's own handlers, which shut it down.
    const crashes: unknown[] = [];
    const crash = (error: unknown) => crashes.push(error);
    process.on('uncaughtException', crash);
    process.on('unhandledRejection', crash);
    try {
      await expect(service.createBackup()).resolves.toMatchObject({ fileName: 'probe.enc' });
      await new Promise((resolve) => setTimeout(resolve, 200)); // anything the dead socket still emits
    } finally {
      process.off('uncaughtException', crash);
      process.off('unhandledRejection', crash);
      connect.mockRestore();
    }
    expect(crashes).toEqual([]);
    expect(BackupService.isBackupInProgress()).toBe(false);
    expect(await holderPid()).toBeUndefined();
    // The dead connection was discarded, not pooled: the app's pool still answers.
    for (let i = 0; i < 3; i++) {
      expect((await appPool.query<{ one: number }>('SELECT 1 AS one')).rows[0].one).toBe(1);
    }
  });
});
