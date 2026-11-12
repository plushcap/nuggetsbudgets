import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { CONTROL_PLANE_VOCABULARIES, TENANT_VOCABULARIES } from '@nuggets/shared';

/**
 * Static guard: what the UI sends for a fixed list is the list's own value.
 *
 * The server checks each value of a list in @nuggets/shared's vocabulary.ts against that list
 * exactly, so a value in another case or spelling ('Cleared' for 'cleared', 'needs_review' for
 * 'needs review') is refused, or, as a filter, matches nothing. The transaction edit page held
 * its status as the label 'Cleared' and sent it, and every whole-form save failed. This reads
 * each source file's syntax and fails on:
 *
 * 1. **An option written out.** A `Select.Item` (or RadioGroup, SegmentedControl, … item) whose
 *    `value` is a string that is a value of a list, or nearly one, and an option object's
 *    (`{ value: 'cleared', label: … }`). A list's options come from its shared constant
 *    (`TRANSACTION_STATUSES.map(…)`) with its label map (`TRANSACTION_STATUS_LABELS`), so the
 *    value can't drift from the server's. A subset is typed with the list's type
 *    (`TransactionType[]`), which then refuses a wrong value.
 * 2. **A near miss where a value is typed, compared or set.** A string that is nearly a value
 *    of a list (another case, `_`/`-` for a space) and exactly none, in a literal type
 *    (`status: 'Pending' | …`), in a comparison or `case` on something named for a list's
 *    column (`x.status === 'Cleared'`, `switch (reviewStatus)`), as a property, a variable or
 *    an assignment named for one (`status: 'Cleared'`, `const defaultStatus = …`,
 *    `data.status = …`), as the value a call sets for one (`setValue('status', 'Cleared')`,
 *    `params.set('review_status', …)`, `setStatus(…)`, `useState(…)` for `[status, …]`), as a
 *    default (`{ status = … }`, `(reviewStatus = …) =>`), a member of an enum or of a const
 *    object named for one (`const STATUS = { CLEARED: … }`), what a switch on one returns, a
 *    choice's `defaultValue` or a tab's `value`, or in a list at least half of whose strings
 *    (sentinels aside, two or more) are one list's values or nearly them (`['pending',
 *    'Cleared', 'reconciled']`). An option object is keyed `value`, or `v` beside a `label`. A
 *    string is followed through parentheses, `as`, `satisfies`, `!`, both branches of `?:` and
 *    the fallback of `??`/`||`.
 *
 * 3. **A value compared written out** (`t.status === 'cleared'`, a `case`, a list looked up): the
 *    backend's vocabularyLiterals.test.ts checks it, here and in the backend and the MCP server,
 *    with each package's TypeScript program, so it tells a field with a list from a listless one
 *    of the same name (a budget period's or a backup's `status`) by its type or table, never by
 *    file.
 *
 * A string that names no value of any list isn't checked (a typo far from every value), nor is
 * one exactly a value of some list outside an option or a comparison (it can't tell which list
 * a column means), nor one reached any other way (a constant from another file, a computed
 * string). The types do the rest: forms and API types take the shared types
 * (`TransactionStatus`, …).
 */

const SRC = join(import.meta.dirname, '..');

const VOCABULARY: Record<string, readonly string[]> = { ...TENANT_VOCABULARIES, ...CONTROL_PLANE_VOCABULARIES };

/** A value as people might misspell it: lowercase, with runs of space, `_` and `-` as one space. */
const loose = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, ' ').trim();

const EXACT = new Set(Object.values(VOCABULARY).flat());
const NEAR = new Map<string, string[]>();
for (const [column, values] of Object.entries(VOCABULARY)) {
  for (const value of values) NEAR.set(loose(value), [...(NEAR.get(loose(value)) ?? []), `${column} '${value}'`]);
}
/** The column names (`status`, `review_status`, `account_type`, …). */
const COLUMNS = new Set(Object.keys(VOCABULARY).map((key) => key.split('.')[1]));

/** Items whose `value` is the choice sent. */
const OPTION_ITEMS = new Set([
  'Select.Item',
  'RadioGroup.Item',
  'SegmentedControl.Item',
  'RadioCards.Item',
  'CheckboxGroup.Item',
  'CheckboxCards.Item',
  'DropdownMenu.RadioItem',
  'ContextMenu.RadioItem',
]);
/** An option's value that means no choice or no filter, never sent as a list's value. */
const SENTINELS = new Set(['all', 'none', 'null', 'default']);
/**
 * Options written out that are a list's value by coincidence, by file, and why. The test fails
 * on an entry nothing matches any more.
 */
const NOT_VOCABULARY: Record<string, { values: string[]; why: string }> = {
  [join('components', 'forms', 'CategoryFormFields.tsx')]: {
    values: ['Essential', 'Optional'],
    why: "categories.priority, which has no list (it also takes 'Undefined')",
  },
  [join('components', 'forms', 'AccountFormFields.tsx')]: {
    values: ['Cash'],
    why: "accounts.subtype, which has no list ('Cash' is also an account type's value in another case)",
  },
  [join('pages', 'AddBudgetItemPage.tsx')]: {
    values: ['income', 'expense'],
    why: 'which add form the page shows (?kind=), not a value it sends',
  },
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'test' ? [] : walk(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : [];
  });

/** `reviewStatus` → `review_status`. */
const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Whether a name is a column's, or ends with one (`newReviewStatus`, `transactionType`). */
const namesColumn = (name: string): boolean => {
  const n = snake(name);
  for (const column of COLUMNS) if (n === column || n.endsWith(`_${column}`)) return true;
  return false;
};

/** The name an expression reads, through `.toLowerCase()`, `?.`, `!`, parentheses and `x['y']`. */
const nameOf = (node: ts.Expression): string | undefined => {
  let e: ts.Expression = node;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
    else if (
      ts.isCallExpression(e) &&
      e.arguments.length === 0 &&
      ts.isPropertyAccessExpression(e.expression) &&
      ['toLowerCase', 'toUpperCase', 'trim'].includes(e.expression.name.text)
    )
      e = e.expression.expression;
    else break;
  }
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
  return undefined;
};

const propertyName = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;

const tagOf = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) => node.tagName.getText();

/** Roots whose `defaultValue` is a choice, and tabs, whose `value` may be a filter's. */
const CHOICE_DEFAULTS = new Set([...OPTION_ITEMS].map((item) => item.replace(/\.\w+$/, '.Root')).concat('Tabs.Root'));
const TAB_ITEMS = new Set(['Tabs.Trigger', 'Tabs.Content', 'TabNav.Link']);

/** An object literal through parentheses, `as` and `satisfies` (`{ … } as const`). */
const unwrapObject = (node: ts.Expression): ts.ObjectLiteralExpression | undefined => {
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return unwrapObject(node.expression);
  return undefined;
};

/**
 * The strings an expression may come to: itself, through parentheses, `as`, `satisfies` and
 * `!`, either branch of `?:`, and the fallback of `??` / `||`.
 */
const literalsIn = (node: ts.Expression): ts.StringLiteralLike[] => {
  if (ts.isStringLiteralLike(node)) return [node];
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    return literalsIn(node.expression);
  if (ts.isConditionalExpression(node)) return [...literalsIn(node.whenTrue), ...literalsIn(node.whenFalse)];
  if (
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)
  )
    return literalsIn(node.right);
  return [];
};

interface Problem {
  where: string;
  text: string;
  why: string;
}

/** What the source of one file sends wrong, or writes out, for a list. */
function problemsIn(file: string, source: string): Problem[] {
  const rel = relative(SRC, file);
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const problems: Problem[] = [];
  const at = (node: ts.Node) => `${rel.split(sep).join('/')}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const nearMiss = (text: string) => (!EXACT.has(text) ? NEAR.get(loose(text)) : undefined);
  const checkNear = (node: ts.Node, text: string, context: string) => {
    const near = nearMiss(text);
    if (near) problems.push({ where: at(node), text, why: `${context}: nearly ${near.join(' / ')}, which the server checks exactly` });
  };
  /** An option's value written out: a list's value, or nearly one. */
  const writtenOut = (literal: ts.StringLiteralLike, what: string) => {
    if (SENTINELS.has(literal.text) || NOT_VOCABULARY[rel]?.values.includes(literal.text)) return;
    const lists = NEAR.get(loose(literal.text));
    if (lists) {
      problems.push({
        where: at(literal),
        text: literal.text,
        why: `${what} value written out for ${lists.join(' / ')}: build the options from the shared constant and its labels`,
      });
    }
  };

  const visit = (node: ts.Node) => {
    // 1. An option item's value written out.
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagOf(node);
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || !attr.initializer) continue;
        const attrName = attr.name.getText();
        const init = attr.initializer;
        const found = ts.isStringLiteral(init)
          ? [init]
          : ts.isJsxExpression(init) && init.expression
            ? literalsIn(init.expression)
            : [];
        if (OPTION_ITEMS.has(tag) && attrName === 'value') {
          for (const literal of found) writtenOut(literal, tag);
        } else if ((CHOICE_DEFAULTS.has(tag) && attrName === 'defaultValue') || (TAB_ITEMS.has(tag) && attrName === 'value')) {
          for (const literal of found) checkNear(literal, literal.text, `${tag} ${attrName}`);
        }
      }
    }
    // 2. Near misses where a value is typed, compared or set.
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) checkNear(node, node.literal.text, 'a literal type');
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(
        node.operatorToken.kind,
      )
    ) {
      for (const [literal, other] of [
        [node.right, node.left],
        [node.left, node.right],
      ] as const) {
        const name = nameOf(other);
        if (ts.isStringLiteralLike(literal) && name && namesColumn(name)) checkNear(literal, literal.text, `compared with ${name}`);
      }
    }
    if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression)) {
      const name = nameOf(node.parent.parent.expression);
      if (name && namesColumn(name)) checkNear(node.expression, node.expression.text, `a case of ${name}`);
    }
    // What a switch on a column returns (`switch (dbStatus) { case 'cleared': return 'Cleared' }`):
    // a value for the same column.
    if ((ts.isCaseClause(node) || ts.isDefaultClause(node)) && ts.isSwitchStatement(node.parent.parent)) {
      const name = nameOf(node.parent.parent.expression);
      if (name && namesColumn(name)) {
        for (const statement of node.statements) {
          if (ts.isReturnStatement(statement) && statement.expression) {
            for (const literal of literalsIn(statement.expression)) checkNear(literal, literal.text, `returned for ${name}`);
          }
        }
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      // An option object (`{ value: 'cleared', label: … }`, or `v` beside a label) is an option
      // written out.
      const parent = node.parent;
      const optionKey =
        ts.isObjectLiteralExpression(parent) &&
        (name === 'value' ||
          (name === 'v' && parent.properties.some((p) => p.name !== undefined && propertyName(p.name) === 'label')));
      if (optionKey) {
        for (const literal of literalsIn(node.initializer)) writtenOut(literal, 'an option object');
      } else if (name && namesColumn(name)) {
        for (const literal of literalsIn(node.initializer)) checkNear(literal, literal.text, `property ${name}`);
      }
    }
    // Assigned (`data.status = …`) or declared (`const defaultStatus = …`) for a column.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = nameOf(node.left);
      if (name && namesColumn(name)) for (const literal of literalsIn(node.right)) checkNear(literal, literal.text, `assigned to ${name}`);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && namesColumn(node.name.text)) {
        for (const literal of literalsIn(node.initializer)) checkNear(literal, literal.text, `${node.name.text}'s value`);
      }
      // `const [status, setStatus] = useState('…')`.
      const first = ts.isArrayBindingPattern(node.name) ? node.name.elements[0] : undefined;
      const call = node.initializer;
      if (
        first && ts.isBindingElement(first) && ts.isIdentifier(first.name) && namesColumn(first.name.text) &&
        ts.isCallExpression(call) && nameOf(call.expression) === 'useState' && call.arguments[0]
      ) {
        for (const literal of literalsIn(call.arguments[0])) checkNear(literal, literal.text, `${first.name.text}'s first value`);
      }
    }
    if (ts.isCallExpression(node)) {
      const [key, value] = node.arguments;
      if (node.arguments.length >= 2 && key && value && ts.isStringLiteralLike(key) && namesColumn(key.text)) {
        for (const literal of literalsIn(value)) checkNear(literal, literal.text, `the value set for ${key.text}`);
      }
      // A setter named for a column (`setStatus('…')`, `setReviewStatus(…)`).
      const callee = nameOf(node.expression);
      if (key && callee && /^set[A-Z]/.test(callee) && namesColumn(callee.slice(3))) {
        for (const literal of literalsIn(key)) checkNear(literal, literal.text, `the value ${callee} sets`);
      }
    }
    // A list written out (`['pending', 'Cleared', 'reconciled']`): at least half of its strings
    // (sentinels aside), two or more, are one list's values or nearly them; its near misses are
    // flagged. (A near miss alone in a list is more likely a heading: a CSV's 'Budget Item'.)
    if (ts.isArrayLiteralExpression(node) && node.elements.length >= 2) {
      const strings = node.elements.flatMap((element) => literalsIn(element));
      const byList = new Map<string, ts.StringLiteralLike[]>();
      for (const literal of strings) {
        if (SENTINELS.has(literal.text)) continue;
        for (const list of NEAR.get(loose(literal.text)) ?? []) {
          const column = list.slice(0, list.indexOf(' '));
          byList.set(column, [...(byList.get(column) ?? []), literal]);
        }
      }
      const listed = node.elements.length - strings.filter((literal) => SENTINELS.has(literal.text)).length;
      const flagged = new Set<ts.StringLiteralLike>();
      for (const literals of byList.values()) {
        if (literals.length >= 2 && literals.length * 2 >= listed) for (const literal of literals) flagged.add(literal);
      }
      for (const literal of flagged) checkNear(literal, literal.text, 'a list written out');
    }
    // A default named for a column (`({ status = '…' })`, `(reviewStatus = '…') =>`), an enum's
    // member, and a const object named for one (`const STATUS = { CLEARED: '…' }`).
    if ((ts.isBindingElement(node) || ts.isParameter(node)) && node.initializer && ts.isIdentifier(node.name) && namesColumn(node.name.text)) {
      for (const literal of literalsIn(node.initializer)) checkNear(literal, literal.text, `${node.name.text}'s default`);
    }
    if (ts.isEnumMember(node) && node.initializer) {
      for (const literal of literalsIn(node.initializer)) checkNear(literal, literal.text, 'an enum member');
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && namesColumn(node.name.text) && node.initializer) {
      const object = unwrapObject(node.initializer);
      for (const property of object?.properties ?? []) {
        if (ts.isPropertyAssignment(property)) {
          for (const literal of literalsIn(property.initializer)) checkNear(literal, literal.text, `${node.name.text}'s member`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}

const format = (problems: Problem[]) => problems.map((p) => `${p.where} '${p.text}': ${p.why}`);

describe('values the UI sends for a fixed list', () => {
  it('builds options from the shared lists, and has no near miss of a value', () => {
    const problems = walk(SRC).flatMap((file) => problemsIn(file, readFileSync(file, 'utf8')));
    expect(format(problems)).toEqual([]);
  });

  it('has no exception nothing needs', () => {
    const stale: string[] = [];
    for (const [file, { values }] of Object.entries(NOT_VOCABULARY)) {
      const source = readFileSync(join(SRC, file), 'utf8');
      for (const value of values) {
        if (!source.includes(`value="${value}"`) && !source.includes(`value: '${value}'`)) stale.push(`${file}: ${value}`);
      }
    }
    expect(stale).toEqual([]);
  });

  // The rules catch what they say, so a pass above means something.
  describe('catches', () => {
    const check = (source: string, file = join(SRC, 'pages', 'Probe.tsx')) => format(problemsIn(file, source));

    it("the edit page's status options, held as labels", () => {
      const problems = check(`
        const S = () => (
          <Select.Content>
            <Select.Item value="Pending">Pending</Select.Item>
            <Select.Item value={'cleared'}>Cleared</Select.Item>
          </Select.Content>
        );`);
      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(/pages\/Probe\.tsx:4 'Pending': Select\.Item value written out for .*transactions\.status 'pending'/);
      expect(problems[1]).toMatch(/'cleared': Select\.Item value written out/);
    });

    it('any option item, and lets a sentinel or a value from a constant through', () => {
      expect(check(`<SegmentedControl.Item value="needs_review" />`)).toHaveLength(1);
      expect(check(`<RadioGroup.Item value="reviewed" />`)).toHaveLength(1);
      expect(check(`<Select.Item value="all">All</Select.Item>`)).toEqual([]);
      expect(check(`<Select.Item value={s}>{LABELS[s]}</Select.Item>`)).toEqual([]);
      expect(check(`<Select.Item value="weekly">Weekly</Select.Item>`)).toEqual([]);
    });

    it('a near miss in a literal type, a comparison, a case, a property and a set', () => {
      expect(check(`type F = { status: 'Pending' | 'Cleared' | 'Reconciled' };`)).toHaveLength(3);
      expect(check(`if (t.status === 'Cleared') x();`)).toHaveLength(1);
      expect(check(`if ('Needs Review' !== reviewStatus.toLowerCase()) x();`)).toHaveLength(1);
      expect(check(`switch (row.review_status) { case 'needs_review': break; }`)).toHaveLength(1);
      expect(check(`const d = { status: 'Pending', reviewStatus: 'Flagged' };`)).toHaveLength(2);
      expect(check(`setValue('status', 'Cleared'); params.set('review_status', 'needs_review');`)).toHaveLength(2);
    });

    it('an option object, a list written out, a default, an assignment, a setter and a tab', () => {
      expect(check(`const O = [{ value: 'Cleared', label: 'Cleared' }, { value: 'pending', label: 'Pending' }];`)).toHaveLength(2);
      expect(check(`const REVIEW_CHOICES = ['Needs Review', 'Reviewed', 'Flagged'];`)).toHaveLength(3);
      expect(check(`const defaultStatus = 'Cleared';`)).toHaveLength(1);
      expect(check(`const [status, setStatus] = useState('Cleared'); setStatus('Pending');`)).toHaveLength(2);
      expect(check(`data.status = 'Reconciled';`)).toHaveLength(1);
      expect(check(`const b = { review_status: x ? 'Needs Review' : 'Flagged', status: 'Cleared' as const };`)).toHaveLength(3);
      expect(check(`<Select.Item value={'Reconciled' as string}>R</Select.Item>`)).toHaveLength(1);
      expect(check(`<Select.Root defaultValue="Cleared" />`)).toHaveLength(1);
      expect(check(`<Tabs.Root defaultValue="needs_review"><Tabs.Trigger value="needs_review">x</Tabs.Trigger></Tabs.Root>`)).toHaveLength(2);
    });

    // What the first extension still let through.
    it("one miscased value in a list, a converter's returns, `v` options, enums, const objects and defaults", () => {
      expect(check(`const STATUSES = ['pending', 'Cleared', 'reconciled'];`)).toHaveLength(1);
      expect(check(`const FILTERS = ['all', 'any', 'Needs Review', 'Flagged'];`)).toHaveLength(2);
      expect(check(`const f = (dbStatus: string) => { switch (dbStatus) { case 'cleared': return 'Cleared'; default: return 'Pending'; } };`)).toHaveLength(2);
      expect(check(`const M = [{ v: 'Actual', label: 'Actual' }, { v: 'allocated', label: 'Allocated' }];`)).toHaveLength(2);
      expect(check(`const STATUS = { CLEARED: 'Cleared', PENDING: 'Pending' } as const;`)).toHaveLength(2);
      expect(check(`enum ReviewStatus { NeedsReview = 'needs_review', Reviewed = 'Reviewed' }`)).toHaveLength(2);
      expect(check(`function Row({ status = 'Cleared' }: { status?: string }) {} function send(reviewStatus = 'Needs Review') {}`)).toHaveLength(2);
    });

    it('a heading or a label in a list, or a list of other words, is not a list written out', () => {
      expect(check(`const headers = ['Budget Item', 'Type', 'Actual', 'Remaining'];`)).toEqual([]);
      expect(check(`const buckets = ['Domestic Stock', 'Foreign Stock', 'Cash', 'Preferred', 'Other'];`)).toEqual([]);
      expect(check(`const statuses = ['pending', 'cleared'];`)).toEqual([]);
    });

    it('nothing exact, nothing far from every value, and nothing compared with an unrelated name', () => {
      expect(check(`type F = { status: TransactionStatus }; if (t.status === transactionStatus.enum.cleared) x();`)).toEqual([]);
      expect(check(`if (step === 'Complete') x(); const label = { reviewed: 'Reviewed' };`)).toEqual([]);
      expect(check(`if (t.status === 'clear') x();`)).toEqual([]);
    });
  });
});
