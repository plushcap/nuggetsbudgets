import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dbPasswordFileProblem, dbPasswordFileProblems, loadSecrets } from '../docker-secrets.js';
import { ProductionConfigError, validateStartupConfig } from '../productionConfig.js';

/**
 * A db_password file Postgres and the backend read differently. The postgres image's
 * first start takes the file less its trailing newlines (and signs in with that during its
 * own setup), and initdb sets its first line, less a CR at the end, as the password; the
 * backend trims both ends. So a CR or spaces at the end of the line, whitespace at the start,
 * or a line break inside leave the two with different passwords, and sign-in fails, saying
 * nothing about why. The backend refuses such a file, naming it, before anything signs in
 * with it. The other secret files are read by the backend alone: their line endings never
 * mattered, and a CRLF jwt_secret that worked before an upgrade still does.
 */
describe('a db_password file Postgres would read differently', () => {
  let dir: string;
  const strong = () => randomBytes(32).toString('base64');
  const secretFile = (name: string, content: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, content);
    return file;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'secret-line-endings-'));
    vi.stubEnv('SECRETS_PATH', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes a password both read the same, a CR inside the line included', () => {
    for (const content of ['pass-word', 'pass-word\n', 'pass-word\n\n', 'pa\rss-word\n', '']) {
      expect(dbPasswordFileProblem(content), JSON.stringify(content)).toBeNull();
    }
  });

  it('says what is wrong, and that whitespace at the end alone can be cut', () => {
    for (const content of ['pass-word\r\n', 'pass-word\r', 'pass-word\r\n\r\n', 'pass-word  \n', 'pass-word\t']) {
      expect(dbPasswordFileProblem(content), JSON.stringify(content)).toMatch(
        /^ends in whitespace other than a newline .*Remove it from the end of the file/
      );
    }
    const refused: Array<[string, RegExp]> = [
      [' pass-word\n', /^starts with whitespace/],
      ['\uFEFFpass-word', /^starts with whitespace/],
      ['AAAA-first-line\nBBBB-second\n', /^has a line break inside the password \(Postgres takes only its first line\)/],
      ['AAAA-first-line\r\nBBBB-second\r\n', /^has a line break inside the password/],
      ['pass\0word', /^has a NUL byte/],
    ];
    for (const [content, problem] of refused) {
      const said = dbPasswordFileProblem(content);
      expect(said, JSON.stringify(content)).toMatch(problem);
      expect(said).toContain('Write the password alone on one line');
    }
  });

  it('looks at db_password only: every other secret is the backend\'s alone', () => {
    secretFile('jwt_secret', `${randomBytes(48).toString('base64')}\r\n${randomBytes(24).toString('base64')}\r\n`);
    secretFile('session_secret', `${strong()}\r\n`);
    secretFile('csrf_secret', `${strong()}\r`);
    secretFile('data_encryption_key', `AAAA${strong()}\r\nBBBB`);
    secretFile('db_password', `${strong()}\n`);
    expect(dbPasswordFileProblems()).toEqual([]);

    const db = secretFile('db_password', `${strong()}\r\n`);
    expect(dbPasswordFileProblems()).toEqual([expect.stringMatching(new RegExp(`^The secret file ${db} ends in whitespace`))]);
  });

  // Postgres keeps the file's bytes, and the backend reads UTF-8: a Latin-1 "é" became U+FFFD,
  // so Postgres started and the backend couldn't sign in, and the check said nothing.
  it("refuses a db_password that isn't UTF-8 text, and takes one that is", () => {
    const db = path.join(dir, 'db_password');
    writeFileSync(db, Buffer.concat([Buffer.from('Xk9pQ2vL7mNr4s'), Buffer.from([0xe9]), Buffer.from('\n')]));
    expect(dbPasswordFileProblems()).toEqual([expect.stringMatching(new RegExp(`^The secret file ${db} isn't UTF-8 text`))]);
    writeFileSync(db, 'Xk9pQ2vL7mNr4s\u00e9\n', 'utf8');
    expect(dbPasswordFileProblems()).toEqual([]);
  });

  it('finds none without a secrets directory', () => {
    vi.stubEnv('SECRETS_PATH', path.join(dir, 'missing'));
    expect(dbPasswordFileProblems()).toEqual([]);
  });

  it('refuses to load the secrets, before anything signs in with them, and never shows a value', () => {
    const value = strong();
    const db = secretFile('db_password', `${value}\r\n`);
    const jwt = randomBytes(64).toString('base64');
    for (const [name, env] of [
      ['db_password', 'DB_PASSWORD'],
      ['jwt_secret', 'JWT_SECRET'],
      ['session_secret', 'SESSION_SECRET'],
      ['csrf_secret', 'CSRF_SECRET'],
    ]) {
      // CRLF in the backend's own secrets is fine: it trims them.
      if (name !== 'db_password') secretFile(name, `${name === 'jwt_secret' ? jwt : strong()}\r\n`);
      vi.stubEnv(env, '');
    }
    let error: Error | undefined;
    try {
      loadSecrets();
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).toContain(`The secret file ${db} ends in whitespace other than a newline`);
    expect(error?.message).not.toContain(value);

    // The same password with an LF ending loads, and the CRLF jwt_secret reads as it did.
    secretFile('db_password', `${value}\n`);
    const loaded = loadSecrets();
    expect(loaded.dbPassword).toBe(value);
    expect(loaded.jwtSecret).toBe(jwt);
  });

  it('is a startup problem, listed with the rest', () => {
    const db = secretFile('db_password', `${strong()}  \n`);
    const env = { NODE_ENV: 'development', SECRETS_PATH: dir, DB_POOL_MAX: '0' } as NodeJS.ProcessEnv;
    let error: unknown;
    try {
      validateStartupConfig(env);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ProductionConfigError);
    expect((error as ProductionConfigError).problems).toEqual(
      expect.arrayContaining([expect.stringContaining(`The secret file ${db} ends in whitespace other than a newline`)])
    );
    secretFile('db_password', strong());
    secretFile('jwt_secret', `${randomBytes(64).toString('base64')}\r\n`);
    expect(() => validateStartupConfig({ NODE_ENV: 'development', SECRETS_PATH: dir } as NodeJS.ProcessEnv)).not.toThrow();
  });
});
