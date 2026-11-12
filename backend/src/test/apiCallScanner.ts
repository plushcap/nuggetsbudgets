import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { INTEGER_ID_PARAMS, UUID_PARAMS, isIntegerId, isUuid } from '../middleware/routeParams.js';

/**
 * Finds the API calls the frontend and the MCP tools make, by reading their source.
 * apiContract.test.ts matches each one against the live route table.
 *
 * The calls: the frontend's request helpers (apiGet, apiPost, …, downloadCsv) and its raw
 * `fetch(\`${API_BASE_URL}/…\`, { method })` calls; the links the browser opens itself
 * (`window.open(url)`, an element's `href`), as GETs; the MCP client's get/post/put/patch/
 * delete/request.
 *
 * A path is read from the call's first argument: a string, a template (each `${…}` that
 * isn't itself a string becomes a placeholder), `a + b`, `c ? a : b` (both branches), a
 * `const` declared in the same file, a parameter typed as a union of strings, or
 * apiPath`…`; @nuggets/shared's queryString(…) is a query. Everything from the first `?` or
 * `#` is the query and is dropped. A call
 * whose path can't be read this way (a parameter, `let`, a placeholder glued to text, more
 * than 64 possible paths, a fetch whose method isn't written in the call) is reported as
 * unreadable, so a new one has to be made readable or listed on purpose.
 */

export interface ApiCall {
  method: string; // upper case
  /** The path with `/api`, each placeholder as `{}`; undefined when it can't be read. */
  paths: string[] | undefined;
  file: string; // relative to the repository root
  line: number;
  text: string; // the call's source, for messages
}

/** `table[key]` for the table's own entries only (never `toString` and the like). */
const own = <T>(table: Record<string, T> | undefined, key: string): T | undefined =>
  table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;

/** A placeholder for a value the scanner can't know (a uuid, a parameter). */
export const PLACEHOLDER = '\u0001';
/**
 * A value the scanner can't know that could hold a `/` and so reach another route:
 * one that isn't encodeURIComponent(…), a number or something named for an id or uuid.
 * In a path (not the query) it makes the call unreadable, until it is encoded.
 */
const MAYBE_SEGMENTS = '\u0002';

/** Is `expr` a value that is one path segment however it reads: encoded, a number, an id or a uuid? */
function oneSegment(expr: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) return oneSegment(expr.expression);
  if (ts.isNumericLiteral(expr)) return true;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    if (expr.expression.text === 'encodeURIComponent') return true;
    const [arg] = expr.arguments;
    return (expr.expression.text === 'String' || expr.expression.text === 'Number') && arg !== undefined && oneSegment(arg);
  }
  if (ts.isIdentifier(expr)) {
    // A parameter typed as a union of strings without a `/` (`action?: 'start' | 'stop'`).
    const binding = bindingOf(expr);
    const values = binding?.kind === 'parameter' ? literalUnion(binding.declaration.type) : undefined;
    if (values && values.every((v) => !v.includes('/'))) return true;
  }
  const name = ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : undefined;
  return name !== undefined && /(?:^|[a-z_])(?:id|Id|ID|uuid|Uuid|UUID)$/.test(name);
}
const placeholderFor = (expr: ts.Expression) => (oneSegment(expr) ? PLACEHOLDER : MAYBE_SEGMENTS);
const MAX_VARIANTS = 64;

/** The frontend's request helpers (services/api/base.ts), by the method each sends. */
export const FRONTEND_HELPERS: Record<string, string> = {
  apiGet: 'GET',
  apiPost: 'POST',
  apiPut: 'PUT',
  apiPatch: 'PATCH',
  apiDelete: 'DELETE',
  apiPostFormData: 'POST',
  apiPutFormData: 'PUT',
  downloadCsv: 'GET', // services/api/investments.ts: an authenticated CSV download
};

/** Where each helper is defined: only there is its own forwarding call skipped. */
const HELPER_HOMES: Record<string, string> = {
  ...Object.fromEntries(Object.keys(FRONTEND_HELPERS).map((name) => [name, 'frontend/src/services/api/base.ts'])),
  downloadCsv: 'frontend/src/services/api/investments.ts',
};

/**
 * The name of the function `node` is directly in (`const name = () => …` or `function
 * name`), not counting functions around that one: undefined inside an anonymous callback.
 */
function enclosingFunctionName(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!ts.isFunctionLike(n)) continue;
    if (ts.isFunctionDeclaration(n)) return n.name?.text;
    const decl = n.parent;
    return decl && ts.isVariableDeclaration(decl) && decl.initializer === n && ts.isIdentifier(decl.name)
      ? decl.name.text
      : undefined;
  }
  return undefined;
}

/** NuggetsApiClient's methods (mcp/src/client.ts). `request` takes the method first. */
const CLIENT_METHODS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
};

type Values = string[] | undefined; // undefined: a value the scanner can't know

/** Too many possible paths to list: the call is reported as unreadable, not guessed at. */
class TooManyVariants extends Error {}

function cross(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (const x of a) for (const y of b) out.push(x + y);
  if (out.length > MAX_VARIANTS) throw new TooManyVariants();
  return out;
}

/** The frontend's base for API URLs (services/api/base.ts API_BASE_URL is config.apiBaseUrl, '/api'). */
const API_BASE_NAMES: Record<string, string> = { API_BASE_URL: '/api' };

type Binding =
  | { kind: 'const'; initializer: ts.Expression }
  | { kind: 'parameter'; declaration: ts.ParameterDeclaration }
  | { kind: 'other' } // let, var, a destructured name, a function or loop variable
  | undefined; // not declared in this file (an import or a global)

/** Does a binding (`x`, `{ a, b: [c] }`) declare `name`? */
function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, name));
}

/** A `var` named `name` anywhere in this function's body (var is hoisted), not in nested functions. */
function hoistedVar(scope: ts.Node, name: string): boolean {
  let found = false;
  ts.forEachChild(scope, function visit(child) {
    if (found || ts.isFunctionLike(child)) return;
    if (
      ts.isVariableDeclaration(child) &&
      ts.isVariableDeclarationList(child.parent) &&
      (child.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0 &&
      bindsName(child.name, name)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  });
  return found;
}

/** Does `node` declare `name` in its own scope (not in a nested function)? */
function bindingIn(scope: ts.Node, name: string, use: ts.Identifier): Binding {
  if (ts.isFunctionLike(scope)) {
    for (const param of scope.parameters) {
      if (ts.isIdentifier(param.name) && param.name.text === name) return { kind: 'parameter', declaration: param };
      if (bindsName(param.name, name)) return { kind: 'other' };
    }
  }
  // A function or class expression's own name is bound inside it (`function f() { f(); }`),
  // and a catch clause's variable inside the clause.
  if ((ts.isFunctionExpression(scope) || ts.isClassExpression(scope)) && scope.name?.text === name) return { kind: 'other' };
  if (ts.isCatchClause(scope) && scope.variableDeclaration && bindsName(scope.variableDeclaration.name, name)) return { kind: 'other' };
  if ((ts.isFunctionLike(scope) || ts.isSourceFile(scope)) && hoistedVar(scope, name)) return { kind: 'other' };
  let found: Binding;
  ts.forEachChild(scope, function visit(child) {
    if (found) return;
    if (ts.isVariableStatement(child) || ts.isVariableDeclarationList(child)) {
      ts.forEachChild(child, visit);
      return;
    }
    if (ts.isVariableDeclaration(child)) {
      if (ts.isIdentifier(child.name)) {
        if (child.name.text !== name) return;
        const isConst = ts.isVariableDeclarationList(child.parent) && (child.parent.flags & ts.NodeFlags.Const) !== 0;
        found = isConst && child.initializer && child.getStart() < use.getStart()
          ? { kind: 'const', initializer: child.initializer }
          : { kind: 'other' };
      } else if (bindsName(child.name, name)) {
        found = { kind: 'other' };
      }
      return;
    }
    if ((ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child)) && child.name?.text === name) {
      found = { kind: 'other' };
    }
  });
  return found;
}

/** What `use` refers to: the innermost declaration of its name, walking out from it. */
function bindingOf(use: ts.Identifier): Binding {
  for (let scope: ts.Node | undefined = use.parent; scope; scope = scope.parent) {
    const found = bindingIn(scope, use.text, use);
    if (found) return found;
  }
  return undefined;
}

/** A parameter typed as a union of string literals ('start' | 'stop'): its values. */
function literalUnion(type: ts.TypeNode | undefined): string[] | undefined {
  if (!type) return undefined;
  const members = ts.isUnionTypeNode(type) ? type.types : [type];
  const values: string[] = [];
  for (const m of members) {
    if (!ts.isLiteralTypeNode(m) || !ts.isStringLiteral(m.literal)) return undefined;
    values.push(m.literal.text);
  }
  return values;
}

/** A call of `queryString` imported (by that name) from @nuggets/shared. */
function isSharedQueryString(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== 'queryString') return false;
  if (bindingOf(expr.expression) !== undefined) return false; // a local function, parameter or name of that name
  return expr.getSourceFile().statements.some((st) =>
    ts.isImportDeclaration(st) &&
    ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === '@nuggets/shared' &&
    st.importClause !== undefined && !st.importClause.isTypeOnly &&
    st.importClause.namedBindings !== undefined && ts.isNamedImports(st.importClause.namedBindings) &&
    st.importClause.namedBindings.elements.some((el) => el.name.text === 'queryString' && el.propertyName === undefined && !el.isTypeOnly)
  );
}

/** shared's queryString(…), or a const in this file that holds one (`const q = queryString(…)`). */
function isQueryValue(expr: ts.Expression, depth = 0): boolean {
  if (depth > 8) return false;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) return isQueryValue(expr.expression, depth + 1);
  if (isSharedQueryString(expr)) return true;
  if (!ts.isIdentifier(expr)) return false;
  const binding = bindingOf(expr);
  return binding?.kind === 'const' && isQueryValue(binding.initializer, depth + 1);
}

function evaluate(expr: ts.Expression, depth = 0): Values {
  if (depth > 8) return undefined;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
    return evaluate(expr.expression, depth + 1);
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (ts.isTaggedTemplateExpression(expr)) {
    // apiPath`…` encodes each value as one segment; its strings are the path.
    return ts.isIdentifier(expr.tag) && expr.tag.text === 'apiPath' ? evaluate(expr.template, depth + 1) : undefined;
  }
  if (ts.isTemplateExpression(expr)) {
    let out: string[] = [expr.head.text];
    for (const [i, span] of expr.templateSpans.entries()) {
      if (isQueryValue(span.expression)) {
        // @nuggets/shared's queryString(schema, values): '' or a query ('?a=1'), which is
        // dropped; so only as the very end of a path, where nothing follows it.
        if (i !== expr.templateSpans.length - 1 || span.literal.text !== '') return undefined;
        out = cross(out, ['', '?']);
        continue;
      }
      const value = evaluate(span.expression, depth + 1) ?? [placeholderFor(span.expression)];
      out = cross(cross(out, value), [span.literal.text]);
    }
    return out;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluate(expr.left, depth + 1) ?? [placeholderFor(expr.left)];
    const right = evaluate(expr.right, depth + 1) ?? [placeholderFor(expr.right)];
    return cross(left, right);
  }
  if (ts.isConditionalExpression(expr)) {
    const a = evaluate(expr.whenTrue, depth + 1) ?? [placeholderFor(expr.whenTrue)];
    const b = evaluate(expr.whenFalse, depth + 1) ?? [placeholderFor(expr.whenFalse)];
    const both = [...new Set([...a, ...b])];
    if (both.length > MAX_VARIANTS) throw new TooManyVariants();
    return both;
  }
  if (ts.isIdentifier(expr)) {
    const binding = bindingOf(expr);
    if (!binding) return own(API_BASE_NAMES, expr.text) !== undefined ? [API_BASE_NAMES[expr.text]] : undefined;
    if (binding.kind === 'const') return evaluate(binding.initializer, depth + 1);
    // An optional parameter can also be undefined (`/scheduler/undefined`): an unknown value.
    if (binding.kind === 'parameter') {
      return binding.declaration.questionToken ? undefined : literalUnion(binding.declaration.type);
    }
    return undefined;
  }
  return undefined;
}

/** A path as the router sees it: the query dropped, `{}` for each placeholder. */
function toPath(value: string): string | undefined {
  const cut = value.search(/[?#]/);
  const pathPart = cut === -1 ? value : value.slice(0, cut);
  if (!pathPart.startsWith('/')) return undefined; // a placeholder or relative text first
  const segments = pathPart.split('/');
  // A placeholder glued to other text (`${base}${endpoint}`, `/x-${id}`) can't be matched
  // segment by segment, and a value that could hold a `/` (MAYBE_SEGMENTS) could reach
  // another route: the call is unreadable.
  if (pathPart.includes(MAYBE_SEGMENTS)) return undefined;
  if (segments.some((seg) => seg.includes(PLACEHOLDER) && seg !== PLACEHOLDER)) return undefined;
  return pathPart.replaceAll(PLACEHOLDER, '{}');
}

function readPaths(arg: ts.Expression | undefined, prefix: string): string[] | undefined {
  if (!arg) return undefined;
  let values: Values;
  try {
    values = evaluate(arg);
  } catch (err) {
    if (err instanceof TooManyVariants) return undefined;
    throw err;
  }
  if (!values) return undefined;
  const paths = values.map((v) => toPath(prefix + v));
  if (paths.some((p) => p === undefined)) return undefined;
  return [...new Set(paths as string[])];
}

/** The one test support folder the scan skips (besides __tests__ folders). */
export const TEST_SUPPORT_DIR = 'frontend/src/test';

/** TypeScript and JavaScript sources (the frontend allows JS). */
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

function scriptKindOf(file: string): ts.ScriptKind {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '__tests__'].includes(entry.name)) continue;
      // The frontend's test support code (the fetch stand-in for page tests, fixtures) isn't
      // the product's calls. Only that folder: product code in another `test` folder is read.
      if (full.split(path.sep).join('/').endsWith(TEST_SUPPORT_DIR)) continue;
      out.push(...listSourceFiles(full));
    } else if (SOURCE_FILE.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export type CallKind = 'frontend' | 'mcp';

const isFetch = (callee: ts.Expression) =>
  (ts.isIdentifier(callee) && callee.text === 'fetch') ||
  (ts.isPropertyAccessExpression(callee) && callee.name.text === 'fetch' && /^(window|globalThis|self)$/.test(callee.expression.getText()));

/** A fetch of something that isn't the API (`/manifest.json`, another site) isn't a call to check. */
const isApiPath = (p: string) => p === '/api' || p.startsWith('/api/');

/** A fetch's method: GET without options, the `method` of an options literal, else '?'. */
function fetchMethod(options: ts.Expression | undefined): string {
  if (!options) return 'GET';
  if (!ts.isObjectLiteralExpression(options)) return '?';
  let method = 'GET';
  for (const prop of options.properties) {
    if (ts.isSpreadAssignment(prop)) return '?'; // { ...init } could set it
    if (prop.name && ts.isComputedPropertyName(prop.name)) return '?'; // { [key]: … } could be it
    if (prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) && prop.name.text === 'method') {
      if (!ts.isPropertyAssignment(prop)) return '?';
      const values = evaluate(prop.initializer);
      if (!values || values.length !== 1) return '?';
      method = values[0].toUpperCase();
    }
  }
  return method;
}

/**
 * Functions in one file that only pass a path on to a helper (`exportCsv(endpoint) =>
 * downloadCsv(endpoint)`), by file and name, with the method they send: their callers are
 * read instead of them. Keep this short: a forwarder hides its callers unless listed.
 */
export const LOCAL_FORWARDERS: Record<string, Record<string, string>> = {
  'frontend/src/pages/InvestmentTaxPage.tsx': { exportCsv: 'GET' },
};

/** The first parameter's name of the function `node` is directly in. */
function firstParamOf(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      const first = n.parameters[0];
      return first && ts.isIdentifier(first.name) ? first.name.text : undefined;
    }
  }
  return undefined;
}

/** Is `param` assigned anywhere in the function `node` is in (`endpoint = \`/v2${endpoint}\``)? */
function isReassigned(node: ts.Node, param: string): boolean {
  let fn: ts.Node | undefined = node.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn) return false;
  let found = false;
  ts.forEachChild(fn, function visit(child) {
    if (found) return;
    const target =
      ts.isBinaryExpression(child) &&
      child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      child.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ? child.left
        : (ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child)) &&
            (child.operator === ts.SyntaxKind.PlusPlusToken || child.operator === ts.SyntaxKind.MinusMinusToken)
          ? child.operand
          : undefined;
    if (target && ts.isIdentifier(target) && target.text === param) found = true;
    else ts.forEachChild(child, visit);
  });
  return found;
}

/** Is `expr` exactly `${API_BASE_URL}${param}`? */
function isBasePlusParam(expr: ts.Expression | undefined, param: string): boolean {
  if (!expr || !ts.isTemplateExpression(expr) || expr.head.text !== '' || expr.templateSpans.length !== 2) return false;
  const [base, rest] = expr.templateSpans;
  return (
    ts.isIdentifier(base.expression) && base.expression.text === 'API_BASE_URL' && base.literal.text === '' &&
    ts.isIdentifier(rest.expression) && rest.expression.text === param && rest.literal.text === ''
  );
}

/** Where a helper's name may appear other than as the callee of a call. */
function isAllowedHelperMention(id: ts.Identifier, file: string): boolean {
  const parent = id.parent;
  // import { apiGet } from …: a plain import (a renamed one hides its calls).
  const isForwarder = own(own(LOCAL_FORWARDERS, file), id.text) !== undefined;
  if (ts.isImportSpecifier(parent)) return parent.propertyName === undefined;
  // A forwarder is read in its own file only: exported, its callers elsewhere would be missed.
  if (ts.isExportSpecifier(parent)) return parent.propertyName === undefined && !isForwarder;
  // Its own definition, in its home file (a forwarder's not exported).
  if ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) && parent.name === id) {
    if (own(HELPER_HOMES, id.text) === file) return true;
    if (!isForwarder) return false;
    const statement = ts.isVariableDeclaration(parent) ? parent.parent.parent : parent;
    return !(ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  }
  // A type (`typeof apiGet`) or a member named like it (`{ apiGet: … }`, an interface's
  // `apiGet(): …`), not a use of the helper.
  if (ts.isTypeQueryNode(parent)) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === id) {
    return true;
  }
  return false;
}

/**
 * Every API call in one source text. `file` (relative to the repository root) names it in
 * the results. A call the scanner can't follow (a helper renamed, aliased or reached through
 * a namespace; fetch passed around as a value; a fetch whose URL it can't read) is reported
 * as unreadable rather than missed.
 */
export function scanSource(source: string, file: string, kind: CallKind): ApiCall[] {
  const helpers: Record<string, string> = kind === 'frontend' ? { ...FRONTEND_HELPERS, ...own(LOCAL_FORWARDERS, file) } : {};
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const calls: ApiCall[] = [];
  const at = (node: ts.Node) => ({
    file,
    line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    text: node.getText().split('\n')[0].slice(0, 120),
  });
  const record = (node: ts.CallExpression, method: string, arg: ts.Expression | undefined, prefix: string) => {
    calls.push({ method, paths: readPaths(arg, prefix), ...at(node) });
  };
  const unfollowable = (node: ts.Node) => calls.push({ method: '?', paths: undefined, ...at(node) });

  /**
   * A helper's own forwarding call, skipped because its callers are read instead: in its
   * home file, directly in its body, and exactly the expected shape: apiGet's
   * fetch(`${API_BASE_URL}${endpoint}`, { method: 'GET' }), or a listed forwarder's
   * downloadCsv(endpoint) with the method the tables give. Anything else is checked.
   */
  const isForwarding = (node: ts.CallExpression) => {
    const name = enclosingFunctionName(node);
    if (name === undefined) return false;
    const param = firstParamOf(node);
    if (param === undefined || isReassigned(node, param)) return false;
    if (own(HELPER_HOMES, name) === file && isFetch(node.expression)) {
      return isBasePlusParam(node.arguments[0], param) && fetchMethod(node.arguments[1]) === own(FRONTEND_HELPERS, name);
    }
    const forwardedMethod = own(own(LOCAL_FORWARDERS, file), name);
    if (forwardedMethod !== undefined && ts.isIdentifier(node.expression)) {
      const arg = node.arguments[0];
      return (
        own(FRONTEND_HELPERS, node.expression.text) === forwardedMethod &&
        arg !== undefined && ts.isIdentifier(arg) && arg.text === param
      );
    }
    return false;
  };

  ts.forEachChild(sf, function visit(node) {
    if (kind === 'frontend' && ts.isIdentifier(node)) {
      const isCallee = ts.isCallExpression(node.parent) && node.parent.expression === node;
      const isPropertyName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      if (Object.hasOwn(helpers, node.text) && !isCallee) {
        // apiGet passed around, renamed on import, or read as api.apiGet: its calls can't be followed.
        if (isPropertyName || !isAllowedHelperMention(node, file)) unfollowable(node.parent);
      } else if (
        node.text === 'fetch' && !isCallee && !isPropertyName && !ts.isTypeQueryNode(node.parent) &&
        // a member named fetch (`{ fetch: fetchMock }`, `fetch(): …`) is not the global fetch
        !((ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent) || ts.isMethodDeclaration(node.parent) ||
          ts.isMethodSignature(node.parent) || ts.isPropertyDeclaration(node.parent)) && node.parent.name === node)
      ) {
        unfollowable(node.parent); // const f = fetch; fetch.call(…)
      }
    }
    if (kind === 'frontend' && ts.isPropertyAccessExpression(node) && isFetch(node)) {
      // window.fetch, self.fetch, globalThis.fetch as a value: (0, window.fetch)(…), .call(…)
      if (!(ts.isCallExpression(node.parent) && node.parent.expression === node)) unfollowable(node);
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      // window['fetch'], api['apiGet'], client['get']: a name the scanner would follow, by string.
      const key = node.argumentExpression.text;
      const followed = kind === 'frontend' ? key === 'fetch' || Object.hasOwn(helpers, key) : key === 'fetch' || own(CLIENT_METHODS, key) !== undefined || key === 'request';
      if (followed) unfollowable(node);
    }
    if (kind === 'mcp' && file.includes('/tools/') && ts.isCallExpression(node) && isFetch(node.expression)) {
      unfollowable(node); // the tools reach the API through the client only
    }
    // Links the browser opens itself: window.open(url) and an element's href.
    // Checked as GETs when the URL reads as /api/…; one that visibly names the API
    // (API_BASE_URL, '/api') but can't be read is reported; any other (another site, an
    // address the server sent) isn't the API's.
    if (kind === 'frontend') {
      const isWindowOpen =
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'open' &&
        /^(window|globalThis|self)$/.test(node.expression.expression.getText());
      const href =
        ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'href' ? node.initializer : undefined;
      const url = isWindowOpen
        ? (node as ts.CallExpression).arguments[0]
        : href && ts.isJsxExpression(href)
          ? href.expression
          : href && ts.isStringLiteral(href)
            ? href
            : undefined;
      if (url) {
        const paths = readPaths(url, '');
        const namesApi = /API_BASE_URL|['`"]\/api(\/|['`"])/.test(url.getText());
        if (paths ? paths.some(isApiPath) : namesApi) calls.push({ method: 'GET', paths, ...at(node) });
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (kind === 'frontend' && ts.isIdentifier(callee) && Object.hasOwn(helpers, callee.text)) {
        // base.ts prepends /api.
        if (!isForwarding(node)) record(node, helpers[callee.text], node.arguments[0], '/api'); // own: checked above
      } else if (kind === 'frontend' && isFetch(callee)) {
        // A raw fetch(`${API_BASE_URL}/…`, { method }): the URL carries its own /api. A URL it
        // can read that isn't the API (`/manifest.json`) is not a call to check; one it can't
        // read is reported.
        const paths = readPaths(node.arguments[0], '');
        if (!isForwarding(node) && (paths === undefined || paths.some(isApiPath))) {
          record(node, fetchMethod(node.arguments[1]), node.arguments[0], '');
        }
      } else if (
        kind === 'mcp' &&
        ts.isPropertyAccessExpression(callee) &&
        /client$/i.test(callee.expression.getText()) &&
        (own(CLIENT_METHODS, callee.name.text) !== undefined || callee.name.text === 'request')
      ) {
        if (callee.name.text === 'request') {
          const m = node.arguments[0];
          const method = m && ts.isStringLiteral(m) ? m.text.toUpperCase() : '?';
          record(node, method, node.arguments[1], '');
        } else {
          record(node, own(CLIENT_METHODS, callee.name.text) ?? '?', node.arguments[0], '');
        }
      }
    }
    if (kind === 'mcp' && file.includes('/tools/') && ts.isIdentifier(node) && node.text === 'client') {
      // The tools (mcp/src/tools; server.ts only builds the client and hands it to them)
      // reach the API only as client.get(…) or ctx.client.get(…): a client passed on,
      // aliased, destructured or indexed (client['get'], const { get } = ctx.client) can't
      // be followed. For ctx.client, the expression checked is ctx.client itself.
      const viaProperty = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      const expr: ts.Expression = viaProperty ? (node.parent as ts.PropertyAccessExpression) : node;
      const p = expr.parent;
      const isReceiver =
        ts.isPropertyAccessExpression(p) && p.expression === expr &&
        ts.isCallExpression(p.parent) && p.parent.expression === p &&
        (own(CLIENT_METHODS, p.name.text) !== undefined || p.name.text === 'request');
      const isBinding =
        !viaProperty &&
        ((ts.isBindingElement(p) && p.name === node) || (ts.isParameter(p) && p.name === node) ||
          (ts.isPropertySignature(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node));
      if (!isReceiver && !isBinding) unfollowable(p);
    }
    ts.forEachChild(node, visit);
  });
  return calls;
}
/** Every API call in the source files under `dir` (tests and their folders skipped). */
export function scanDirectory(dir: string, kind: CallKind, repoRoot: string): ApiCall[] {
  return listSourceFiles(dir).flatMap((file) =>
    scanSource(fs.readFileSync(file, 'utf8'), path.relative(repoRoot, file), kind)
  );
}

/**
 * Does a route's parameter (`:uuid`, `:accountId`, `:fileName`) take the call's segment `c`?
 * A placeholder, yes; fixed text only when it is a value of the parameter's kind:
 * a uuid for a uuid parameter, a whole number for an integer id, anything for a free-form
 * one. So `/accounts/summray` doesn't reach `/accounts/:uuid` (the route would answer 404).
 */
function paramTakes(param: string, c: string): boolean {
  if (c === '') return false;
  if (c === '{}') return true;
  const name = param.replace(/^:/, '').replace(/[?*+]$/, '');
  if ((UUID_PARAMS as readonly string[]).includes(name)) return isUuid(c);
  if ((INTEGER_ID_PARAMS as readonly string[]).includes(name)) return isIntegerId(c);
  return true;
}

/**
 * Does an Express route path (`/api/accounts/:uuid`) take a request for `callPath`? A
 * placeholder (`{}`, a value the scanner can't know) matches only a parameter segment
 * (`:uuid`) or `*`: a uuid in a call to `/accounts/${uuid}` must not count as reaching
 * `/accounts/paginated`. A value that can only be some fixed strings is read as those
 * (a parameter typed `'start' | 'stop'`), so it is matched as text, and a parameter takes
 * text only of its kind (paramTakes). A placeholder is one segment: a value that could hold
 * a `/` makes the call unreadable instead (MAYBE_SEGMENTS).
 */
export function routeTakes(routePath: string, callPath: string): boolean {
  const split = (p: string) => p.replace(/\/+$/, '').split('/');
  const route = split(routePath);
  const call = split(callPath);
  if (route.length !== call.length) return false;
  return route.every((seg, i) => {
    const c = call[i] ?? '';
    if (seg === '*') return c !== '';
    if (seg.startsWith(':')) return paramTakes(seg, c);
    return seg === c; // a literal segment takes only the same text, never a placeholder
  });
}
