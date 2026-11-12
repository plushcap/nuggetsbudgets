import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { runPgTool, runningPgTools, terminatePgTools } from '../../utils/pgTools.js';

/**
 * pg_dump and pg_restore run in a process group of their own, so the stop
 * signal dumb-init sends the server's group doesn't kill them before the server can let a
 * backup finish; the server ends them itself. A stand-in pg_dump (PG_BIN_DIR) writes its pid
 * and sleeps. Checked with kill(2), not `ps`, which the server image (node:26-slim) lacks.
 */
describe('runPgTool', () => {
  let bin: string;

  beforeAll(async () => {
    bin = await mkdtemp(path.join(os.tmpdir(), 'pg-tools-'));
    // exec keeps the pid, so the one written is the sleeping process's.
    await writeFile(
      path.join(bin, 'pg_dump'),
      `#!/bin/sh\necho $$ > '${path.join(bin, 'pid')}'\necho "password=$PGPASSWORD args=$*" >&2\nexec sleep 30\n`
    );
    await chmod(path.join(bin, 'pg_dump'), 0o755);
  });
  afterAll(() => rm(bin, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllEnvs());

  it('runs the tool in its own process group, and stops it on request', async () => {
    vi.stubEnv('PG_BIN_DIR', bin);
    const run = runPgTool('pg_dump', ['--file', 'x.dump'], 'secret');
    await vi.waitFor(() => expect(runningPgTools()).toBe(1));
    // Up to 10 s: starting sh takes longer than vi.waitFor's default second on a loaded machine.
    const pid = await vi.waitFor(async () => {
      const written = Number((await readFile(path.join(bin, 'pid'), 'utf8')).trim());
      expect(written).toBeGreaterThan(0);
      return written;
    }, { timeout: 10_000 });
    // The stand-in leads a process group of its own: kill(-pid, 0) finds a group whose id is
    // its pid. A process group's id is its leader's pid, so it isn't ours (the server's).
    // Run in our group (not detached), it would lead none, and the call throws ESRCH.
    expect(() => process.kill(-pid, 0)).not.toThrow();

    expect(terminatePgTools()).toBe(1);
    const result = await run;
    expect(result.signal).toBe('SIGTERM');
    expect(result.stderr).toContain('password=secret args=--file x.dump');
    expect(runningPgTools()).toBe(0);
  });

  it('rejects when the tool is not there', async () => {
    vi.stubEnv('PG_BIN_DIR', path.join(bin, 'missing'));
    await expect(runPgTool('pg_restore', ['--list'], '')).rejects.toThrow(/Failed to start pg_restore/);
  });
});
