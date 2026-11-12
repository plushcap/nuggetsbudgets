import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import pino from 'pino';
import { Pool } from 'pg';

/**
 * A failed migration's report and log lines leave out a row's values: they
 * are meant to be posted on an issue, and an error's message can quote what it read. Real
 * failures, each in a database of its own, with migrate's log lines captured as pino would
 * write them:
 * - 22P02, a cast over a memo, whose message quotes the memo;
 * - 23505, a duplicate, whose message names the constraint and whose DETAIL has the key;
 * - P0001, a RAISE in a migration, with a quoted value, one in parentheses and a hint;
 * - SQLSTATEs with a letter in their class, which are database errors all the same: 2BP01
 *   (a DROP in dynamic SQL, the value in the SQL the context quotes) and 0A000 (a RAISE
 *   with that code, a DETAIL and a quoted value);
 * - classes whose message quotes what dynamic SQL named: 42P01 and 42601.
 */

const logged = vi.hoisted(() => [] as unknown[][]);
vi.mock('../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger.js')>();
  const record = (...args: unknown[]) => {
    logged.push(args);
  };
  const fake = { trace: record, debug: record, info: record, warn: record, error: record, fatal: record, child: () => fake };
  return { ...actual, createLogger: () => fake };
});

const { MigrationService } = await import('../services/MigrationService.js');
const { FAILURE_REPORT_FILE } = await import('../services/migrationFailureFiles.js');
const migrate = await import('../scripts/migrate.js');

const ownerUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = ownerUrl ? describe : describe.skip;

const MEMO = 'Rent to J. Smith, acct 12345';
const PAYEE = 'Acme Plumbing';
const SECRETS = ['Smith', '12345', 'Acme', 'Plumbing'];

/** The captured log lines as pino writes them: an Error through its err serializer. */
function asWritten(args: unknown[]): string {
  const serialize = (value: unknown): unknown => {
    if (value instanceof Error) return pino.stdSerializers.err(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, serialize(inner)]));
    }
    return value;
  };
  return JSON.stringify(args.map(serialize));
}

describeDb("a failed migration's report and log lines leave out a row's values", () => {
  const created: string[] = [];
  const pools: Pool[] = [];
  let admin: Pool;
  let fixtures: string;

  async function failing(sql: string) {
    const name = `nuggets_failvalues_test_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
    const url = new URL(ownerUrl!);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.toString(), max: 4 });
    pool.on('error', () => {});
    pool.on('connect', (client) => client.on('error', () => {}));
    pools.push(pool);
    const dir = mkdtempSync(path.join(fixtures, 'm-'));
    writeFileSync(path.join(dir, '20990101000100_fails.sql'), `${sql}\n-- === DOWN ===\nSELECT 1;\n`);
    const backups = mkdtempSync(path.join(fixtures, 'backups-'));
    const service = new MigrationService(pool, { migrationsDir: dir, standalone: true });
    const error = await service.migrate().then(() => null, (err: unknown) => err);
    await migrate.writeFailureFiles(service, error, {
      pool,
      dir: backups,
      location: { host: url.hostname, port: Number(url.port || 5432), database: name },
      credentials: { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) },
    });
    const report = await readFile(path.join(backups, FAILURE_REPORT_FILE), 'utf8');
    return { error: error as { code?: string; detail?: string; message?: string }, report, logs: logged.map(asWritten).join('\n') };
  }

  const expectNone = (where: string, written: string) => {
    for (const secret of SECRETS) expect(written, `${where} quotes "${secret}"`).not.toContain(secret);
  };

  beforeAll(() => {
    admin = new Pool({ connectionString: ownerUrl, max: 2 });
    fixtures = mkdtempSync(path.join(tmpdir(), 'nuggets-failvalues-'));
  });
  beforeEach(() => {
    logged.length = 0;
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    for (const name of created) {
      for (let i = 0; i < 200; i++) {
        const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [name]);
        if (rows[0].n === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    await admin?.end();
    rmSync(fixtures, { recursive: true, force: true });
  }, 60_000);

  it('22P02: a cast over a memo', async () => {
    const { error, report, logs } = await failing(
      `CREATE TABLE memos (memo text);\nINSERT INTO memos VALUES ('${MEMO}');\nALTER TABLE memos ALTER COLUMN memo TYPE integer USING memo::integer;`
    );
    expect(error).toMatchObject({ code: '22P02', message: `invalid input syntax for type integer: "${MEMO}"` });
    expect(report).toContain('Error code: 22P02 (SQLSTATE)');
    expect(report).toContain('Message:    invalid input syntax for type integer: "…"');
    expectNone('the report', report);
    expectNone('the log', logs);
    expect(logs).toContain('invalid input syntax for type integer: \\"…\\"');
    expect(migrate.migrationFailedLine(error)).toBe('Migration failed: 22P02: invalid input syntax for type integer: "…"');
  });

  it('23505: a duplicate key, its constraint named and its DETAIL left out', async () => {
    const { error, report, logs } = await failing(
      `CREATE TABLE payees (name text CONSTRAINT payees_name_key UNIQUE);\nINSERT INTO payees VALUES ('${PAYEE}');\nINSERT INTO payees VALUES ('${PAYEE}');`
    );
    expect(error).toMatchObject({ code: '23505', detail: `Key (name)=(${PAYEE}) already exists.` });
    expect(report).toContain('Message:    duplicate key value violates unique constraint "payees_name_key"');
    expect(report).toContain('Object:     schema public, table payees, constraint payees_name_key');
    expectNone('the report', report);
    expectNone('the log', logs);
    expect(logs).toContain('payees_name_key');
    expect(migrate.migrationFailedLine(error)).toBe('Migration failed: 23505: duplicate key value violates unique constraint "payees_name_key"');
  });

  it("P0001: a migration's RAISE, its quoted and parenthesized values and its hint", async () => {
    const { error, report, logs } = await failing(
      `DO $$ BEGIN\n  RAISE EXCEPTION 'payee "%" (account %) has no ledger', '${PAYEE}', 12345\n    USING HINT = 'Fix the payee ''${PAYEE}'' first';\nEND $$;`
    );
    expect(error).toMatchObject({ code: 'P0001', message: `payee "${PAYEE}" (account 12345) has no ledger` });
    expect(report).toContain('Message:    payee "…" (…) has no ledger');
    expect(report).toContain("Hint:       Fix the payee '…' first");
    expect(report).toContain('In:         PL/pgSQL function inline_code_block line 2 at RAISE');
    expectNone('the report', report);
    expectNone('the log', logs);
    expect(migrate.migrationFailedLine(error)).toBe('Migration failed: P0001: payee "…" (…) has no ledger');
  });

  it('2BP01: a DROP in dynamic SQL, the value only in the SQL its context quotes', async () => {
    const { error, report, logs } = await failing(
      `CREATE TABLE memos (memo text);\nCREATE VIEW memo_view AS SELECT * FROM memos;\nDO $$ BEGIN EXECUTE 'DROP TABLE memos /* ${MEMO} */'; END $$;`
    );
    expect(error).toMatchObject({ code: '2BP01', where: expect.stringContaining(MEMO) });
    expect(report).toContain('Error code: 2BP01 (SQLSTATE)');
    expect(report).toContain('Message:    cannot drop table memos because other objects depend on it');
    expect(report).toContain('In:         PL/pgSQL function inline_code_block line 1 at EXECUTE');
    expectNone('the report', report);
    expectNone('the log', logs);
    expect(logs).toContain('2BP01');
    expect(migrate.migrationFailedLine(error)).toBe('Migration failed: 2BP01: cannot drop table memos because other objects depend on it');
  });

  it('0A000: a RAISE with a lettered SQLSTATE, a DETAIL and a quoted value', async () => {
    const { error, report, logs } = await failing(
      `DO $$ BEGIN\n  RAISE EXCEPTION 'payee "%" (account %) is not supported', '${PAYEE}', 12345\n    USING ERRCODE = 'feature_not_supported', DETAIL = '${PAYEE}';\nEND $$;`
    );
    expect(error).toMatchObject({ code: '0A000', detail: PAYEE });
    expect(report).toContain('Error code: 0A000 (SQLSTATE)');
    expect(report).toContain('Message:    payee "…" (…) is not supported');
    expectNone('the report', report);
    expectNone('the log', logs);
    expect(migrate.migrationFailedLine(error)).toBe('Migration failed: 0A000: payee "…" (…) is not supported');
  });

  it('42P01 and 42601: what dynamic SQL named, quoted in the message', async () => {
    const missing = await failing(`DO $$ BEGIN EXECUTE 'SELECT * FROM "${MEMO}"'; END $$;`);
    expect(missing.error).toMatchObject({ code: '42P01', message: `relation "${MEMO}" does not exist` });
    expect(missing.report).toContain('Message:    relation "…" does not exist');
    expectNone('the report', missing.report);
    expectNone('the log', missing.logs);
    logged.length = 0;
    const syntax = await failing(`DO $$ BEGIN EXECUTE 'SELECT Smith 12345'; END $$;`);
    expect(syntax.error).toMatchObject({ code: '42601', message: 'syntax error at or near "12345"' });
    expect(syntax.report).toContain('Message:    syntax error at or near "…"');
    expect(syntax.report).not.toContain('12345');
    expect(syntax.logs).not.toContain('12345');
  });
});
