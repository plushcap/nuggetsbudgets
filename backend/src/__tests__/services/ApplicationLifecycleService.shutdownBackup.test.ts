import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Pool } from 'pg';
import type { ImportService } from '../../services/ImportService.js';

// The schedulers aren't under test, and they'd load db.ts (Docker secrets).
vi.mock('../../services/SyncScheduler.js', () => ({ SyncScheduler: class {} }));
vi.mock('../../services/NotificationScheduler.js', () => ({ NotificationScheduler: class {} }));
vi.mock('../../services/investments/OrgPriceSyncScheduler.js', () => ({ OrgPriceSyncScheduler: class {} }));
vi.mock('../../services/OneDriveService.js', () => ({ OneDriveService: class {} }));

import { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';
import { BackupService, ShuttingDownError } from '../../services/BackupService.js';

/**
 * A shutdown with a backup running: the backup gets 35 s, then its pg_dump
 * is stopped and it gets 10 s more. One still running after that (past its pg_dump, so
 * nothing stopped it) is cut short by the exit, which is then not a clean one: exit 1. It
 * used to exit 0. No backup starts once the shutdown has begun.
 */
describe('a shutdown while a backup runs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shutdown-backup-'));

  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when the backup is still running as it exits, and refuses another meanwhile', async () => {
    vi.useFakeTimers();
    vi.stubEnv('SHUTDOWN_DRAIN_MS', '0');
    vi.stubEnv('SHUTDOWN_TIMEOUT_MS', '55000');
    const pool = { end: vi.fn(async () => {}) } as unknown as Pool;
    const options = {
      backupLocation: path.join(dir, 'backups'),
      uploadsDir: path.join(dir, 'uploads'),
      tempDir: path.join(dir, 'temp'),
      location: { host: 'localhost', port: 5432, database: 'nuggets_test' },
      owner: { user: 'owner', password: 'x' },
      serving: { user: 'nuggets_app', password: 'x' },
    };
    // A backup that never ends, past its pg_dump: there is no pg tool for the shutdown to stop.
    vi.spyOn(BackupService.prototype as unknown as { withBackupLock: () => Promise<never> }, 'withBackupLock').mockImplementation(
      () => new Promise<never>(() => {})
    );
    const backups = new BackupService(pool, options);
    void backups.createBackup().catch(() => {});
    expect(BackupService.runningOperation()).toMatchObject({ kind: 'backup', database: 'nuggets_test' });

    const exit = vi.fn();
    const lifecycle = new ApplicationLifecycleService(pool, {} as ImportService, backups, { exit });
    const shutdown = lifecycle.shutdown('SIGTERM');

    // Nothing new starts, here or through the routes (503 SHUTTING_DOWN).
    const refused = await new BackupService(pool, options).createBackup().catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ShuttingDownError);
    expect(refused).toMatchObject({ status: 503, code: 'SHUTTING_DOWN' });

    // 35 s for the backup, then 10 s after stopping its (absent) pg_dump.
    await vi.advanceTimersByTimeAsync(44_000);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    await shutdown;
    expect(pool.end).toHaveBeenCalledOnce();
    expect(exit.mock.calls).toEqual([[1]]);
  });
});
