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

  /**
   * A deployment admin who can sign in, as every deployment has: a restore refuses data
   * without one (restoreCarryOver.ts). Returns their id.
   */
  const addDeploymentAdmin = async (database: string, email: string): Promise<number> => {
    const [{ id }] = await ownerQuery<{ id: number }>(database, "INSERT INTO users (email, password_hash) VALUES ($1, 'not-a-hash') RETURNING id", [email]);
    await ownerQuery(database, "INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1", [id]);
    return id;
  };
  let adminId: number;

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
    adminId = await addDeploymentAdmin(location.database, 'admin@round-trip.test');
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
    expect(result.manifest).toMatchObject({ manifestVersion: 5, backupId: backup.fileName.replace(/\.tar\.age$/, '') });
    // Every table's rows, counted as the backup was made; the restore found the same.
    expect(result.manifest?.rowCounts).toMatchObject({ tenants: 1, stored_images: 1, schema_migrations: expect.any(Number) });
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

  describe("what a restore takes from the running server, and ends (restoreCarryOver.ts)", () => {
    /** A person in the data, with a password set a day ago. */
    const person = async (email: string) =>
      (
        await live(
          "INSERT INTO users (email, password_hash, password_changed_at) VALUES ($1, 'hash-at-backup', now() - interval '1 day') RETURNING id, uuid",
          [email]
        )
      )[0] as { id: number; uuid: string };
    const one = async (sql: string, params: unknown[] = []) => (await live(sql, params))[0];
    /** A hash column's 64 hex digits, for `text`. */
    const hex = (text: string) => `encode(sha256('${text}'::bytea), 'hex')`;
    const withBackupKey = async (backups: BackupService) => {
      if ((await backups.listRecipients()).length === 0) await addTestRecipient(backups);
      return backups;
    };
    const setSetting = async (key: string, value: string) => {
      await live('UPDATE system_settings SET setting_value = $2 WHERE setting_key = $1', [key, value]);
      await live('INSERT INTO system_settings (setting_key, setting_value) SELECT $1::text, $2::text WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = $1::text)', [key, value]);
    };

    it("ends every sign-in, takes the running server's sign-in state, and keeps its keys and OneDrive connection", async () => {
      await useDataKey('server-a');
      const backups = await withBackupKey(service());
      const { org } = (await one('SELECT organization_id AS org FROM tenants WHERE id = 1')) as { org: number };
      const b = await person('b@carry.test');
      const c = await person('c@carry.test');
      const d = await person('d@carry.test');
      await live("INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1", [b.id]);
      await live('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, false)', [org, c.id]);
      await live('INSERT INTO tenant_users (tenant_id, user_id, is_admin) VALUES (1, $1, true)', [c.id]);
      const passkey = async (credential: string) =>
        ((await one("INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter) VALUES ($1, $2, 'pk', 5) RETURNING uuid", [b.id, credential])) as { uuid: string }).uuid;
      const removedPasskey = await passkey('cred-removed');
      const keptPasskey = await passkey('cred-kept');
      // What every restore ends.
      await live(`INSERT INTO sessions (session_token_hash, user_id, expires_at) VALUES (${hex('carry-session')}, $1, now() + interval '1 day')`, [b.id]);
      await live(`INSERT INTO webauthn_challenges (browser_hash, challenge, expires_at, purpose) VALUES (${hex('carry-browser')}, 'carry-challenge', now() + interval '5 minutes', 'authentication')`);
      await live("INSERT INTO personal_access_tokens (jti, tenant_id, user_id, expires_at) VALUES ('carry-jti', 1, $1, now() + interval '30 days')", [b.id]);
      await live(`INSERT INTO organization_invitations (email, expires_at, organization_id, token_hash) VALUES ('invitee@carry.test', now() + interval '7 days', $1, ${hex('carry-token')})`, [org]);
      await live(
        "INSERT INTO notifications (tenant_id, user_id, notification_type, recipient_email, subject, template_data, status) VALUES (1, $1, 'budget_alert', 'c@carry.test', 'queued', '{}', 'pending')",
        [c.id]
      );
      await setSetting('backup_enabled', 'false');
      const backup = await backups.createBackup();

      // Since the backup, on the running server.
      await live('UPDATE users SET login_disabled = true WHERE id = $1', [b.id]);
      await live("UPDATE users SET password_hash = 'hash-now', password_changed_at = now(), must_change_password = true WHERE id = $1", [c.id]);
      await live('DELETE FROM passkey_credentials WHERE uuid = $1', [removedPasskey]);
      await live('UPDATE passkey_credentials SET counter = 50 WHERE uuid = $1', [keptPasskey]);
      await live('DELETE FROM deployment_users WHERE user_id = $1', [b.id]);
      await live('DELETE FROM users WHERE id = $1', [d.id]);
      await live(`INSERT INTO login_throttles (throttle_key, attempts) VALUES (${hex('carry-throttle')}, 7)`);
      await live("INSERT INTO notification_deliveries (tenant_id, user_id, rule_key, subject_key) VALUES (1, $1, 'carry-rule', 'since-the-backup')", [c.id]);
      await live('DELETE FROM organization_users WHERE user_id = $1', [c.id]);
      await live('UPDATE tenant_users SET is_admin = false WHERE user_id = $1 AND tenant_id = 1', [c.id]);
      await backups.addRecipient({ recipient: await identityToRecipient(await generateHybridIdentity()), label: 'added since', checked: false, createdBy: adminId });
      await setSetting('onedrive_client_id', 'live-client');
      await setSetting('onedrive_client_secret', 'sealed-live-secret');
      await live("INSERT INTO onedrive_tokens (user_id, access_token, refresh_token, expires_at) VALUES ($1, 'sealed-access', 'sealed-refresh', now() + interval '1 hour')", [adminId]);
      await setSetting('backup_enabled', 'true');

      const restored = await backups.restoreFromFile(backup.filePath, { fileKey: await fileKeyOf(backup.filePath), fileName: backup.fileName, restorerId: adminId });

      expect(restored.carryOver).toMatchObject({
        tookFromRunningServer: true,
        sameDeployment: true,
        taken: { passwords: 1, passkeysRemoved: 1, passkeyCounters: 1, deploymentRoles: 1, loginThrottles: 1, deliveries: 1 },
        lockedDeletedSince: 1,
        kept: { backupKeys: true, oneDriveRegistration: true, oneDriveConnections: 1, backupRuns: true, automaticBackupsKeptOn: true },
      });
      expect(restored.carryOver?.taken.locks).toBeGreaterThanOrEqual(1);
      expect(restored.carryOver?.ended).toMatchObject({ challenges: 1, invitations: 1, notifications: 1 });
      expect(restored.carryOver?.ended.sessions).toBeGreaterThanOrEqual(1);
      expect(restored.carryOver?.ended.tokens).toBeGreaterThanOrEqual(1);
      expect(restored.carryOver?.removedSince).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ person: 'c@carry.test', kind: 'organization', change: 'member' }),
          expect.objectContaining({ person: 'c@carry.test', kind: 'tenant', change: 'admin' }),
        ])
      );

      // Ended.
      expect(await one('SELECT count(*)::int AS n FROM sessions')).toEqual({ n: 0 });
      expect(await one('SELECT count(*)::int AS n FROM webauthn_challenges')).toEqual({ n: 0 });
      expect(await one("SELECT revoked_reason FROM personal_access_tokens WHERE jti = 'carry-jti'")).toEqual({ revoked_reason: 'restore' });
      expect(await one("SELECT revoked_at IS NOT NULL AS revoked FROM organization_invitations WHERE email = 'invitee@carry.test'")).toEqual({ revoked: true });
      expect(await one("SELECT status FROM notifications WHERE subject = 'queued'")).toEqual({ status: 'failed' });
      // Taken from the running server.
      expect(await one('SELECT login_disabled FROM users WHERE id = $1', [b.id])).toEqual({ login_disabled: true });
      expect(await one('SELECT password_hash, must_change_password FROM users WHERE id = $1', [c.id])).toEqual({ password_hash: 'hash-now', must_change_password: true });
      expect(await live('SELECT uuid, counter FROM passkey_credentials WHERE user_id = $1', [b.id])).toEqual([{ uuid: keptPasskey, counter: '50' }]);
      expect(await live('SELECT 1 FROM deployment_users WHERE user_id = $1', [b.id])).toEqual([]);
      expect(await one(`SELECT attempts FROM login_throttles WHERE throttle_key = ${hex('carry-throttle')}`)).toEqual({ attempts: 7 });
      expect(await one("SELECT tenant_id, user_id FROM notification_deliveries WHERE subject_key = 'since-the-backup'")).toEqual({ tenant_id: 1, user_id: c.id });
      // Deleted since: back, but locked. Reported, not changed: the memberships.
      expect(await one('SELECT is_locked FROM users WHERE uuid = $1', [d.uuid])).toEqual({ is_locked: true });
      expect(await one('SELECT is_admin FROM tenant_users WHERE user_id = $1 AND tenant_id = 1', [c.id])).toEqual({ is_admin: true });
      // Kept.
      expect((await live('SELECT label FROM backup_recipients ORDER BY label')).map((r) => r.label)).toEqual(['added since', 'test key']);
      expect(await one("SELECT setting_value FROM system_settings WHERE setting_key = 'onedrive_client_id'")).toEqual({ setting_value: 'live-client' });
      expect(await live('SELECT user_id, access_token FROM onedrive_tokens')).toEqual([{ user_id: adminId, access_token: 'sealed-access' }]);
      expect(await one("SELECT setting_value FROM system_settings WHERE setting_key = 'backup_enabled'")).toEqual({ setting_value: 'true' });
      expect((await live('SELECT file_name, outcome FROM backup_runs')).map((r) => r.file_name)).toContain(backup.fileName);
    }, 300_000);

    it("refuses a web restore by someone who isn't a deployment admin who can sign in in the backup, and changes nothing", async () => {
      await useDataKey('server-a');
      const backups = await withBackupKey(service());
      const member = await person('member@carry.test');
      const lockedAdmin = await person('locked-admin@carry.test');
      await live("INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1", [lockedAdmin.id]);
      const backup = await backups.createBackup();
      // Locked since the backup: the lock is taken over, so they couldn't sign in either.
      await live('UPDATE users SET is_locked = true WHERE id = $1', [lockedAdmin.id]);
      await live("INSERT INTO tags (tenant_id, name) VALUES (1, 'kept-by-the-lock-out-refusal')");
      for (const restorerId of [member.id, lockedAdmin.id]) {
        const refused = backups.restoreFromFile(backup.filePath, { fileKey: await fileKeyOf(backup.filePath), restorerId });
        await expect(refused).rejects.toMatchObject({ databaseChanged: false, cause: { code: 'RESTORE_WOULD_LOCK_OUT' } });
      }
      expect(await tagNames()).toContain('kept-by-the-lock-out-refusal');
      // The admin it has can restore it.
      await expect(backups.restoreFromFile(backup.filePath, { fileKey: await fileKeyOf(backup.filePath), restorerId: adminId })).resolves.toMatchObject({
        carryOver: { sameDeployment: true },
      });
    }, 300_000);

    it("takes nothing from the running server when told to ignore it, or when the backup is another deployment's", async () => {
      await useDataKey('server-a');
      const backups = await withBackupKey(service());
      const changed = await person('changed@carry.test');
      const backup = await backups.createBackup();
      await live("UPDATE users SET password_hash = 'hash-now', password_changed_at = now() WHERE id = $1", [changed.id]);
      await live(`INSERT INTO sessions (session_token_hash, user_id, expires_at) VALUES (${hex('ignored-session')}, $1, now() + interval '1 day')`, [adminId]);

      const ignoring = await backups.restoreFromFile(backup.filePath, { fileKey: await fileKeyOf(backup.filePath), ignoreCurrentDatabase: true });
      expect(ignoring.carryOver).toMatchObject({ tookFromRunningServer: false, sameDeployment: false, kept: { backupKeys: false, oneDriveConnections: 0 } });
      expect(await one('SELECT password_hash FROM users WHERE id = $1', [changed.id])).toEqual({ password_hash: 'hash-at-backup' });
      // Sessions are ended all the same.
      expect(await one('SELECT count(*)::int AS n FROM sessions')).toEqual({ n: 0 });

      // Another deployment's backup (this server's uuid differs): nothing of sign-in is taken,
      // but this server's backup keys are kept.
      await live("UPDATE users SET password_hash = 'hash-now', password_changed_at = now() WHERE id = $1", [changed.id]);
      await live('UPDATE deployment SET uuid = uuidv7()');
      const other = await backups.restoreFromFile(backup.filePath, { fileKey: await fileKeyOf(backup.filePath), restorerId: adminId });
      expect(other.carryOver).toMatchObject({ tookFromRunningServer: true, sameDeployment: false, lockedDeletedSince: 0, kept: { backupKeys: true } });
      expect(await one('SELECT password_hash FROM users WHERE id = $1', [changed.id])).toEqual({ password_hash: 'hash-at-backup' });
    }, 300_000);
  });

  it("refuses restored data whose rows differ from the backup's counts, and changes nothing", async () => {
    await useDataKey('server-a');
    const backups = service();
    // A backup whose signed manifest counts one tag more, and lacks a table, than its dump has:
    // what a dump cut short looks like to the restore.
    type Dump = (tempDir: string, backupId: string) => Promise<{ dumpFile: string; rowCounts: Record<string, number> }>;
    const steps = backups as unknown as { createDatabaseDump: Dump };
    const dump = steps.createDatabaseDump.bind(backups);
    vi.spyOn(steps, 'createDatabaseDump').mockImplementation(async (tempDir, backupId) => {
      const made = await dump(tempDir, backupId);
      const { login_throttles: _left, ...rest } = made.rowCounts;
      return { ...made, rowCounts: { ...rest, tags: (rest.tags ?? 0) + 1 } };
    });
    const backup = await backups.createBackup();
    vi.restoreAllMocks();
    await live("INSERT INTO tags (tenant_id, name) VALUES (1, 'kept-by-the-refusal')");
    const refused = backups.restoreFromFile(backup.filePath, { fileKey: await fileKeyOf(backup.filePath) });
    await expect(refused).rejects.toMatchObject({
      databaseChanged: false,
      message: expect.stringMatching(/doesn't match the rows the backup counted.*login_throttles is in the restored data.*tags has \d+ rows, the backup \d+/),
    });
    await expect(refused).rejects.toMatchObject({ cause: { code: 'BACKUP_ROW_COUNTS' } });
    expect(await tagNames()).toContain('kept-by-the-refusal');
    expect(await databases()).toEqual([location.database, `${location.database}_before_restore`].sort());
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
      await addDeploymentAdmin(v240.database, 'admin@v240.test');
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
