import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Pool } from 'pg';

// pg_dump never runs: spawn hands back a process that exits 0 at once.
const spawned: string[][] = [];
vi.mock('child_process', () => ({
  spawn: (_command: string, args: string[]) => {
    spawned.push(args);
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), stdout: new EventEmitter() });
    setImmediate(() => child.emit('close', 0));
    return child;
  },
}));

const { BackupService } = await import('../../services/BackupService.js');

/**
 * A backup dumps the database the app serves, DB_NAME. It read POSTGRES_DB, which only
 * the Postgres container is given, so against an external database with another name
 * it dumped `nuggets_db`.
 */
describe('BackupService database name', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    spawned.length = 0;
  });

  async function dumpedDatabase(): Promise<string> {
    const service = new BackupService({} as unknown as Pool);
    await (service as unknown as { createDatabaseDump(dir: string, backupId: string): Promise<string> })
      .createDatabaseDump('/tmp', 'dump');
    const args = spawned.at(-1)!;
    return args[args.indexOf('-d') + 1];
  }

  it('is DB_NAME', async () => {
    vi.stubEnv('DB_PASSWORD', 'x');
    vi.stubEnv('JWT_SECRET', 'x');
    vi.stubEnv('SESSION_SECRET', 'x');
    vi.stubEnv('CSRF_SECRET', 'x');
    vi.stubEnv('DB_NAME', 'household_finances');
    vi.stubEnv('POSTGRES_DB', '');
    expect(await dumpedDatabase()).toBe('household_finances');
  });

  it('falls back to POSTGRES_DB, then nuggets_db', async () => {
    vi.stubEnv('DB_PASSWORD', 'x');
    vi.stubEnv('JWT_SECRET', 'x');
    vi.stubEnv('SESSION_SECRET', 'x');
    vi.stubEnv('CSRF_SECRET', 'x');
    vi.stubEnv('DB_NAME', '');
    vi.stubEnv('POSTGRES_DB', 'from_image');
    expect(await dumpedDatabase()).toBe('from_image');
    vi.stubEnv('POSTGRES_DB', '');
    expect(await dumpedDatabase()).toBe('nuggets_db');
  });
});
