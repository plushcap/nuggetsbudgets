import { describe, it, expect } from 'vitest';
import { splitSqlStatements } from '../utils/splitSqlStatements.js';

// A `-- nuggets:no-transaction` migration runs statement by statement, so its
// split must match how Postgres reads the script.
describe('splitSqlStatements', () => {
  it('splits on semicolons and drops empty and comment-only pieces', () => {
    expect(
      splitSqlStatements(`
        -- nuggets:no-transaction
        CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON a (x);
        ;
        -- the second one
        CREATE INDEX CONCURRENTLY IF NOT EXISTS b_idx ON b (y)
        -- trailing comment only
      `)
    ).toEqual([
      '-- nuggets:no-transaction\n        CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON a (x)',
      '-- the second one\n        CREATE INDEX CONCURRENTLY IF NOT EXISTS b_idx ON b (y)\n        -- trailing comment only',
    ]);
  });

  it('keeps semicolons inside strings, quoted names, comments and dollar-quoted bodies', () => {
    const script = [
      "INSERT INTO t (s) VALUES ('a;b'), ('it''s; fine'), (E'x\\';y')",
      'SELECT "odd;name"""  FROM "t;"',
      '/* a; /* nested; */ still comment; */ SELECT 1',
      "DO $$ BEGIN RAISE NOTICE 'x;'; END $$",
      'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $body$ BEGIN RETURN 1; END; $body$',
      'SELECT $1::text, a$b FROM t',
    ];
    expect(splitSqlStatements(script.join(';\n') + ';')).toEqual(script);
    // A line comment runs to the end of the line, semicolon and all.
    expect(splitSqlStatements('SELECT 1 -- not; the end;\n;SELECT 2')).toEqual(['SELECT 1 -- not; the end;', 'SELECT 2']);
  });

  it('reads backslash escapes only in E strings', () => {
    expect(splitSqlStatements("SELECT name'x\\'; SELECT 2")).toEqual(["SELECT name'x\\'", 'SELECT 2']);
    expect(splitSqlStatements("SELECT e'a\\';b'; SELECT 2")).toEqual(["SELECT e'a\\';b'", 'SELECT 2']);
  });

  it('refuses SQL-standard function bodies, whose semicolons it cannot place', () => {
    expect(() =>
      splitSqlStatements('CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;')
    ).toThrow(/BEGIN ATOMIC/);
    // The words in a comment or a string are fine.
    expect(splitSqlStatements("SELECT 'BEGIN ATOMIC'; -- BEGIN ATOMIC\nSELECT 1")).toEqual([
      "SELECT 'BEGIN ATOMIC'",
      '-- BEGIN ATOMIC\nSELECT 1',
    ]);
  });

  it('reports what is left open', () => {
    expect(() => splitSqlStatements("SELECT 'open")).toThrow(/Unterminated string/);
    expect(() => splitSqlStatements('SELECT $x$ open')).toThrow(/Unterminated dollar-quoted/);
    expect(() => splitSqlStatements('/* open')).toThrow(/Unterminated block comment/);
  });
});
