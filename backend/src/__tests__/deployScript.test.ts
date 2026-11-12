import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * deploy/deploy.sh's own settings, its functions run from the script sourced (it
 * runs nothing then), with sudo and compose stood in for:
 * - `backup` keeps the newest DEPLOY_BACKUP_KEEP of its dumps, and nothing else it finds;
 * - compose's settings the calling shell exports (COMPOSE_PROJECT_NAME) don't steer it;
 * - db_password, which Postgres and the backend both read, has whitespace cut from its end
 *   (a CRLF line ending, say) and is refused when they'd read it differently otherwise; the
 *   other secret files, the backend's alone, are never changed.
 */

// The tests run from backend/.
const DEPLOY = path.resolve(process.cwd(), '..', 'deploy', 'deploy.sh');

/** Run `body` in bash with deploy.sh sourced, in `env` alone (and PATH). */
function inScript(body: string, env: Record<string, string>) {
  const script = `set -euo pipefail\nsource "$DEPLOY" production test\nsudo() { "$@"; }\n${body}\n`;
  return spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', DEPLOY, ...env }, encoding: 'utf8' });
}

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'deploy-script-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('deploy.sh backup', () => {
  /** A running postgres whose pg_dump writes a line. */
  const COMPOSE = `compose() { case "$1" in ps) echo postgres-id ;; exec) echo '-- a dump' ;; esac; }`;
  const OLD = [
    'nuggets_backup_20260101_010000.sql',
    'nuggets_backup_20260102_010000.sql',
    'nuggets_backup_20260103_010000.sql',
    'nuggets_backup_20260104_010000.sql',
  ];
  const OTHERS = ['nuggets_backup_notes.sql', 'nuggets_backup_20260101_010000.sql.gz', 'nuggets-backup-20260101_010000.enc'];

  function backups(keep?: string, env: Record<string, string> = {}) {
    const dir = path.join(work, 'backups');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    for (const file of [...OLD, ...OTHERS]) writeFileSync(path.join(dir, file), 'x');
    const result = inScript(`${COMPOSE}\nbackup_database`, { BACKUPS_PATH: dir, ...env, ...(keep === undefined ? {} : { DEPLOY_BACKUP_KEEP: keep }) });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const files = readdirSync(dir).sort();
    const made = files.filter((f) => /^nuggets_backup_\d{8}_\d{6}\.sql$/.test(f) && !OLD.includes(f));
    expect(made, files.join(' ')).toHaveLength(1);
    return { files, made: made[0], output: result.stdout };
  }

  it('keeps the newest DEPLOY_BACKUP_KEEP of its dumps, the new one too, and every other file', () => {
    const { files, made, output } = backups('3');
    expect(files).toEqual(
      [made, 'nuggets_backup_20260103_010000.sql', 'nuggets_backup_20260104_010000.sql', ...OTHERS].sort()
    );
    expect(output).toContain('Removed 2 older dump(s), keeping the newest 3 (DEPLOY_BACKUP_KEEP)');
  });

  it('keeps every dump with DEPLOY_BACKUP_KEEP=0, and the newest 10 without it', () => {
    expect(backups('0').files).toHaveLength(OLD.length + OTHERS.length + 1);
    expect(backups().files).toHaveLength(OLD.length + OTHERS.length + 1);
  });

  it("names a dump by the UTC date, whatever the host's zone, so the names sort in the order made", () => {
    // At any hour, one of these two zones is on another date than UTC.
    for (const TZ of ['Etc/GMT-14', 'Etc/GMT+12']) {
      const utcDays = [new Date(Date.now() - 60_000), new Date()].map(
        (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
      );
      const { made } = backups('3', { TZ });
      expect(utcDays, TZ).toContain(/^nuggets_backup_(\d{8})_\d{6}\.sql$/.exec(made)![1]);
    }
  });
});

describe('deploy.sh load_environment', () => {
  const REQUIRED = ['DEPLOY_BASE_PATH', 'SECRETS_BASE_PATH', 'POSTGRES_DATA_PATH', 'UPLOADS_PATH', 'BACKUPS_PATH', 'TEMP_PATH', 'LOGS_PATH'];

  function load(envFile: string, shell: Record<string, string> = {}) {
    const file = path.join(work, 'test.env');
    writeFileSync(file, [...REQUIRED.map((name) => `${name}=${work}/${name.toLowerCase()}`), 'DOMAIN_URL=https://nuggets.example.com', envFile].join('\n'));
    return inScript(
      `ENV_FILE="$TEST_ENV_FILE"\nload_environment >&2\nprintf '%s|%s|%s|%s\\n' "\${COMPOSE_PROJECT_NAME-unset}" "\${COMPOSE_PROFILES-unset}" "$DEPLOY_BACKUP_KEEP" "$(basename "$COMPOSE_FILE")"`,
      { TEST_ENV_FILE: file, ...shell }
    );
  }

  it("drops compose's settings the shell exports, and DEPLOY_BACKUP_KEEP, so the env file alone sets them", () => {
    const result = load('', { COMPOSE_PROJECT_NAME: 'stray', COMPOSE_PROFILES: 'debug', COMPOSE_FILE: '/elsewhere.yml', DEPLOY_BACKUP_KEEP: '1' });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe('unset|unset|10|docker-compose.prod.yml');
  });

  it('takes them from the env file', () => {
    const result = load('COMPOSE_PROJECT_NAME=nuggets_prod\nDEPLOY_BACKUP_KEEP=4', { COMPOSE_PROJECT_NAME: 'stray' });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe('nuggets_prod|unset|4|docker-compose.prod.yml');
  });

  it('refuses a DEPLOY_BACKUP_KEEP that is not a whole number', () => {
    const result = load('DEPLOY_BACKUP_KEEP=ten');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DEPLOY_BACKUP_KEEP must be a whole number (0 keeps every dump), not "ten"');
  });
});

describe('deploy.sh db_password check', () => {
  function secretsDir(files: Record<string, string | Buffer>) {
    const dir = path.join(work, 'secrets');
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, `${name}.txt`), content);
    return dir;
  }
  const read = (dir: string, name: string) => readFileSync(path.join(dir, `${name}.txt`));

  it('cuts whitespace from the end of db_password in place, in setup too, and leaves every other file alone', () => {
    // An older deploy.sh wrote jwt_secret as two lines of base64; any of these may have CRLF.
    const others: Record<string, Buffer> = {
      app_db_password: Buffer.from('app-db-password-value\r\n'),
      jwt_secret: Buffer.from('AAAA-first-line-of-base64\r\nBBBB-second\r\n'),
      session_secret: Buffer.from('session-value\r'),
      csrf_secret: Buffer.from('csrf\rvalue\n'),
      data_encryption_key: Buffer.from('AAAA-key\r\nBBBB'),
      // A file deploy.sh made before 3.0.0, which nothing reads any more.
      smtp_password: Buffer.from(' smtp \0 password \r\n'),
    };
    const dir = secretsDir({ ...others, db_password: 'db-password-value\r\n' });
    const before = statSync(path.join(dir, 'db_password.txt'));
    // secure_secret_files would chown to root and set ACLs; it isn't what's tested here.
    const result = inScript('secure_secret_files() { :; }\nsetup_secrets', { SECRETS_BASE_PATH: dir });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(read(dir, 'db_password').toString()).toBe('db-password-value\n');
    for (const [name, content] of Object.entries(others)) expect(read(dir, name), name).toEqual(content);
    // The same file (its owner, mode and ACLs with it).
    expect(statSync(path.join(dir, 'db_password.txt')).ino).toBe(before.ino);
    expect(result.stdout).toContain(`Removed the whitespace after the password at the end of ${dir}/db_password.txt`);
    expect(result.stdout).toContain('ALTER ROLE');
    expect(result.stdout.match(/Removed the whitespace/g)).toHaveLength(1);
    expect(result.stdout).not.toContain('\r');
  });

  // The host's locale changes what bash's [[:space:]] matches and how it counts: the cut is
  // in bytes either way.
  const LOCALES: Array<Record<string, string>> = [{}, { LC_ALL: 'C.UTF-8' }];

  it('cuts only the end: a CR, spaces or tabs, keeping a final newline if there was one', () => {
    for (const locale of LOCALES) {
      for (const [content, fixed] of [
        ['db-password-value\r', 'db-password-value'],
        ['db-password-value  \n', 'db-password-value\n'],
        ['db-password-value\t\r\n\r\n', 'db-password-value\n'],
        ['pa\rss-word \n', 'pa\rss-word\n'],
        ['pässwörd-värde\r\n', 'pässwörd-värde\n'],
      ]) {
        const dir = secretsDir({ db_password: content });
        const result = inScript('check_db_password_file', { SECRETS_BASE_PATH: dir, ...locale });
        expect(result.status, JSON.stringify({ content, locale }) + result.stdout).toBe(0);
        expect(read(dir, 'db_password').toString(), JSON.stringify({ content, locale })).toBe(fixed);
      }
    }
  });

  // Postgres takes the bytes, the backend reads UTF-8: a Latin-1 "é" gave two passwords.
  it("refuses a db_password that isn't UTF-8 text, and leaves it as it was", () => {
    const latin1 = Buffer.concat([Buffer.from('Xk9pQ2vL7mNr4s'), Buffer.from([0xe9]), Buffer.from('\n')]);
    const dir = secretsDir({ db_password: latin1 });
    const result = inScript('check_db_password_file', { SECRETS_BASE_PATH: dir });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("db_password.txt isn't UTF-8 text");
    expect(read(dir, 'db_password')).toEqual(latin1);
  });

  it('changes nothing when Postgres and the backend read it the same, a CR inside the line included', () => {
    for (const content of ['db-password-value', 'db-password-value\n', 'db-password-value\n\n', 'pa\rss-word\n']) {
      const dir = secretsDir({ db_password: content });
      const result = inScript('check_db_password_file', { SECRETS_BASE_PATH: dir });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(read(dir, 'db_password').toString()).toBe(content);
      expect(result.stdout).toBe('');
    }
  });

  it('refuses whitespace at the start, a line break inside or a NUL byte, and changes nothing', () => {
    const refused: Array<[string | Buffer, string]> = [
      [' db-password-value\n', 'starts with whitespace'],
      [Buffer.from('\uFEFFdb-password-value\n'), 'starts with whitespace'],
      ['AAAA-first-line\nBBBB-second\n', 'has a line break inside the password'],
      ['AAAA-first-line\r\nBBBB-second\r\n', 'has a line break inside the password'],
      [Buffer.from('db-pass\0word\r\n'), 'has a NUL byte in it'],
    ];
    for (const locale of LOCALES) {
      for (const [content, problem] of refused) {
        const dir = secretsDir({ db_password: content });
        const result = inScript('check_db_password_file', { SECRETS_BASE_PATH: dir, ...locale });
        expect(result.status, JSON.stringify({ content: content.toString(), locale })).toBe(1);
        expect(result.stdout).toContain(`${dir}/db_password.txt ${problem}`);
        expect(read(dir, 'db_password')).toEqual(Buffer.from(content));
      }
    }
  });
});

describe('deploy.sh', () => {
  it('passes bash -n', () => {
    expect(() => execFileSync('bash', ['-n', DEPLOY])).not.toThrow();
  });
});
