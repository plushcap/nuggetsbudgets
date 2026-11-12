import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Static guard: every form control and icon button in src/ has an accessible name.
 *
 * eslint-plugin-jsx-a11y can't see these: a caption written as a plain <Text> (not a
 * <Text as="label">) names nothing, an icon-only <IconButton> has no name at all, and a
 * placeholder is not a name. This reads each .tsx file's JSX and requires each control
 * below to be named in one of these ways:
 *
 * - `aria-label` or `aria-labelledby` on the control;
 * - an `id` that a `htmlFor` in the same file names (`<Text as="label" htmlFor>`);
 * - a `<label>` (or `as="label"`) around it;
 * - spread props (`{...props}`): the caller names it.
 *
 * The custom pickers show their value on a button, and a <label> would replace that
 * value in the name, so they take only `aria-labelledby`, `aria-label` or their `label`
 * prop. A radio group (RadioGroup, SegmentedControl) is a `div`, which neither a <label>
 * nor `htmlFor` names: it takes `aria-label` / `aria-labelledby`. An IconButton needs
 * `aria-label` / `aria-labelledby` (a `title` is a tooltip, not a name), or `asChild`
 * with a named child. An empty or `undefined` aria-label names nothing. Components are
 * recognized under an alias (`IconButton as IB`), a namespace (`Themes.Switch`), or a
 * picker's default import under another name.
 *
 * It is a floor, not the whole check: it can't tell a label that wraps two fields, an
 * `htmlFor` matched to an `id` in another component, or what a spread passes on. The
 * browser audit (the accessibility tree of every route) is what finds those.
 */

const SRC = join(import.meta.dirname, '..', '..');

/** Controls named by a label or by aria-*. */
const FIELDS = new Set([
  'Select.Trigger',
  'Switch',
  'Checkbox',
  'TextField.Root',
  'TextArea',
  'CurrencyInput',
]);
/** Radio groups: a `div`, named only by aria-*. */
const GROUPS = new Set(['RadioGroup.Root', 'SegmentedControl.Root']);
/** Buttons that show their value: aria-labelledby / aria-label / their own `label` prop. */
const PICKERS = new Set([
  'RadixDatePicker',
  'TagSelector',
  'SingleTagSelector',
  'RadixMerchantSelector',
  'RadixBudgetItemSelector',
  'RadixIconPicker',
  'RadixColorPicker',
]);

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'test' ? [] : walk(path);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : [];
  });

/** The string literals in an expression (`{isEditing ? 'type' : undefined}` → ['type']). */
const literals = (node: ts.Node): string[] => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  const found: string[] = [];
  ts.forEachChild(node, (child) => {
    found.push(...literals(child));
  });
  return found;
};

/** What an attribute's value refers to: its literal strings, and its expression's text. */
const refs = (init: ts.JsxAttributeValue | undefined): string[] => {
  if (!init) return [];
  if (ts.isStringLiteral(init)) return [init.text];
  if (ts.isJsxExpression(init) && init.expression) return [init.expression.getText(), ...literals(init.expression)];
  return [];
};

const elementOf = (node: ts.JsxElement | ts.JsxSelfClosingElement) => (ts.isJsxElement(node) ? node.openingElement : node);

/** Whether an aria-label / aria-labelledby value names anything: not absent, empty, null or undefined. */
const naming = (attrs: Map<string, ts.JsxAttributeValue | undefined>, name: string): boolean => {
  if (!attrs.has(name)) return false;
  const init = attrs.get(name);
  if (!init) return false;
  if (ts.isStringLiteral(init)) return init.text.trim() !== '';
  if (!ts.isJsxExpression(init) || !init.expression) return false;
  const e = init.expression;
  if (ts.isIdentifier(e) && e.text === 'undefined') return false;
  if (e.kind === ts.SyntaxKind.NullKeyword) return false;
  if ((ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && e.text.trim() === '') return false;
  return true;
};

/** Maps a tag as written to the name checked here: an alias, a namespace or a renamed picker import. */
const canonicalTags = (sf: ts.SourceFile) => {
  const alias = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const { name, namedBindings } = statement.importClause;
    const module = from.split('/').pop() ?? from;
    if (name && PICKERS.has(module)) alias.set(name.text, module);
    if (namedBindings && ts.isNamespaceImport(namedBindings) && from === '@radix-ui/themes') namespaces.add(namedBindings.name.text);
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) if (element.propertyName) alias.set(element.name.text, element.propertyName.text);
    }
  }
  return (tag: string) => {
    const [head, ...rest] = tag.split('.');
    if (namespaces.has(head) && rest.length > 0) return rest.join('.');
    return [alias.get(head) ?? head, ...rest].join('.');
  };
};

/** The controls in one file's source that have no name, as `path:line <Tag>`. */
const unnamedControls = (file: string, source: string): string[] => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const canonical = canonicalTags(sf);
  const labelTargets = new Set<string>();
  const collect = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText() === 'htmlFor') refs(node.initializer).forEach((r) => labelTargets.add(r));
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const problems: string[] = [];
  const visit = (node: ts.Node, inLabel: boolean) => {
    let insideLabel = inLabel;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = elementOf(node);
      const tag = canonical(open.tagName.getText());
      const attrs = new Map<string, ts.JsxAttributeValue | undefined>();
      let spread = false;
      for (const prop of open.attributes.properties) {
        if (ts.isJsxAttribute(prop)) attrs.set(prop.name.getText(), prop.initializer);
        // react-hook-form's register()/field carry the form's field name, not a name for people.
        else if (!/^((\w+\.)?register\(|field$)/.test(prop.expression.getText())) spread = true;
      }
      if (tag === 'label' || refs(attrs.get('as')).includes('label')) insideLabel = true;

      const aria = naming(attrs, 'aria-label') || naming(attrs, 'aria-labelledby');
      let named: boolean | null = null;
      if (tag === 'IconButton') {
        const child = ts.isJsxElement(node) && attrs.has('asChild')
          ? node.children.find((c): c is ts.JsxElement | ts.JsxSelfClosingElement => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c))
          : undefined;
        const childNamed = !!child && elementOf(child).attributes.properties.some(
          (p) => ts.isJsxAttribute(p) && /^aria-label(ledby)?$/.test(p.name.getText()),
        );
        const text = ts.isJsxElement(node) && node.children.some((c) => ts.isJsxText(c) && c.getText().trim() !== '');
        named = aria || spread || childNamed || text;
      } else if (PICKERS.has(tag)) {
        named = aria || spread || attrs.has('label');
      } else if (GROUPS.has(tag)) {
        named = aria || spread;
      } else if (FIELDS.has(tag)) {
        named = aria || spread || inLabel || refs(attrs.get('id')).some((r) => labelTargets.has(r));
      }
      if (named === false) {
        const { line } = sf.getLineAndCharacterOfPosition(open.getStart());
        problems.push(`${relative(SRC, file)}:${line + 1} <${tag}>`);
      }
    }
    ts.forEachChild(node, (child) => visit(child, insideLabel));
  };
  visit(sf, false);
  return problems;
};

describe('accessible names', () => {
  // It parses every .tsx in src/: under coverage on a busy machine that passed 5 s.
  it('every form control and icon button in src/ is named', { timeout: 30000 }, () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(100);
    // Each entry needs a name: the comment at the top of this file lists the ways.
    expect(files.flatMap((file) => unnamedControls(file, readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('tells a named control from an unnamed one', () => {
    const source = [
      "import { IconButton as IB } from '@radix-ui/themes';",
      "import * as Themes from '@radix-ui/themes';",
      "import DateField from '../components/RadixDatePicker';",
      'const A = () => (<>',
      '  <IconButton onClick={go}><X /></IconButton>',
      '  <IconButton title="Close"><X /></IconButton>',
      '  <IconButton aria-label="Close"><X /></IconButton>',
      '  <IconButton asChild><Link to="/" aria-label="Home"><X /></Link></IconButton>',
      '  <Text size="2">Type</Text><Select.Root><Select.Trigger /></Select.Root>',
      '  <Select.Root><Select.Trigger aria-label="Review status" /></Select.Root>',
      '  <Text as="label" htmlFor="kind">Kind</Text><Select.Root><Select.Trigger id="kind" /></Select.Root>',
      "  <Text as=\"label\" htmlFor={on ? 'amount' : undefined}>Amount</Text><CurrencyInput id=\"amount\" />",
      '  <Text as="label" htmlFor={`${uid}-notes`}>Notes</Text><TextArea id={`${uid}-notes`} />',
      '  <TextField.Root placeholder="Search..." />',
      "  <TextField.Root {...register('name')} />",
      '  <Flex asChild><label><Switch /> Active</label></Flex>',
      '  <label><RadixDatePicker value={d} onChange={f} /></label>',
      '  <RadixDatePicker aria-labelledby="date-caption" value={d} onChange={f} />',
      '  <TextField.Root {...props} />',
      '  <IB onClick={go}><X /></IB>',
      '  <Themes.Select.Root><Themes.Select.Trigger /></Themes.Select.Root>',
      '  <label><DateField value={d} onChange={f} /></label>',
      '  <IconButton aria-label="" onClick={go}><X /></IconButton>',
      '  <Switch aria-label={undefined} />',
      "  <TextField.Root {...form.register('name')} />",
      '  <label>Kind<SegmentedControl.Root><SegmentedControl.Item value="a">A</SegmentedControl.Item></SegmentedControl.Root></label>',
      '  <SegmentedControl.Root aria-label="Kind"><SegmentedControl.Item value="a">A</SegmentedControl.Item></SegmentedControl.Root>',
      '</>);',
    ].join('\n');
    expect(unnamedControls(join(SRC, 'Sample.tsx'), source)).toEqual([
      'Sample.tsx:5 <IconButton>',
      'Sample.tsx:6 <IconButton>',
      'Sample.tsx:9 <Select.Trigger>',
      'Sample.tsx:14 <TextField.Root>',
      'Sample.tsx:15 <TextField.Root>',
      'Sample.tsx:17 <RadixDatePicker>',
      'Sample.tsx:20 <IconButton>',
      'Sample.tsx:21 <Select.Trigger>',
      'Sample.tsx:22 <RadixDatePicker>',
      'Sample.tsx:23 <IconButton>',
      'Sample.tsx:24 <Switch>',
      'Sample.tsx:25 <TextField.Root>',
      'Sample.tsx:26 <SegmentedControl.Root>',
    ]);
  });
});
