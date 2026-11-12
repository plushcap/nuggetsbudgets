import { describe, it, expect } from 'vitest';
import pino from 'pino';
import {
  dbErrorForLog,
  dbErrorLine,
  functionContext,
  isDatabaseError,
  publicDbError,
  withoutQuotedValues,
} from '../dbErrorText.js';

/**
 * What a database error may say in a failed migration's report and log lines:
 * for every error, its message and hint without the values they quote or list
 * (only the names the error's own fields give stay), and never its DETAIL, SQL or stack.
 * When the text is ambiguous, more is left out, not less. migrationFailureValues.db.test.ts
 * checks the same with real Postgres errors.
 */

const pgError = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message)), { severity: 'ERROR', ...fields });
/** What a log line holds for `err`: pino's err serializer, as the logger writes it. */
const asLogged = (err: unknown) => JSON.parse(JSON.stringify(pino.stdSerializers.err(dbErrorForLog(err) as Error)));

describe('withoutQuotedValues', () => {
  it('leaves out a quoted value, keeping the message\'s shape, whatever the class', () => {
    expect(withoutQuotedValues('invalid input syntax for type integer: "Rent to J. Smith, acct 12345"'))
      .toBe('invalid input syntax for type integer: "…"');
    expect(withoutQuotedValues('value "99999999999" is out of range for type integer')).toBe('value "…" is out of range for type integer');
    expect(withoutQuotedValues('syntax error at or near "12345"')).toBe('syntax error at or near "…"');
    expect(withoutQuotedValues('column "Smith 12345" does not exist')).toBe('column "…" does not exist');
  });

  it('leaves out a value that holds the quote itself, to its last quote', () => {
    expect(withoutQuotedValues('invalid input syntax for type integer: "Rent "J" Smith"')).toBe('invalid input syntax for type integer: "…"');
  });

  it("keeps the names the error's own fields give, when every quoted run is one", () => {
    expect(withoutQuotedValues('new row for relation "checked" violates check constraint "checked_positive"', ['public', 'checked', undefined, undefined, 'checked_positive']))
      .toBe('new row for relation "checked" violates check constraint "checked_positive"');
    expect(withoutQuotedValues('duplicate key value violates unique constraint "payees_name_key"', ['payees_name_key']))
      .toBe('duplicate key value violates unique constraint "payees_name_key"');
    // A name its fields don't give is left out like a value.
    expect(withoutQuotedValues('duplicate key value violates unique constraint "payees_name_key"')).toBe('duplicate key value violates unique constraint "…"');
  });

  it('leaves out every quoted run once one is a value: a value can look like a name followed by more', () => {
    expect(withoutQuotedValues('bad: "tags" Smith 12345 "x"', ['tags'])).toBe('bad: "…"');
    // A delete's message names the parent, which isn't in its fields: the child table and
    // the constraint are, so the report's Object line still names them.
    expect(withoutQuotedValues('update or delete on table "parents" violates foreign key constraint "kids_parent_fkey" on table "kids"', ['public', 'kids', 'kids_parent_fkey']))
      .toBe('update or delete on table "…"');
  });

  it('leaves out single-quoted values, an apostrophe right after a letter included, and keeps a contraction', () => {
    expect(withoutQuotedValues("Fix the payee 'Acme Plumbing' first")).toBe("Fix the payee '…' first");
    expect(withoutQuotedValues("payee'Smith' is bad")).toBe("payee'…' is bad");
    expect(withoutQuotedValues("x'Smith'y")).toBe("x'…'y");
    expect(withoutQuotedValues("it isn't there, and doesn't fit")).toBe("it isn't there, and doesn't fit");
    expect(withoutQuotedValues("it isn't 'Smith 12345'")).toBe("it isn't '…'");
    expect(withoutQuotedValues("payee O'Brien 12345")).toBe("payee O'…");
  });

  // A server with lc_messages set to another language quotes with its own marks: German
  // »…« and „…“, French « … », Japanese 「…」. Each was passed through as it was.
  it("leaves out what a translated server's messages quote, and keeps the names its fields give", () => {
    expect(withoutQuotedValues('ungültige Eingabesyntax für Typ integer: »Rent to J. Smith, acct 12345«'))
      .toBe('ungültige Eingabesyntax für Typ integer: »…«');
    expect(withoutQuotedValues('syntaxe en entrée invalide pour le type integer : « Rent to J. Smith »'))
      .toBe('syntaxe en entrée invalide pour le type integer : «…»');
    expect(withoutQuotedValues('Wert „Smith 12345“ ist außerhalb des gültigen Bereichs')).toBe('Wert „…“ ist außerhalb des gültigen Bereichs');
    expect(withoutQuotedValues('型integerの入力構文が無効です: 「Smith 12345」')).toBe('型integerの入力構文が無効です: 「…」');
    expect(withoutQuotedValues('Relation »tags« verletzt Check-Constraint »chk_tags_max_level«', ['public', 'tags', 'chk_tags_max_level']))
      .toBe('Relation »tags« verletzt Check-Constraint »chk_tags_max_level«');
    expect(withoutQuotedValues('la relation « tags » viole la contrainte « chk_tags_max_level »', ['tags', 'chk_tags_max_level']))
      .toBe('la relation « tags » viole la contrainte « chk_tags_max_level »');
    expect(withoutQuotedValues('Schlüssel »Smith 12345')).toBe('Schlüssel »…');
  });

  // Each kind of quote was masked in a pass of its own, so one pass could take in the
  // opening quote of another kind, whose closing one then left the value before it.
  it('masks every kind of quote at once, so one kind never hides where another opens', () => {
    expect(withoutQuotedValues("l'entrée «O'Brien 12345» est invalide")).toBe("l'…» est invalide");
    expect(withoutQuotedValues('payee "x «Smith" 12345»')).toBe('payee "…»');
    expect(withoutQuotedValues("valeur d'entrée invalide : « l'ami Smith 12345 »")).toBe("valeur d'…»");
  });

  it('leaves out what any parentheses hold, after a word too, and from an unpaired one to its end', () => {
    expect(withoutQuotedValues('Key (name)=(Acme Plumbing) already exists.')).toBe('Key (…)=(…) already exists.');
    expect(withoutQuotedValues('bad row(Smith, 12345) here')).toBe('bad row(…) here');
    expect(withoutQuotedValues('value too long for type character varying(10)')).toBe('value too long for type character varying(…)');
    expect(withoutQuotedValues('payee (account (old 12345)) is closed')).toBe('payee (…) is closed');
    expect(withoutQuotedValues('payee (Smith 12345 is closed')).toBe('payee (…');
    expect(withoutQuotedValues('Smith 12345) is closed')).toBe('…) is closed');
    expect(withoutQuotedValues('call f() returned')).toBe('call f() returned');
  });
});

describe('publicDbError, dbErrorForLog and dbErrorLine', () => {
  const duplicate = pgError({
    code: '23505',
    message: 'duplicate key value violates unique constraint "payees_name_key"',
    detail: 'Key (name)=(Acme Plumbing) already exists.',
    schema: 'public',
    table: 'payees',
    constraint: 'payees_name_key',
    internalQuery: "SELECT 'Acme Plumbing'",
    where: 'SQL statement "INSERT INTO payees VALUES (\'Acme Plumbing\')"\nPL/pgSQL function public.add_payee() line 3 at SQL statement',
    hint: "Remove 'Acme Plumbing' first",
  });

  it('keeps what failed and where, without the DETAIL, the SQL or the values', () => {
    expect(publicDbError(duplicate)).toEqual({
      code: '23505',
      message: 'duplicate key value violates unique constraint "payees_name_key"',
      hint: "Remove '…' first",
      where: 'PL/pgSQL function public.add_payee() line 3 at SQL statement',
      schema: 'public',
      table: 'payees',
      constraint: 'payees_name_key',
    });
    const logged = JSON.stringify(asLogged(duplicate));
    expect(logged).not.toMatch(/Acme|Plumbing|detail|internalQuery|SQL statement \\"/);
    expect(asLogged(duplicate)).toMatchObject({ type: 'DatabaseError', code: '23505', stack: 'DatabaseError: duplicate key value violates unique constraint "payees_name_key"' });
    expect(dbErrorLine(duplicate)).toBe('23505: duplicate key value violates unique constraint "payees_name_key"');
  });

  it('treats a SQLSTATE with a letter in its class as a database error: 2BP01, 0A000', () => {
    const dependents = pgError({
      code: '2BP01',
      message: 'cannot drop table memos because other objects depend on it',
      detail: 'view memo_view depends on table memos',
      hint: 'Use DROP ... CASCADE to drop the dependent objects too.',
      where: 'SQL statement "DROP TABLE memos /* Rent to J. Smith, acct 12345 */"\nPL/pgSQL function inline_code_block line 1 at EXECUTE',
      file: 'dependency.c',
      routine: 'reportDependentObjects',
    });
    expect(asLogged(dependents)).toEqual({
      type: 'DatabaseError',
      message: 'cannot drop table memos because other objects depend on it',
      stack: 'DatabaseError: cannot drop table memos because other objects depend on it',
      code: '2BP01',
      hint: 'Use DROP ... CASCADE to drop the dependent objects too.',
      where: 'PL/pgSQL function inline_code_block line 1 at EXECUTE',
    });
    const raised = pgError({ code: '0A000', message: 'payee "Acme Plumbing" (account 12345) is not supported', detail: 'Acme Plumbing' });
    expect(dbErrorLine(raised)).toBe('0A000: payee "…" (…) is not supported');
    expect(JSON.stringify(asLogged(raised))).not.toMatch(/Acme|12345/);
  });

  it('passes any other error through as it is', () => {
    const own = new Error('Migration 20260101000000 (a) has been modified!');
    expect(publicDbError(own)).toBeNull();
    expect(dbErrorForLog(own)).toBe(own);
    expect(dbErrorLine(own)).toBe('Migration 20260101000000 (a) has been modified!');
    const node = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(isDatabaseError(node)).toBe(false);
    expect(dbErrorLine(node)).toBe('EPIPE: write EPIPE');
    expect(dbErrorLine('a string')).toBe('a string');
  });

  it("knows node-postgres's DatabaseError: a five-character code and a severity", () => {
    for (const code of ['22P02', '23505', 'P0001', '42703', '42P01', '2BP01', '0A000', '3D000', '0LP01', 'XX000']) {
      expect(isDatabaseError({ code, severity: 'ERROR' }), code).toBe(true);
    }
    expect(isDatabaseError({ code: '2BP01' })).toBe(false);
    expect(isDatabaseError({ code: 'ECONNREFUSED', severity: 'ERROR' })).toBe(false);
    expect(isDatabaseError({ code: 2350, severity: 'ERROR' })).toBe(false);
  });

  it("keeps only the context's function lines", () => {
    expect(functionContext('SQL statement "UPDATE t SET a = 4242"\nPL/pgSQL function public.f() line 3 at SQL statement\nSQL function "g" statement 1'))
      .toBe('PL/pgSQL function public.f() line 3 at SQL statement; SQL function "g" statement 1');
    expect(functionContext(undefined)).toBeUndefined();
  });
});
