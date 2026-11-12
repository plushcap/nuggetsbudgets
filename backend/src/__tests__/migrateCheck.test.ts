import { describe, it, expect, vi, afterEach } from 'vitest';

// Secret files the test pretends are mounted: their contents, or the error reading one throws.
const secretFiles = vi.hoisted(() => ({ files: null as Record<string, string | Error> | null }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const faked = (p: unknown) => secretFiles.files !== null && String(p) in secretFiles.files;
  const existsSync = ((p: Parameters<typeof actual.existsSync>[0]) => faked(p) || actual.existsSync(p)) as typeof actual.existsSync;
  const readFileSync = ((p: Parameters<typeof actual.readFileSync>[0], options?: unknown) => {
    if (faked(p)) {
      const value = secretFiles.files![String(p)];
      if (value instanceof Error) throw value;
      return value;
    }
    return actual.readFileSync(p, options as BufferEncoding);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, existsSync, readFileSync }, existsSync, readFileSync };
});

import {
  allowConnectionsHint,
  describeError,
  isDatabaseNotAcceptingConnections,
  isDatabaseUnreachable as notReachableYet,
} from '../utils/dbErrors.js';
import { loadSecrets } from '../utils/docker-secrets.js';

/**
 * docker-entrypoint.sh waits for the database with `migrate check`, and tries again only
 * while the database isn't reachable yet. It used to throw every error
 * away, so a wrong password or an unreadable secret file looked like "database not
 * ready" for 90 seconds, then "Database not reachable".
 */
describe('migrate check', () => {
  afterEach(() => {
    secretFiles.files = null;
  });

  it('waits for a database that is not reachable yet', () => {
    const code = (c: string) => Object.assign(new Error(`connect ${c}`), { code: c });
    for (const c of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', '57P03', '53300']) {
      expect(notReachableYet(code(c)), c).toBe(true);
    }
    // pg's own wordings for a connection that timed out or dropped.
    expect(notReachableYet(new Error('timeout expired'))).toBe(true);
    expect(notReachableYet(new Error('Connection terminated due to connection timeout'))).toBe(true);
  });

  it('does not wait for what waiting will not fix', () => {
    const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
    expect(notReachableYet(pgError('28P01', 'password authentication failed for user "nuggetsApp_user"'))).toBe(false);
    expect(notReachableYet(pgError('28000', 'role "nobody" does not exist'))).toBe(false);
    expect(notReachableYet(pgError('3D000', 'database "nugets_db" does not exist'))).toBe(false);
    expect(notReachableYet(new Error('Missing required secrets: db_password'))).toBe(false);
  });

  // A restore stopped while it swapped the databases leaves the database's ALLOW_CONNECTIONS
  // off: waiting won't fix that, and the hint says the statement that does.
  it('says how to let connections in again to a database that refuses them all', () => {
    const refusing = Object.assign(new Error('database "nuggets_db" is not currently accepting connections'), { code: '55000' });
    expect(notReachableYet(refusing)).toBe(false);
    expect(isDatabaseNotAcceptingConnections(refusing)).toBe(true);
    // 55000 is "object not in prerequisite state" in general: only this one is.
    expect(isDatabaseNotAcceptingConnections(Object.assign(new Error('cannot do that now'), { code: '55000' }))).toBe(false);
    expect(allowConnectionsHint('nuggets_db')).toMatch(
      /^The database "nuggets_db" doesn't accept connections \(ALLOW_CONNECTIONS is off\)\. .* run: ALTER DATABASE "nuggets_db" ALLOW_CONNECTIONS true; /
    );
    expect(allowConnectionsHint('odd"name')).toContain('ALTER DATABASE "odd""name" ALLOW_CONNECTIONS true');
  });

  it('says why, including each address a connection was tried at', () => {
    // Node's AggregateError for a host with several addresses has no message of its own.
    const aggregate = Object.assign(
      new AggregateError([new Error('connect ECONNREFUSED ::1:5432'), new Error('connect ECONNREFUSED 127.0.0.1:5432')], ''),
      { code: 'ECONNREFUSED' }
    );
    expect(describeError(aggregate)).toBe('ECONNREFUSED: connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432');
    expect(notReachableYet(aggregate)).toBe(true);
    expect(describeError(Object.assign(new Error('password authentication failed'), { code: '28P01' }))).toBe(
      '28P01: password authentication failed'
    );
  });

  it('names a secret file that is there but cannot be read, rather than calling it missing', () => {
    const env = { ...process.env };
    for (const name of ['DB_PASSWORD', 'JWT_SECRET', 'SESSION_SECRET', 'CSRF_SECRET']) delete process.env[name];
    secretFiles.files = {
      '/run/secrets/db_password': Object.assign(new Error("EACCES: permission denied, open '/run/secrets/db_password'"), {
        code: 'EACCES',
      }),
      '/run/secrets/jwt_secret': 'a-jwt-secret-that-is-long-enough-for-the-test',
      '/run/secrets/session_secret': 'a-session-secret-long-enough',
      '/run/secrets/csrf_secret': '  \n',
    };
    try {
      expect(() => loadSecrets()).toThrow(
        /^Missing required secrets: db_password \(\/run\/secrets\/db_password can't be read by this user \(uid \d+\): check its owner and mode\), csrf_secret \(\/run\/secrets\/csrf_secret is empty\)\./
      );
    } finally {
      process.env = env;
    }
  });
});
