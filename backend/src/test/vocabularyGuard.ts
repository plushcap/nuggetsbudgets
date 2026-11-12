import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { CONTROL_PLANE_VOCABULARIES, TENANT_VOCABULARIES } from '@nuggets/shared';

/**
 * Finds a list's value written out where the code compares or sets a field that has a list
 * (vocabulary.ts: `table.column` and its values), in a package's sources, with its own
 * TypeScript program so it can tell a field with a list from a listless one of the same name.
 *
 * What it reads:
 * - `x.status === 'archived'` (and `!==`, `==`, `!=`, through `String(…)`, `.toLowerCase()`,
 *   `?.`, `!`, `as`), a `case` of a switch on one, and `['archived', 'paused'].includes(x.status)`;
 * - a Kysely condition: `.where('status', '=', 'archived')`, `.where('status', 'in', [...])`,
 *   `eb('status', '!=', …)`, `.orWhere`, `.having`;
 * - in the files named clean (`writes`), also every list's value written out anywhere else
 *   (`status: 'cleared'` in an insert, a default, `let matchingMethod = 'none'`) unless its
 *   type says it is another list (a bulk row's `'created' | 'skipped' | 'failed'`), and a value
 *   quoted in SQL text. No value is let through for being a common word.
 *
 * Which fields have a list, by the field's name and its table or type, never by file:
 * 1. a field typed as string literals (a stored value's open `string & {}` aside): a list's
 *    field when the list holds them all (`TransactionStatus`), a listless one otherwise
 *    (`'idle' | 'running' | 'completed'`, a budget period's `'active' | 'closed' | 'upcoming'`);
 * 2. a field declared in a database row (schema.generated.ts) or in a type or schema named for
 *    a table (`categoryResponseSchema`, `interface Organization`): that table's column;
 * 3. a field of an object whose type is named for a table: that table's;
 * 4. a Kysely condition: the tables of the query it is on, through its aliases (`tenants as t`);
 * 5. else, by its name alone (a raw SQL row, an untyped object): a column with a list.
 */

const VOCABULARY: Record<string, readonly string[]> = { ...TENANT_VOCABULARIES, ...CONTROL_PLANE_VOCABULARIES };
const LIST_COLUMNS = new Set(Object.keys(VOCABULARY).map((key) => key.split('.')[1]!));

/** schema.generated.ts: the tables, and the interface each row type is. */
const SCHEMA = resolve(import.meta.dirname, '..', 'db', 'schema.generated.ts');
const TABLE_OF_INTERFACE = new Map<string, string>();
for (const [, table, iface] of readFileSync(SCHEMA, 'utf8').matchAll(/^ {2}(\w+): (\w+);$/gm)) {
  if (table && iface) TABLE_OF_INTERFACE.set(iface, table);
}
const TABLES = new Set(TABLE_OF_INTERFACE.values());
/** A type or table name without case, underscores or a plural: `BudgetPeriod`, `budget_period`, `transactions`. */
const normal = (name: string) => name.toLowerCase().replace(/_/g, '').replace(/(ies)$/, 'y').replace(/s$/, '');
const TABLE_OF_NAME = new Map([...TABLES].map((table) => [normal(table), table]));

const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** The list columns a field name names: itself, or the column it ends with (`syncStatus`, `newReviewStatus`). */
function columnsNamed(name: string): string[] {
  const n = snake(name);
  return [...LIST_COLUMNS].filter((column) => n === column || n.endsWith(`_${column}`));
}

/** The lists of `column` in `tables` (or every table) that hold `value`. */
function listsHolding(columns: string[], value: string, tables?: readonly string[]): string[] {
  return Object.entries(VOCABULARY)
    .filter(([key, values]) => {
      const [table, column] = key.split('.') as [string, string];
      return columns.includes(column) && values.includes(value) && (!tables || tables.includes(table));
    })
    .map(([key]) => key);
}

export interface Finding {
  where: string;
  value: string;
  why: string;
}

export interface GuardOptions {
  /** The package's tsconfig for its sources. */
  tsconfig: string;
  /** Its source root; the paths found are relative to it. */
  root: string;
  /** Files (relative to `root`) that take every value from the lists, writes and SQL included. */
  writes?: readonly string[];
  /** Extra source files to check, beside the program's own (a probe). */
  probes?: Record<string, string>;
}

const PROGRAMS = new Map<string, ts.Program>();

/** The package's program (built once), or one with `probes` added, reusing it. */
function programFor(tsconfig: string, probes: Record<string, string> = {}): ts.Program {
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (!parsed) throw new Error(`Can't read ${tsconfig}`);
  const options = { ...parsed.options, noEmit: true };
  let base = PROGRAMS.get(tsconfig);
  if (!base) {
    base = ts.createProgram({ rootNames: parsed.fileNames, options });
    PROGRAMS.set(tsconfig, base);
  }
  if (Object.keys(probes).length === 0) return base;
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => probes[resolve(file)] ?? readFile(file);
  host.fileExists = (file) => resolve(file) in probes || fileExists(file);
  host.getSourceFile = (file, language, onError, create) =>
    resolve(file) in probes ? ts.createSourceFile(file, probes[resolve(file)]!, language, true) : getSourceFile(file, language, onError, create);
  return ts.createProgram({ rootNames: [...parsed.fileNames, ...Object.keys(probes)], options, host, oldProgram: base });
}

export function vocabularyFindings(options: GuardOptions): Finding[] {
  const root = resolve(options.root);
  const probes = Object.fromEntries(Object.entries(options.probes ?? {}).map(([rel, text]) => [resolve(root, rel), text]));
  const program = programFor(options.tsconfig, probes);
  const checker = program.getTypeChecker();
  const writes = new Set((options.writes ?? []).map((rel) => resolve(root, rel)));
  const findings: Finding[] = [];

  for (const sf of program.getSourceFiles()) {
    const file = resolve(sf.fileName);
    if (sf.isDeclarationFile || !file.startsWith(root + sep) || /[\\/](__tests__|test)[\\/]|\.test\.tsx?$/.test(file)) continue;
    if (Object.keys(probes).length > 0 && !(file in probes)) continue;
    const rel = relative(root, file).split(sep).join('/');
    const at = (node: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
    const found = (node: ts.Node, value: string, why: string) => findings.push({ where: at(node), value, why });

    /** The expression a comparison reads, through parentheses, `!`, `as`, String(…) and .toLowerCase(). */
    const unwrap = (node: ts.Expression): ts.Expression => {
      let e = node;
      for (;;) {
        if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
        else if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'String' && e.arguments[0]) e = e.arguments[0];
        else if (
          ts.isCallExpression(e) && e.arguments.length === 0 && ts.isPropertyAccessExpression(e.expression) &&
          ['toLowerCase', 'toUpperCase', 'trim', 'toString'].includes(e.expression.name.text)
        ) e = e.expression.expression;
        else break;
      }
      return e;
    };
    const nameOf = (e: ts.Expression): string | undefined => {
      if (ts.isIdentifier(e)) return e.text;
      if (ts.isPropertyAccessExpression(e)) return e.name.text;
      if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
      return undefined;
    };

    /**
     * The string literal values a type is made of, or undefined when it isn't only those. A stored
     * value's open branch (`string & {}`, responses.ts storedValue) doesn't count.
     */
    const literalValues = (type: ts.Type): string[] | undefined => {
      const open = (t: ts.Type) => t.isIntersection() && t.types.some((part) => part.flags & ts.TypeFlags.String);
      const parts = (type.isUnion() ? type.types : [type]).filter((t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) && !open(t));
      if (parts.length === 0 || !parts.every((t) => t.isStringLiteral())) return undefined;
      return parts.map((t) => (t as ts.StringLiteralType).value);
    };

    /**
     * The table a type or schema's name is for: `BudgetPeriod`, `categoryResponseSchema`,
     * `TransactionRow`, or the one table whose name ends with it (`syncLog` is import_sync_log's).
     */
    const tableOfName = (name: string): string | undefined => {
      const n = normal(name.replace(/(Response)?Schema$|Response$|Row$|Input$/, ''));
      const exact = TABLE_OF_NAME.get(n);
      if (exact || n.length < 5) return exact;
      const ending = [...TABLE_OF_NAME].filter(([table]) => table.endsWith(n));
      return ending.length === 1 ? ending[0]![1] : undefined;
    };

    /** The table a field's declaration belongs to: a row interface's, or a named type's or schema's. */
    const tableOfDeclaration = (decl: ts.Declaration | undefined): string | undefined => {
      if (!decl) return undefined;
      if (resolve(decl.getSourceFile().fileName) === SCHEMA) {
        const owner = decl.parent;
        return ts.isInterfaceDeclaration(owner) ? TABLE_OF_INTERFACE.get(owner.name.text) : undefined;
      }
      for (let n: ts.Node | undefined = decl.parent; n; n = n.parent) {
        // A list of rows held in a field named for their table (a page's `syncLogs`).
        if ((ts.isPropertySignature(n) || ts.isPropertyAssignment(n)) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) {
          const table = tableOfName(n.name.text);
          if (table) return table;
          continue;
        }
        if ((ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isClassDeclaration(n)) && n.name) return tableOfName(n.name.text);
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return tableOfName(n.name.text);
        if (ts.isFunctionLike(n) || ts.isSourceFile(n)) return undefined;
      }
      return undefined;
    };

    /** The table a type is a row of, by its declaration or its name. */
    const tableOfType = (type: ts.Type): string | undefined => {
      // Kysely's row types: Selectable<BudgetPeriod> is a budget_period row.
      const rowOf = type.aliasSymbol && ['Selectable', 'Insertable', 'Updateable'].includes(type.aliasSymbol.name) ? type.aliasTypeArguments?.[0] : undefined;
      if (rowOf) return tableOfType(rowOf);
      const symbol = type.aliasSymbol ?? type.getSymbol();
      if (!symbol || symbol.name.startsWith('__')) return undefined;
      const declaredIn = symbol.declarations?.[0]?.getSourceFile().fileName;
      if (declaredIn && resolve(declaredIn) === SCHEMA) return TABLE_OF_INTERFACE.get(symbol.name);
      return tableOfName(symbol.name);
    };

    /** Why `literal`, compared with or set for the field `expr` reads, is a list's value written out, or undefined. */
    const fieldProblem = (expr: ts.Expression, value: string): string | undefined => {
      const e = unwrap(expr);
      const name = nameOf(e);
      if (!name) return undefined;
      const columns = columnsNamed(name);
      if (listsHolding(columns, value).length === 0) return undefined;
      // 1. Typed as literals: a list's field when the list holds them all.
      const literals = literalValues(checker.getTypeAtLocation(e));
      if (literals) {
        const lists = Object.entries(VOCABULARY).filter(([, values]) => literals.every((v) => values.includes(v)) && values.includes(value));
        return lists.length > 0 ? `${lists.map(([k]) => k).join(' / ')} '${value}'` : undefined;
      }
      // 2-3. A row's field: its table's column, by the field's declaration, or the row type's.
      if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
        const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e.argumentExpression);
        const table = tableOfDeclaration(symbol?.declarations?.[0]) ?? tableOfType(checker.getTypeAtLocation(e.expression));
        if (table) {
          const lists = listsHolding(columns, value, [table]);
          return lists.length > 0 ? `${lists.join(' / ')} '${value}'` : undefined;
        }
      }
      // 5. By its name.
      return `${listsHolding(columns, value).join(' / ')} '${value}' (by its name)`;
    };

    /**
     * The tables a Kysely builder (or expression builder) works on, by the names the query uses
     * for them (a table's own, or its alias: `tenants as t` is `t`), when its type says.
     */
    const tablesOfBuilder = (builder: ts.Expression): Map<string, string> | undefined => {
      const type = checker.getTypeAtLocation(builder);
      const args = (type.flags & ts.TypeFlags.Object) && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)
        ? checker.getTypeArguments(type as ts.TypeReference)
        : type.aliasTypeArguments ?? [];
      const [db, ...rest] = args;
      for (const arg of rest) {
        const names = literalValues(arg);
        if (!names || names.length === 0) continue;
        const tables = new Map<string, string>();
        for (const name of names) {
          if (TABLES.has(name)) tables.set(name, name);
          else {
            // An alias: the database type the query carries has it as a property of the table's row type.
            const prop = db && checker.getPropertyOfType(db, name);
            const row = prop && checker.getTypeOfSymbol(prop).getSymbol()?.name;
            const table = row ? TABLE_OF_INTERFACE.get(row) : undefined;
            if (table) tables.set(name, table);
          }
        }
        // The names it could tell (a left join's nullable row may not say).
        if (tables.size > 0) return tables;
      }
      return undefined;
    };

    /** A Kysely condition's column and value: `.where('t.status', '=', 'x')`, `eb('status', 'in', [...])`. */
    const kyselyCondition = (call: ts.CallExpression) => {
      const [column, op, value] = call.arguments;
      if (!column || !op || !value || !ts.isStringLiteralLike(column) || !ts.isStringLiteralLike(op)) return;
      const callee = call.expression;
      const builder = ts.isPropertyAccessExpression(callee) && ['where', 'orWhere', 'having'].includes(callee.name.text)
        ? callee.expression
        : ts.isIdentifier(callee) && callee.text === 'eb' ? callee : undefined;
      if (!builder) return;
      const [qualifier, columnName] = column.text.includes('.') ? (column.text.split('.') as [string, string]) : [undefined, column.text];
      const columns = columnsNamed(columnName).filter((c) => c === columnName);
      const literals = ts.isStringLiteralLike(value) ? [value] : ts.isArrayLiteralExpression(value) ? value.elements.filter(ts.isStringLiteralLike) : [];
      const named = tablesOfBuilder(builder);
      const table = qualifier !== undefined ? named?.get(qualifier) : undefined;
      // A qualified column: its table, when the query says; an unqualified one: every table it says.
      const tables = qualifier !== undefined ? (table ? [table] : undefined) : named ? [...new Set(named.values())] : undefined;
      for (const literal of literals) {
        const lists = listsHolding(columns, literal.text, tables);
        if (lists.length > 0) found(literal, literal.text, `${lists.join(' / ')} '${literal.text}' in a Kysely condition${tables ? '' : ' (by its column)'}`);
      }
    };

    const isEquality = (kind: ts.SyntaxKind) =>
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(kind);

    /** In a clean file: a list's value set where a field is, or quoted in SQL text. */
    const writtenOut = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const parent = node.parent;
        // A shared enum's member (`transactionType.enum['starting balance']`) is the shared value.
        if (ts.isElementAccessExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === 'enum') return;
        if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isLiteralTypeNode(parent) || ts.isExternalModuleReference(parent)) return;
        // Every list's value written out, whatever it is set for (`let matchingMethod = 'none'`
        // reaches budget_matching_method), unless a type says it is another list's than a
        // vocabulary's: its contextual type is literals no list holds (a bulk row's 'failed').
        const lists = Object.entries(VOCABULARY).filter(([, values]) => values.includes(node.text)).map(([key]) => key);
        if (lists.length > 0) {
          // What it is set for or compared with: the contextual type, or the compared side's.
          const compared = ts.isBinaryExpression(parent) && isEquality(parent.operatorToken.kind)
            ? checker.getTypeAtLocation(parent.left === node ? parent.right : parent.left)
            : undefined;
          const contextual = compared ?? checker.getContextualType(node);
          const literals = contextual ? literalValues(contextual) ?? literalValues(checker.getBaseConstraintOfType(contextual) ?? contextual) : undefined;
          const listless = literals && !Object.values(VOCABULARY).some((values) => literals.every((v) => values.includes(v)));
          if (!listless) found(node, node.text, `${lists.join(' / ')} '${node.text}' written out`);
        }
      }
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        for (const [, value] of node.text.matchAll(/'([^']*)'/g)) {
          if (value === undefined) continue;
          const lists = Object.entries(VOCABULARY).filter(([, values]) => values.includes(value)).map(([key]) => key);
          if (lists.length > 0) found(node, value, `${lists.join(' / ')} '${value}' quoted in SQL text`);
        }
      }
    };

    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && isEquality(node.operatorToken.kind)) {
        for (const [literal, other] of [[node.right, node.left], [node.left, node.right]] as const) {
          if (ts.isStringLiteralLike(literal)) {
            const why = fieldProblem(other, literal.text);
            if (why) found(literal, literal.text, `${why}, compared`);
          }
        }
      }
      if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression)) {
        const why = fieldProblem(node.parent.parent.expression, node.expression.text);
        if (why) found(node.expression, node.expression.text, `${why}, a case`);
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        // ['archived', 'paused'].includes(item.status)
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'includes' && node.arguments[0]) {
          const list = unwrapArray(callee.expression);
          if (list) {
            for (const literal of list.elements.filter(ts.isStringLiteralLike)) {
              const why = fieldProblem(node.arguments[0], literal.text);
              if (why) found(literal, literal.text, `${why}, in a list it is looked up in`);
            }
          }
        }
        kyselyCondition(node);
      }
      if (writes.has(file)) writtenOut(node);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return findings;
}

function unwrapArray(node: ts.Expression): ts.ArrayLiteralExpression | undefined {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return ts.isArrayLiteralExpression(e) ? e : undefined;
}

/** A package's tsconfig for its sources, from the repository root. */
export const packageConfig = (pkg: 'backend' | 'frontend' | 'mcp') => {
  const repo = resolve(import.meta.dirname, '..', '..', '..');
  const file = { backend: 'backend/tsconfig.build.json', frontend: 'frontend/tsconfig.app.json', mcp: 'mcp/tsconfig.build.json' }[pkg];
  const tsconfig = resolve(repo, file);
  return { tsconfig, root: resolve(dirname(tsconfig), 'src') };
};
