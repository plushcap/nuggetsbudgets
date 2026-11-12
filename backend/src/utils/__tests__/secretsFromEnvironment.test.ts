import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SECRET_VARIABLES,
  copySecretsIntoEnvironment,
  loadSecrets,
  optionalSecret,
  readDockerSecret,
  secretsInEnvironment,
} from '../docker-secrets.js';
import { getOwnerCredentials } from '../../db/dbConfig.js';
import { servingRolePassword } from '../../db/servingRole.js';
import { getDirname } from '../esm-compat.js';

/**
 * Production reads a secret only from its Docker secret file and refuses to start with one
 * in the environment, so a stack's settings never hold a secret; outside production the
 * variables stand in for the files, for development and the tests.
 */
describe('secrets and the environment', () => {
  let dir: string;
  const before = {
    NODE_ENV: process.env.NODE_ENV,
    SECRETS_PATH: process.env.SECRETS_PATH,
    JWT_SECRET: process.env.JWT_SECRET,
    DB_PASSWORD: process.env.DB_PASSWORD,
    SESSION_SECRET: process.env.SESSION_SECRET,
    CSRF_SECRET: process.env.CSRF_SECRET,
    APP_DB_PASSWORD: process.env.APP_DB_PASSWORD,
    MIGRATION_DB_PASSWORD: process.env.MIGRATION_DB_PASSWORD,
    BACKUP_DB_PASSWORD: process.env.BACKUP_DB_PASSWORD,
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'secrets-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('knows every secret config.ts lists', () => {
    expect([...SECRET_VARIABLES].sort()).toEqual([
      'APP_DB_PASSWORD',
      'BACKUP_DB_PASSWORD',
      'CSRF_SECRET',
      'DB_PASSWORD',
      'JWT_SECRET',
      'MIGRATION_DB_PASSWORD',
      'SESSION_SECRET',
    ]);
  });

  it('refuses a secret in the environment in production, naming its file', () => {
    const env = { NODE_ENV: 'production', JWT_SECRET: 'made-up', MIGRATION_DB_PASSWORD: 'made-up', SESSION_SECRET: '' };
    const problems = secretsInEnvironment(env);
    expect(problems).toHaveLength(2); // an empty variable isn't a secret
    expect(problems[0]).toMatch(/^JWT_SECRET is set in the environment.*the jwt_secret Docker secret file/);
    expect(problems[1]).toMatch(/^MIGRATION_DB_PASSWORD is set.*the migration_db_password Docker secret file/);
  });

  it('takes the variables outside production', () => {
    expect(secretsInEnvironment({ NODE_ENV: 'development', JWT_SECRET: 'made-up' })).toEqual([]);
    expect(secretsInEnvironment({ NODE_ENV: 'test', DB_PASSWORD: 'made-up' })).toEqual([]);
  });

  it('reads an optional secret from its file first, and its variable only outside production', () => {
    const variable = { SECRETS_PATH: dir, MIGRATION_DB_PASSWORD: 'from-the-variable' };
    expect(optionalSecret('MIGRATION_DB_PASSWORD', { ...variable, NODE_ENV: 'development' })).toBe('from-the-variable');
    expect(optionalSecret('MIGRATION_DB_PASSWORD', { ...variable, NODE_ENV: 'production' })).toBeUndefined();

    writeFileSync(path.join(dir, 'migration_db_password'), 'from-the-file\n');
    expect(optionalSecret('MIGRATION_DB_PASSWORD', { ...variable, NODE_ENV: 'development' })).toBe('from-the-file');
    expect(optionalSecret('MIGRATION_DB_PASSWORD', { ...variable, NODE_ENV: 'production' })).toBe('from-the-file');
    expect(optionalSecret('BACKUP_DB_PASSWORD', { ...variable, NODE_ENV: 'production' })).toBeUndefined();
  });

  it('gives the owner, and the serving role in a single-role setup, the migration_db_password file', () => {
    writeFileSync(path.join(dir, 'migration_db_password'), 'owner-from-file');
    writeFileSync(path.join(dir, 'backup_db_password'), 'backups-from-file');
    const env = { NODE_ENV: 'production', SECRETS_PATH: dir, MIGRATION_DB_USER: 'owner', DB_USER: 'owner' };
    expect(getOwnerCredentials(env).password).toBe('owner-from-file');
    expect(getOwnerCredentials(env, true).password).toBe('backups-from-file');
    expect(servingRolePassword({ dbPassword: 'db', appDbPassword: '' }, env)).toBe('owner-from-file');
  });

  it('names the variable left where a missing file should be, in production', () => {
    process.env.SECRETS_PATH = dir;
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'from-the-variable';
    delete process.env.DB_PASSWORD;
    delete process.env.SESSION_SECRET;
    delete process.env.CSRF_SECRET;
    expect(() => loadSecrets()).toThrow(
      /Missing required secrets: db_password, jwt_secret \(JWT_SECRET is set in the environment, which production never reads a secret from: put it in this file and remove the variable\), session_secret, csrf_secret\. Mount each as a Docker secret file/
    );
  });

  it("doesn't take the secrets startup copied from their files for ones a stack set", () => {
    process.env.NODE_ENV = 'production';
    for (const name of ['APP_DB_PASSWORD', 'MIGRATION_DB_PASSWORD', 'BACKUP_DB_PASSWORD']) delete process.env[name];
    copySecretsIntoEnvironment({ dbPassword: 'a', appDbPassword: 'b', jwtSecret: 'c', sessionSecret: 'd', csrfSecret: 'e' });
    expect(process.env.JWT_SECRET).toBe('c');
    expect(secretsInEnvironment()).toEqual([]);
    // APP_DB_PASSWORD isn't copied, so one in the environment is still a stack's.
    expect(secretsInEnvironment({ ...process.env, APP_DB_PASSWORD: 'made-up' })).toEqual([
      expect.stringMatching(/^APP_DB_PASSWORD is set in the environment/),
    ]);
  });

  it('refuses an optional secret file that is there but can\'t be read, rather than sign in another way', () => {
    mkdirSync(path.join(dir, 'migration_db_password')); // a directory reads as EISDIR, even for root
    expect(() => optionalSecret('MIGRATION_DB_PASSWORD', { NODE_ENV: 'production', SECRETS_PATH: dir })).toThrow(
      /^The migration_db_password secret file \(.*\) can't be read: EISDIR$/
    );
  });

  it('says why a separate serving role has no password when APP_DB_PASSWORD is set in production', () => {
    const env = { NODE_ENV: 'production', SECRETS_PATH: dir, DB_USER: 'nuggets_app', MIGRATION_DB_USER: 'owner', APP_DB_PASSWORD: 'made-up' };
    expect(() => servingRolePassword({ dbPassword: 'db', appDbPassword: '' }, env)).toThrow(
      /APP_DB_PASSWORD is set in the environment, which production never reads a secret from: put it in the app_db_password Docker secret file/
    );
  });

  it.each([
    // Each command that runs in production, and the first thing it does with a secret or the database.
    ['index.ts', 'copySecretsIntoEnvironment('],
    ['scripts/migrate.ts', 'switch (command)'],
    ['scripts/restore.ts', "await import('pg')"],
    ['scripts/rewrap-secrets.ts', 'createMigrationPool()'],
    ['scripts/setup-token.ts', "await import('../db.js')"],
    ['scripts/migrate-images-to-db.ts', 'createMigrationPool()'],
  ])('%s refuses a secret in the environment before %s', (file, first) => {
    const source = readFileSync(path.join(getDirname(import.meta.url), '..', '..', file), 'utf8');
    const check = source.search(/secretsInEnvironment\(\)\]?;\n\s*if \((refused|problems|secretsFromEnvironment)\.length > 0\)/);
    expect(check, 'the check, and its result acted on').toBeGreaterThan(-1);
    expect(source.indexOf(first), first).toBeGreaterThan(check);
  });

  it("doesn't fall back to a secret's variable in production", () => {
    process.env.SECRETS_PATH = dir;
    process.env.JWT_SECRET = 'from-the-variable';
    process.env.NODE_ENV = 'development';
    expect(readDockerSecret('jwt_secret', 'JWT_SECRET')).toBe('from-the-variable');
    process.env.NODE_ENV = 'production';
    expect(readDockerSecret('jwt_secret', 'JWT_SECRET')).toBeUndefined();
    writeFileSync(path.join(dir, 'jwt_secret'), 'from-the-file');
    expect(readDockerSecret('jwt_secret', 'JWT_SECRET')).toBe('from-the-file');
  });
});
