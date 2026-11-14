import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from '../../db/schema.generated.js';
import { lastScheduledRun, listBackupRuns, recordBackupRun, recordVerify, VERIFY_OVERDUE_DAYS, type BackupRunRecord } from '../../services/backup/backupRuns.js';

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

/**
 * The record of backups (backup_runs): every run recorded, failures included, each verify
 * recorded against its file, and the Backup page's list and "no backup verified for 90 days".
 *
 * backup_runs and users are deployment-wide, and the list counts the whole table, so they are
 * copies in a schema of this file's own (search_path), never the shared ones.
 */
describeDb('backup runs', () => {
  const schema = `backup_runs_${randomBytes(4).toString('hex')}`;
  let owner: Pool;
  let pool: Pool;
  let db: Kysely<DB>;
  let admin: number;
  let noName: number;

  const run = (overrides: Partial<BackupRunRecord> = {}): BackupRunRecord => ({
    startedAt: new Date(Date.now() - 60_000),
    finishedAt: new Date(),
    trigger: 'scheduled',
    outcome: 'succeeded',
    message: null,
    fileName: `nuggets_backup_${randomBytes(4).toString('hex')}.tar.age`,
    fileSize: 1234,
    sha256: 'ab'.repeat(32),
    recipients: ['abcd efgh ijkl mnop'],
    startedBy: null,
    ...overrides,
  });

  beforeAll(async () => {
    owner = new Pool({ connectionString, max: 2 });
    await owner.query(`CREATE SCHEMA ${schema}`);
    await owner.query(`CREATE TABLE ${schema}.users (LIKE public.users INCLUDING ALL)`);
    await owner.query(`CREATE TABLE ${schema}.backup_runs (LIKE public.backup_runs INCLUDING ALL)`);
    pool = new Pool({ connectionString, max: 2, options: `-c search_path=${schema}` });
    db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    admin = (await owner.query<{ id: number }>(`INSERT INTO ${schema}.users (email, password_hash, first_name, last_name) VALUES ('ada@runs.test', 'x', 'Ada', 'Admin') RETURNING id`)).rows[0].id;
    noName = (await owner.query<{ id: number }>(`INSERT INTO ${schema}.users (email, password_hash) VALUES ('nameless@runs.test', 'x') RETURNING id`)).rows[0].id;
  });

  beforeEach(async () => {
    await owner.query(`DELETE FROM ${schema}.backup_runs`);
  });

  afterAll(async () => {
    await db?.destroy();
    await owner?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner?.end();
  });

  it('records each run, failures too, and lists the newest first with who started it', async () => {
    const older = run({ startedAt: new Date(Date.now() - 86_400_000), finishedAt: new Date(Date.now() - 86_000_000) });
    await recordBackupRun(db, older);
    await recordBackupRun(db, run({ trigger: 'manual', startedBy: admin }));
    await recordBackupRun(
      db,
      run({ trigger: 'before-deletion', startedBy: noName, outcome: 'failed', message: 'x'.repeat(3000), fileName: null, fileSize: null, sha256: null, recipients: [] })
    );

    const { runs } = await listBackupRuns(db);
    expect(runs.map((r) => [r.trigger, r.outcome, r.startedBy])).toEqual([
      ['before-deletion', 'failed', 'nameless@runs.test'],
      ['manual', 'succeeded', 'Ada Admin'],
      ['scheduled', 'succeeded', null],
    ]);
    // Clipped to what the column holds; the failure made no file.
    expect(runs[0]).toMatchObject({ fileName: null, fileSize: null, recipients: [] });
    expect(runs[0]!.message).toHaveLength(2000);
    expect(runs[2]).toMatchObject({
      fileName: older.fileName,
      fileSize: 1234,
      recipients: ['abcd efgh ijkl mnop'],
      startedAt: older.startedAt.toISOString(),
      finishedAt: older.finishedAt.toISOString(),
      verifiedAt: null,
      verifyOutcome: null,
    });
  });

  it('records a verify against its file, says who, and ignores a file it has no run of', async () => {
    const made = run();
    await recordBackupRun(db, made);
    expect(await recordVerify(db, { fileName: made.fileName!, verifiedBy: admin, outcome: 'passed', message: null })).toBe(true);
    expect(await recordVerify(db, { fileName: 'nuggets_backup_another_server.tar.age', verifiedBy: admin, outcome: 'passed', message: null })).toBe(false);
    let [listed] = (await listBackupRuns(db)).runs;
    expect(listed).toMatchObject({ verifyOutcome: 'passed', verifiedBy: 'Ada Admin', verifyMessage: null });
    expect(Date.now() - Date.parse(listed!.verifiedAt!)).toBeLessThan(60_000);

    // The restore command's: no one signed in. The last verify is what shows.
    await recordVerify(db, { fileName: made.fileName!, verifiedBy: null, outcome: 'failed', message: 'The backup is damaged' });
    [listed] = (await listBackupRuns(db)).runs;
    expect(listed).toMatchObject({ verifyOutcome: 'failed', verifiedBy: null, verifyMessage: 'The backup is damaged' });
  });

  it(`says when no backup has passed a verify for ${VERIFY_OVERDUE_DAYS} days, once backups have been made that long`, async () => {
    expect(await listBackupRuns(db)).toMatchObject({ runs: [], lastVerifiedAt: null, verifyOverdue: false });

    // A new server's first backups aren't overdue, verified or not.
    const made = run();
    await recordBackupRun(db, made);
    expect(await listBackupRuns(db)).toMatchObject({ lastVerifiedAt: null, verifyOverdue: false });
    // Backups made for longer than that, none verified: overdue. A failed run counts for nothing.
    await recordBackupRun(db, run({ outcome: 'failed', message: 'no key', fileName: null, fileSize: null, sha256: null, startedAt: new Date(Date.now() - 400 * 86_400_000) }));
    expect((await listBackupRuns(db)).verifyOverdue).toBe(false);
    await owner.query(`UPDATE ${schema}.backup_runs SET started_at = now() - make_interval(days => $1) WHERE file_name = $2`, [VERIFY_OVERDUE_DAYS + 1, made.fileName]);
    expect(await listBackupRuns(db)).toMatchObject({ lastVerifiedAt: null, verifyOverdue: true });

    // A failed verify isn't a verified backup.
    await recordVerify(db, { fileName: made.fileName!, verifiedBy: admin, outcome: 'failed', message: 'damaged' });
    expect(await listBackupRuns(db)).toMatchObject({ lastVerifiedAt: null, verifyOverdue: true });

    await recordVerify(db, { fileName: made.fileName!, verifiedBy: admin, outcome: 'passed', message: null });
    const passed = await listBackupRuns(db);
    expect(passed.verifyOverdue).toBe(false);
    expect(passed.lastVerifiedAt).toBe(passed.runs.find((r) => r.fileName === made.fileName)!.passedVerifyAt);

    // A failed verify after it leaves the pass: the backup was verified, and still counts.
    await recordVerify(db, { fileName: made.fileName!, verifiedBy: admin, outcome: 'failed', message: 'the server shut down' });
    const after = await listBackupRuns(db);
    expect(after.runs.find((r) => r.fileName === made.fileName)).toMatchObject({ verifyOutcome: 'failed', passedVerifyAt: passed.lastVerifiedAt });
    expect(after).toMatchObject({ lastVerifiedAt: passed.lastVerifiedAt, verifyOverdue: false });

    await owner.query(`UPDATE ${schema}.backup_runs SET passed_verify_at = now() - make_interval(days => $1) WHERE passed_verify_at IS NOT NULL`, [VERIFY_OVERDUE_DAYS - 1]);
    expect((await listBackupRuns(db)).verifyOverdue).toBe(false);
    await owner.query(`UPDATE ${schema}.backup_runs SET passed_verify_at = now() - make_interval(days => $1) WHERE passed_verify_at IS NOT NULL`, [VERIFY_OVERDUE_DAYS + 1]);
    expect((await listBackupRuns(db)).verifyOverdue).toBe(true);
  });

  it("gives the health check the newest scheduled run, a manual one aside", async () => {
    expect(await lastScheduledRun(db)).toBeNull();
    const failedAt = new Date(Date.now() - 3_600_000);
    await recordBackupRun(db, run({ startedAt: new Date(failedAt.getTime() - 60_000), finishedAt: failedAt, outcome: 'failed', message: 'no key', fileName: null }));
    await recordBackupRun(db, run({ trigger: 'manual', startedBy: admin }));
    expect(await lastScheduledRun(db)).toEqual({ startedAt: new Date(failedAt.getTime() - 60_000), finishedAt: failedAt, outcome: 'failed' });
  });
});
