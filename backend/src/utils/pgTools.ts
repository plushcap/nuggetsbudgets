import { spawn, type ChildProcess, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import * as path from 'path';
import { config } from '../config.js';

/**
 * Running pg_dump and pg_restore for backups and restores, and for the
 * schema download.
 *
 * Each runs in a process group of its own (`detached`). The image's init, dumb-init, sends
 * a stop signal to the whole process group of the server, so children in that group were
 * killed the instant `docker stop` began, before the server could let a backup finish or
 * stop a restore cleanly. Now the server decides: the shutdown waits for the operation,
 * then ends what is still running with terminatePgTools().
 *
 * A backup's or restore's tools ('operation') and a schema download's ('download') are
 * counted apart: stopping a restore, or a backup at shutdown, stops only theirs, and its
 * count says what it stopped. A download stops its own (its time limit, its caller going
 * away, the start of a shutdown: stopSchemaDownloads); a shutdown that runs out of time
 * kills what is left of both kinds.
 */

export type PgToolKind = 'operation' | 'download';

const running: Record<PgToolKind, Set<ChildProcess>> = { operation: new Set(), download: new Set() };

/** Where the client tools are: PG_BIN_DIR if set (e.g. /usr/lib/postgresql/18/bin), else PATH. */
export function pgToolPath(tool: 'pg_dump' | 'pg_restore'): string {
  const dir = config().PG_BIN_DIR;
  return dir ? path.join(dir, tool) : tool;
}

export interface PgToolResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const MAX_STDOUT = 64 * 1024 * 1024;
const MAX_STDERR = 1024 * 1024;

/**
 * Start `tool` with `args`, connecting with `password` (PGPASSWORD; never on the command
 * line), with no shell, in a process group of its own, and count it as running (as `kind`)
 * until it exits. Its output is the caller's to read; it emits 'error' if it couldn't start.
 */
export function spawnPgTool(
  tool: 'pg_dump' | 'pg_restore',
  args: string[],
  password: string,
  kind: PgToolKind = 'operation'
): ChildProcessByStdio<null, Readable, Readable> {
  const child = spawn(pgToolPath(tool), args, {
    // eslint-disable-next-line no-restricted-syntax -- the child's environment: this process's, and its password
    env: { ...process.env, PGPASSWORD: password },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running[kind].add(child);
  const forget = () => running[kind].delete(child);
  child.once('error', forget);
  child.once('close', forget);
  return child;
}

/** Whether spawnPgTool started `child` and it hasn't closed (its output's last holder is alive). */
const isRunning = (child: ChildProcess) => running.operation.has(child) || running.download.has(child);

/**
 * Signal one tool started by spawnPgTool, and its process group. Its group, not only it:
 * one whose leader has exited while another member still holds its output is still
 * running, and its group id can't be reused while that member lives. False when it has
 * closed, or the group has gone.
 */
export function stopPgTool(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (child.pid === undefined || !isRunning(child)) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `tool` with `args`, connecting with `password` (PGPASSWORD; never on the command
 * line). Resolves with how it ended; rejects only if it couldn't start.
 */
export function runPgTool(tool: 'pg_dump' | 'pg_restore', args: string[], password: string): Promise<PgToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawnPgTool(tool, args, password);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      if (stdout.length < MAX_STDOUT) stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += data.toString();
    });
    child.on('error', (error) => {
      reject(new Error(`Failed to start ${tool}: ${error.message}`, { cause: error }));
    });
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** How many pg_dump / pg_restore processes of `kind` this server is running. */
export function runningPgTools(kind: PgToolKind = 'operation'): number {
  return running[kind].size;
}

/**
 * Signal every running pg_dump / pg_restore of `kinds` (and its process group): a backup's
 * or restore's unless said. Returns how many.
 */
export function terminatePgTools(signal: NodeJS.Signals = 'SIGTERM', kinds: readonly PgToolKind[] = ['operation']): number {
  let count = 0;
  for (const child of kinds.flatMap((kind) => [...running[kind]])) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, signal);
      count++;
    } catch {
      // Already gone.
    }
  }
  return count;
}
