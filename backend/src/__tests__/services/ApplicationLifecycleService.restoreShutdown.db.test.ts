import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { Client, Pool, escapeIdentifier } from 'pg';
import { BackupService, RESTORE_ROLE_LOCK_KEY } from '../../services/BackupService.js';
import { MigrationService } from '../../services/MigrationService.js';
import { pgToolPath } from '../../utils/pgTools.js';
import type { ImportService } from '../../services/ImportService.js';
import type { RestoreOptions } from '../../services/BackupService.js';
import { readAgeHeader } from '../../utils/backupFormat.js';
import { Decrypter, generateHybridIdentity, identityToRecipient } from 'age-encryption';

/**
 * A shutdown while a real restore runs. It used to wait 50 s
 * whatever the restore was doing, then exit 0 with it still running: a restore that got
 * past its checks meanwhile could be cut off in the middle of its swap, leaving the
 * database refusing every connection. Now:
 *   - a restore that hasn't begun replacing the data is stopped at once, its scratch
 *     database dropped, the data as it was;
 *   - one that has (the swap) is waited for, up to the shutdown's deadline;
 *   - none starts once the shutdown has begun.
 *
 * Its own database, as the round trip makes (BackupService.roundTrip.db.test.ts), with
 * pg_dump/pg_restore of the server's major version (PG_BIN_DIR, or on PATH). Each test
 * imports the services afresh: a shutdown refuses backups and restores for good.
 */

const ownerUrl = process.env.DATABASE_URL;

function toolMajor(): number | null {
  try {
    const out = execFileSync(pgToolPath('pg_dump'), ['--version'], { encoding: 'utf8' });
    return Number(/(\d+)\.\d+/.exec(out)?.[1] ?? NaN);
  } catch {
    return null;
  }
}

const serverMajor = (() => {
  if (!ownerUrl) return null;
  try {
    const out = execFileSync('psql', [ownerUrl, '-XAtc', 'SHOW server_version_num'], { encoding: 'utf8' });
    return Math.floor(Number(out.trim()) / 10000);
  } catch {
    return null;
  }
})();
const tools = toolMajor();
const runnable = !!ownerUrl && serverMajor !== null && tools === serverMajor;
if (!runnable && process.env.CI) {
  throw new Error(`The restore shutdown test needs pg_dump ${serverMajor ?? '?'} (found ${tools ?? 'none'}): set PG_BIN_DIR`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MARKER = 'made-after-the-backup';

/**
 * How long a test's restore may take to reach the step the test holds it at, not
 * counting its wait for the restore role's lock (RESTORE_ROLE_LOCK_KEY). That lock is the whole
 * server's: every restore on the server holds it through its own scratch database and
 * pg_restore, and BackupService.roundTrip restores six backups in the same run. On a server
 * other test runs share, their restores can hold it for minutes, and counted against one
 * deadline (150 s, as it was) that failed the tests now and then in full runs ("Timed out
 * waiting for the swap"; reproduced by holding the lock past the deadline). The
 * wait is the other runs', so it has a budget of its own, QUEUE_MS. Measured on the 4-core
 * development machine: 2 s to reach the checks when it was idle, 6 s with every core busy
 * and the round trip running beside it. Once a restore is held where a test wants it, the
 * test's own steps take seconds; their budget stays 60 s, and the times they assert stay as
 * they were.
 */
const REACH_MS = 90_000;
const QUEUE_MS = 600_000;
const TEST_MS = QUEUE_MS + REACH_MS + 60_000;

describe.skipIf(!runnable)('a shutdown while a backup is restored', () => {
  const url = new URL(ownerUrl ?? 'postgresql://x@localhost/x');
  const location = { host: url.hostname, port: Number(url.port || 5432), database: `nuggets_rs_${process.pid}_${randomBytes(3).toString('hex')}` };
  const owner = { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const serving = { user: process.env.DB_USER || 'nuggets_app', password: process.env.APP_DB_PASSWORD || '' };
  const migrationsDir = path.join(process.cwd(), 'migrations');
  let tmp: string;
  let dirs: { backupLocation: string; uploadsDir: string; tempDir: string };
  let backupFile: { filePath: string; fileName: string };
  /** The backup's file key, as the browser sends it: each restore job gets a copy (it zeroes its own). */
  let fileKey: Buffer;
  /** The deployment admin restoring. */
  let restorerId: number;
  const clients: Client[] = [];

  const ownerQuery = async <T extends object = Record<string, unknown>>(database: string, sql: string, params: unknown[] = []) => {
    const client = new Client({ ...location, database, ...owner });
    await client.connect();
    try {
      return (await client.query<T>(sql, params)).rows;
    } finally {
      await client.end();
    }
  };
  /** The test's databases (the app's, a scratch one, the kept copy) and whether each takes connections. */
  const databases = async () =>
    (
      await ownerQuery<{ datname: string; datallowconn: boolean }>(
        'postgres',
        'SELECT datname, datallowconn FROM pg_database WHERE datname LIKE $1 ORDER BY 1',
        [`${location.database}%`]
      )
    ).map((r) => `${r.datname}${r.datallowconn ? '' : ' (refuses connections)'}`);
  const scratchName = async () =>
    (
      await ownerQuery<{ datname: string }>('postgres', `SELECT datname FROM pg_database WHERE datname LIKE $1 AND datname ~ '_restore_[0-9]{17}$'`, [
        `${location.database}\\_restore\\_%`,
      ])
    )[0]?.datname ?? null;
  const markers = async () =>
    Number((await ownerQuery<{ n: number }>(location.database, 'SELECT count(*)::int AS n FROM tags WHERE name = $1', [MARKER]))[0].n);
  const connectAs = async (database: string) => {
    const client = new Client({ ...location, database, ...owner });
    client.on('error', () => {});
    await client.connect();
    clients.push(client);
    return client;
  };
  /**
   * The sessions holding or waiting for the restore role's lock, for a timeout's message.
   * Advisory locks are reported by their key's two halves (classid, objid).
   */
  const roleLockSessions = async () =>
    (
      await ownerQuery<{ who: string }>(
        'postgres',
        `SELECT format('pid %s on %s (%s, %s)', a.pid, a.datname, a.application_name, CASE WHEN l.granted THEN 'holds it' ELSE 'waits' END) AS who
           FROM pg_locks l JOIN pg_stat_activity a USING (pid)
          WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = $2`,
        [Math.floor(RESTORE_ROLE_LOCK_KEY / 2 ** 32), RESTORE_ROLE_LOCK_KEY % 2 ** 32]
      )
    ).map((r) => r.who);
  /**
   * Whether one session holds the restore role's lock while another waits for it
   * (pg_advisory_lock blocks, so a waiter shows in pg_locks, not granted).
   */
  const roleLockContended = async () =>
    Number(
      (
        await ownerQuery<{ n: number }>(
          'postgres',
          `SELECT count(*)::int AS n
             FROM pg_locks h JOIN pg_locks w
               ON w.locktype = h.locktype AND w.database IS NOT DISTINCT FROM h.database
              AND w.classid = h.classid AND w.objid = h.objid AND w.objsubid = h.objsubid
            WHERE h.locktype = 'advisory' AND h.classid = $1 AND h.objid = $2
              AND h.granted AND NOT w.granted AND w.pid <> h.pid`,
          [Math.floor(RESTORE_ROLE_LOCK_KEY / 2 ** 32), RESTORE_ROLE_LOCK_KEY % 2 ** 32]
        )
      )[0].n
    ) > 0;
  /**
   * The restore is queued for the restore role's lock: in 'restoring' with no scratch database
   * yet, which it makes as soon as it has the lock, and another session holds the lock while one
   * waits for it. Without that last check, a restore stuck before it asked for the lock
   * counted as queued, and had QUEUE_MS (10 minutes) rather than REACH_MS to get anywhere.
   */
  const queuedForRoleLock = async (phase: string | null | undefined) =>
    phase === 'restoring' && (await scratchName()) === null && (await roleLockContended());
  /**
   * Wait until `done()`: the restore's progress to the step a test holds it at. It gets REACH_MS
   * of its own, and up to QUEUE_MS besides queued for the restore role's lock behind the
   * server's other restores; its own clock starts again once it has the lock. A timeout says
   * which ran out, the phase the restore was in and who had the restore role's lock.
   */
  const progress = async (what: string, done: () => boolean | Promise<boolean>, phase: () => string | null | undefined) => {
    const queueDeadline = Date.now() + QUEUE_MS;
    let deadline = Date.now() + REACH_MS;
    while (!(await done())) {
      const restoring = phase() === 'restoring';
      const queued = restoring && (await queuedForRoleLock(phase()));
      if (queued) deadline = Date.now() + REACH_MS;
      if (Date.now() > (queued ? queueDeadline : deadline)) {
        const sessions = await roleLockSessions().catch(() => ['(unknown)']);
        throw new Error(
          `Timed out waiting for ${what}, after ${queued ? `${QUEUE_MS / 1000} s queued for the restore role's lock` : `${REACH_MS / 1000} s of its own`}: ` +
            `the restore was in phase ${phase() ?? '(none)'}; the restore role's lock: ${sessions.join('; ') || 'free'}`
        );
      }
      // A look for the scratch database is a connection of its own: a few a second, not 50.
      await sleep(restoring ? 250 : 20);
    }
  };
  /** Wait for the restore to reach a step a test holds it at (`reached` settles there): see progress(). */
  const reach = async <T>(what: string, reached: Promise<T>, phase: () => string | null | undefined): Promise<T> => {
    let settled = false;
    const result = reached.finally(() => {
      settled = true;
    });
    result.catch(() => {}); // awaited below; not an unhandled rejection meanwhile
    await progress(what, () => settled, phase);
    return result;
  };
  /** Wait for a state that holds once reached (a step held, a lock waited on), never a passing one. */
  const until = async (what: string, condition: () => boolean | Promise<boolean>, timeoutMs = 40_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(10);
    }
  };
  /**
   * The restore's sessions on `database` (its connections are named nuggets-backup): those
   * waiting for a lock, or those trying the migration runner's advisory lock. Between tries
   * the runner holds its connection, whose last query is then either the try or, after a
   * failed one, its look-up of who holds the lock (runnerLockHolder, FROM pg_locks l): the
   * try alone shows for under a millisecond, so a poll for it alone could miss every one.
   */
  const restoreSessionsOn = async (database: string, doing: 'waiting for a lock' | 'trying the migration lock') =>
    Number(
      (
        await ownerQuery<{ n: number }>(
          'postgres',
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = $1 AND application_name = 'nuggets-backup'
              AND CASE WHEN $2 THEN wait_event_type = 'Lock'
                       ELSE (query LIKE '%pg_try_advisory_lock%' OR query LIKE '%FROM pg_locks l%') END`,
          [database, doing === 'waiting for a lock']
        )
      )[0].n
    );

  /**
   * Hold the restore as it starts one of its steps (BackupService's private `method`) until
   * `release()`. `reached` settles once it is there, so a test waits for the step itself:
   * polling for a phase, as these did, missed a short one on a busy machine.
   */
  function holdAt(backupService: BackupService, method: 'migrateDatabase' | 'assertIsolationMatches') {
    let arrive!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (arrive = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const steps = backupService as unknown as Record<typeof method, (...args: unknown[]) => Promise<unknown>>;
    const step = steps[method].bind(backupService);
    vi.spyOn(steps, method).mockImplementation(async (...args: unknown[]) => {
      arrive();
      await released;
      return step(...args);
    });
    return { reached, release };
  }

  /**
   * The services as the server builds them, imported afresh, on a pool of the serving
   * role; the shutdown's exit() is recorded rather than run.
   */
  async function server(options: { beforeSwap?: () => Promise<void> } = {}) {
    vi.resetModules();
    const { BackupService: Backups, ShuttingDownError } = await import('../../services/BackupService.js');
    const { ApplicationLifecycleService } = await import('../../services/ApplicationLifecycleService.js');
    const job = await import('../../services/restoreJob.js');
    const pool = new Pool({ ...location, ...serving, max: 4 });
    // The swap ends every session on the database it replaces, this pool's idle ones too.
    pool.on('error', () => {});
    const backupService = new Backups(pool, { location, owner, serving, migrationsDir, ...dirs });
    const { beforeSwap } = options;
    if (beforeSwap) {
      // What runs after every check, just before the swap's last check (RestoreOptions.beforeSwap).
      const restore = backupService.restoreFromFile.bind(backupService);
      vi.spyOn(backupService, 'restoreFromFile').mockImplementation((file: string, restoreOptions?: RestoreOptions) =>
        restore(file, { ...restoreOptions, beforeSwap })
      );
    }
    const exits: Array<{ code: number; status: ReturnType<typeof job.getRestoreStatus> }> = [];
    const lifecycle = new ApplicationLifecycleService(pool, {} as ImportService, backupService, {
      exit: (code) => exits.push({ code, status: job.getRestoreStatus() }),
    });
    const restore = () =>
      job.startRestoreJob(
        { pool, backupService, schedulers: lifecycle },
        { filePath: backupFile.filePath, fileName: backupFile.fileName, key: null, fileKey: Buffer.from(fileKey), deleteAfter: false, userId: restorerId }
      );
    return { lifecycle, backupService, Backups, ShuttingDownError, job, restore, exits };
  }

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'restore-shutdown-'));
    dirs = { backupLocation: path.join(tmp, 'backups'), uploadsDir: path.join(tmp, 'uploads'), tempDir: path.join(tmp, 'temp') };
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
    const keyFile = path.join(tmp, 'data.key');
    await writeFile(keyFile, `data-encryption-secret-for-restore-shutdown-${'x'.repeat(32)}`);
    vi.stubEnv('DATA_ENCRYPTION_KEY_FILE', keyFile);

    await ownerQuery('postgres', `CREATE DATABASE ${escapeIdentifier(location.database)}`);
    const migrationPool = new Pool({ ...location, ...owner, max: 2 });
    try {
      await new MigrationService(migrationPool, { migrationsDir, baselinePath: path.join(process.cwd(), 'init.sql') }).migrate();
    } finally {
      await migrationPool.end();
    }

    // The person restoring: a deployment admin who can sign in, in the backup's data too (a
    // restore refuses one that would leave them unable to manage the server).
    const [admin] = await ownerQuery<{ id: number }>(location.database, "INSERT INTO users (email, password_hash) VALUES ('restorer@shutdown.test', 'not-a-hash') RETURNING id");
    restorerId = admin!.id;
    await ownerQuery(location.database, "INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1", [restorerId]);

    // The backup every test restores; the marker row is made after it, so a restore that
    // replaced the data removes it.
    const pool = new Pool({ ...location, ...serving, max: 2 });
    try {
      const backups = new BackupService(pool, { location, owner, serving, migrationsDir, ...dirs });
      // A backup key made at run time, and the file key the browser would get with it.
      const identity = await generateHybridIdentity();
      await backups.addRecipient({ recipient: await identityToRecipient(identity), label: 'test key', checked: true, createdBy: null });
      backupFile = await backups.createBackup();
      const opener = new Decrypter();
      opener.addIdentity(identity);
      fileKey = Buffer.from(await opener.decryptHeader(await readAgeHeader(backupFile.filePath)));
    } finally {
      await pool.end();
    }
  }, 240_000);

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.end().catch(() => {});
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    for (const name of await databases().catch(() => [] as string[])) {
      const datname = name.replace(/ \(refuses connections\)$/, '');
      await ownerQuery('postgres', `DROP DATABASE IF EXISTS ${escapeIdentifier(datname)} WITH (FORCE)`).catch(() => {});
    }
    vi.unstubAllEnvs();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  /** The live data back to the backup's, plus the marker. */
  async function freshData() {
    await ownerQuery(location.database, 'DELETE FROM tags WHERE name = $1', [MARKER]);
    await ownerQuery(location.database, 'INSERT INTO tags (tenant_id, name) VALUES (1, $1)', [MARKER]);
  }

  it('stops a restore that is still checking the restored data: the scratch database goes, the data stays', async () => {
    await freshData();
    const { lifecycle, job, restore, exits, backupService } = await server();
    const checks = holdAt(backupService, 'assertIsolationMatches');
    restore();

    // Hold the restore in 'verifying', on a lock in its scratch database: no pg tool runs
    // then, so stopping pg_restore alone (as before) stopped nothing. Held as its checks
    // begin, the table they count is locked; let go, they wait for the lock.
    await reach('the restore to begin its checks', checks.reached, () => job.getRestoreStatus().phase);
    const scratch = (await scratchName())!;
    const blocker = await connectAs(scratch);
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE stored_images IN ACCESS EXCLUSIVE MODE');
    checks.release();
    await until('the checks to wait for the lock', async () => (await restoreSessionsOn(scratch, 'waiting for a lock')) > 0);
    expect(job.getRestoreStatus()).toMatchObject({ status: 'running', phase: 'verifying' });

    const started = Date.now();
    void lifecycle.shutdown('SIGTERM');
    await until('the exit', () => exits.length > 0);
    // Stopped, not waited for: it used to wait 50 s whatever the restore was doing. The
    // stop drops the scratch database, which waits for a checkpoint on a busy server.
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(exits).toEqual([
      {
        code: 0,
        status: expect.objectContaining({
          status: 'failed',
          databaseChanged: false,
          error: expect.stringMatching(/^The server shut down before the restore replaced the data, so nothing was changed/),
        }),
      },
    ]);
    // No scratch database left, the data as it was, and connections allowed.
    expect(await databases()).toEqual([location.database]);
    expect(await markers()).toBe(1);
  }, TEST_MS);

  it('stops a restore that is migrating the restored data, with no uncaught error', async () => {
    // The shutdown ends the migration's sessions on the scratch database. Its pool had no
    // 'error' listener, and pg emits 'error' on a connection whose session ends: an
    // uncaught exception, which in the server shuts it down with 1.
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      await freshData();
      const { lifecycle, job, restore, exits, backupService } = await server();
      const migrations = holdAt(backupService, 'migrateDatabase');
      restore();

      // Hold the restore in 'migrating': the migration runner waits for its advisory lock
      // (MigrationService.MIGRATION_LOCK_KEY), taken on the scratch database first, while
      // the restore is held just before it starts the runner.
      await reach('the restore to begin its migrations', migrations.reached, () => job.getRestoreStatus().phase);
      expect(job.getRestoreStatus()).toMatchObject({ status: 'running', phase: 'migrating' });
      const scratch = (await scratchName())!;
      const blocker = await connectAs(scratch);
      await blocker.query('SELECT pg_advisory_lock(4242042042)');
      migrations.release();
      // It polls the lock each second, holding its connection between polls: that
      // connection is what the shutdown ends.
      await until('the migration runner to wait for its lock', async () => (await restoreSessionsOn(scratch, 'trying the migration lock')) > 0);
      await sleep(200);
      expect(job.getRestoreStatus()).toMatchObject({ status: 'running', phase: 'migrating' });

      void lifecycle.shutdown('SIGTERM');
      await until('the exit', () => exits.length > 0);
      // Whatever the ended sessions emit arrives by now.
      await sleep(200);
      expect(uncaught).toEqual([]);
      expect(exits).toEqual([
        {
          code: 0,
          status: expect.objectContaining({
            status: 'failed',
            databaseChanged: false,
            error: expect.stringMatching(/^The server shut down before the restore replaced the data, so nothing was changed/),
          }),
        },
      ]);
      expect(await databases()).toEqual([location.database]);
      expect(await markers()).toBe(1);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  }, TEST_MS);

  it('stops a restore at its last check before the swap', async () => {
    await freshData();
    let passChecks!: () => void;
    const checked = new Promise<void>((resolve) => (passChecks = resolve));
    let reachSwap!: () => void;
    const lastCheck = new Promise<void>((resolve) => (reachSwap = resolve));
    const { lifecycle, job, restore, exits, Backups } = await server({
      beforeSwap: () => {
        reachSwap();
        return checked;
      },
    });
    restore();
    // Every check has passed and it waits at the last one before the swap.
    await reach('the restore to pass every check', lastCheck, () => job.getRestoreStatus().phase);
    expect(job.getRestoreStatus()).toMatchObject({ status: 'running', phase: 'verifying' });
    expect(Backups.runningOperation()).toMatchObject({ kind: 'restore', replacingData: false });

    void lifecycle.shutdown('SIGTERM');
    await sleep(200);
    expect(exits).toEqual([]);
    passChecks();
    await until('the exit', () => exits.length > 0);
    expect(exits[0]).toEqual({ code: 0, status: expect.objectContaining({ status: 'failed', databaseChanged: false }) });
    expect(await databases()).toEqual([location.database]);
    expect(await markers()).toBe(1);
  }, TEST_MS);

  it('waits for a restore that is swapping the databases, then exits 0', async () => {
    await freshData();
    // Once every check has passed, a lock on the scratch database itself (COMMENT ON
    // DATABASE holds one to the end of its transaction) holds the swap's RENAME of it:
    // the swap has turned connections to the live database off, and waits.
    let blocker!: Client;
    const { lifecycle, job, restore, exits, Backups } = await server({
      beforeSwap: async () => {
        blocker = await connectAs('postgres');
        await blocker.query('BEGIN');
        await blocker.query(`COMMENT ON DATABASE ${escapeIdentifier((await scratchName())!)} IS 'held by the test'`);
      },
    });
    restore();
    await progress('the swap', () => job.getRestoreStatus().phase === 'swapping', () => job.getRestoreStatus().phase);
    await until('the swap to wait on the rename', async () => (await databases()).includes(`${location.database} (refuses connections)`));
    expect(Backups.runningOperation()).toMatchObject({ kind: 'restore', replacingData: true });

    void lifecycle.shutdown('SIGTERM');
    // It waits for the swap: stopped here the database would be left refusing connections.
    await sleep(2500);
    expect(exits).toEqual([]);
    expect(job.getRestoreStatus()).toMatchObject({ status: 'running', phase: 'swapping' });

    await blocker.query('ROLLBACK');
    await until('the exit', () => exits.length > 0);
    expect(exits).toEqual([{ code: 0, status: expect.objectContaining({ status: 'completed', databaseChanged: true }) }]);
    expect(await databases()).toEqual([location.database, `${location.database}_before_restore`]);
    // The data is the backup's: the marker made after it is gone.
    expect(await markers()).toBe(0);
  }, TEST_MS);

  it('starts no restore or backup once a shutdown has begun', async () => {
    const { lifecycle, backupService, ShuttingDownError, restore, job, exits } = await server();
    vi.stubEnv('SHUTDOWN_DRAIN_MS', '0');
    const shutdown = lifecycle.shutdown('SIGTERM');
    expect(() => restore()).toThrow(ShuttingDownError);
    expect(job.isRestoreRunning()).toBe(false);
    await expect(backupService.createBackup()).rejects.toMatchObject({ status: 503, code: 'SHUTTING_DOWN' });
    await shutdown;
    expect(exits.map((e) => e.code)).toEqual([0]);
    // Importing the services afresh takes seconds on a busy machine.
  }, 60_000);
});
