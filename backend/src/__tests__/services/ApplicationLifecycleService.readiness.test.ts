import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Pool } from 'pg';
import type { BackupService } from '../../services/BackupService.js';
import type { ImportService } from '../../services/ImportService.js';

// The schedulers are stand-ins: the import scheduler fails to start `importFailures`
// times (the database unreachable, or with `importError` if set), and every stop is
// recorded.
const control = vi.hoisted(() => ({ importFailures: 0, importError: null as Error | null, stopped: [] as string[] }));

vi.mock('../../services/SyncScheduler.js', () => ({
  SyncScheduler: class {
    async startScheduler() {
      if (control.importFailures > 0) {
        control.importFailures--;
        throw control.importError ?? Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      }
    }
    isTimerArmed() { return false; }
    async getNextScheduledSyncTime() { return null; }
    async stopScheduler() { control.stopped.push('import'); }
  },
}));
vi.mock('../../services/BackupScheduler.js', () => ({
  BackupScheduler: class {
    async startScheduler() {}
    isTimerArmed() { return false; }
    async getNextScheduledBackupTime() { return null; }
    async stopScheduler() { control.stopped.push('backup'); }
  },
}));
vi.mock('../../services/NotificationScheduler.js', () => ({
  NotificationScheduler: class {
    async startScheduler() {}
    isSchedulerRunning() { return false; }
    async stopScheduler() { control.stopped.push('notifications'); }
  },
}));
vi.mock('../../services/investments/OrgPriceSyncScheduler.js', () => ({
  OrgPriceSyncScheduler: class {
    async startScheduler() {}
    async stopScheduler() { control.stopped.push('price sync'); }
  },
}));
vi.mock('../../services/maintenance/MaintenanceScheduler.js', () => ({
  MaintenanceScheduler: class {
    async startScheduler() {}
    getStatus() { return null; }
    async stopScheduler() { control.stopped.push('retention'); }
  },
}));
vi.mock('../../services/OneDriveService.js', () => ({ OneDriveService: class {} }));
vi.mock('../../services/NotificationRulesEngine.js', () => ({ NotificationRulesEngine: class {} }));
vi.mock('../../services/NotificationQueueService.js', () => ({ NotificationQueueService: class {} }));
vi.mock('../../services/EmailTemplateService.js', () => ({ EmailTemplateService: class { registerHelpers() {} } }));
vi.mock('../../services/EmailDeliveryService.js', () => ({ EmailDeliveryService: class {} }));
vi.mock('../../services/PushNotificationService.js', () => ({ PushNotificationService: class {} }));

import { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';
import { BASELINE } from '../../db/baseline.js';

/**
 * Health, startup and shutdown: /api/ready says whether the server can serve;
 * a scheduler that can't start is tried again, then the server gives up rather
 * than serve without it; a shutdown stops being ready, lets the requests in
 * flight finish and exits within its deadline.
 */

/**
 * A pg Pool stand-in: the database answers, fails, or never answers. `applied` is its
 * schema_migrations (the baseline's row and two migrations); the readiness query asks how
 * many of the versions it is given aren't in it.
 */
function fakePool() {
  const db = {
    applied: new Set([BASELINE.version, '20261201000000', '20261202091000']),
    mode: 'up' as 'up' | 'down' | 'hung',
    queries: 0,
  };
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      db.queries++;
      if (db.mode === 'hung') return new Promise(() => {});
      if (db.mode === 'down') throw Object.assign(new Error('Connection terminated unexpectedly'), {});
      const rows = /schema_migrations/.test(text)
        ? [
            {
              // The shipped versions not applied, and the rows older than the baseline when it is applied.
              pending:
                (params[0] as string[]).filter((version) => !db.applied.has(version)).length +
                (db.applied.has(params[2] as string) ? [...db.applied].filter((version) => version < (params[1] as string)).length : 0),
            },
          ]
        : [];
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
    release: () => {},
  };
  const end = vi.fn(async () => {});
  return { pool: { connect: async () => client, end } as unknown as Pool, db, end };
}

function migrationsDir(...versions: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nuggets-migrations-'));
  for (const v of versions) writeFileSync(path.join(dir, `${v}_test.sql`), '-- test\n');
  return dir;
}

describe('ApplicationLifecycleService readiness, startup and shutdown', () => {
  const dirs: string[] = [];
  const env = { ...process.env };

  beforeEach(() => {
    control.importFailures = 0;
    control.importError = null;
    control.stopped = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...env };
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function lifecycle(opts: { versions?: string[]; readinessCacheMs?: number } = {}) {
    const fake = fakePool();
    const dir = migrationsDir(...(opts.versions ?? ['20261201000000', '20261202091000']));
    dirs.push(dir);
    const exit = vi.fn();
    const service = new ApplicationLifecycleService(fake.pool, {} as ImportService, { sweepLeftovers: async () => {} } as unknown as BackupService, {
      exit,
      migrationsDir: dir,
      // Each check asks the database again, unless a test is about the reuse.
      readinessCacheMs: opts.readinessCacheMs ?? 0,
    });
    return { service, exit, ...fake };
  }

  it('is not ready until the services have started, and ready once they have', async () => {
    const { service } = lifecycle();
    expect(await service.readiness()).toEqual({
      ready: false,
      checks: { startup: 'starting', shuttingDown: false, database: 'ok', migrations: 'ok' },
    });
    await service.initializeServices();
    expect(await service.readiness()).toEqual({
      ready: true,
      checks: { startup: 'ready', shuttingDown: false, database: 'ok', migrations: 'ok' },
    });
  });

  it('tries a service that did not start again, with a growing delay', async () => {
    vi.useFakeTimers();
    control.importFailures = 2;
    const { service } = lifecycle();
    let done = false;
    const started = service.initializeServices({ attempts: 5, retryDelayMs: 1000 }).then(() => { done = true; });

    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    expect(control.importFailures).toBe(1); // failed once, waiting 1 s
    await vi.advanceTimersByTimeAsync(1);
    expect(control.importFailures).toBe(0); // failed twice, waiting 2 s
    expect(service.getStartupState()).toBe('starting');
    await vi.advanceTimersByTimeAsync(2000);
    await started;
    expect(done).toBe(true);
    expect(service.getStartupState()).toBe('ready');
  });

  it('gives up after its attempts while the database is unreachable, saying which service did not start', async () => {
    control.importFailures = 100;
    const { service } = lifecycle();
    await expect(service.initializeServices({ attempts: 3, retryDelayMs: 1 })).rejects.toThrow(
      'These background services did not start after 3 attempts, the database unreachable: import scheduler'
    );
    expect(control.importFailures).toBe(97);
    expect(service.getStartupState()).toBe('failed');
    expect(await service.readiness()).toMatchObject({ ready: false, checks: { startup: 'failed' } });
  });

  // A restart would fail the same way, and keep the app (and the settings page that could
  // fix it) down in a restart loop.
  it('serves on, not ready, when a service fails for another reason', async () => {
    control.importFailures = 100;
    control.importError = new RangeError('Invalid time zone specified: US/Bogus');
    const { service } = lifecycle();
    await service.initializeServices({ attempts: 2, retryDelayMs: 1 });
    expect(control.importFailures).toBe(98);
    expect(service.getStartupState()).toBe('failed');
    expect(await service.readiness()).toMatchObject({ ready: false, checks: { startup: 'failed', database: 'ok' } });
  });

  it('is not ready while the database is down or does not answer', async () => {
    const { service, db } = lifecycle();
    await service.initializeServices();

    db.mode = 'down';
    expect(await service.readiness()).toMatchObject({ ready: false, checks: { database: 'unavailable', migrations: 'unknown' } });
    expect(service.getServiceStatus().services.database).toBe(false);

    vi.useFakeTimers();
    db.mode = 'hung';
    const answer = service.readiness();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await answer).toMatchObject({ ready: false, checks: { database: 'unavailable' } });

    db.mode = 'up';
    expect((await service.readiness()).ready).toBe(true);
    expect(service.getServiceStatus().services.database).toBe(true);
  });

  it('asks the database once for a burst of probes, and again a second later', async () => {
    vi.useFakeTimers();
    const { service, db } = lifecycle({ readinessCacheMs: 1000 });
    await service.initializeServices();
    const before = db.queries;
    const answers = await Promise.all(Array.from({ length: 50 }, () => service.readiness()));
    expect(answers.every((a) => a.ready)).toBe(true);
    expect(db.queries - before).toBe(1);
    await service.readiness();
    expect(db.queries - before).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    db.mode = 'down';
    expect((await service.readiness()).checks.database).toBe('unavailable');
    expect(db.queries - before).toBe(2);
  });

  it('is not ready while a migration this code ships is not applied', async () => {
    const { service, db } = lifecycle({ versions: ['20261201000000', '20261201120000', '20261202091000', '20261202140700'] });
    await service.initializeServices();
    expect(await service.readiness()).toMatchObject({ ready: false, checks: { database: 'ok', migrations: 'pending' } });
    db.applied.add('20261202140700');
    // Still one older than the newest applied, merged late: the runner would apply it.
    expect(await service.readiness()).toMatchObject({ ready: false, checks: { migrations: 'pending' } });
    db.applied.add('20261201120000');
    expect(await service.readiness()).toMatchObject({ ready: true, checks: { migrations: 'ok' } });
    // A database ahead of the code (an older image rolled back to) can still serve.
    db.applied.add('20991231000000');
    expect((await service.readiness()).ready).toBe(true);
  });

  it('is not ready while the database lacks the baseline (a v2.4.0 one not cut over yet), with no migration files', async () => {
    const { service, db } = lifecycle({ versions: [] });
    await service.initializeServices();
    db.applied = new Set(['20261112100100', '20261112200000']);
    expect(await service.readiness()).toMatchObject({ ready: false, checks: { database: 'ok', migrations: 'pending' } });
    // Cut over: v2.4.0's rows are the baseline's one.
    db.applied = new Set([BASELINE.version]);
    expect(await service.readiness()).toMatchObject({ ready: true, checks: { migrations: 'ok' } });
  });

  it("is not ready with the baseline's row and a row older than it, which the runner refuses", async () => {
    const { service, db } = lifecycle({ versions: [] });
    await service.initializeServices();
    expect(await service.readiness()).toMatchObject({ ready: true, checks: { migrations: 'ok' } });
    db.applied.add('20261112200000');
    expect(await service.readiness()).toMatchObject({ ready: false, checks: { database: 'ok', migrations: 'pending' } });
  });

  it('reads the migration files once', async () => {
    const { service } = lifecycle({ versions: ['20261201000000'] });
    await service.initializeServices();
    expect((await service.readiness()).ready).toBe(true);
    rmSync(dirs[dirs.length - 1], { recursive: true, force: true });
    // Deleting them now changes nothing: the code that shipped them is the code running.
    expect(await service.readiness()).toMatchObject({ ready: true, checks: { migrations: 'ok' } });
  });

  it('answers GET /api/ready with 200 when ready and 503, naming the failed check, when not', async () => {
    const { readinessCheck } = await import('../../middleware/health-checks.js');
    const { service, db } = lifecycle();
    const answer = async () => {
      const res = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, string> };
      await readinessCheck(service)({} as never, {
        setHeader: (k: string, v: string) => { res.headers[k] = v; },
        status(code: number) { res.statusCode = code; return this; },
        json(body: unknown) { res.body = body; return this; },
      } as never);
      return res;
    };

    expect(await answer()).toMatchObject({ statusCode: 503, body: { status: 'not_ready', checks: { startup: 'starting' } } });
    await service.initializeServices();
    expect(await answer()).toMatchObject({
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: { status: 'ready', checks: { startup: 'ready', database: 'ok', migrations: 'ok', shuttingDown: false } },
    });
    db.mode = 'down';
    expect(await answer()).toMatchObject({ statusCode: 503, body: { checks: { database: 'unavailable' } } });
  });

  describe('shutdown', () => {
    let server: http.Server;
    let port: number;
    let finishSlowRequest: (() => void) | undefined;

    beforeEach(async () => {
      finishSlowRequest = undefined;
      server = http.createServer((req, res) => {
        if (req.url === '/slow') {
          finishSlowRequest = () => res.end('finished');
          return;
        }
        res.end('ok');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterEach(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    const get = (pathname: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: pathname, agent: false }, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          })
          .on('error', reject);
      });

    it('stops being ready, lets the requests in flight finish, then stops everything and exits 0', async () => {
      process.env.SHUTDOWN_DRAIN_MS = '300';
      process.env.SHUTDOWN_TIMEOUT_MS = '5000';
      const { service, exit, end } = lifecycle();
      await service.initializeServices();
      service.setServer(server);

      const inFlight = get('/slow');
      await vi.waitFor(() => expect(finishSlowRequest).toBeTypeOf('function'));

      const shutdown = service.shutdown('SIGTERM');
      // Draining: not ready, still serving.
      expect(service.isShutdownInProgress()).toBe(true);
      expect(await service.readiness()).toMatchObject({ ready: false, checks: { shuttingDown: true } });
      expect(await get('/during-drain')).toEqual({ status: 200, body: 'ok' });

      // After the drain: no new connections, but the one in flight is still answered.
      await vi.waitFor(() => expect(server.listening).toBe(false), { timeout: 2000 });
      await expect(get('/after-close')).rejects.toThrow(/ECONNREFUSED/);
      expect(end).not.toHaveBeenCalled();
      finishSlowRequest!();
      expect(await inFlight).toEqual({ status: 200, body: 'finished' });

      await shutdown;
      expect(control.stopped.sort()).toEqual(['backup', 'import', 'notifications', 'price sync', 'retention']);
      expect(end).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
      // A second signal doesn't start another.
      await service.shutdown('SIGTERM');
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it('exits 1 at its deadline when a request is still in flight', async () => {
      process.env.SHUTDOWN_DRAIN_MS = '0';
      process.env.SHUTDOWN_TIMEOUT_MS = '1000';
      const { service, exit } = lifecycle();
      service.setServer(server);

      const inFlight = get('/slow').catch((err: Error) => err);
      await vi.waitFor(() => expect(finishSlowRequest).toBeTypeOf('function'));
      const started = Date.now();
      void service.shutdown('SIGTERM');

      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 3000 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(950);
      expect(Date.now() - started).toBeLessThan(2000);
      // The connection left open was closed rather than kept waiting.
      expect(await inFlight).toBeInstanceOf(Error);
    });

    it('exits 1 for a shutdown that a startup failure asked for', async () => {
      process.env.SHUTDOWN_DRAIN_MS = '0';
      const { service, exit } = lifecycle();
      service.setServer(server);
      await service.shutdown('startup failure', 1);
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('exits 1 when an uncaught exception comes during a graceful shutdown', async () => {
      process.env.SHUTDOWN_DRAIN_MS = '200';
      const { service, exit } = lifecycle();
      service.setServer(server);
      const shutdown = service.shutdown('SIGTERM');
      await service.shutdown('uncaughtException', 1); // returns at once: one is running
      expect(exit).not.toHaveBeenCalled();
      await shutdown;
      expect(exit.mock.calls).toEqual([[1]]);
    });
  });
});
