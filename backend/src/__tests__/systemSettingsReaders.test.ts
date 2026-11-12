import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { getDirname } from '../utils/esm-compat.js';

/**
 * system_settings is read and written only through services/systemSettings.ts: the
 * helpers run in the caller's transaction, or on the connection it names (globalDb, a
 * service's own pool), so a reader can't land on the wrong one by accident, and a change to
 * the table's shape has one place to go.
 *
 * So the table's name appears nowhere else in the backend's code (tests aside): no string,
 * template or identifier outside those files names it, in any case, whatever the query
 * looks like around it (matching SQL's shapes missed a leading comment, `table …`,
 * `explain`, a parenthesized select, concatenation, a nested sql fragment and
 * `public.system_settings`, and flagged SQL quoted in a doc comment). The file is parsed with
 * TypeScript, so comments are never read. The few other mentions are listed below, each with
 * why it is there.
 *
 * services/secretRewrap.ts is allowed whole: rewrap-secrets re-encrypts every encrypted
 * column of every table through one generic path (REWRAP_TARGETS, the table and column as
 * data, each row locked and rewritten under its own key id), so system_settings is one of its
 * targets rather than a caller of these helpers. A path of its own there would split the one
 * rewrap and the checks that every target is covered.
 */
const SRC = path.join(getDirname(import.meta.url), '..');
const ALLOWED_FILES = new Set(['services/systemSettings.ts', 'services/secretRewrap.ts']);
/** Mentions outside those files that are not queries: the file, the token's exact text, and why. */
const ALLOWED_MENTIONS: ReadonlyArray<{ file: string; text: string; reason: string }> = [
  {
    file: 'db/schema.generated.ts',
    text: 'system_settings',
    reason: "kysely-codegen's key for the table in the DB interface: a type, which no query is",
  },
];

/** The tokens a name can be in: identifiers, and every kind of string, template and regex text. */
const NAMED_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
]);
const TABLE = /system_settings/i;

/** Each token of `text` (TypeScript) that names the table: its 1-based line and its text. */
function mentions(text: string, fileName = 'probe.ts'): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (NAMED_KINDS.has(node.kind)) {
      const tokenText = node.getText(source);
      if (TABLE.test(tokenText)) found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: tokenText });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
const mentionLines = (text: string) => [...new Set(mentions(text).map((m) => m.line))].sort((a, b) => a - b);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'test' ? [] : sources(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('system_settings readers', () => {
  it('only services/systemSettings.ts names system_settings in code', () => {
    const used = new Set<string>();
    const hits = sources(SRC)
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
      .filter((file) => !ALLOWED_FILES.has(file))
      .flatMap((file) =>
        mentions(readFileSync(path.join(SRC, file), 'utf8'), file)
          .filter((m) => {
            const allowed = ALLOWED_MENTIONS.find((a) => a.file === file && a.text === m.text);
            if (allowed) used.add(`${allowed.file} ${allowed.text}`);
            return !allowed;
          })
          .map((m) => `${file}:${m.line}`)
      );
    expect(hits).toEqual([]);
    // Each allowed mention is still there: one gone is taken off the list.
    expect(ALLOWED_MENTIONS.filter((a) => !used.has(`${a.file} ${a.text}`))).toEqual([]);
  });

  it('catches the name in any string, template or identifier, whatever the query looks like', () => {
    const shapes = [
      `await globalDb.selectFrom('system_settings')`,
      `await globalDb\n  .selectFrom(\n    'system_settings'\n  )`,
      `db.selectFrom('public.system_settings').selectAll()`,
      `'SELECT setting_value FROM system_settings WHERE setting_key = $1'`,
      'await pool.query(`\n  -- the deployment settings\n  select setting_value from system_settings`)',
      `await pool.query('/* settings */ select setting_value from system_settings')`,
      `await pool.query('table system_settings')`,
      `await pool.query('explain select * from system_settings')`,
      `await pool.query('(select setting_value from system_settings) union (select 1)')`,
      `await pool.query('select setting_value ' + 'from system_settings')`,
      'await sql`select ${sql`setting_value`} from system_settings`.execute(db)',
      'await sql`select ${sql`x`} from ${sql.table(\'system_settings\')}`.execute(db)',
      `sql.raw('select * from system_settings')`,
      `const q = "select 1 from users u join system_settings s on true"`,
      `pool.query('select * from public."system_settings"')`,
      `pool.query('SELECT * FROM SYSTEM_SETTINGS')`,
      `const target = { table: 'system_settings', column: 'setting_value' };`,
      `type T = DB['system_settings'];`,
      `const t = db.system_settings;`,
      `const re = /from system_settings/;`,
    ];
    for (const shape of shapes) expect(mentionLines(shape), shape).not.toEqual([]);
    expect(mentionLines(`await globalDb\n  .selectFrom(\n    'system_settings'\n  )`)).toEqual([3]);
    expect(mentionLines('client.query(`\n  select setting_value\n    from public.system_settings`)')).toEqual([1]);
  });

  it('reads no comment, and names no other table', () => {
    expect(mentionLines('/**\n * Was read with `select setting_value from system_settings` once.\n */')).toEqual([]);
    expect(mentionLines('/**\n * `update system_settings` happens only in services/systemSettings.ts.\n */\nconst x = 1;')).toEqual([]);
    expect(mentionLines('// SELECT * FROM system_settings\nconst y = 2;')).toEqual([]);
    expect(mentionLines(`import { readSetting } from '../services/systemSettings.js';`)).toEqual([]);
    expect(mentionLines(`await globalDb.selectFrom('settings_history')`)).toEqual([]);
    expect(mentionLines(`interface SystemSettings { id: number }`)).toEqual([]);
  });
});
