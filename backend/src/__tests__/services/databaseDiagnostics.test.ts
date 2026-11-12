import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import {
  fileNamePart,
  migrationsListing,
  schemaDumpArgs,
  SchemaDumpError,
  streamSchemaDump,
  withoutSecret,
  stderrForLog,
  writePrivateFile,
  writeSchemaDump,
  type SchemaDumpOptions,
} from '../../services/databaseDiagnostics.js';
import { runningPgTools, terminatePgTools } from '../../utils/pgTools.js';

/**
 * Settings → Utilities' schema download without a database: a stand-in pg_dump
 * (PG_BIN_DIR) plays each way a dump can end, and a one-route app streams it.
 */

const PASSWORD = 'owner-password-Zq81';
const OPTIONS: SchemaDumpOptions = {
  location: { host: 'db.internal', port: 5432, database: 'nuggets_db' },
  credentials: { user: 'nuggets_owner', password: PASSWORD },
};

let bin: string;

/** A stand-in pg_dump: `script` is its shell body. */
async function standIn(script: string): Promise<void> {
  await writeFile(path.join(bin, 'pg_dump'), `#!/bin/sh\n${script}\n`);
  await chmod(path.join(bin, 'pg_dump'), 0o755);
}

/** An app whose one route streams the dump, recording how it ended. */
function app(options: Partial<SchemaDumpOptions> = {}, { delayMs = 0 } = {}) {
  const outcome: { error?: SchemaDumpError; bytes?: number } = {};
  let ended: () => void;
  const done = new Promise<void>((resolve) => (ended = resolve));
  const server = express();
  server.get('/schema', async (_req, res) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    streamSchemaDump(res, 'nuggets-schema-1.0.0-2026-11-03.sql', { ...OPTIONS, ...options })
      .then(({ bytes }) => (outcome.bytes = bytes))
      .catch((error: SchemaDumpError) => {
        outcome.error = error;
        if (!res.headersSent) res.status(500).json({ error: 'failed', code: 'SCHEMA_EXPORT_FAILED' });
      })
      .finally(() => ended());
  });
  return { server, outcome, done };
}

beforeAll(async () => {
  bin = await mkdtemp(path.join(os.tmpdir(), 'schema-dump-'));
});
afterAll(() => rm(bin, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

describe('streamSchemaDump', () => {
  it('streams what pg_dump writes as an attachment, after a header, with the password only in its environment', async () => {
    // Echo the arguments and whether PGPASSWORD arrived, never on the command line.
    await standIn(
      'echo "-- args: $*"; [ "$PGPASSWORD" = "' + PASSWORD + '" ] && echo "-- PGPASSWORD set"; echo "CREATE TABLE public.t (id integer);"'
    );
    vi.stubEnv('PG_BIN_DIR', bin);
    const { server, outcome, done } = app();
    const res = await request(server).get('/schema');
    await done;

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/sql; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="nuggets-schema-1.0.0-2026-11-03.sql"; filename*=UTF-8''nuggets-schema-1.0.0-2026-11-03.sql`
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toMatch(/^-- Nuggets database schema: pg_dump --schema-only, with no rows\.\n-- Nuggets /);
    expect(res.text).toContain('-- PGPASSWORD set');
    expect(res.text).toContain('CREATE TABLE public.t (id integer);');
    const args = /-- args: (.*)/.exec(res.text)![1];
    expect(args).not.toContain(PASSWORD);
    expect(args).toContain('--schema-only');
    expect(args).toContain('-U nuggets_owner');
    expect(outcome.error).toBeUndefined();
    expect(outcome.bytes).toBeGreaterThan(0);
    expect(runningPgTools('download')).toBe(0);
  });

  it('rejects before sending anything when pg_dump fails, with its stderr for the log and the password taken out', async () => {
    await standIn(`echo "pg_dump: error: connection to server failed: password=$PGPASSWORD FATAL: no such role" >&2; exit 1`);
    vi.stubEnv('PG_BIN_DIR', bin);
    const { server, outcome, done } = app();
    const res = await request(server).get('/schema');
    await done;

    expect(res.status).toBe(500);
    expect(res.text).not.toContain('FATAL');
    expect(outcome.error).toBeInstanceOf(SchemaDumpError);
    expect(outcome.error).toMatchObject({ reason: 'failed', afterOutput: false });
    expect(outcome.error!.message).toContain('exited with code 1');
    expect(outcome.error!.message).toContain('password=[REDACTED] FATAL: no such role');
    expect(outcome.error!.message).not.toContain(PASSWORD);
  });

  it('rejects when pg_dump is not there', async () => {
    vi.stubEnv('PG_BIN_DIR', path.join(bin, 'missing'));
    const { server, outcome, done } = app();
    const res = await request(server).get('/schema');
    await done;

    expect(res.status).toBe(500);
    expect(outcome.error).toMatchObject({ reason: 'failed', afterOutput: false });
    expect(outcome.error!.message).toMatch(/pg_dump could not start/);
  });

  it('treats a pg_dump that writes nothing as a failure', async () => {
    await standIn('exit 0');
    vi.stubEnv('PG_BIN_DIR', bin);
    const { server, outcome, done } = app();
    const res = await request(server).get('/schema');
    await done;

    expect(res.status).toBe(500);
    expect(outcome.error).toMatchObject({ reason: 'failed', afterOutput: false });
    expect(outcome.error!.message).toContain('wrote nothing');
  });

  it('stops pg_dump at the time limit', async () => {
    await standIn('exec sleep 30');
    vi.stubEnv('PG_BIN_DIR', bin);
    const { server, outcome, done } = app({ timeLimitMs: 300 });
    const started = Date.now();
    const res = await request(server).get('/schema');
    await done;

    expect(res.status).toBe(500);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome.error).toMatchObject({ reason: 'timeout', afterOutput: false });
    expect(outcome.error!.message).toContain('it took longer than 300 ms');
    await vi.waitFor(() => expect(runningPgTools('download')).toBe(0));
  });

  it('answers at the time limit even when pg_dump ignores SIGTERM, and kills it after the grace', async () => {
    await standIn("trap '' TERM; sleep 30");
    vi.stubEnv('PG_BIN_DIR', bin);
    const { server, outcome, done } = app({ timeLimitMs: 300, killGraceMs: 500 });
    const started = Date.now();
    const res = await request(server).get('/schema');
    await done;

    expect(res.status).toBe(500);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcome.error).toMatchObject({ reason: 'timeout', afterOutput: false });
    await vi.waitFor(() => expect(runningPgTools('download')).toBe(0), { timeout: 5_000 });
  });

  it('starts nothing for a client that left before the dump began', async () => {
    const marker = path.join(bin, 'started');
    await rm(marker, { force: true });
    await standIn(`touch ${marker}; echo "CREATE TABLE public.t (id integer);"`);
    vi.stubEnv('PG_BIN_DIR', bin);
    const { server, outcome, done } = app({}, { delayMs: 300 });
    const listening = http.createServer(server);
    await new Promise<void>((resolve) => listening.listen(0, resolve));
    try {
      const { port } = listening.address() as { port: number };
      const req = http.get({ port, path: '/schema' });
      req.on('error', () => {});
      setTimeout(() => req.destroy(), 50);
      await done;
      expect(outcome.error).toMatchObject({ reason: 'aborted', afterOutput: false });
      expect(outcome.error!.message).toContain('was not started');
      await expect(stat(marker)).rejects.toThrow();
      expect(runningPgTools('download')).toBe(0);
    } finally {
      await new Promise<void>((resolve) => listening.close(() => resolve()));
    }
  });

  it('kills the whole process group, even after its leader has exited', async () => {
    // The leader exits at once; a member of its group that ignores SIGTERM keeps its
    // output open, so the dump isn't over until that member is killed too.
    await standIn("trap '' TERM; sleep 30 & exit 0");
    vi.stubEnv('PG_BIN_DIR', bin);
    const { server, outcome, done } = app({ timeLimitMs: 300, killGraceMs: 300 });
    const res = await request(server).get('/schema');
    await done;

    expect(res.status).toBe(500);
    expect(outcome.error).toMatchObject({ reason: 'timeout' });
    await vi.waitFor(() => expect(runningPgTools('download')).toBe(0), { timeout: 5_000 });
  });

  it("isn't stopped by stopping a backup's or restore's tools", async () => {
    await standIn('sleep 0.5; echo "CREATE TABLE public.t (id integer);"');
    vi.stubEnv('PG_BIN_DIR', bin);
    const { server, outcome, done } = app();
    const pending = request(server).get('/schema').then((r) => r);
    await vi.waitFor(() => expect(runningPgTools('download')).toBe(1));
    expect(runningPgTools()).toBe(0);
    expect(terminatePgTools()).toBe(0);
    const res = await pending;
    await done;
    expect(res.status).toBe(200);
    expect(outcome.error).toBeUndefined();
  });

  it('cuts the connection at the size cap rather than end a cut-off file as if whole', async () => {
    // About 2 MB, more than the cap, then a line the client must never see.
    await standIn('i=0; while [ $i -lt 2000 ]; do head -c 1024 /dev/zero | tr "\\0" "x"; echo; i=$((i+1)); done; echo "-- THE END"');
    vi.stubEnv('PG_BIN_DIR', bin);
    const { server, outcome, done } = app({ maxBytes: 64 * 1024 });
    const res = await request(server).get('/schema').then(
      (r) => ({ aborted: false, text: r.text }),
      (err: Error) => ({ aborted: true, text: err.message })
    );
    await done;

    expect(res.aborted).toBe(true);
    expect(res.text).not.toContain('THE END');
    expect(outcome.error).toMatchObject({ reason: 'too-large', afterOutput: true });
    await vi.waitFor(() => expect(runningPgTools('download')).toBe(0));
  });

  it('cuts the connection when pg_dump fails after its output began', async () => {
    await standIn('echo "CREATE TABLE public.t (id integer);"; sleep 0.2; echo "pg_dump: error: lost the connection" >&2; exit 1');
    vi.stubEnv('PG_BIN_DIR', bin);
    const { server, outcome, done } = app();
    const res = await request(server).get('/schema').then(
      () => ({ aborted: false }),
      () => ({ aborted: true })
    );
    await done;

    expect(res.aborted).toBe(true);
    expect(outcome.error).toMatchObject({ reason: 'failed', afterOutput: true });
    expect(outcome.error!.message).toContain('lost the connection');
  });

  it('stops pg_dump when the client goes away', async () => {
    await standIn('echo "-- first"; exec sleep 30');
    vi.stubEnv('PG_BIN_DIR', bin);
    const { server, outcome, done } = app();
    const listening = http.createServer(server);
    await new Promise<void>((resolve) => listening.listen(0, resolve));
    try {
      const { port } = listening.address() as { port: number };
      await new Promise<void>((resolve) => {
        const req = http.get({ port, path: '/schema' }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', () => resolve());
      });
      await done;
      expect(outcome.error).toMatchObject({ reason: 'aborted' });
      await vi.waitFor(() => expect(runningPgTools('download')).toBe(0));
    } finally {
      await new Promise<void>((resolve) => listening.close(() => resolve()));
    }
  });
});

describe('writeSchemaDump (the migrate script\'s failure file)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'schema-file-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));
  afterEach(async () => {
    for (const name of await readdir(dir)) await rm(path.join(dir, name), { force: true });
  });

  it('writes the header and what pg_dump wrote, owner-only, with the password only in its environment', async () => {
    await standIn('echo "-- args: $*"; [ "$PGPASSWORD" = "' + PASSWORD + '" ] && echo "-- PGPASSWORD set"; echo "CREATE TABLE public.t (id integer);"');
    vi.stubEnv('PG_BIN_DIR', bin);
    const file = path.join(dir, 'schema.sql');
    const { bytes } = await writeSchemaDump(file, OPTIONS);

    const text = await readFile(file, 'utf8');
    expect(text.startsWith('-- Nuggets database schema: pg_dump --schema-only, with no rows.\n')).toBe(true);
    expect(text).toContain('-- args: -h db.internal -p 5432 -U nuggets_owner -d nuggets_db --schema-only');
    expect(text).toContain('-- PGPASSWORD set');
    expect(text).not.toContain(PASSWORD);
    expect(text.endsWith('CREATE TABLE public.t (id integer);\n')).toBe(true);
    expect(bytes).toBeGreaterThan(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['schema.sql']);
  });

  it('leaves the file there untouched, and nothing of its own, when pg_dump fails', async () => {
    await standIn('echo "CREATE TABLE public.half (id integer);"; echo "pg_dump: error: password=$PGPASSWORD" >&2; exit 1');
    vi.stubEnv('PG_BIN_DIR', bin);
    const file = path.join(dir, 'schema.sql');
    await writeFile(file, 'the earlier one');
    const error = await writeSchemaDump(file, OPTIONS).catch((err: SchemaDumpError) => err);

    expect(error).toBeInstanceOf(SchemaDumpError);
    expect(error).toMatchObject({ reason: 'failed' });
    expect((error as Error).message).toContain('exited with code 1');
    expect((error as Error).message).not.toContain(PASSWORD);
    expect(await readFile(file, 'utf8')).toBe('the earlier one');
    expect(await readdir(dir)).toEqual(['schema.sql']);
  });

  it('fails a pg_dump that writes nothing, or is not there', async () => {
    await standIn('exit 0');
    vi.stubEnv('PG_BIN_DIR', bin);
    await expect(writeSchemaDump(path.join(dir, 'schema.sql'), OPTIONS)).rejects.toThrow(/wrote nothing/);
    vi.stubEnv('PG_BIN_DIR', path.join(bin, 'nowhere'));
    await expect(writeSchemaDump(path.join(dir, 'schema.sql'), OPTIONS)).rejects.toThrow(/could not start/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('stops pg_dump at the size cap and at the time limit, even one that ignores SIGTERM', async () => {
    await standIn('yes "CREATE TABLE public.t (id integer);"');
    vi.stubEnv('PG_BIN_DIR', bin);
    await expect(writeSchemaDump(path.join(dir, 'schema.sql'), { ...OPTIONS, maxBytes: 64 * 1024 })).rejects.toMatchObject({ reason: 'too-large' });

    await standIn("trap '' TERM; sleep 30");
    const started = Date.now();
    await expect(writeSchemaDump(path.join(dir, 'schema.sql'), { ...OPTIONS, timeLimitMs: 300, killGraceMs: 300 })).rejects.toMatchObject({
      reason: 'timeout',
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(runningPgTools('download')).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('writePrivateFile', () => {
  it('replaces the file, or a link, owner-only, and never writes through the link', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'private-file-'));
    try {
      const elsewhere = path.join(dir, 'elsewhere.txt');
      await writeFile(elsewhere, 'not to be touched');
      await chmod(elsewhere, 0o644);
      const file = path.join(dir, 'report.txt');
      await symlink(elsewhere, file);
      await writePrivateFile(file, 'the report\n');

      expect(await readFile(file, 'utf8')).toBe('the report\n');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(elsewhere, 'utf8')).toBe('not to be touched');
      expect((await readdir(dir)).sort()).toEqual(['elsewhere.txt', 'report.txt']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('schemaDumpArgs', () => {
  it('dumps the schema only, without statistics, subscriptions or a password prompt', () => {
    const args = schemaDumpArgs({ host: 'h', port: 5433, database: 'd' }, 'u');
    expect(args.slice(0, 8)).toEqual(['-h', 'h', '-p', '5433', '-U', 'u', '-d', 'd']);
    expect(args).toEqual(expect.arrayContaining(['--schema-only', '--no-statistics', '--no-subscriptions', '--no-password']));
    expect(args.some((a) => a.startsWith('--lock-wait-timeout='))).toBe(true);
    expect(args).not.toEqual(expect.arrayContaining(['--data-only']));
  });
});

describe('fileNamePart', () => {
  it('keeps a version as it is, and turns anything else into a safe file name part', () => {
    expect(fileNamePart('1.0.0')).toBe('1.0.0');
    expect(fileNamePart('1.2.0-rc.1')).toBe('1.2.0-rc.1');
    expect(fileNamePart('main')).toBe('main');
    expect(fileNamePart('../../etc/passwd')).toBe('etc-passwd');
    expect(fileNamePart('a"b\r\nContent-Type: x')).toBe('a-b-Content-Type-x');
    expect(fileNamePart('')).toBe('unknown');
    expect(fileNamePart('///')).toBe('unknown');
    expect(fileNamePart('x'.repeat(100))).toHaveLength(40);
  });
});

describe('stderrForLog', () => {
  it('leaves out the password and every line that quotes a query, and keeps the error', () => {
    const stderr = [
      'pg_dump: error: query failed: ERROR:  column "x" does not exist in owner-password-Zq81',
      'LINE 1: SELECT x, y FROM pg_catalog.pg_class',
      '               ^',
      'QUERY:  SELECT secret_column FROM somewhere',
      'pg_dump: detail: Query was: SELECT a,',
      '  b FROM pg_catalog.pg_class',
      "  WHERE relname = 'x'",
      'pg_dump: hint: ask the owner',
      '',
    ].join('\n');
    const logged = stderrForLog(stderr, PASSWORD);
    expect(logged).toBe(
      [
        'pg_dump: error: query failed: ERROR:  column "x" does not exist in [REDACTED]',
        'pg_dump: detail: Query was: [left out]',
        'pg_dump: hint: ask the owner',
        '[other lines left out]',
      ].join('\n')
    );
    expect(logged).not.toMatch(/SELECT|pg_class|relname|secret_column/);
  });

  it("leaves out the query a single-row query's error quotes", () => {
    expect(stderrForLog("pg_dump: error: query returned 0 rows instead of one: SELECT rolname FROM pg_roles WHERE oid = '16384'\n", PASSWORD)).toBe(
      'pg_dump: error: query returned 0 rows instead of one: [query left out]'
    );
  });

  it('keeps a plain error as it is', () => {
    expect(stderrForLog('pg_dump: error: connection to server failed: FATAL:  no such role\n', PASSWORD)).toBe(
      'pg_dump: error: connection to server failed: FATAL:  no such role'
    );
  });
});

describe('stopSchemaDownloads (a shutdown)', () => {
  it('stops the dumps running, then starts none', async () => {
    // Its own copy of the module: once stopped, a module starts no dump again.
    vi.resetModules();
    const diagnostics = await import('../../services/databaseDiagnostics.js');
    const tools = await import('../../utils/pgTools.js');
    await standIn('echo "-- first"; exec sleep 30');
    vi.stubEnv('PG_BIN_DIR', bin);
    const outcomes: unknown[] = [];
    let first: express.Response | undefined;
    const server = express();
    server.get('/schema', (_req, res) => {
      first ??= res;
      diagnostics
        .streamSchemaDump(res, 'x.sql', OPTIONS)
        .catch((error: unknown) => {
          outcomes.push(error);
          if (!res.headersSent) res.status(503).end();
        });
    });
    const running = request(server).get('/schema').then(
      () => 'answered',
      () => 'cut'
    );
    // Once its output has begun.
    await vi.waitFor(() => expect(first?.headersSent).toBe(true));
    expect(tools.runningPgTools('download')).toBe(1);
    expect(diagnostics.stopSchemaDownloads()).toBe(1);
    expect(await running).toBe('cut');
    expect(outcomes[0]).toMatchObject({ reason: 'shutdown', afterOutput: true });
    await vi.waitFor(() => expect(tools.runningPgTools('download')).toBe(0));

    const later = await request(server).get('/schema');
    expect(later.status).toBe(503);
    expect(outcomes[1]).toMatchObject({ reason: 'shutdown', afterOutput: false });
    expect(tools.runningPgTools('download')).toBe(0);
  });
});

describe('withoutSecret', () => {
  it('takes out every copy of the secret, and leaves text alone without one', () => {
    expect(withoutSecret('a s3cr3t b s3cr3t', 's3cr3t')).toBe('a [REDACTED] b [REDACTED]');
    expect(withoutSecret('nothing here', '')).toBe('nothing here');
  });
});

describe('migrationsListing', () => {
  const NOW = new Date('2026-11-03T12:00:00.000Z');

  it('writes one INSERT per migration, oldest first as given, with every value quoted', () => {
    const text = migrationsListing(
      [
        { version: '20251024152915', name: 'initial schema', checksum: 'a'.repeat(64), applied_at: '2025-10-24 15:29:15.000000+00' },
        { version: '20261102200100', name: "it's \\ odd", checksum: 'b'.repeat(64), applied_at: '2026-11-03 04:34:02.094818+00' },
      ],
      NOW
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('-- Nuggets applied migrations: the rows of schema_migrations.');
    expect(lines[1]).toMatch(/^-- Nuggets .* exported 2026-11-03T12:00:00\.000Z\.$/);
    expect(text).toContain('-- Migrations applied: 2 (oldest 20251024152915, newest 20261102200100).');
    const inserts = lines.filter((l) => l.startsWith('INSERT'));
    expect(inserts).toEqual([
      `INSERT INTO public.schema_migrations (version, name, checksum, applied_at) VALUES ('20251024152915', 'initial schema', '${'a'.repeat(64)}', '2025-10-24 15:29:15.000000+00');`,
      `INSERT INTO public.schema_migrations (version, name, checksum, applied_at) VALUES ('20261102200100', E'it''s \\\\ odd', '${'b'.repeat(64)}', '2026-11-03 04:34:02.094818+00');`,
    ]);
    // Every line that isn't an INSERT is a comment or blank: nothing else runs.
    expect(lines.every((l) => l === '' || l.startsWith('-- ') || l === '--' || l.startsWith('INSERT INTO public.schema_migrations '))).toBe(true);
  });

  it('says so when the database has no schema_migrations table', () => {
    const text = migrationsListing(null, NOW);
    expect(text).toContain('-- This database has no schema_migrations table');
    expect(text).not.toContain('INSERT');
  });
});
