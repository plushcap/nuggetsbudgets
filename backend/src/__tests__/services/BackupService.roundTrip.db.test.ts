import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { Client, Pool, escapeIdentifier } from 'pg';
import {
  BackupService,
  BackupInProgressError,
  ForeignBackupError,
  RestoreFailedError,
  RESTORE_ROLE,
  RESTORE_ROLE_LOCK_KEY,
} from '../../services/BackupService.js';
import { MigrationService } from '../../services/MigrationService.js';
import { pgToolPath } from '../../utils/pgTools.js';
import { BASELINE } from '../../db/baseline.js';
import { V2_4_0_NEWEST_VERSION } from '../../db/v240Migrations.js';
import { loadV240Install, schemaSnapshot } from '../../test/schemaSnapshot.js';
import { EncryptionService } from '../../services/EncryptionService.js';
import { decryptBundle, parseSignerId, readAgeHeader } from '../../utils/backupFormat.js';
import { Decrypter, generateHybridIdentity, identityToRecipient } from 'age-encryption';

/**
 * Backups and restores, end to end against Postgres: make data, back it up,
 * change it, restore, and check it is back — through the real pg_dump and pg_restore.
 *
 * The restore replaces a whole database, so this file makes its own (the migration runner
 * loads init.sql and the migrations, as a fresh install does) and drops it, with what a restore keeps of it, after.
 * It needs pg_dump/pg_restore of the server's major version: PG_BIN_DIR, or on PATH. CI
 * installs them; elsewhere, without them, it is skipped (and says so).
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
  throw new Error(`The backup round trip needs pg_dump ${serverMajor ?? '?'} (found ${tools ?? 'none'}): set PG_BIN_DIR`);
}

describe.skipIf(!runnable)(`backup and restore round trip (pg_dump ${tools}, server ${serverMajor})`, () => {
  const url = new URL(ownerUrl ?? 'postgresql://x@localhost/x');
  const location = { host: url.hostname, port: Number(url.port || 5432), database: `nuggets_rt_${process.pid}_${randomBytes(3).toString('hex')}` };
  const owner = { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const serving = { user: process.env.DB_USER || 'nuggets_app', password: process.env.APP_DB_PASSWORD || '' };
  const migrationsDir = path.join(process.cwd(), 'migrations');
  let tmp: string;
  let dirs: { backupLocation: string; uploadsDir: string; tempDir: string };
  let servingPool: Pool;

  const ownerQuery = async <T extends object = Record<string, unknown>>(database: string, sql: string, params: unknown[] = []) => {
    const client = new Client({ ...location, database, ...owner });
    await client.connect();
    try {
      return (await client.query<T>(sql, params)).rows;
    } finally {
      await client.end();
    }
  };
  const live = (sql: string, params: unknown[] = []) => ownerQuery<Record<string, unknown>>(location.database, sql, params);
  /**
   * The serving role's privileges: on each table and view and on any single column, and who
   * besides its owner may run each SECURITY DEFINER function. A restore has none of the
   * archive's, so it must re-grant what the migrations give (deployment_users and
   * schema_migrations read-only, of the deployment row only the setup token writable, the
   * functions the serving role's only).
   */
  const servingGrants = async () =>
    (
      await live(
        `SELECT 'table ' || c.relname || ' ' || coalesce((
                  SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type)
                    FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                   WHERE a.grantee = $1::regrole), '-') AS grant
           FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
         UNION ALL
         SELECT 'column ' || c.relname || '.' || a.attname || ' ' || string_agg(x.privilege_type, ',' ORDER BY x.privilege_type)
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
          CROSS JOIN LATERAL aclexplode(a.attacl) x
          WHERE c.relnamespace = 'public'::regnamespace AND x.grantee = $1::regrole
          GROUP BY c.relname, a.attname
         UNION ALL
         SELECT 'definer ' || p.proname || ' ' || coalesce((
                  SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END, ',' ORDER BY 1)
                    FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner), '-')
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
          ORDER BY 1`,
        [serving.user]
      )
    ).map((r) => r.grant as string);
  const tagNames = async () => (await live('SELECT name FROM tags WHERE tenant_id = 1 ORDER BY name')).map((r) => r.name);
  const databases = async () =>
    (await ownerQuery<{ datname: string }>('postgres', 'SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY 1', [`${location.database}%`])).map(
      (r) => r.datname
    );

  async function useDataKey(name: string): Promise<void> {
    const file = path.join(tmp, `${name}.key`);
    await writeFile(file, `data-encryption-secret-for-${name}-${'x'.repeat(32)}`);
    vi.stubEnv('DATA_ENCRYPTION_KEY_FILE', file);
  }

  /**
   * Whether RESTORE_ROLE can log in, read while no restore uses it: the role is the whole
   * cluster's, and another file's restore (ApplicationLifecycleService.restoreShutdown)
   * may be running. A restore holds RESTORE_ROLE_LOCK_KEY for as long as the role can log in.
   */
  const restoreRole = async () => {
    const client = new Client({ ...location, database: 'postgres', ...owner });
    await client.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [RESTORE_ROLE_LOCK_KEY]);
      return (await client.query<{ rolcanlogin: boolean }>('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [RESTORE_ROLE])).rows[0];
    } finally {
      await client.end();
    }
  };

  /** A BackupService on the test database; a new one reads the data key afresh. */
  const service = () => new BackupService(servingPool, { location, owner, serving, migrationsDir, ...dirs });

  /** The test's backup key: an age key pair made at run time (none is committed). */
  let identity: string;
  const addTestRecipient = async (backups: BackupService) =>
    backups.addRecipient({ recipient: await identityToRecipient(identity), label: 'test key', checked: true, createdBy: null });
  /** What the browser does: open the backup's header with the private key, and keep only the file key. */
  const fileKeyOf = async (file: string) => {
    const opener = new Decrypter();
    opener.addIdentity(identity);
    return Buffer.from(await opener.decryptHeader(await readAgeHeader(file)));
  };
  /** The old backup key K, as an install from before age backups has it. */
  const seedLegacyKey = async (backups: BackupService) => {
    const key = randomBytes(32).toString('base64');
    await backups.saveBackupSetting('backup_data_key', await new EncryptionService().encryptString(key));
    await backups.saveBackupSetting('backup_key_downloaded', 'false');
    return key;
  };

  beforeAll(async () => {
    identity = await generateHybridIdentity();
    tmp = await mkdtemp(path.join(os.tmpdir(), 'backup-round-trip-'));
    dirs = { backupLocation: path.join(tmp, 'backups'), uploadsDir: path.join(tmp, 'uploads'), tempDir: path.join(tmp, 'temp') };
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });

    // The test database, as a fresh install builds one: the runner loads init.sql into the
    // empty database, then applies the migrations.
    await ownerQuery('postgres', `CREATE DATABASE ${escapeIdentifier(location.database)}`);
    const migrationPool = new Pool({ ...location, ...owner, max: 2 });
    try {
      await new MigrationService(migrationPool, { migrationsDir, baselinePath: path.join(process.cwd(), 'init.sql') }).migrate();
    } finally {
      await migrationPool.end();
    }

    servingPool = new Pool({ ...location, ...serving, max: 4 });
    // A restore ends every session on the database it replaces, this pool's idle ones too.
    servingPool.on('error', () => {});
  }, 240_000);

  afterAll(async () => {
    await servingPool?.end().catch(() => {});
    for (const name of await databases().catch(() => [] as string[])) {
      await ownerQuery('postgres', `DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`).catch(() => {});
    }
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('refuses a backup before a backup key exists', async () => {
    await useDataKey('server-a');
    await expect(service().createBackup()).rejects.toThrow(/No backup key has been set up/);
  });

  it('brings the data and the upload files back, and refuses what it must', async () => {
    await useDataKey('server-a');
    const backups = service();
    await addTestRecipient(backups);

    // The data at backup time.
    await live("INSERT INTO tags (tenant_id, name) VALUES (1, 'kept-by-backup'), (1, 'changed-later')");
    await live("INSERT INTO stored_images (tenant_id, mime_type, byte_size, data) VALUES (1, 'image/png', 3, '\\x010203')");
    await mkdir(path.join(dirs.uploadsDir, 'statements'), { recursive: true });
    await writeFile(path.join(dirs.uploadsDir, 'statements', 'march.pdf'), 'march statement');
    const checksum = async () =>
      (await live("SELECT md5(string_agg(name || ':' || uuid, ',' ORDER BY id)) AS sum FROM tags WHERE tenant_id = 1"))[0].sum;
    const before = { tags: await tagNames(), checksum: await checksum(), grants: await servingGrants() };
    expect(before.grants).toContain('table deployment_users SELECT');
    expect(before.grants).toContain('table schema_migrations SELECT');
    expect(before.grants).toContain('table deployment SELECT');
    expect(before.grants).toContain('column deployment.setup_token_hash UPDATE');
    expect(before.grants).toContain('table tags DELETE,INSERT,SELECT,UPDATE');
    expect(before.grants).toContain(`definer revoke_deployment_admin ${serving.user}`);

    const backup = await backups.createBackup();
    expect(backup.fileName).toMatch(/^nuggets_backup_\d{8}_\d{6}_\d{3}\.tar\.age$/);
    const bytes = await readFile(backup.filePath);
    // age, not the dump or any of its data in the clear.
    expect(bytes.subarray(0, 21).toString('latin1')).toBe('age-encryption.org/v1');
    expect(bytes.includes(Buffer.from('PGDMP'))).toBe(false);
    expect(bytes.includes(Buffer.from('kept-by-backup'))).toBe(false);
    expect(bytes.includes(Buffer.from('march statement'))).toBe(false);
    expect(backup.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Nothing left in the clear in temp, and no partial file.
    expect(await readdir(dirs.tempDir)).toEqual([]);
    expect(await readdir(dirs.backupLocation)).toEqual([backup.fileName]);
    const fileKey = await fileKeyOf(backup.filePath);

    // A wrong file key, and none: refused, clearly, with nothing changed.
    const wrong = backups.restoreFromFile(backup.filePath, { fileKey: randomBytes(16) });
    await expect(wrong).rejects.toBeInstanceOf(RestoreFailedError);
    await expect(wrong).rejects.toMatchObject({ databaseChanged: false, message: expect.stringMatching(/doesn't open this backup/) });
    await expect(backups.restoreBackup(backup.filePath)).rejects.toMatchObject({ databaseChanged: false, message: expect.stringMatching(/encrypted with age/) });
    expect(await tagNames()).toEqual(before.tags);
    expect(await databases()).toEqual([location.database]);

    // The data changes after the backup.
    await live("DELETE FROM tags WHERE name = 'changed-later'");
    await live("INSERT INTO tags (tenant_id, name) VALUES (1, 'made-after-backup')");
    await live('DELETE FROM stored_images');
    await writeFile(path.join(dirs.uploadsDir, 'statements', 'march.pdf'), 'overwritten');
    await writeFile(path.join(dirs.uploadsDir, 'after-backup.pdf'), 'new file');

    // While one restore runs, neither a second one nor a backup starts.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const phases: string[] = [];
    const restoring = backups.restoreFromFile(backup.filePath, {
      fileKey,
      fileName: backup.fileName,
      onPhase: (phase) => phases.push(phase),
      beforeSwap: () => gate,
    });
    await vi.waitFor(() => expect(phases).toContain('verifying'), { timeout: 120_000, interval: 100 });
    await expect(service().restoreFromFile(backup.filePath, { fileKey })).rejects.toBeInstanceOf(BackupInProgressError);
    await expect(service().createBackup()).rejects.toBeInstanceOf(BackupInProgressError);
    // Nothing is replaced until every check has passed: the data is still the changed one.
    expect(await tagNames()).toContain('made-after-backup');
    release();
    const result = await restoring;

    expect(result).toMatchObject({ format: 'age', signature: 'valid', signer: await backups.signerPublicId() });
    expect(result.manifest).toMatchObject({ manifestVersion: 4, backupId: backup.fileName.replace(/\.tar\.age$/, '') });
    // A backup at the baseline: no cutover.
    expect(result.cutover).toBeNull();
    expect(result.previousDatabase).toBe(`${location.database}_before_restore`);
    expect(phases).toEqual(['decrypting', 'checking', 'restoring', 'migrating', 'verifying', 'swapping', 'restoring-uploads']);
    expect(await tagNames()).toEqual(before.tags);
    expect(await checksum()).toBe(before.checksum);
    expect(await live('SELECT byte_size, data FROM stored_images')).toEqual([{ byte_size: 3, data: Buffer.from([1, 2, 3]) }]);
    expect(result.rowCounts).toMatchObject({ tenants: 1, stored_images: 1 });
    expect(await readFile(path.join(dirs.uploadsDir, 'statements', 'march.pdf'), 'utf8')).toBe('march statement');
    expect(await readdir(dirs.uploadsDir)).toEqual(['statements']);
    // What it replaced is kept: the database under its new name, the files in temp.
    expect((await ownerQuery<{ name: string }>(result.previousDatabase!, 'SELECT name FROM tags WHERE tenant_id = 1 ORDER BY name')).map((r) => r.name)).toContain(
      'made-after-backup'
    );
    expect(await readFile(path.join(result.previousUploads!, 'after-backup.pdf'), 'utf8')).toBe('new file');
    expect(await databases()).toEqual([location.database, `${location.database}_before_restore`].sort());

    // The restored database is what migrations make: owned by the owner, isolation intact,
    // the database-level UTC setting there, and the serving role working under RLS.
    expect(await live("SELECT count(*)::int AS n FROM pg_class WHERE relowner = $1::regrole AND relnamespace = 'public'::regnamespace", [RESTORE_ROLE])).toEqual([{ n: 0 }]);
    expect(await live("SELECT relforcerowsecurity FROM pg_class WHERE relname = 'tags'")).toEqual([{ relforcerowsecurity: true }]);
    expect(await servingGrants()).toEqual(before.grants);
    expect(
      await live('SELECT unnest(setconfig) AS setting FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())')
    ).toContainEqual({ setting: 'TimeZone=UTC' });
    const app = await servingPool.connect();
    try {
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.current_tenant_id', '1', true)");
      expect((await app.query('SELECT name FROM tags ORDER BY name')).rows.map((r) => r.name)).toEqual(before.tags);
      await app.query('ROLLBACK');
      await expect(app.query('SELECT count(*) FROM tags')).rejects.toThrow(/no tenant is set/);
      // An organization's own tables too (organization RLS).
      await expect(app.query('SELECT count(*) FROM organization_price_sync_runs')).rejects.toThrow(/no organization is set/);
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.current_organization_id', '1', true)");
      expect((await app.query('SELECT count(*)::int AS n FROM organization_price_sync_runs')).rows).toEqual([{ n: 0 }]);
      await app.query('ROLLBACK');
    } finally {
      app.release();
    }
    expect(await restoreRole()).toEqual({ rolcanlogin: false });
    expect(await readdir(dirs.tempDir)).toEqual(['before-restore']);
  }, 300_000);

  it("restores another server's backup only when allowed to (the restore command)", async () => {
    await useDataKey('server-a');
    const backups = service();
    const backup = await backups.createBackup();
    const fileKey = await fileKeyOf(backup.filePath);
    const signerA = (await backups.signerPublicId())!;
    expect(signerA).toMatch(/^ed25519:[A-Za-z0-9_-]{43}$/);
    await live("INSERT INTO tags (tenant_id, name) VALUES (1, 'only-on-server-b')");

    // Server B: another data encryption key, so the signature isn't its own.
    await useDataKey('server-b');
    expect(await service().signerPublicId()).not.toBe(signerA);
    const refused = service().restoreFromFile(backup.filePath, { fileKey });
    await expect(refused).rejects.toMatchObject({ databaseChanged: false, cause: expect.any(ForeignBackupError) });
    await expect(refused).rejects.toMatchObject({ cause: { signer: signerA, message: expect.stringContaining(`--signer ${signerA}`) } });
    expect(await tagNames()).toContain('only-on-server-b');

    const result = await service().restoreFromFile(backup.filePath, { fileKey, allowForeign: true, verifyOnly: true });
    expect(result).toMatchObject({ signature: 'invalid', signer: signerA });
    // The restore command's --signer trusts that one signer, and no other.
    const trusted = await service().restoreFromFile(backup.filePath, { fileKey, signers: [parseSignerId(signerA)!], verifyOnly: true });
    expect(trusted.signature).toBe('valid');
    expect(await tagNames()).toContain('only-on-server-b');
    expect(await databases()).toEqual([location.database, `${location.database}_before_restore`].sort());

    await service().restoreFromFile(backup.filePath, { fileKey, allowForeign: true });
    expect(await tagNames()).not.toContain('only-on-server-b');
  }, 300_000);

  it('opens a backup with the private key, or decrypted by its owner, and refuses one renamed as another', async () => {
    await useDataKey('server-a');
    const backups = service();
    const backup = await backups.createBackup();

    // The restore command's --identity-file, and --decrypted (a bundle age -d made).
    await expect(backups.restoreFromFile(backup.filePath, { identities: [identity], verifyOnly: true })).resolves.toMatchObject({ signature: 'valid' });
    const tar = path.join(tmp, 'decrypted.tar');
    await rm(tar, { force: true });
    await decryptBundle(backup.filePath, { identities: [identity] }, tar);
    await expect(backups.restoreFromFile(tar, { decrypted: true, verifyOnly: true })).resolves.toMatchObject({ format: 'age', signature: 'valid' });
    await expect(backups.restoreFromFile(backup.filePath, { decrypted: true, verifyOnly: true })).rejects.toMatchObject({
      message: expect.stringMatching(/still encrypted/),
    });

    // Copied under an older backup's name: its signed id says which backup it is.
    const renamed = path.join(tmp, 'nuggets_backup_20250101_000000_000.tar.age');
    await copyFile(backup.filePath, renamed);
    const fileKey = await fileKeyOf(renamed);
    await expect(backups.restoreFromFile(renamed, { fileKey, fileName: path.basename(renamed), verifyOnly: true })).rejects.toMatchObject({
      databaseChanged: false,
      message: expect.stringMatching(/named as backup nuggets_backup_20250101_000000_000, but it is backup nuggets_backup_/),
    });
    // Without the milliseconds the name still says when it was made, and is checked too.
    const short = path.join(tmp, 'nuggets_backup_20250101_000000.tar.age');
    await copyFile(backup.filePath, short);
    await expect(backups.restoreFromFile(short, { fileKey, fileName: path.basename(short), verifyOnly: true })).rejects.toMatchObject({
      message: expect.stringMatching(/named as backup nuggets_backup_20250101_000000, but it is backup/),
    });
    // Its own time, without the milliseconds: the same backup.
    const own = path.join(tmp, `${backup.fileName.replace(/_\d{3}\.tar\.age$/, '')}.tar.age`);
    await copyFile(backup.filePath, own);
    await expect(backups.restoreFromFile(own, { fileKey, fileName: path.basename(own), verifyOnly: true })).resolves.toMatchObject({ signature: 'valid' });
    // Near misses of a backup's name are read as one too: they'd be taken for that backup.
    for (const near of ['Nuggets_backup_20250101_000000_000.tar.age', 'nuggets_backup_20250101_000000_000.age', 'nuggets_backup_20250101_000000_000 .tar.age']) {
      const copy = path.join(tmp, near);
      await copyFile(backup.filePath, copy);
      await expect(backups.restoreFromFile(copy, { fileKey, fileName: near, verifyOnly: true }), near).rejects.toMatchObject({
        message: expect.stringMatching(/it was renamed/),
      });
    }
    // A name that isn't a backup's says nothing about which it is.
    await expect(backups.restoreFromFile(renamed, { fileKey, fileName: 'copied-from-the-nas.tar.age', verifyOnly: true })).resolves.toMatchObject({
      signature: 'valid',
    });

    // A verify is an operation of its own: no restore, so no maintenance mode, but no backup meanwhile.
    const phases: string[] = [];
    const verifying = backups.restoreFromFile(backup.filePath, { fileKey: await fileKeyOf(backup.filePath), verifyOnly: true, onPhase: (p) => phases.push(p) });
    await vi.waitFor(() => expect(phases).toContain('restoring'), { timeout: 120_000, interval: 50 });
    expect(BackupService.isVerifyInProgress()).toBe(true);
    expect(BackupService.isRestoreInProgress()).toBe(false);
    await expect(service().createBackup()).rejects.toMatchObject({ heldBy: 'verify' });
    await verifying;
    expect(BackupService.isVerifyInProgress()).toBe(false);
  }, 300_000);

  it('still restores an .enc backup made with the old key, which it makes until a backup key is set up', async () => {
    await useDataKey('server-a');
    const backups = service();
    for (const recipient of await backups.listRecipients()) await backups.removeRecipient(recipient.uuid);
    const key = await seedLegacyKey(backups);
    const backup = await backups.createBackup();
    expect(backup.fileName).toMatch(/\.enc$/);
    expect((await readFile(backup.filePath))[0]).toBe(0x03);

    await expect(backups.restoreBackupWithCustomKey(backup.filePath, randomBytes(32).toString('base64'))).rejects.toMatchObject({
      databaseChanged: false,
      message: expect.stringMatching(/Invalid encryption key/),
    });
    await live("INSERT INTO tags (tenant_id, name) VALUES (1, 'after-the-enc-backup')");
    // With the key typed, or the server's own.
    await expect(backups.restoreBackup(backup.filePath, { verifyOnly: true })).resolves.toMatchObject({ format: 'legacy', signature: 'valid', signer: null });
    await expect(backups.restoreFromFile(backup.filePath, { key })).resolves.toMatchObject({ format: 'legacy', signature: 'valid' });
    expect(await tagNames()).not.toContain('after-the-enc-backup');

    // A backup key again: age from now on.
    await addTestRecipient(backups);
    expect((await backups.createBackup()).fileName).toMatch(/\.tar\.age$/);
  }, 300_000);

  it('refuses restored data whose row-level security differs, and changes nothing', async () => {
    await useDataKey('server-a');
    const backups = service();
    const backup = await backups.createBackup();
    // This server's database no longer has the policy the backup's migrations give tags:
    // the restored data's isolation differs from it, so the restore must refuse.
    const [{ policy }] = (await live("SELECT policyname AS policy FROM pg_policies WHERE tablename = 'tags'")) as Array<{ policy: string }>;
    await live(`ALTER POLICY ${escapeIdentifier(policy)} ON tags RENAME TO renamed_policy`);
    await live("INSERT INTO tags (tenant_id, name) VALUES (1, 'still-here')");
    try {
      const refused = backups.restoreFromFile(backup.filePath, { fileKey: await fileKeyOf(backup.filePath) });
      await expect(refused).rejects.toMatchObject({
        databaseChanged: false,
        message: expect.stringMatching(/row-level security differs.*renamed_policy/),
      });
      expect(await tagNames()).toContain('still-here');
      expect(await databases()).toEqual([location.database, `${location.database}_before_restore`].sort());
    } finally {
      await live(`ALTER POLICY renamed_policy ON tags RENAME TO ${escapeIdentifier(policy)}`);
    }
    // And an organization table's: the restored data forces RLS on it, this server's
    // database doesn't.
    await live('ALTER TABLE organization_price_sync_runs NO FORCE ROW LEVEL SECURITY');
    try {
      await expect(backups.restoreFromFile(backup.filePath, { fileKey: await fileKeyOf(backup.filePath) })).rejects.toMatchObject({
        databaseChanged: false,
        message: expect.stringMatching(/row-level security differs.*rls organization_price_sync_runs/),
      });
      expect(await tagNames()).toContain('still-here');
    } finally {
      await live('ALTER TABLE organization_price_sync_runs FORCE ROW LEVEL SECURITY');
    }
  }, 300_000);

  it('puts the database back when the upload files fail, and leaves nothing behind', async () => {
    await useDataKey('server-a');
    const backups = service();
    const backup = await backups.createBackup();
    await live("INSERT INTO tags (tenant_id, name) VALUES (1, 'survives-failed-restore')");
    await writeFile(path.join(dirs.uploadsDir, 'current.pdf'), 'current');
    const replaceUploads = vi
      .spyOn(backups as unknown as { replaceUploads: (from: string) => Promise<unknown> }, 'replaceUploads')
      .mockRejectedValue(new Error('disk full'));

    await expect(backups.restoreFromFile(backup.filePath, { fileKey: await fileKeyOf(backup.filePath) })).rejects.toMatchObject({
      databaseChanged: false,
      message: expect.stringMatching(/uploads failed, so the database was put back/),
    });
    expect(replaceUploads).toHaveBeenCalledOnce();
    expect(await tagNames()).toContain('survives-failed-restore');
    expect(await readFile(path.join(dirs.uploadsDir, 'current.pdf'), 'utf8')).toBe('current');
    // The scratch database is gone; so is the copy the restore before kept, which this one
    // replaced when it swapped its data in, before the uploads failed.
    expect(await databases()).toEqual([location.database]);
  }, 300_000);

  it('drops the scratch database when pg_restore fails part-way', async () => {
    await useDataKey('server-a');
    const backups = service();
    const backup = await backups.createBackup();
    const real = (backups as unknown as { pgRestoreAsRestoreRole: (...args: string[]) => Promise<void> }).pgRestoreAsRestoreRole.bind(backups);
    vi.spyOn(backups as unknown as { pgRestoreAsRestoreRole: (...args: string[]) => Promise<void> }, 'pgRestoreAsRestoreRole').mockImplementation(
      async (...args: string[]) => {
        await real(...args);
        throw new Error('pg_restore failed with signal SIGTERM');
      }
    );
    await expect(backups.restoreFromFile(backup.filePath, { fileKey: await fileKeyOf(backup.filePath) })).rejects.toMatchObject({ databaseChanged: false });
    expect(await tagNames()).toContain('survives-failed-restore');
    expect(await databases()).toEqual([location.database]);
    expect(await restoreRole()).toEqual({ rolcanlogin: false });
  }, 300_000);

  it('refuses an archive with objects a Nuggets backup has no business holding', async () => {
    // A dump of a database with another schema, a rule and an event trigger.
    const evil = `${location.database}_evil`;
    await ownerQuery('postgres', `CREATE DATABASE ${escapeIdentifier(evil)}`);
    try {
      await ownerQuery(
        evil,
        `CREATE SCHEMA other; CREATE TABLE other.t (id int);
         CREATE TABLE public.t (id int); CREATE RULE r AS ON INSERT TO public.t DO INSTEAD NOTHING;
         CREATE FUNCTION public.f() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN END$$;
         CREATE EVENT TRIGGER e ON ddl_command_start EXECUTE FUNCTION public.f();`
      );
      const dump = path.join(tmp, 'evil.dump');
      execFileSync(pgToolPath('pg_dump'), ['-h', location.host, '-p', String(location.port), '-U', owner.user, '-d', evil, '--format=custom', '--file', dump], {
        env: { ...process.env, PGPASSWORD: owner.password },
      });
      const check = (service() as unknown as { assertArchiveContents: (file: string) => Promise<void> }).assertArchiveContents(dump);
      await expect(check).rejects.toThrow(/objects a Nuggets backup doesn't \(\d+\): .*(SCHEMA|RULE|EVENT TRIGGER)/);
    } finally {
      await ownerQuery('postgres', `DROP DATABASE IF EXISTS ${escapeIdentifier(evil)} WITH (FORCE)`);
    }
  }, 120_000);

  // pg_restore --no-privileges leaves each function runnable by PUBLIC, its default. The
  // two-role restore above takes that back with the serving role's grants; a single-role
  // setup (the owner serves) and one with no serving role skipped those, leaving the
  // SECURITY DEFINER functions any role could run.
  it('takes PUBLIC off the SECURITY DEFINER functions after a restore in a single-role setup too', async () => {
    const definers = async () => (await servingGrants()).filter((grant) => grant.startsWith('definer '));
    const expected = await definers();
    expect(expected.length).toBeGreaterThan(0);
    for (const grant of expected) expect(grant).not.toMatch(/PUBLIC/);
    const reapply = (as: { user: string; password: string }) =>
      (new BackupService(servingPool, { location, owner, serving: as, migrationsDir, ...dirs }) as unknown as {
        reapplyServingRoleGrants: (database: string) => Promise<void>;
      }).reapplyServingRoleGrants(location.database);
    const publicMayRun = async () => {
      // As a restore leaves them: each function with its default privileges back.
      const functions = await live("SELECT p.oid::regprocedure::text AS signature FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef");
      for (const { signature } of functions) await live(`GRANT EXECUTE ON FUNCTION ${signature as string} TO PUBLIC`);
      expect((await definers()).every((grant) => grant.includes('PUBLIC'))).toBe(true);
    };

    for (const as of [owner, { user: 'nuggets_no_such_serving_role', password: '' }]) {
      await publicMayRun();
      await reapply(as);
      expect(await definers(), as.user).toEqual(expected);
    }
  }, 60_000);

  it('sweeps what an interrupted backup or restore left behind', async () => {
    await mkdir(path.join(dirs.tempDir, 'nuggets_backup_20260101_000000_000'), { recursive: true });
    await writeFile(path.join(dirs.tempDir, 'nuggets_backup_20260101_000000_000', 'x.dump'), 'plaintext');
    await mkdir(path.join(dirs.tempDir, 'uploads'), { recursive: true });
    await writeFile(path.join(dirs.tempDir, 'uploads', 'abc123'), 'uploaded backup');
    const leftover = `${location.database}_restore_20260101000000000`;
    await ownerQuery('postgres', `CREATE DATABASE ${escapeIdentifier(leftover)}`);

    await service().sweepLeftovers();
    expect((await readdir(dirs.tempDir)).sort()).toEqual(['before-restore', 'uploads']);
    expect(await readdir(path.join(dirs.tempDir, 'uploads'))).toEqual([]);
    expect(await databases()).toEqual([location.database]);
  }, 60_000);

  // Last: it leaves the test database holding the v2.4.0 install's data.
  it("restores a v2.4.0 backup, which the migrate after the restore cuts over to the baseline", async () => {
    await useDataKey('server-a');
    const snapshot = async () => {
      const pool = new Pool({ ...location, ...owner, max: 1 });
      try {
        return await schemaSnapshot(pool);
      } finally {
        await pool.end();
      }
    };
    // The baseline's schema, as the runner made this database.
    const baselineSchema = await snapshot();
    // The baseline's row, and a row for each migration newer than it.
    const rowsBefore = await live('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    expect(rowsBefore[0]).toEqual({ version: BASELINE.version, name: BASELINE.name, checksum: BASELINE.checksum });

    // A v2.4.0 install with a tag of its own, and a backup made on it.
    const v240 = { ...location, database: `${location.database}_v240` };
    await ownerQuery('postgres', `CREATE DATABASE ${escapeIdentifier(v240.database)}`);
    const v240Url = new URL(ownerUrl!);
    v240Url.pathname = `/${v240.database}`;
    try {
      await loadV240Install(v240Url.toString());
      await ownerQuery(v240.database, "INSERT INTO tags (tenant_id, name) VALUES (1, 'kept-from-v2.4.0')");
      // What its backup's manifest records as its schema version.
      expect(await ownerQuery(v240.database, 'SELECT max(version) AS version FROM schema_migrations')).toEqual([{ version: V2_4_0_NEWEST_VERSION }]);
      const v240Serving = new Pool({ ...v240, ...serving, max: 2 });
      v240Serving.on('error', () => {});
      let backup: { filePath: string };
      let key: string;
      try {
        // v2.4.0 made .enc backups with its backup key K, and has no backup_recipients table.
        const onV240 = new BackupService(v240Serving, { location: v240, owner, serving, migrationsDir, ...dirs });
        vi.spyOn(onV240, 'listRecipients').mockResolvedValue([]);
        key = await seedLegacyKey(onV240);
        backup = await onV240.createBackup();
      } finally {
        await v240Serving.end();
      }

      const phases: string[] = [];
      const restored = await service().restoreFromFile(backup.filePath, { key, allowForeign: true, onPhase: (phase) => phases.push(phase) });
      // Cut over, and compared with a fresh baseline: nothing differs (the restore command prints it).
      expect(restored.cutover).toEqual({ drift: { missing: [], extra: [], changed: [] } });
      expect(phases).toContain('migrating');
    } finally {
      await ownerQuery('postgres', `DROP DATABASE IF EXISTS ${escapeIdentifier(v240.database)} WITH (FORCE)`);
    }

    // Its data, on the baseline's schema: v2.4.0's 161 rows are the baseline's one (and the
    // migrations newer than it are applied, as here).
    expect(await tagNames()).toContain('kept-from-v2.4.0');
    expect(await live('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).toEqual(rowsBefore);
    expect(await snapshot()).toEqual(baselineSchema);
  }, 300_000);
});
