import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Pool } from 'pg';
import type { ImportService } from '../../services/ImportService.js';

// The schedulers aren't under test.
vi.mock('../../services/SyncScheduler.js', () => ({ SyncScheduler: class {} }));
vi.mock('../../services/NotificationScheduler.js', () => ({ NotificationScheduler: class {} }));
vi.mock('../../services/investments/OrgPriceSyncScheduler.js', () => ({ OrgPriceSyncScheduler: class {} }));
vi.mock('../../services/OneDriveService.js', () => ({ OneDriveService: class {} }));

const downloads = vi.hoisted(() => ({ stopSchemaDownloads: vi.fn(() => 0) }));
vi.mock('../../services/databaseDiagnostics.js', () => downloads);
const tools = vi.hoisted(() => ({ terminatePgTools: vi.fn(() => 0) }));
vi.mock('../../utils/pgTools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/pgTools.js')>()),
  terminatePgTools: tools.terminatePgTools,
}));

import { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';
import { BackupService } from '../../services/BackupService.js';

/**
 * A shutdown and Settings → Utilities' schema downloads: the shutdown stops them
 * when it begins (a dump may run longer than a shutdown may), and kills what is left of
 * them before it exits, cleanly or out of time.
 */
describe('a shutdown and the schema downloads', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shutdown-downloads-'));
  const options = {
    backupLocation: path.join(dir, 'backups'),
    uploadsDir: path.join(dir, 'uploads'),
    tempDir: path.join(dir, 'temp'),
    location: { host: 'localhost', port: 5432, database: 'nuggets_test' },
    owner: { user: 'owner', password: 'x' },
    serving: { user: 'nuggets_app', password: 'x' },
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('stops them as it begins', async () => {
    vi.stubEnv('SHUTDOWN_DRAIN_MS', '0');
    const pool = { end: vi.fn(async () => {}) } as unknown as Pool;
    const exit = vi.fn();
    const lifecycle = new ApplicationLifecycleService(pool, {} as ImportService, new BackupService(pool, options), { exit });

    await lifecycle.shutdown('SIGTERM');
    expect(downloads.stopSchemaDownloads).toHaveBeenCalledOnce();
    expect(downloads.stopSchemaDownloads.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    expect(exit.mock.calls).toEqual([[0]]);
    // Before it exits, it kills a download's pg_dump still there (stuck in SIGTERM); a
    // backup's or restore's tools it leaves to their own handling, as before.
    expect(tools.terminatePgTools.mock.calls).toEqual([['SIGKILL', ['download']]]);
    expect(tools.terminatePgTools.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
  });

  it('kills what is left of them when it runs out of time', async () => {
    vi.useFakeTimers();
    vi.stubEnv('SHUTDOWN_DRAIN_MS', '0');
    vi.stubEnv('SHUTDOWN_TIMEOUT_MS', '55000');
    // A pool that never closes keeps the shutdown from finishing.
    const pool = { end: vi.fn(() => new Promise<void>(() => {})) } as unknown as Pool;
    const exit = vi.fn();
    const lifecycle = new ApplicationLifecycleService(pool, {} as ImportService, new BackupService(pool, options), { exit });

    void lifecycle.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(55_000);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(tools.terminatePgTools.mock.calls).toEqual([[], ['SIGKILL', ['download']]]);
  });
});
