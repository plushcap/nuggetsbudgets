#!/usr/bin/env node
/**
 * Idiom A design-system guard, plus the calendar-date guard.
 *
 * Fails the build if banned styling patterns are reintroduced into the frontend
 * (see CLAUDE.md "UI / theming / a11y"). The whole app leads on Radix Themes:
 * colour must come from Radix props or `var(--*)` arbitrary classes — never from
 * `dark:` classes, static Tailwind palette classes, `bg-white`/`text-black`, a hex
 * chosen by `isDark` or the appearance, or the retired `accessible-*`/`dark-*` token
 * layers. Text isn't set in a step-9/10 colour, nor in step 11 of the scales whose step
 * 11 is under 4.5:1 on the app's gray-2 page in light mode; an icon (a lucide-react
 * component or an SVG element) may be, as it isn't text (3:1 is its bar). No colour goes in
 * an inline style (`style={…}` read through consts, functions and spreads), save one from
 * data (a user-chosen or a chart colour), which a comment on its property says why:
 * `/* lint:guard colour: <a few words> *\/`. A comment is the property's it comes before, on
 * that property's line or on a line of its own above it, or the property's it follows when it
 * ends that property's line: in `color: c, /* … *\/ backgroundColor: d` it marks backgroundColor
 * only. A colour written out can't be marked; only the FIXED_ARTWORK files (the Nuggets logo)
 * keep theirs. Browser confirm()/alert() are banned too.
 *
 * It also reads a style through a const map (`styles.card`),
 * `Object.assign`, the app's own imports, another style prop (`labelStyle`) and a DOM write
 * (`el.style.color =`); a template's const substitution, a same-file function's or useMemo's
 * return, an alias and destructuring behind a marker; step-9/10 text of any hue; steps 3–8 text,
 * `text-white`, <Badge>/<Callout.Text> colours, more appearance tests, vendor prefixes and code
 * after a leading block comment. It no longer flags a non-colour custom property, a colour word in
 * url(), a mask, or color-mix of a marked colour; a marker may start on the next line or sit
 * before `return ({ … })`, and one whose reason is under three words is an error.
 *
 * It catches, too, a colour written out beside data in color-mix()/light-dark(), a
 * custom property of data whose name isn't a measure's (`--swatch`), `el.style['color'] =`,
 * `el.style.cssText =` and `setAttribute('style', …)`, a <Callout.Root color>'s text, and a class
 * or colour read from a const map or a same-file function's result (`status.cardClass`).
 *
 * Also a colour written out in an object passed in a call or a prop
 * not named …Style (`renderIcon(v, { color: '#f00' })`), `<T.Dialog.Title color>` through a
 * namespace import, a colour picked by any name compared with 'dark' or 'light', and text set as
 * wide as a form page (a reading measure is narrower).
 *
 * And a Tailwind layout class where a Radix prop carries the same (padding, margin,
 * gaps, sizes, flex, position, overflow, display, a lucide icon's size, a static radius), in pages/
 * and components/; the message names the prop (tailwindLayoutProblems).
 *
 * It also fails on the idioms that shift a calendar date (a DATE column) by a
 * day: "today" taken from `toISOString()` (the UTC day), and a date-only
 * value parsed with `new Date(...)` (midnight UTC, the evening before in the
 * Americas). Use the helpers in src/utils/dateUtils.ts, which is exempt, as are
 * tests.
 *
 * And the page-width guard: a page (pages/*.tsx) takes its width from <PageContainer>
 * (wide by default; form, editor or auth by its kind), never from a wrapper written in the page,
 * and each page component renders inside it in every state it returns. Elsewhere a Radix
 * Container is refused but in PageContainer itself.
 *
 * Scans src/ *.ts/*.tsx, skipping comment lines and JSX comments (`{/* … *\/}`). Each file is
 * parsed with TypeScript, which finds the JSX comments and reads the JSX elements (their
 * attributes, the names they're imported under); the other rules are patterns over the text.
 * Run via `npm run lint:guard`; scripts/__tests__/check-idiom-a.test.mjs shows what each rule
 * catches.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative, sep, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// The files whose money formats move onto formatMoney with their sums. Empty this once they
// have; nothing else may join it.
const MONEY_FORMAT_PENDING = new Set([]);

const RULES = [
  // `dark:` before a class, an arbitrary value, or another variant (Tailwind 4: dark:@md:, dark:*:,
  // dark:!x, a breakpoint that starts with a digit: dark:2xl:, and a negative value: dark:-mt-1).
  { re: /\bdark:[a-z0-9[@*!(-]/, msg: 'Tailwind `dark:` class — Radix CSS vars self-swap with appearance; use var(--*).' },
  { re: /\bbg-white\b/, msg: '`bg-white` static surface — use <Card> or bg-[var(--color-panel-solid)].' },
  { re: /\btext-black\b/, msg: '`text-black` static colour — use default Text/Heading or text-[var(--gray-12)].' },
  { re: /\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|placeholder|decoration|caret|accent|shadow)-gray-\d{2,3}\b/, msg: 'Static Tailwind gray scale — use a Radix color prop or var(--gray-*).' },
  { re: /accessible-(?:text|focus|bg|border)/, msg: 'Retired `accessible-*` token layer — use var(--gray-*)/var(--accent-*).' },
  { re: /\bdark-(?:text|bg|border)-/, msg: 'Retired `dark-*` token layer — use var(--*) (which self-swaps).' },
  { re: /window\.(?:confirm|alert)\s*\(/, msg: 'Browser confirm()/alert() — use ConfirmationDialog + useConfirmation.' },
  // The rest of the static palette (only gray had a rule), and text a reader can't read.
  {
    re: /\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|placeholder|decoration|caret|accent|shadow)-(?:slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe)-\d{2,3}\b/,
    msg: 'Static Tailwind palette colour — the theme picker can\'t change it; use a Radix color prop or var(--accent-*)/var(--red-*) etc.',
  },
  {
    // Tailwind 4 also reads its palette through variables: text-(--color-red-500),
    // bg-[var(--color-white)]. Radix's own variables (--red-9, --color-panel-solid) don't match.
    re: /(?:\(|var\()(?:color:)?--color-(?:white|black|(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe)-\d{2,3})\b/,
    msg: 'Static Tailwind palette colour through a variable — the theme picker can\'t change it; use a Radix color prop or var(--accent-*)/var(--red-*) etc.',
  },
  { re: /\b(?:from|via|to)-white\b/, msg: 'Static white in a gradient — it stays white in dark mode; use var(--color-background) / var(--color-panel-solid).' },
  // White text on a fill. A step-9 fill's text is its --<color>-contrast, which is
  // dark on the light fills (amber, yellow, lime, mint, sky).
  // One money formatter. An Intl currency format written by hand hard-codes the
  // currency and locale the household setting will choose.
  {
    skipTests: true,
    exempt: (rel) => MONEY_FORMAT_PENDING.has(rel),
    re: /\bstyle:\s*['"]currency['"]/,
    msg: 'A money format written by hand — use formatMoney (@nuggets/shared), or formatCurrency (utils/currency.ts) for accounting parentheses.',
  },
  // A row's hover is the row-hover class (index.css): on it, a coloured badge's step-11 text goes
  // to step 12, which a bare hover:bg-[var(--gray-3)] leaves under AA.
  {
    skipTests: true,
    re: /(?<![\w-])hover:bg-\[var\(--gray-a?3\)\]/,
    msg: '`hover:bg-[var(--gray-3)]` — use the row-hover class: on its hover a coloured badge\'s text goes to step 12, which stays readable on gray-3.',
  },
  { skipTests: true, re: /(?<![\w-]|\bdark:(?:[\w@*!-]+:)*)text-white(?![\w-])/, msg: '`text-white` — text on a step-9 fill is text-[var(--<color>-contrast)] (dark on amber, yellow, lime, mint and sky); elsewhere use var(--gray-12).' },
];

/**
 * A text colour, as a class or a `color:` style, ending in one of `steps` of a scale in
 * `scales`: text-[var(--red-9)], text-[color:var(--red-9)], Tailwind 3's text-[--red-9],
 * Tailwind 4's text-(--red-9) and text-(color:--red-9), an alpha step (-a9), and a `color:`
 * whose value holds the variable (a ternary, across lines too: a style's value ends at a
 * comma, semicolon or brace).
 */
const textColour = (scales, steps, { classesOnly = false } = {}) => {
  const variable = `--${scales}-a?(?:${steps})`;
  const classes = `text-\\[(?:color:)?var\\(${variable}\\)\\]|text-\\[(?:color:)?${variable}\\]|text-\\((?:color:)?${variable}\\)`;
  return new RegExp(classesOnly ? classes : `${classes}|(?:^|[^\\w-])color:\\s*[^,;}]*var\\(${variable}\\)`, 'g');
};

// Matched against the whole file; a match inside an icon's tag (a lucide-react component,
// or an SVG element) is let through: an icon isn't text, so its bar is 3:1, which step 9
// clears. So is one in a string held for an icon: the value of a property, variable or
// attribute whose name says so (`iconClass: 'text-[var(--green-9)]'`, `const iconColor = …`).
const TEXT_RULES = [
  {
    // A hue chosen at run time (`text-[var(--${c}-9)]`) is a step-9/10 text all the same.
    re: textColour('(?:[a-z]+|\\$\\{[^}]*\\})', '9|10'),
    msg: 'Text in a step-9/10 colour — those are fills, as low as 1.2:1 on the page (WCAG AA wants 4.5:1). Use step 11, or 12 (see the next rule). A chart series takes its colour from useChartTheme.',
  },
  {
    re: textColour('(?:green|amber|yellow|orange|teal|jade)', '11'),
    msg: 'Text in green/amber/yellow/orange/teal/jade step 11 — 4.26–4.46:1 on the app\'s gray-2 page in light mode, under AA. Use step 12.',
  },
  {
    // Steps 3–8 are backgrounds and borders (gray-7 text is about 1.9:1); 1 and 2
    // are text only on a step-12 fill (an inverted toast). An icon may be one, and so may a mark
    // hidden from assistive technology (a separator bullet). A class only: an inline style's
    // colour is the inline-colour rule's, and a stylesheet's (a disabled control's) is CSS's.
    re: textColour('[a-z]+', '[3-8]', { classesOnly: true }),
    msg: 'Text in a step 3–8 colour — those are backgrounds and borders, far under AA. Use step 11 or 12; a decorative mark (a separator) takes aria-hidden.',
    letHidden: true,
  },
];

// What a test of the appearance looks like: isDark, isDarkMode, prefs.darkMode; theme === 'dark',
// appearance !== 'light', mode === 'dark': a value compared with 'dark' or 'light', a name,
// a member (`prefs?.mode`, `prefs['mode']`, `prefs?.['mode']`), a call's result (`getMode()`) or a
// non-null one (`mode!`), the word quoted (any case: 'Dark'), a template, or a const (`DARK`,
// `Appearance.Dark`); and the comparison the other way round ('dark' === mode), in parentheses or
// not. Only the app's appearance counts: what is compared must read a theme, a mode, an
// appearance or a scheme (APPEARANCE_READ), so a data colour's own contrast pick
// (`luminanceOf(c) === 'light'`, `tag.tone === 'dark'`) and a font weight pass. A comment may
// stand before the `?` or `&&` (APPEARANCE_GAP).
const COMPARED = String.raw`(?<![\w$.])[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\?\.\[[^\][]*\]|\((?:[^()]|\([^()]*\))*\)|\[[^\][]*\]|!)*\)?`;
const APPEARANCE_WORD = String.raw`(?:['"\x60](?:[dD]ark|[lL]ight|DARK|LIGHT)['"\x60]|\b(?:[A-Z0-9]+_)*(?:DARK|LIGHT)(?:_[A-Z0-9]+)*\b|\b[A-Za-z_$][\w$]*\.(?:Dark|Light|DARK|LIGHT)\b)`;
const APPEARANCE_TEST = String.raw`(?:\b[\w.]*[dD]ark(?:Mode|Theme|Appearance|Scheme)?|${COMPARED}\s*[!=]==?\s*${APPEARANCE_WORD}|${APPEARANCE_WORD}\s*[!=]==?\s*${COMPARED})\)?`;
const APPEARANCE_GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
/** Whether a match compares something that isn't the app's appearance (its colour branch and the word compared left out). */
const APPEARANCE_READ = /[tT]heme|[mM]ode|[aA]ppearance|[sS]cheme|[dD]ark/;
const APPEARANCE_NOT = (text) => {
  const test = text.slice(0, Math.max(text.lastIndexOf('?'), text.lastIndexOf('&&')));
  return !APPEARANCE_READ.test(test.replace(/['"\x60](?:dark|light)['"\x60]/gi, ''));
};
// A colour as a ternary's value: hex, rgb()/hsl(), a var(--…) (which self-swaps already), or a
// named colour (CSS's, and Radix's scale names: picking a color prop by appearance is the same thing).
const QUOTED_COLOUR = String.raw`['"\x60](?:#|rgba?\(|hsla?\(|var\(|(?:white|black|gr[ae]y|silver|red|green|blue|yellow|orange|purple|pink|brown|navy|maroon|olive|lime|teal|aqua|fuchsia|cyan|magenta|gold|bronze|amber|tomato|ruby|crimson|plum|violet|iris|indigo|jade|grass|mint|sky)['"\x60])`;

// Matched against the whole file, so a ternary split across lines is caught too.
const FILE_RULES = [
  {
    re: new RegExp(`${APPEARANCE_TEST}${APPEARANCE_GAP}\\?\\s*${QUOTED_COLOUR}`, 'g'),
    msg: 'A colour picked by appearance — the JS `dark:`; it ignores the accent and gray pickers. Read the theme (useChartTheme) or use var(--*).',
    skip: APPEARANCE_NOT,
  },
  {
    // `isDark && '#fff'` is the same choice without its other branch.
    re: new RegExp(`${APPEARANCE_TEST}${APPEARANCE_GAP}&&\\s*${QUOTED_COLOUR}`, 'g'),
    msg: 'A colour picked by appearance — the JS `dark:`; it ignores the accent and gray pickers. Read the theme (useChartTheme) or use var(--*).',
    skip: APPEARANCE_NOT,
  },
  {
    // And a map read by the appearance: COLORS[appearance], PALETTE[resolvedTheme], C[colorScheme].
    re: /\b[A-Za-z_$][\w$]*\s*\[\s*[\w.]*(?:[aA]ppearance|[tT]heme|[cC]olorScheme|isDark(?:Mode)?)\s*\]/g,
    msg: 'A value picked from a map by appearance — the JS `dark:`; it ignores the accent and gray pickers. Read the theme (useChartTheme) or use var(--*).',
  },
];

// A colour whose step 11 is under AA on the gray-2 page: in a color="…" or anywhere in a
// color={…} expression (a ternary, `'amber' as const`, or the const it names).
const LOW_CONTRAST_SCALES = new Set(['green', 'amber', 'yellow', 'orange', 'teal', 'jade']);
// Radix's text components, which draw a color prop's step 11 unless highContrast (Strong, Em and
// Quote don't take one, but a guard costs nothing). Read under an alias (`Text as RText`) or a
// namespace (`Themes.Text`); a name imported from another package (lucide's Link icon, the
// router's Link) isn't one.
// A callout's root draws its text (its Callout.Text, a Heading in it) in its color's step 11 too,
// on its own step-3 tint.
const TEXT_COMPONENTS = new Set(['Text', 'Heading', 'Link', 'Code', 'Blockquote', 'Strong', 'Em', 'Quote', 'Badge', 'Callout.Root']);
const TEXT_PROP_MSG =
  '<Text color> (or <Heading>, <Link>, <Code>, <Badge>, <Callout.Root>, <Callout.Text>…) in green/amber/yellow/orange/teal/jade draws step 11, under AA on the gray-2 page — add highContrast, or use textColorProps() for a computed colour.';

/** The file parsed as TypeScript (TSX for a .tsx file), with parent links. Its fileName is `rel`. */
function parse(source, rel) {
  const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, kind);
}

// The app's own modules, read when a file imports a value from one (`import { cardStyle } from
// './styles'`), so a colour written there is read where it is used. Keyed by the
// path under src/; findViolations' `files` option gives a test its own.
const DISK_READER = (rel) => {
  try {
    return readFileSync(join(SRC, rel), 'utf8');
  } catch {
    return null;
  }
};
let readModule = DISK_READER;
const modules = new Map();

/** The parsed module a relative import `spec` in file `fromRel` names, or null (a package, a file that isn't there). */
function moduleAt(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  for (const path of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (!/\.tsx?$/.test(path)) continue;
    if (!modules.has(path)) {
      const source = readModule(path);
      modules.set(path, source === null ? null : parse(source, path));
    }
    if (modules.get(path)) return modules.get(path);
  }
  return null;
}

/** What a module's top level gives `name`: a const's initializer or a function declaration. */
function topLevelValues(sf, name) {
  const found = [];
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) found.push(...declaredIn(statement.declarationList, name)[1]);
    else if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) found.push(statement);
  }
  return found;
}

/** What a module exports as `name` ('default' for its default export), followed through `export { a as b }` and re-exports. */
function exportedValues(sf, name, depth = 0) {
  if (depth > 8) return [];
  const isExported = (statement) => statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (statement) => statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  const found = [];
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement) && isExported(statement)) found.push(...declaredIn(statement.declarationList, name)[1]);
    else if (ts.isFunctionDeclaration(statement) && isExported(statement) && (isDefault(statement) ? name === 'default' : statement.name?.text === name)) found.push(statement);
    else if (ts.isExportAssignment(statement) && name === 'default') {
      const expression = unwrap(statement.expression);
      found.push(...(ts.isIdentifier(expression) ? topLevelValues(sf, expression.text) : [expression]));
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== name) continue;
        const local = (element.propertyName ?? element.name).text;
        if (statement.moduleSpecifier) {
          const other = moduleAt(sf.fileName, statement.moduleSpecifier.text);
          if (other) found.push(...exportedValues(other, local, depth + 1));
        } else {
          found.push(...topLevelValues(sf, local));
        }
      }
    }
  }
  return found;
}

/** The values an import gives `name`, read from the app's module it names; [] for a package or a namespace import. */
function importedValues(statement, name) {
  const { name: local, namedBindings } = statement.importClause;
  let exported = null;
  if (local?.text === name) exported = 'default';
  else if (namedBindings && ts.isNamedImports(namedBindings)) {
    const element = namedBindings.elements.find((e) => e.name.text === name);
    if (element) exported = (element.propertyName ?? element.name).text;
  }
  const other = exported && moduleAt(statement.getSourceFile().fileName, statement.moduleSpecifier.text);
  return other ? exportedValues(other, exported) : [];
}

/**
 * `source` with each JSX comment (`{/* … *\/}`) blanked out, its newlines kept so line numbers
 * and offsets stay: a commented-out tag isn't drawn. The parser finds them, so a `{/*` in one
 * string and a `*\/}` in a later one, an apostrophe in JSX text, or a block comment after a
 * brace (`catch { /* ignore *\/ }`) can't start or end one.
 */
function withoutJsxComments(source, sf) {
  const spans = [];
  const visit = (node) => {
    // `{/* … */}` is a JSX expression with no expression; the comment is its trivia.
    if (ts.isJsxExpression(node) && !node.expression) spans.push([node.getStart(sf), node.end]);
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  let text = source;
  for (const [from, to] of spans) {
    text = text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, ' ') + text.slice(to);
  }
  return text;
}

/**
 * What this file imports: `radix`, local name → Radix Themes component ('RText' → 'Text');
 * `radixNamespaces`, the names of `import * as Themes from '@radix-ui/themes'`; `other`, the
 * names imported from any other module; `lucide`, the lucide-react icons among them; and `nivo`,
 * the names imported from @nivo's packages (its charts).
 */
function importsOf(sf) {
  const radix = new Map();
  const radixNamespaces = new Set();
  const other = new Set();
  const lucide = new Set();
  const nivo = new Set();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const from = statement.moduleSpecifier.text;
    const { name, namedBindings } = statement.importClause;
    if (name) other.add(name.text);
    if (name && from.startsWith('@nivo/')) nivo.add(name.text);
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      (from === '@radix-ui/themes' ? radixNamespaces : other).add(namedBindings.name.text);
    } else if (namedBindings) {
      for (const element of namedBindings.elements) {
        const local = element.name.text;
        if (from === '@radix-ui/themes') radix.set(local, (element.propertyName ?? element.name).text);
        else other.add(local);
        if (from === 'lucide-react') lucide.add(local);
        if (from.startsWith('@nivo/')) nivo.add(local);
      }
    }
  }
  return { radix, radixNamespaces, other, lucide, nivo };
}

/**
 * The Radix Themes component a JSX tag name stands for ('Text' for `RText`, imported as
 * `Text as RText`, or for `Themes.Text`), or null. A name the file doesn't import is taken as
 * itself (a fixture, or a component defined here).
 */
function radixName(tagName, imports) {
  if (ts.isIdentifier(tagName)) {
    const name = tagName.text;
    if (imports.radix.has(name)) return imports.radix.get(name);
    return imports.other.has(name) ? null : name;
  }
  if (ts.isPropertyAccessExpression(tagName) && ts.isIdentifier(tagName.expression)) {
    const root = tagName.expression.text;
    if (imports.radixNamespaces.has(root)) return tagName.name.text;
    // A dialog's title and description are a Heading and a Text, color prop and all; so is a
    // callout's text, and its root draws that text. A root the file doesn't import is itself (a fixture).
    const base = imports.radix.get(root) ?? (imports.other.has(root) ? null : root);
    const part = `${base}.${tagName.name.text}`;
    if (part in DIALOG_TEXT) return DIALOG_TEXT[part];
  }
  // The same parts through a namespace import: `T.Dialog.Title`, `Themes.Callout.Root`.
  const inner = ts.isPropertyAccessExpression(tagName) ? tagName.expression : null;
  if (inner && ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression) && imports.radixNamespaces.has(inner.expression.text)) {
    const part = `${inner.name.text}.${tagName.name.text}`;
    if (part in DIALOG_TEXT) return DIALOG_TEXT[part];
  }
  return null;
}

const DIALOG_TEXT = {
  'Callout.Root': 'Callout.Root',
  'Callout.Text': 'Text',
  'Dialog.Title': 'Heading',
  'Dialog.Description': 'Text',
  'AlertDialog.Title': 'Heading',
  'AlertDialog.Description': 'Text',
};

/** The string literals in an expression (`isPaid ? 'green' : 'red'` → ['green', 'red']). */
function literals(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  const found = [];
  ts.forEachChild(node, (child) => {
    found.push(...literals(child));
  });
  return found;
}

/** Whether a binding name (`c`, `{ c }`, `[c]`, `{ c = 'green' }`) declares `name`; the element that does, or null. */
function bindingFor(binding, name) {
  if (ts.isIdentifier(binding)) return binding.text === name ? binding.parent : null;
  for (const element of binding.elements ?? []) {
    if (ts.isOmittedExpression(element)) continue;
    const found = bindingFor(element.name, name);
    if (found) return found;
  }
  return null;
}

/**
 * What the name `identifier` refers to where it's used, by the scopes around it (so a
 * parameter or an inner const of the same name hides an outer one): the initializer of the
 * const/let/var, the function a function declaration is, or a destructured name's default. A
 * parameter gives PARAMETER (a value from the caller), and its default if it has one. [] when
 * it can't be read: a destructured name without a default, an import, or a name declared
 * nowhere in the file.
 */
const PARAMETER = Symbol('parameter');

/** The values `declarations` (a const/let/var list) give `name`: [found?, initializers]. */
function declaredIn(list, name) {
  let declared = false;
  const values = [];
  for (const declaration of list.declarations) {
    const element = ts.isIdentifier(declaration.name) ? (declaration.name.text === name ? declaration : null) : bindingFor(declaration.name, name);
    if (!element) continue;
    declared = true;
    if (element.initializer) values.push(element.initializer);
    // `const { brand } = COLOURS` (or `{ a: { b } }`, `[first]`): the value it takes from the object.
    if (element !== declaration && declaration.initializer) values.push(...destructured(declaration, element));
  }
  return [declared, values];
}

/**
 * The object or array literals an expression is: itself, what the name it is refers to (an alias
 * of an alias too), or what a function of this file it calls returns (`const status = config()`,
 * `useMemo(() => ({ … }), [])`).
 */
function literalsOf(expression, seen = new Set()) {
  const node = unwrap(expression);
  if (!node || seen.has(node)) return [];
  seen.add(node);
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) return [node];
  if (ts.isIdentifier(node)) return resolve(node).filter((d) => d !== PARAMETER && !ts.isFunctionLike(d)).flatMap((d) => literalsOf(d, seen));
  if (ts.isConditionalExpression(node)) return [...literalsOf(node.whenTrue, seen), ...literalsOf(node.whenFalse, seen)];
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    if (ts.isIdentifier(callee) && callee.text === 'useMemo' && node.arguments[0] && ts.isFunctionLike(unwrap(node.arguments[0]))) {
      return returnedExpressions(unwrap(node.arguments[0])).flatMap((e) => literalsOf(e, seen));
    }
    const fns = ts.isIdentifier(callee) ? resolve(callee).filter((d) => d !== PARAMETER && ts.isFunctionLike(d) && d.getSourceFile() === node.getSourceFile()) : [];
    return fns.flatMap(returnedExpressions).flatMap((e) => literalsOf(e, seen));
  }
  return [];
}

/** What a destructured binding `element` of `declaration` takes from the literal it destructures, or [] when that can't be read. */
function destructured(declaration, element) {
  const path = [];
  for (let node = element; node && node !== declaration; node = node.parent) {
    if (!ts.isBindingElement(node)) continue;
    if (ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return [];
      path.unshift(key.text);
    } else {
      path.unshift(node.parent.elements.indexOf(node));
    }
  }
  let current = literalsOf(declaration.initializer);
  for (const step of path) {
    current = current.flatMap((literal) => {
      if (typeof step === 'number') return ts.isArrayLiteralExpression(literal) && literal.elements[step] ? literalsOf(literal.elements[step]).concat(step === path[path.length - 1] ? [literal.elements[step]] : []) : [];
      if (!ts.isObjectLiteralExpression(literal)) return [];
      const property = literal.properties.find((p) => ts.isPropertyAssignment(p) && styleKey(p) === step);
      if (!property) return [];
      return step === path[path.length - 1] ? [property.initializer] : literalsOf(property.initializer);
    });
  }
  return current;
}

/** The `var` declarations of `name` anywhere in a function body or file (hoisted), not in a nested function. */
function hoistedVars(body, name) {
  const values = [];
  let declared = false;
  const visit = (node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)) {
      const [found, initializers] = declaredIn(node, name);
      declared ||= found;
      values.push(...initializers);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return [declared, values];
}

function resolve(identifier) {
  const name = identifier.text;
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      for (const parameter of scope.parameters ?? []) {
        const found = bindingFor(parameter.name, name);
        if (found) return found.initializer ? [PARAMETER, found.initializer] : [PARAMETER];
      }
    }
    // A for statement's own bindings: `for (let c = 'green';;)` gives its value, a for-of or
    // for-in binding (each item) and a catch binding (the error) can't be read.
    if (ts.isForStatement(scope) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
      const [declared, values] = declaredIn(scope.initializer, name);
      if (declared) return values;
    }
    if ((ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && ts.isVariableDeclarationList(scope.initializer)) {
      if (declaredIn(scope.initializer, name)[0]) return [];
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration && bindingFor(scope.variableDeclaration.name, name)) return [];
    if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
      const found = [];
      let declared = false;
      // A `var` anywhere in a function's body (or the file) belongs to all of it.
      if (ts.isSourceFile(scope) || (ts.isBlock(scope) && ts.isFunctionLike(scope.parent))) {
        const [hoisted, values] = hoistedVars(scope, name);
        declared ||= hoisted;
        found.push(...values);
      }
      for (const statement of scope.statements) {
        if (ts.isVariableStatement(statement)) {
          if (!(statement.declarationList.flags & ts.NodeFlags.BlockScoped)) continue; // a var: counted above
          const [here, values] = declaredIn(statement.declarationList, name);
          declared ||= here;
          found.push(...values);
        } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
          declared = true;
          found.push(statement);
        } else if (ts.isImportDeclaration(statement) && statement.importClause) {
          const { name: local, namedBindings } = statement.importClause;
          const names = [local?.text, ...(namedBindings && ts.isNamedImports(namedBindings) ? namedBindings.elements.map((e) => e.name.text) : []), namedBindings && ts.isNamespaceImport(namedBindings) ? namedBindings.name.text : undefined];
          if (names.includes(name)) return importedValues(statement, name);
        }
      }
      if (declared) return found;
    }
  }
  return [];
}

/** The root name of `c`, `STATUS[s].color`, `(x!)`: the identifier it reads, or null. */
function rootIdentifier(expression) {
  let root = expression;
  while (
    ts.isPropertyAccessExpression(root) ||
    ts.isElementAccessExpression(root) ||
    ts.isNonNullExpression(root) ||
    ts.isParenthesizedExpression(root) ||
    ts.isAsExpression(root)
  ) {
    root = root.expression;
  }
  return ts.isIdentifier(root) ? root : null;
}

/**
 * The strings an expression can be: a literal, either branch of a ternary, either side of
 * `||`/`??` (the right of `&&`), every string in an object or array literal (a map read later),
 * and for a call, the strings among its arguments and what a function among them, or the
 * same-file function it calls, returns (`pick(ok, 'green', 'red')`,
 * `useMemo(() => (ok ? 'green' : 'red'), [ok])`). A comparison gives none: in
 * `rows.find((r) => r.status === 'green')` the 'green' isn't a value.
 */
function valueLiterals(expression, seen = new Set()) {
  const node = unwrap(expression);
  if (!node || seen.has(node)) return [];
  seen.add(node);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) return [...valueLiterals(node.whenTrue, seen), ...valueLiterals(node.whenFalse, seen)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return [...valueLiterals(node.left, seen), ...valueLiterals(node.right, seen)];
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.CommaToken) return valueLiterals(node.right, seen);
    return [];
  }
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) return literals(node);
  if (ts.isFunctionLike(node)) return returnedExpressions(node).flatMap((e) => valueLiterals(e, seen));
  if (ts.isCallExpression(node)) {
    const fromArguments = node.arguments.flatMap((a) => valueLiterals(a, seen));
    const callee = unwrap(node.expression);
    const fromCallee = ts.isIdentifier(callee)
      ? resolve(callee).flatMap((d) => (d !== PARAMETER && ts.isFunctionLike(d) ? valueLiterals(d, seen) : []))
      : [];
    return [...fromArguments, ...fromCallee];
  }
  if (ts.isIdentifier(node)) return resolve(node).flatMap((d) => (d === PARAMETER || ts.isFunctionLike(d) ? [] : valueLiterals(d, seen)));
  // A const map read in place (`S[s].cardClass`, `status.cardClass`), and a template's
  // pieces (`p-4 ${S[s].cardClass}`), each a string of its own.
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return (mapValues(node) ?? []).flatMap((v) => valueLiterals(v, seen));
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.flatMap((s) => [...valueLiterals(s.expression, seen), s.literal.text])];
  return [];
}

/**
 * The colours a color={…} expression may hold: its string literals and, where it reads a
 * variable (`c`, `STATUS[s].color`), the strings the declaration that name refers to can give
 * (valueLiterals). In this file only: a prop or a parameter (but for its default) can't be
 * read, so a computed colour takes textColorProps().
 */
function colourLiterals(expression) {
  const found = literals(expression);
  const root = rootIdentifier(expression);
  if (root) {
    for (const initializer of resolve(root)) {
      if (initializer === PARAMETER || ts.isFunctionLike(initializer)) continue;
      found.push(...valueLiterals(initializer));
    }
  }
  return found;
}

// An inline style's colour. It belongs in a Radix prop, textColorProps() or a var(--*)
// class, which the theme picker drives. A colour from data (a user's or a chart's) can't be a
// class, so it may stay inline with a comment on its property (or on the object holding it)
// that says why: `/* lint:guard colour: <a few words> */`. A colour written out (a literal) is
// never from data: the marker doesn't let it through.
//
// A property whose value is a colour: color, any *Color (backgroundColor, borderTopColor,
// WebkitTextFillColor, …), fill, stroke. Not colorScheme.
const COLOUR_PROPERTY = /^(?:color|fill|stroke|[A-Za-z]+Color)$/;
// A property whose value may hold one, among other things.
// A mask isn't one: its colours give only an alpha (`linear-gradient(black 80%, transparent)`).
const MAY_HOLD_COLOUR =
  /^(?:background|backgroundImage|border(?:Top|Right|Bottom|Left|Block|Inline)?(?:Start|End)?|borderImage(?:Source)?|outline|boxShadow|textShadow|textDecoration|textEmphasis|columnRule|filter|backdropFilter|textStroke|listStyle|listStyleImage)$/;
// A property's name without a vendor prefix: WebkitBoxShadow is boxShadow.
const unprefixed = (key) => key.replace(/^(?:Webkit|Moz|ms|O)(?=[A-Z])/, '').replace(/^[A-Z]/, (c) => c.toLowerCase());
// A custom property may hold a colour, from data as much as written out (`--swatch: c` as much as
// `--tag-bg: c`), unless its name says it holds a measure: a value from data in `--progress` or
// `--bar-width` is a number. A name that says colour is one (`--border-color`).
// Whole dash-separated parts of the name, not substrings: as substrings "order"
// matched "--border", "space" "--namespace-bg" and "angle" "--triangle-fill", which hold colours.
const MEASURE_CUSTOM_PROPERTY =
  /(?:^--|-)(?:progress|percent|pct|ratio|width|height|size|gap|spacing|space|offset|inset|indent|margin|padding|radius|delay|duration|opacity|alpha|scale|rotate|angle|index|count|columns|rows|span|order|grow|shrink|weight|level|depth|[xyz])(?=-|$)/i;
const holdsMeasure = (key) => MEASURE_CUSTOM_PROPERTY.test(key) && !/colou?r/i.test(key);
// The colour functions whose arguments are colours: in one that takes a colour from data,
// each other argument is still a colour of its own (`color-mix(in srgb, ${c} 20%, white)` writes
// out white), but for a theme variable (it swaps with the theme) and transparent (an alpha).
const MIX_FUNCTION = /^(?:color-mix|light-dark)\($/i;
/**
 * A piece of a value with url() emptied (`url(/img/red.svg)` names no colour) and each colour
 * function of data as \0: an rgb()/hsl()… of data whole (`rgb(${r} ${g} ${b})`), a color-mix() or
 * light-dark() of data as \0 and its other arguments (`\0 in srgb,  20%, white`), so a colour
 * written out among them is still read.
 */
function withoutDataFunctions(text) {
  let out = text.replace(/\burl\([^)]*\)/gi, 'url()');
  const fn = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/gi;
  for (let match = fn.exec(out); match; match = fn.exec(out)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < out.length; end++) {
      if (out[end] === '(') depth++;
      else if (out[end] === ')' && --depth === 0) break;
    }
    const call = out.slice(match.index, end + 1);
    if (call.includes('\0')) {
      const args = out.slice(match.index + match[0].length, end);
      const kept = MIX_FUNCTION.test(match[0])
        ? ` ${args.replace(/\bvar\(--[\w-]+\)/g, '').replace(/(?<![\w-])transparent(?![\w-])/gi, '')}`
        : '';
      out = out.slice(0, match.index) + '\0' + kept + out.slice(end + 1);
      fn.lastIndex = match.index + 1;
    }
  }
  return out;
}
// What a colour property may hold that isn't a colour of its own.
const NOT_A_COLOUR = /^\s*(?:currentcolor|inherit|initial|unset|revert|revert-layer|none|)\s*$/i;
// CSS's named colours, and transparent.
const NAMED_COLOURS =
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent';
// A colour in a piece of a value: a hex, a colour function, a whole var(--…), or a named colour.
// A substitution is written as \0, so `var(--${c}-9)` holds no whole var() and `${w}px solid red`
// still holds `red`.
const COLOUR_IN_TEXT = new RegExp(
  String.raw`#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(|var\(--[\w-]+\)|(?<![\w-])(?:${NAMED_COLOURS.split(' ').join('|')})(?![\w-])`,
  'i'
);
// The marker, with a reason of three words or more, which may start on the comment's next line.
const MARKER_TAG = 'lint:guard colour:';
/** The words of a comment's marker reason (the comment's delimiters and a block's leading `*`s left out), or null without a marker. */
function markerWords(comment) {
  const at = comment.indexOf(MARKER_TAG);
  if (at < 0) return null;
  const reason = comment.slice(at + MARKER_TAG.length).replace(/\*\/\s*$/, '').replace(/^[ \t]*\*(?!\/)/gm, ' ');
  return reason.split(/\s+/).filter(Boolean);
}
const isMarker = (comment) => (markerWords(comment)?.length ?? 0) >= 3;
const SHORT_MARKER_MSG = 'A lint:guard colour marker with a reason under three words — it marks nothing. Say why the colour is from data: /* lint:guard colour: <a few words> */.';
// Fixed artwork, the same in every theme: its written-out colours may stay inline.
const FIXED_ARTWORK = new Map([
  ['components/NuggetsLogo.tsx', 'the Nuggets logo, gold artwork the same in every theme'],
  ['components/NuggetSpinner.tsx', 'the loading spinner, the Nuggets logo’s gold artwork'],
]);
const INLINE_COLOUR_MSG =
  'An inline colour style — the theme picker can\'t reach it. Use a Radix prop (color, highContrast, variant), textColorProps(), or a var(--*) class (text-[var(--gray-11)], bg-[var(--gray-3)], border-t border-[var(--gray-6)]). A colour from data (a user-chosen or a chart colour) may stay inline with a comment on its property saying why: /* lint:guard colour: <a few words> */.';
const INLINE_HUE_TEXT_MSG =
  'Text in a step-9/10 colour whatever its hue (`var(--${c}-9)`) — a marker can\'t keep it: those are fills. Use step 11, or textColorProps() with a color prop.';
const INLINE_STATIC_MSG =
  'An inline colour style with its colour written out — a marker can\'t keep it: only a colour from data may stay inline. Use a Radix prop, textColorProps(), or a var(--*) class.';
const PASSED_STATIC_MSG =
  'A colour written out where a component, a chart or a toast draws it (a colour prop, `colors`, a `theme`, a toast\'s `style` or `iconTheme`) — the theme picker can\'t reach it, and no marker keeps it. Use a Radix prop, textColorProps(), a var(--*) value, or a chart\'s useChartTheme.';
// A theme variable swaps with the theme, and so does a color-mix() of them (`color-mix(in srgb,
// var(--gray-6) 50%, transparent)`); transparent is no colour, nor is a url() (an SVG gradient's
// `fill="url(#g)"`): none of them is a colour written out.
const THEME_VARIABLE = /\bvar\(--[\w-]+\)|(?<![\w-])transparent(?![\w-])|\burl\([^)]*\)/gi;
/** `piece` with each color-mix() of theme variables and transparent alone blanked. */
function withoutThemeMixes(piece) {
  let out = piece;
  for (let at = out.search(/\bcolor-mix\(/i); at >= 0; at = out.slice(at + 1).search(/\bcolor-mix\(/i) + at + 1) {
    const open = out.indexOf('(', at);
    let depth = 0;
    let end = open;
    for (; end < out.length; end++) {
      if (out[end] === '(') depth++;
      else if (out[end] === ')' && --depth === 0) break;
    }
    const [, ...colours] = cssArguments(out.slice(open + 1, end));
    const themed = colours.every((c) => /^(?:var\(--[\w-]+\)|transparent)(?:\s+\d+(?:\.\d+)?%)?$/i.test(c.trim()) || /^\d+(?:\.\d+)?%\s+(?:var\(--[\w-]+\)|transparent)$/i.test(c.trim()));
    if (themed && colours.length > 0) out = out.slice(0, at) + out.slice(end + 1);
    if (out.slice(at + 1).search(/\bcolor-mix\(/i) < 0) break;
  }
  return out;
}
const notWrittenOut = (piece) => withoutThemeMixes(piece).replace(THEME_VARIABLE, '');
// Radix's scales: as a component's colour prop (<Badge color="green">, a <Theme>'s accentColor, the
// app's own <DashboardSummaryCard borderColor="green">, which maps it to var(--green-9)), a scale's
// name is the app's colour vocabulary, which the theme draws. On an icon (lucide's), a chart
// (nivo's), an SVG or DOM element, and under any key of a style, a theme, icon colours or `colors`
// (`background: 'red'`), it's CSS's named colour.
const RADIX_SCALES = new Set('gray mauve slate sage olive sand tomato red ruby crimson pink plum purple violet iris indigo blue cyan teal jade green grass bronze gold brown orange amber yellow lime mint sky'.split(' '));
// What draws a colour outside a style: a component's prop, and a toast's options.
// - A colour prop (color, fill, stroke, borderColor, labelTextColor: COLOUR_PROPERTY), colours
//   (`colors`, `tooltipColors`), a chart's `theme` and its `legends`, `defs`, `markers` and
//   `layers`, a toast's icon colours (`iconTheme`), and a Toaster's `toastOptions`; on a JSX
//   element, through a spread of props, or as createElement()/cloneElement()'s props.
// - A toast's options (`toast.error(msg, { style, iconTheme })`).
// Not a picker's starting value or choices (`defaultColor`, `initialColor`, `presetColors`), and
// never a key inside any other call's argument or prop: a request body, a form's values, saved
// preferences hold a colour (or a Radix scale's name) as data, even under `theme` or `style`.
const COLOURS_PROP = /^(?:colors|[a-z]\w*Colors)$/;
const CHART_STYLE_PROPS = new Set(['theme', 'legends', 'defs', 'markers', 'layers']);
const DATA_COLOUR_PROP = /^(?:default|initial|preset|selected)[A-Z]|^presets$/;

/** The innermost node of the parsed file that holds offset `index`. */
function nodeAt(sf, index) {
  let found = sf;
  const visit = (node) => {
    if (node.getStart(sf) <= index && index < node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sf, visit);
  return found;
}

/**
 * The name the string at offset `index` is held under: the property, variable or JSX attribute
 * whose value it is (through ternaries, `||`, template literals and `as const`), or null.
 */
function holderName(sf, index) {
  const node = nodeAt(sf, index);
  if (!ts.isStringLiteralLike(node) && !ts.isTemplateLiteralToken(node)) return null;
  for (let up = node.parent; up; up = up.parent) {
    if (ts.isPropertyAssignment(up) || ts.isVariableDeclaration(up) || ts.isJsxAttribute(up)) {
      return up.name.getText(sf);
    }
    if (
      !ts.isConditionalExpression(up) &&
      !ts.isBinaryExpression(up) &&
      !ts.isParenthesizedExpression(up) &&
      !ts.isTemplateExpression(up) &&
      !ts.isTemplateSpan(up) &&
      !ts.isAsExpression(up) &&
      !ts.isJsxExpression(up)
    ) {
      return null;
    }
  }
  return null;
}

const unwrap = (node) =>
  node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node))
    ? unwrap(node.expression)
    : node;

/**
 * The values a colour prop or a `colors` entry can be: an array's elements, what a
 * function returns (nivo's `colors={(d) => …}`) or an array's map() or flatMap() gives
 * (`colors={rows.map(() => '#f00')}`), what a function of this file returns, either branch of a
 * ternary, and what a name of this file's (or an import's) holds when that is one of them; anything
 * else is a value. With `fallbacks`, both sides of `??` and `||` too: a `colors` function's
 * `d.data.color ?? '#999'` writes '#999' out (a colour prop's fallback after data is the data's).
 */
function colourValues(expression, { fallbacks = false } = {}, seen = new Set()) {
  const node = unwrap(expression);
  if (!node || seen.has(node)) return [];
  seen.add(node);
  const again = (e) => colourValues(e, { fallbacks }, seen);
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((e) => again(ts.isSpreadElement(e) ? e.expression : e));
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return returnedExpressions(node).flatMap(again);
  if (ts.isConditionalExpression(node)) return [...again(node.whenTrue), ...again(node.whenFalse)];
  if (fallbacks && ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    return [...again(node.left), ...again(node.right)];
  }
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    const fn = node.arguments[0] && unwrap(node.arguments[0]);
    if (ts.isPropertyAccessExpression(callee) && (callee.name.text === 'map' || callee.name.text === 'flatMap') && fn && ts.isFunctionLike(fn)) return again(fn);
    const fns = ts.isIdentifier(callee) ? resolve(callee).filter((d) => d !== PARAMETER && ts.isFunctionLike(d) && d.getSourceFile() === node.getSourceFile()) : [];
    if (fns.length) return fns.flatMap(again);
  }
  if (ts.isIdentifier(node)) {
    const held = resolve(node).filter((d) => d !== PARAMETER && (ts.isArrayLiteralExpression(unwrap(d)) || ts.isFunctionLike(d)));
    if (held.length) return held.flatMap(again);
  }
  return [node];
}

/** The objects a value can be: styleObjects' (through names, spreads, maps, functions and imports), and an array's elements'. */
function objectsOf(expression, seen = new Set()) {
  const node = unwrap(expression);
  if (!node || seen.has(node)) return [];
  seen.add(node);
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((e) => objectsOf(ts.isSpreadElement(e) ? e.expression : e, seen));
  if (ts.isIdentifier(node)) {
    const arrays = resolve(node).filter((d) => d !== PARAMETER && !ts.isFunctionLike(d) && ts.isArrayLiteralExpression(unwrap(d)));
    if (arrays.length) return arrays.flatMap((d) => objectsOf(d, seen));
  }
  return styleObjects(node);
}

/** The expressions a function returns: an arrow's body, or each `return` (not a nested function's). */
function returnedExpressions(fn) {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const found = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found;
}

/**
 * The object literals a style expression can be: itself (through parentheses and `as`), either
 * branch of a ternary or of `||`/`??` (the right of `&&`), what an object spreads, the const a
 * name refers to, and what a function it calls returns (`mk()`, `useMemo(() => ({ … }), [])`).
 */
function styleObjects(expression, seen = new Set()) {
  const node = unwrap(expression);
  if (!node || seen.has(node)) return [];
  seen.add(node);
  if (ts.isConditionalExpression(node)) return [...styleObjects(node.whenTrue, seen), ...styleObjects(node.whenFalse, seen)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return styleObjects(node.right, seen);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return [...styleObjects(node.left, seen), ...styleObjects(node.right, seen)];
    return [];
  }
  if (ts.isIdentifier(node)) return resolve(node).flatMap((d) => (ts.isFunctionLike(d) ? [] : styleObjects(d, seen)));
  if (ts.isFunctionLike(node)) return returnedExpressions(node).flatMap((e) => styleObjects(e, seen));
  // `styles.card`, `STYLES[v]`: the entries of a const map that the access can read.
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return (mapValues(node, 'entry') ?? []).flatMap((v) => styleObjects(v, seen));
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    if (name === 'useMemo' && node.arguments[0]) return styleObjects(node.arguments[0], seen);
    // `Object.assign({}, base, { color })`: every object it merges.
    if (name === 'assign' && ts.isPropertyAccessExpression(callee) && callee.expression.getText() === 'Object') return node.arguments.flatMap((a) => styleObjects(a, seen));
    if (ts.isIdentifier(callee)) return resolve(callee).flatMap((d) => (ts.isFunctionLike(d) ? returnedExpressions(d).flatMap((e) => styleObjects(e, seen)) : []));
    if (ts.isFunctionLike(callee)) return styleObjects(callee, seen);
    return [];
  }
  if (!ts.isObjectLiteralExpression(node)) return [];
  const spread = node.properties.filter(ts.isSpreadAssignment).flatMap((p) => styleObjects(p.expression, seen));
  return [node, ...spread];
}

/**
 * The values `MAP.key`, `MAP[k]` or `MAP[s].color` can read from a const object or array
 * literal in this file (or one it imports, or an alias of one): each `color` property's value in
 * it (for a name at the end of the chain; in `entry` mode only the map's own entries named so),
 * or each of its entries (for an index). Null when the root isn't such a literal (a prop, a
 * call's result), or nothing in it has that name.
 */
function mapValues(access, mode = 'deep') {
  const root = rootIdentifier(access);
  if (!root) return null;
  const declarations = resolve(root).filter((d) => d !== PARAMETER);
  const maps = declarations.flatMap((d) => literalsOf(d));
  if (!maps.length || maps.length < declarations.filter((d) => !ts.isFunctionLike(d)).length) return null;
  const values = [];
  if (ts.isPropertyAccessExpression(access)) {
    const name = access.name.text;
    if (mode === 'entry' && unwrap(access.expression) === root) {
      for (const map of maps.filter(ts.isObjectLiteralExpression)) {
        values.push(...map.properties.filter((p) => ts.isPropertyAssignment(p) && styleKey(p) === name).map((p) => p.initializer));
      }
    } else {
      const visit = (node) => {
        if (ts.isPropertyAssignment(node) && styleKey(node) === name) values.push(node.initializer);
        ts.forEachChild(node, visit);
      };
      maps.forEach(visit);
    }
  } else {
    for (const map of maps) {
      const entries = ts.isArrayLiteralExpression(map) ? map.elements : map.properties.filter(ts.isPropertyAssignment).map((p) => p.initializer);
      values.push(...entries.filter((e) => !ts.isSpreadElement(e)));
    }
  }
  return values.length ? values : null;
}

/**
 * What a style value can be: `statics`, the written-out pieces it may take (a literal, a
 * template's text with each substitution as \0), and `data`, whether it may take a value from
 * somewhere else (a prop, a call, a substitution outside url()). A fallback after a value from
 * data (`tag.color || 'var(--accent-11)'`) is part of that value, not a colour of its own.
 */
function valueParts(expression, seen = new Set()) {
  const node = unwrap(expression);
  const none = { statics: [], data: false };
  if (!node || seen.has(node)) return none;
  seen.add(node);
  const merge = (a, b) => ({ statics: [...a.statics, ...b.statics], data: a.data || b.data });
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return { statics: [node.text], data: false };
  if (ts.isTemplateExpression(node)) {
    // A substitution whose value is written out in this file (`${BRAND}`, a const) is that
    // text; any other is \0. At most 16 versions of the text are kept.
    let texts = [node.head.text];
    for (const span of node.templateSpans) {
      const sub = valueParts(span.expression, seen);
      const pieces = !sub.data && sub.statics.length ? sub.statics : ['\0'];
      texts = texts.flatMap((t) => pieces.map((piece) => t + piece + span.literal.text)).slice(0, 16);
    }
    // A substitution followed by a unit is a length (`${w}px`), not a colour.
    texts = texts.map((t) => t.replace(/\0(?=(?:px|rem|em|ch|ex|vh|vw|vmin|vmax|%|s|ms|deg|fr)\b|%)/g, '0'));
    // Nor is one inside url() or a filter function that takes no colour.
    const outside = texts.map((t) => t.replace(/\b(?:url|blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia)\([^)]*\)/g, ''));
    return { statics: texts, data: outside.some((t) => t.includes('\0')) };
  }
  if (ts.isCallExpression(node)) {
    // What a function of this file (or `useMemo`'s callback) returns; any
    // other call's result is data.
    const callee = unwrap(node.expression);
    const fns = ts.isIdentifier(callee) && callee.text === 'useMemo' && node.arguments[0] ? [unwrap(node.arguments[0])]
      : ts.isIdentifier(callee) ? resolve(callee).filter((d) => d !== PARAMETER && ts.isFunctionLike(d) && d.getSourceFile() === node.getSourceFile())
      : ts.isFunctionLike(callee) ? [callee] : [];
    if (fns.length && fns.every(ts.isFunctionLike)) return fns.flatMap(returnedExpressions).map((e) => valueParts(e, seen)).reduce(merge, none);
    return { statics: [], data: true };
  }
  if (ts.isConditionalExpression(node)) return merge(valueParts(node.whenTrue, seen), valueParts(node.whenFalse, seen));
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return valueParts(node.right, seen);
    const left = valueParts(node.left, seen);
    const right = valueParts(node.right, seen);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return left.data ? left : merge(left, right);
    if (op !== ts.SyntaxKind.PlusToken) return { statics: [], data: true };
    // `+` joins pieces: what a side gives from data is a \0 in the text (`item.color + '20'`).
    const side = (parts) => (parts.data ? `${parts.statics.join('\0')}\0` : parts.statics.join(''));
    return { statics: [side(left) + side(right)], data: left.data || right.data };
  }
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return none;
  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined') return none;
    const declarations = resolve(node);
    // A parameter is the caller's value; its default is a fallback for it, as after `||`.
    if (!declarations.length || declarations.includes(PARAMETER)) return { statics: [], data: true };
    return declarations.filter((d) => !ts.isFunctionLike(d)).map((d) => valueParts(d, seen)).reduce(merge, none);
  }
  // A const map read in place (`STATUS[s].color`): the values it can give are written there.
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const values = mapValues(node);
    if (values) return values.map((v) => valueParts(v, seen)).reduce(merge, none);
  }
  return { statics: [], data: true };
}

/**
 * A style property's name as CSS-in-JS writes it ('backgroundColor', '--tag-bg'), a computed
 * one too when it's a string (`['color']`), or null: a spread or a method has none, and a
 * computed name from data can't be read.
 */
function styleKey(property) {
  let name = property.name;
  if (!name) return null;
  if (ts.isComputedPropertyName(name)) name = unwrap(name.expression);
  if (ts.isIdentifier(name) && !ts.isComputedPropertyName(property.name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    // 'background-color' as 'backgroundColor'; a custom property keeps its name.
    return name.text.startsWith('--') ? name.text : name.text.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }
  return null;
}

/**
 * The comments on a node, by one rule: a comment belongs to the property it comes before when
 * that property starts on the comment's line or the comment has a line of its own above it; a
 * comment that ends its line after a property (past its comma) belongs to that property. So in
 * `color: c, /* … *\/ backgroundColor: d` the comment is backgroundColor's alone, and in
 * `color: c, // …` (end of the line) it is color's.
 */
function commentsOn(sf, node) {
  const text = sf.text;
  const start = node.getStart(sf);
  const before = [...(ts.getTrailingCommentRanges(text, node.pos) ?? []), ...(ts.getLeadingCommentRanges(text, node.pos) ?? [])].filter((range) => {
    const lineStart = text.lastIndexOf('\n', range.pos - 1) + 1;
    const ownLine = /^\s*$/.test(text.slice(lineStart, range.pos));
    const touching = !text.slice(range.end, start).includes('\n');
    return ownLine || touching;
  });
  let end = node.end;
  const comma = /^[ \t]*,/.exec(text.slice(end));
  if (comma) end += comma[0].length;
  // After it: only a comment that ends the line, or that closes the object (`c /* … */ }`).
  const after = (ts.getTrailingCommentRanges(text, end) ?? []).filter((range) => {
    const rest = text.slice(range.end, (text.indexOf('\n', range.end) + 1 || text.length + 1) - 1);
    return /^\s*(?:$|[}\]),])/.test(rest);
  });
  return [...before, ...after].map((range) => text.slice(range.pos, range.end));
}

/**
 * Whether a comment on the property, on the object literal holding it, or on what holds that
 * object (a `return`, a const, an arrow's body, through parentheses: a marker before
 * `return ({ … })`) is the marker. Read in the property's own file.
 */
function isMarked(property, object) {
  const sf = property.getSourceFile();
  const holders = [property, object];
  for (let up = object.parent; up; up = up.parent) {
    if (ts.isParenthesizedExpression(up) || ts.isAsExpression(up) || ts.isSatisfiesExpression(up)) holders.push(up);
    else if (ts.isReturnStatement(up) || ts.isVariableDeclaration(up) || ts.isVariableDeclarationList(up) || ts.isVariableStatement(up)) holders.push(up);
    else if (ts.isArrowFunction(up)) holders.push(up);
    else break;
  }
  return holders.some((node) => commentsOn(sf, node).some(isMarker));
}

/** Each marker comment in the file whose reason is under three words, as { line, msg }. */
function shortMarkers(sf, lineOf) {
  const found = [];
  const seen = new Set();
  const scan = (ranges) => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const words = markerWords(sf.text.slice(range.pos, range.end));
      if (words && words.length < 3) found.push({ line: lineOf(range.pos), msg: SHORT_MARKER_MSG });
    }
  };
  // A comment on the line of the token before it is that token's trailing one, so both kinds
  // are read at each node's start; a JSX comment ({/* … */}) is read inside its braces.
  const visit = (node) => {
    scan(ts.getLeadingCommentRanges(sf.text, node.pos));
    scan(ts.getTrailingCommentRanges(sf.text, node.pos));
    scan(ts.getTrailingCommentRanges(sf.text, node.end));
    if (ts.isJsxExpression(node) && !node.expression) {
      const inside = node.getStart(sf) + 1;
      scan(ts.getLeadingCommentRanges(sf.text, inside));
      scan(ts.getTrailingCommentRanges(sf.text, inside));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  scan(ts.getLeadingCommentRanges(sf.text, sf.endOfFileToken.pos));
  return found;
}

// A prop that takes a style: `style`, or one named …Style (`labelStyle`, `contentStyle`).
const STYLE_PROP = /^(?:style|[a-z]\w*Style)$/;
/** Whether `rel` (a path under src/) is a test's file. */
const isTestFile = (rel) => rel.startsWith('test/') || rel.includes('__tests__/') || /\.test\.tsx?$/.test(rel);

/**
 * Each colour in a `style` that isn't from data and marked, as { line, msg }: in `style={…}` or
 * another style prop (`labelStyle`, `contentStyle`), read through consts, maps,
 * functions, spreads, `Object.assign` and the app's own modules; a spread `{...{ style }}`; and a
 * DOM write (`el.style.color = …`, `el.style.setProperty('color', …)`, `Object.assign(el.style, …)`).
 * A colour written out is refused, marked or not, except in the FIXED_ARTWORK files; so is text in
 * a step-9/10 colour of any hue (`var(--${c}-9)`). Each property is reported once, where it's
 * written; one in another module at the first place this file uses it.
 */
function inlineColourStyles(sf, rel, lineOf) {
  const found = [];
  const reported = new Set();
  const artwork = FIXED_ARTWORK.has(rel);
  // A test's object literals are the data it hands the code (a tag's colour in a fixture).
  const test = isTestFile(rel);
  const imports = importsOf(sf);
  /** The finding for one style property (its name `key`, its value's parts), or null. */
  const problem = (key, parts, marked) => {
    const custom = key.startsWith('--');
    const bare = unprefixed(key);
    if (!custom && !COLOUR_PROPERTY.test(key) && !MAY_HOLD_COLOUR.test(bare)) return null;
    // A colour property's whole literal is a colour (unless a keyword); a piece of one beside
    // a value from data (`var(--${c}-9)`, `item.color + '20'`) is one only if it holds a whole
    // colour. Anything else holds one only where a colour is written in it.
    const pieces = parts.statics.map(withoutDataFunctions);
    const written = pieces.some((p) =>
      COLOUR_PROPERTY.test(key) && !p.includes('\0') ? !NOT_A_COLOUR.test(p) : p.split('\0').some((q) => COLOUR_IN_TEXT.test(q))
    );
    if (written && !artwork) return INLINE_STATIC_MSG;
    // Text in a fill step, whatever the hue: no marker keeps it.
    if ((key === 'color' || bare === 'textFillColor') && parts.statics.some((p) => /var\(--(?:[\w-]*|\0)-a?(?:9|10)\)/.test(p))) return INLINE_HUE_TEXT_MSG;
    if (!parts.data || marked()) return null;
    if (custom && holdsMeasure(key)) return null;
    return INLINE_COLOUR_MSG;
  };
  // `passed`: an object a component, a chart or a toast draws. Only a colour written out is
  // refused there: a colour from data goes on to a library, which a marker can't mark.
  const check = (object, site, passed = false) => {
    for (const property of object.properties) {
      if (reported.has(property)) continue;
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
      const key = styleKey(property);
      if (key === null) continue;
      const parts = ts.isPropertyAssignment(property) ? valueParts(property.initializer) : valueParts(property.name);
      const msg = passed
        ? problem(key, { ...parts, statics: parts.statics.map(notWrittenOut) }, () => true) === INLINE_STATIC_MSG ? PASSED_STATIC_MSG : null
        : problem(key, parts, () => isMarked(property, object));
      if (msg) {
        reported.add(property);
        const here = property.getSourceFile() === sf;
        found.push({ line: lineOf((here ? property : site).getStart(sf)), msg: here ? msg : `${msg} (In ${property.getSourceFile().fileName}, which this style reads.)` });
      }
    }
  };
  const statementMarked = (node) => () => commentsOn(sf, node.parent).some(isMarker);
  const isStyleOf = (expression) => {
    const target = unwrap(expression);
    return ts.isPropertyAccessExpression(target) && target.name.text === 'style';
  };
  /** The findings for CSS text written to an element (`el.style.cssText = …`, `setAttribute('style', …)`), each declaration as its property. */
  const checkCssText = (node, value) => {
    const parts = valueParts(value);
    const marked = statementMarked(node);
    // CSS text wholly from data can't be read: it may hold any colour.
    if (parts.data && !parts.statics.some((t) => t.includes(':'))) {
      if (!marked()) found.push({ line: lineOf(node.getStart(sf)), msg: INLINE_COLOUR_MSG });
      return;
    }
    for (const text of parts.statics) {
      for (const declaration of text.split(';')) {
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        const name = declaration.slice(0, colon).trim();
        const key = name.startsWith('--') ? name : name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const css = declaration.slice(colon + 1);
        const msg = problem(key, { statics: [css], data: withoutDataFunctions(css).includes('\0') }, marked);
        if (msg) found.push({ line: lineOf(node.getStart(sf)), msg });
      }
    }
  };
  const visit = (node) => {
    if (ts.isJsxAttribute(node) && STYLE_PROP.test(node.name.getText(sf)) && node.initializer && ts.isJsxExpression(node.initializer)) {
      styleObjects(node.initializer.expression).forEach((o) => check(o, node));
    } else if (ts.isJsxSpreadAttribute(node)) {
      // styleObjects gives the props object and each object spread into it (`{ ...base, id }`).
      for (const props of styleObjects(node.expression)) {
        for (const property of props.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
          if (styleKey(property) !== 'style') continue;
          if (ts.isPropertyAssignment(property)) styleObjects(property.initializer).forEach((o) => check(o, node));
          else styleObjects(property.name).forEach((o) => check(o, node));
        }
      }
    } else if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
      // `el.style.color = …`, `el.style['color'] = …` and `el.style.cssText = …`,
      // marked by a comment on its statement.
      const left = unwrap(node.left);
      const name = !isStyleOf(left.expression ?? left)
        ? null
        : ts.isPropertyAccessExpression(left)
          ? left.name.text
          : ts.isElementAccessExpression(left) && ts.isStringLiteralLike(unwrap(left.argumentExpression))
            ? unwrap(left.argumentExpression).text
            : null;
      const key = name === null || name.startsWith('--') ? name : name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key === 'cssText') checkCssText(node, node.right);
      else if (key !== null) {
        const msg = problem(key, valueParts(node.right), statementMarked(node));
        if (msg) found.push({ line: lineOf(node.getStart(sf)), msg });
      }
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(unwrap(node.expression))) {
      const callee = unwrap(node.expression);
      const target = unwrap(callee.expression);
      if (callee.name.text === 'setProperty' && ts.isPropertyAccessExpression(target) && target.name.text === 'style' && node.arguments.length >= 2 && ts.isStringLiteralLike(node.arguments[0])) {
        const name = node.arguments[0].text;
        const key = name.startsWith('--') ? name : name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const msg = problem(key, valueParts(node.arguments[1]), statementMarked(node));
        if (msg) found.push({ line: lineOf(node.getStart(sf)), msg });
      }
      // `el.setAttribute('style', 'color: red')` is CSS text too.
      if (callee.name.text === 'setAttribute' && node.arguments.length >= 2 && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text.toLowerCase() === 'style') {
        checkCssText(node, node.arguments[1]);
      }
      const first = node.arguments[0] && unwrap(node.arguments[0]);
      if (callee.name.text === 'assign' && target.getText(sf) === 'Object' && first && ts.isPropertyAccessExpression(first) && first.name.text === 'style') {
        node.arguments.slice(1).flatMap((a) => styleObjects(a)).forEach((o) => check(o, node));
      }
    }
    // A colour written out where a component, a chart or a toast draws it: a prop, a spread
    // of props, createElement()'s props, and a toast's options. Read after the styles, so an object
    // a style reads (`useMemo(() => ({ … }))` for a style={…}) is reported as the style's.
    /** Each key of `expression`'s objects as a prop of `element`. */
    const propsOf = (expression, site, element, styles) => {
      for (const props of styleObjects(expression)) {
        for (const property of props.properties) {
          const key = ts.isPropertyAssignment(property) ? styleKey(property) : null;
          if (key === null) continue;
          const kind = STYLE_PROP.test(key) ? (styles ? 'style' : null) : kindOfProp(key);
          if (kind) drawn.push([property.initializer, kind, site, element, key]);
        }
      }
    };
    if (!test && ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      const base = ts.isPropertyAccessExpression(callee) ? unwrap(callee.expression) : callee;
      if ((name === 'createElement' || name === 'cloneElement') && node.arguments[1]) propsOf(node.arguments[1], node, null, true);
      else if (ts.isIdentifier(base) && toastNames.has(base.text)) node.arguments.forEach((a) => drawn.push([a, 'toast', node, null, 'color']));
    } else if (!test && ts.isJsxAttribute(node) && !STYLE_PROP.test(node.name.getText(sf)) && node.initializer) {
      const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
      const name = node.name.getText(sf);
      const kind = kindOfProp(name);
      if (value && kind) drawn.push([value, kind, node, node.parent.parent, name]);
    } else if (!test && ts.isJsxSpreadAttribute(node)) {
      // Props spread in (`{...{ colors: ['#f00'] }}`, `{...chartProps}`): each key is a prop (a
      // `style` key is the style rule's, above).
      propsOf(node.expression, node, node.parent.parent, false);
    }
    ts.forEachChild(node, visit);
  };
  // react-hot-toast's toast, by the names it's imported under (`toast` in a fixture that imports none).
  const toastNames = new Set(['toast']);
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'react-hot-toast' || !statement.importClause) continue;
    if (statement.importClause.name) toastNames.add(statement.importClause.name.text);
    const named = statement.importClause.namedBindings;
    if (named && ts.isNamedImports(named)) named.elements.filter((e) => (e.propertyName ?? e.name).text === 'toast').forEach((e) => toastNames.add(e.name.text));
  }
  /**
   * What a component's prop `name` draws (CHART_STYLE_PROPS and the rest above): 'style' (a theme,
   * a chart's legends, defs, markers, layers), 'icon' (a toast's icon colours), 'toast' (a
   * Toaster's options), 'colours' (`colors`), 'colour' (a colour prop), or null (nothing drawn).
   */
  const kindOfProp = (name) =>
    DATA_COLOUR_PROP.test(name) ? null
      : CHART_STYLE_PROPS.has(name) ? 'style'
        : name === 'iconTheme' ? 'icon'
          : name === 'toastOptions' ? 'toast'
            : COLOURS_PROP.test(name) ? 'colours'
              : COLOUR_PROPERTY.test(name) ? 'colour'
                : null;
  /** One colour value `value` of `key` (a prop, a key, an entry), refused if written out; a Radix scale passes as a component's colour prop (RADIX_SCALES). */
  const checkValue = (value, key, site, element) => {
    const node = unwrap(value);
    if (reported.has(node)) return;
    const parts = valueParts(node);
    const tag = element && (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) ? element.tagName.getText(sf).split('.')[0] : '';
    const component = /^[A-Z]/.test(tag) && !imports.lucide.has(tag) && !imports.nivo.has(tag);
    const radixProp = component && COLOUR_PROPERTY.test(key);
    const statics = parts.statics.map((p) => (radixProp && RADIX_SCALES.has(p.trim()) ? '' : notWrittenOut(p)));
    const colourKey = COLOUR_PROPERTY.test(key) ? key : 'color';
    if (problem(colourKey, { ...parts, statics }, () => true) !== INLINE_STATIC_MSG) return;
    reported.add(node);
    const here = node.getSourceFile() === sf;
    found.push({ line: lineOf((here ? node : site).getStart(sf)), msg: here ? PASSED_STATIC_MSG : `${PASSED_STATIC_MSG} (In ${node.getSourceFile().fileName}, which this reads.)` });
  };
  /**
   * The colours `expression` draws as `kind`: a style's objects ('style': their colour keys, and the
   * objects in them, a nested `colors` or `iconTheme` as such), a toast's options ('toast': its
   * `style`, its `iconTheme`, and those of its per-kind options, `success: { … }`), icon colours
   * ('icon': each key a colour), colours ('colours': each value, fallbacks included) and a colour
   * prop's values ('colour'); an object a colour prop is (nivo's `{ from: 'color' }`) is a style.
   * Through names, spreads, maps, functions and imports, as a style is read.
   */
  const walkDrawn = (expression, kind, site, element, seen) => {
    if (kind === 'colour' || kind === 'colours') {
      for (const value of colourValues(expression, { fallbacks: kind === 'colours' })) {
        const objects = objectsOf(value);
        if (objects.length) objects.forEach((o) => walkObject(o, 'style', site, seen));
        else checkValue(value, element?.key ?? 'color', site, kind === 'colour' ? element?.node ?? null : null);
      }
      return;
    }
    for (const object of objectsOf(expression)) walkObject(object, kind, site, seen);
  };
  const walkObject = (object, kind, site, seen) => {
    if (seen.has(object)) return;
    seen.add(object);
    if (kind === 'style') check(object, site, true);
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = styleKey(property);
      if (key === null) continue;
      const next = { key, node: null };
      if (kind === 'icon') walkDrawn(property.initializer, 'colour', site, { key: 'color', node: null }, seen);
      else if (kind === 'toast') {
        // A toast's own options: its style and icon colours, and each kind's (`success: { … }`).
        if (STYLE_PROP.test(key)) walkDrawn(property.initializer, 'style', site, next, seen);
        else if (key === 'iconTheme') walkDrawn(property.initializer, 'icon', site, next, seen);
        else walkDrawn(property.initializer, 'toast', site, next, seen);
      } else if (key === 'iconTheme') walkDrawn(property.initializer, 'icon', site, next, seen);
      else if (COLOURS_PROP.test(key)) walkDrawn(property.initializer, 'colours', site, next, seen);
      // A colour key is check()'s; the style's other objects are styles too.
      else if (!COLOUR_PROPERTY.test(key)) walkDrawn(property.initializer, 'style', site, next, seen);
    }
  };
  const drawn = [];
  visit(sf);
  for (const [value, kind, site, element, key] of drawn) walkDrawn(value, kind, site, { key, node: element }, new Set());
  return found;
}

/** The JSX element's own attribute `name` (not a nested element's), or undefined. */
function attribute(element, name) {
  return element.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText() === name);
}

/** Whether the element is highContrast: a bare `highContrast`, or `={true}`. `={false}`, or an expression, may be off. */
function isHighContrast(element) {
  const attr = attribute(element, 'highContrast');
  if (!attr) return false;
  if (!attr.initializer) return true;
  return ts.isJsxExpression(attr.initializer) && attr.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword;
}

const CARD_FILL_MSG =
  'A bg-[…] class on a <Card> — the card draws its own fill (--card-background-color) over it, so it doesn\'t show (in dark mode, not at all). Set the variable: className="[--card-background-color:var(--red-3)]".';
// A background class, with any variants (hover:, md:), as a whole class.
const BACKGROUND_CLASS = /(?<![\w-])(?:[\w-]+:)*bg-[[(]/;

/** Each Radix <Card> whose className sets its background with a bg-[…] class, as { line, msg }. */
function cardFillProblems(sf, imports, lineOf) {
  const found = [];
  const visit = (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && radixName(node.tagName, imports) === 'Card') {
      const init = attribute(node, 'className')?.initializer;
      const classes = !init ? [] : ts.isStringLiteral(init) ? [init.text] : ts.isJsxExpression(init) && init.expression ? valueLiterals(init.expression).concat(literals(init.expression)) : [];
      if (classes.some((c) => BACKGROUND_CLASS.test(c))) found.push({ line: lineOf(node.getStart(sf)), msg: CARD_FILL_MSG });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// Money formatted by hand: toLocaleString(), toFixed(2) or an Intl.NumberFormat's format()
// (one made in place, held in a const, or made in useMemo) on an amount, which the `style:
// 'currency'` rule doesn't see (ZeroBalanceAccountCard showed a balance with toLocaleString).
// formatMoney takes the household's currency and locale; these write en-US dollars (or the host's
// locale) by hand. An amount is:
// - a value named so (MONEY_PARTS: a word of its name, or of the const it is: `absAmount`,
//   `currentCents`, `h.cost_basis`, `netWorth`, `marketValue`), unless a word says it's a count, a
//   percentage or a share (NOT_MONEY_PARTS: `totalCount`, `budgetPct`, `total_shares`,
//   `budgets.length`) or a moment (`budget.created_at` in `new Date(…)`). `total` and `sum` are
//   counts as often as money: toLocaleString() without fraction digits on one alone is a count.
//   `value` alone says nothing (it is everywhere): it is an amount only as `marketValue` or
//   beside a $;
// - or one written beside a $ (a template's `$${x}`, JSX's `Available: ${x}`, `{'$'}{x}`,
//   `<span>$</span>{x}`, '$' + x, String(x) in one of those) or before a currency code (`${x} USD`).
// Not one followed by % (a percentage), nor a figure handed on as data: a request body's or a
// form's value (`{ amount: amount.toFixed(2) }`), or a setter's argument (`setText(x.toFixed(2))`,
// an input's editable text).
const MONEY_FORMAT_MSG =
  'Money formatted by hand: an amount (named so, or with a $ or USD beside it) through toLocaleString, toFixed(2) or Intl.NumberFormat — show it with formatMoney (@nuggets/shared), or formatCurrency (utils/currency.ts) for accounting parentheses: they take the household\'s currency and locale. A count, a percentage or a share isn\'t money: a name that says so (…Count, …Pct, …Percentage, …Shares) passes.';
// The files that write an amount as a plain decimal on purpose, each with why. Nothing joins it
// without a reason a person reads.
const MONEY_TEXT_EXEMPT = new Map([
  ['pages/DataExportPage.tsx', 'CSV cells: a plain decimal for a spreadsheet, not money shown to a person'],
  ['utils/currency.ts', 'the money helpers themselves (cents and amounts as numbers and text)'],
]);
const MONEY_PARTS = new Set(['amount', 'balance', 'total', 'budget', 'cents', 'price', 'cost', 'sum', 'spent', 'remaining', 'available', 'income', 'expense', 'payment', 'debt', 'gain', 'worth']);
// Words that are money only beside another: `marketValue`.
const MONEY_PAIRS = [['market', 'value']];
// A count, a percentage, a share or a measure: `totalCount`, `budgetPct`, `total_shares`.
const NOT_MONEY_PARTS = new Set(['count', 'counts', 'length', 'number', 'num', 'qty', 'quantity', 'pct', 'percent', 'percentage', 'percentages', 'ratio', 'rate', 'share', 'shares', 'units', 'size', 'weight', 'index']);
// A moment's parts: `budget.created_at` in `new Date(…)`, `budgetDate`, are a date's, not an amount's.
const MOMENT_PARTS = new Set(['date', 'dates', 'time', 'at', 'day', 'month', 'year', 'when']);
// Money as often as a count: alone, with toLocaleString() and no fraction digits, a count.
const COUNT_OR_MONEY = new Set(['total', 'sum']);
/** A name's words: `currentCents` → current, cents; `calculated_budget` → calculated, budget. */
const nameParts = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_$]+/).filter(Boolean).map((w) => w.toLowerCase());
/** A word as MONEY_PARTS holds it: itself, or its singular (`expenses`, `costs`). */
const moneyWord = (w) => (MONEY_PARTS.has(w) ? w : w.endsWith('s') && MONEY_PARTS.has(w.slice(0, -1)) ? w.slice(0, -1) : null);

/**
 * The names of the values an expression reads (identifiers and members, not a called function's:
 * `Number(t.amount)` reads t and amount, `centsToAmount(x)` reads x), and the const one bare name is.
 */
function namesIn(expression) {
  const names = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) && !ts.isIdentifier(unwrap(callee.expression))) visit(callee.expression);
      else if (ts.isPropertyAccessExpression(callee) && /^[a-z]/.test(unwrap(callee.expression).text)) visit(callee.expression);
      node.arguments.forEach(visit);
      return;
    }
    if (ts.isIdentifier(node)) names.push(node.text);
    ts.forEachChild(node, visit);
  };
  const node = unwrap(expression);
  visit(node);
  if (ts.isIdentifier(node)) {
    for (const d of resolve(node)) if (d !== PARAMETER && !ts.isFunctionLike(d)) visit(d);
  }
  return names;
}

/**
 * Whether `expression` is an amount by its names (MONEY_PARTS, MONEY_PAIRS), and none says it's a
 * count, a share or a moment. `wholeNumber` (toLocaleString() without fraction digits): `total` or
 * `sum` alone isn't enough.
 */
function namedAmount(expression, { wholeNumber = false } = {}) {
  const node = unwrap(expression);
  if (ts.isNewExpression(node) && node.expression.getText() === 'Date') return false;
  const parts = namesIn(node).flatMap(nameParts);
  if (parts.some((w) => NOT_MONEY_PARTS.has(w) || MOMENT_PARTS.has(w))) return false;
  const words = parts.map(moneyWord).filter(Boolean);
  const paired = MONEY_PAIRS.some(([a, b]) => parts.some((w, i) => w === a && parts[i + 1] === b));
  return paired || words.some((w) => !wholeNumber || !COUNT_OR_MONEY.has(w));
}

/** The node a formatted figure takes its place as: through parentheses, a ternary's branch, `??`/`||`, and String(…). */
function figureSlot(node) {
  let slot = node;
  for (;;) {
    const up = slot.parent;
    if (!up) return slot;
    if (ts.isParenthesizedExpression(up) || (ts.isConditionalExpression(up) && up.condition !== slot)) slot = up;
    else if (ts.isBinaryExpression(up) && up.operatorToken.kind !== ts.SyntaxKind.PlusToken && up.left !== slot) slot = up;
    else if (ts.isBinaryExpression(up) && (up.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || up.operatorToken.kind === ts.SyntaxKind.BarBarToken)) slot = up;
    else if (ts.isCallExpression(up) && ts.isIdentifier(unwrap(up.expression)) && unwrap(up.expression).text === 'String' && up.arguments[0] === slot) slot = up;
    else return slot;
  }
}

/** The text shown just before and just after `node` where it's shown: a template's, JSX's (text, a string in braces, an element's text), or a string it's added to. */
function textAround(node) {
  const slot = figureSlot(node);
  const up = slot.parent;
  const empty = { before: '', after: '' };
  if (!up) return empty;
  if (ts.isTemplateSpan(up) && up.expression === slot) {
    const template = up.parent;
    const at = template.templateSpans.indexOf(up);
    return { before: at === 0 ? template.head.text : template.templateSpans[at - 1].literal.text, after: up.literal.text };
  }
  if (ts.isJsxExpression(up) && up.parent && (ts.isJsxElement(up.parent) || ts.isJsxFragment(up.parent))) {
    const children = up.parent.children;
    const at = children.indexOf(up);
    // A child's shown text: JSX text, a string in braces, an element's own text (`<span>$</span>`).
    const shown = (child) => {
      if (!child) return '';
      if (ts.isJsxText(child)) return child.text;
      if (ts.isJsxExpression(child)) return child.expression && ts.isStringLiteralLike(unwrap(child.expression)) ? unwrap(child.expression).text : '\0';
      if (ts.isJsxElement(child)) return child.children.map(shown).join('');
      return '\0';
    };
    const near = (from, step) => {
      for (let i = from; i >= 0 && i < children.length; i += step) {
        const text = shown(children[i]);
        if (text.trim() !== '' || text === '\0') return text;
      }
      return '';
    };
    return { before: near(at - 1, -1), after: near(at + 1, 1) };
  }
  if (ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const textOf = (side) => {
      const n = unwrap(side);
      return ts.isStringLiteralLike(n) ? n.text : ts.isTemplateExpression(n) ? n.templateSpans.at(-1)?.literal.text ?? '' : '';
    };
    return up.right === slot ? { before: textOf(up.left), after: '' } : { before: '', after: ts.isStringLiteralLike(unwrap(up.right)) ? unwrap(up.right).text : '' };
  }
  return empty;
}
const DOLLAR_BEFORE = /\$\s*$/;
const CODE_AFTER = /^\s*(?:USD|EUR|GBP|CAD|AUD)\b/;
const PERCENT_AFTER = /^\s*%/;

/** Whether the figure is handed on as data: a value in an object literal (a request body, a form's values), or a call's argument (a setter's: an input's editable text). */
function handedOn(node, toastNames) {
  const slot = figureSlot(node);
  const up = slot.parent;
  if (!up) return false;
  if ((ts.isPropertyAssignment(up) && up.initializer === slot) || ts.isShorthandPropertyAssignment(up)) return ts.isObjectLiteralExpression(up.parent);
  if (ts.isCallExpression(up) && up.arguments.includes(slot)) {
    // A toast shows what it's given.
    const callee = unwrap(up.expression);
    const base = ts.isPropertyAccessExpression(callee) ? unwrap(callee.expression) : callee;
    return !(ts.isIdentifier(base) && toastNames.has(base.text));
  }
  return false;
}

/** Whether an expression is an Intl.NumberFormat: `new Intl.NumberFormat(…)`, a const that is one, or what useMemo gives. */
function isNumberFormat(expression, seen = new Set()) {
  const node = unwrap(expression);
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && unwrap(node.expression).getText() === 'Intl.NumberFormat') return true;
  if (ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression)) && unwrap(node.expression).text === 'useMemo' && node.arguments[0] && ts.isFunctionLike(unwrap(node.arguments[0]))) {
    return returnedExpressions(unwrap(node.arguments[0])).some((e) => isNumberFormat(e, seen));
  }
  return ts.isIdentifier(node) && resolve(node).some((d) => d !== PARAMETER && !ts.isFunctionLike(d) && isNumberFormat(d, seen));
}

/** Whether toFixed's digits are 2: `2`, `(2)`, or a const of 2. */
function twoDigits(argument) {
  const node = argument && unwrap(argument);
  if (!node) return false;
  if (ts.isNumericLiteral(node)) return Number(node.text) === 2;
  return ts.isIdentifier(node) && resolve(node).some((d) => d !== PARAMETER && !ts.isFunctionLike(d) && ts.isNumericLiteral(unwrap(d)) && Number(unwrap(d).text) === 2);
}

/** Whether toLocaleString's options ask for fraction digits (or a currency): then a figure, not a count. */
function fractionDigits(options) {
  return styleObjects(options ?? null).some((o) =>
    o.properties.some((p) => ts.isPropertyAssignment(p) && ['minimumFractionDigits', 'maximumFractionDigits', 'style'].includes(styleKey(p) ?? ''))
  );
}

/** Each amount formatted by hand in the parsed file, as { line, msg }. */
function handFormattedMoney(sf, lineOf) {
  const found = [];
  const toastNames = new Set(['toast']);
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === 'react-hot-toast' && statement.importClause?.name) toastNames.add(statement.importClause.name.text);
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(unwrap(node.expression))) {
      const callee = unwrap(node.expression);
      const method = callee.name.text;
      const [first, second] = node.arguments;
      const formatted =
        method === 'toLocaleString' || method === 'toFixed' ? callee.expression
          : method === 'format' && first && isNumberFormat(callee.expression) ? first
            : null;
      if (formatted && !handedOn(node, toastNames)) {
        const { before, after } = textAround(node);
        const wholeNumber = method === 'toLocaleString' && !fractionDigits(second);
        // By its name, as a figure in cents (toFixed(2)); beside a $ or a code, any figure (`$${v.toFixed(0)}`).
        const named = (method !== 'toFixed' || twoDigits(first)) && namedAmount(formatted, { wholeNumber });
        const money = DOLLAR_BEFORE.test(before) || CODE_AFTER.test(after) || named;
        if (money && !PERCENT_AFTER.test(after)) found.push({ line: lineOf(node.getStart(sf)), msg: MONEY_FORMAT_MSG });
      }
    }
    // A d3 format with a $ (nivo's `valueFormat=" >-$.2f"`, an axis's `format: '$,.0f'`): a currency format by hand.
    const formatName = ts.isJsxAttribute(node) || ts.isPropertyAssignment(node) ? (ts.isJsxAttribute(node) ? node.name.getText(sf) : styleKey(node)) : null;
    if (formatName && /^(?:format|[a-z]\w*Format)$/.test(formatName) && node.initializer) {
      const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (value && ts.isStringLiteralLike(unwrap(value)) && /\$/.test(unwrap(value).text)) found.push({ line: lineOf(node.getStart(sf)), msg: MONEY_FORMAT_MSG });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// Tailwind layout classes where a Radix prop carries the same: Tailwind
// is for gradients, animations, text effects and var(--*) colours, not layout (CLAUDE.md). Read in
// pages/ and components/ (not tests), on a JSX element's className (a string, a template's pieces,
// a ternary's branches, cn(…)/clsx(…), and the const or map it names) and chosenColourProps()'s
// class argument. Only an exact move is refused: a Tailwind space step with a Radix token (0, 1, 2,
// 3, 4, 6, 8, 10, 12, 16 → space 0–9), a size Radix's props take as it is, at no breakpoint or one
// Radix has (md 768 = Radix sm, lg 1024 = md, xl 1280 = lg). Whatever has no exact prop stays: sm:
// and 2xl: (Radix has no 640px or 1536px breakpoint), a state variant, a step with no token, a
// class chosen at run time (a ternary's branch, a map read by a value), and every other class of a
// property group one of those is in (`p-4 sm:p-6`: moving p-4 alone would lose to the class left,
// as Tailwind's utilities layer wins over Radix's props). Static radii go to the theme's radius
// variables anywhere. TAILWIND_LAYOUT_MSG names the prop each class becomes.
const TAILWIND_LAYOUT_MSG = 'A Tailwind layout class — use the Radix prop (CLAUDE.md, Tailwind is not for layout)';
// Tailwind's spacing step (n × 4px) → Radix's space token, where one is exact.
const TW_SPACE = { 0: '0', 1: '1', 2: '2', 3: '3', 4: '4', 6: '5', 8: '6', 10: '7', 12: '8', 16: '9' };
// Tailwind's breakpoints → Radix's: md 768 = sm, lg 1024 = md, xl 1280 = lg. sm (640) and 2xl have none.
const TW_BP = { '': 'initial', md: 'sm', lg: 'md', xl: 'lg' };
const TW_NAMED_MAX = { '3xs': '256px', '2xs': '288px', xs: '320px', sm: '384px', md: '448px', lg: '512px', xl: '576px', '2xl': '672px', '3xl': '768px', '4xl': '896px', '5xl': '1024px', '6xl': '1152px', '7xl': '1280px' };
// A static radius → the theme's radius variable that matches it at the default (medium) radius.
const TW_RADIUS = { '': '2', sm: '2', md: '3', lg: '4', xl: '5', '2xl': '6' };
const TW_LAYOUT_TAGS = new Set(['Box', 'Flex', 'Grid', 'Container', 'Section']);
const TW_TEXT_TAGS = new Set(['Text', 'Heading', 'Dialog.Title', 'Dialog.Description', 'AlertDialog.Title', 'AlertDialog.Description']);
const TW_MARGIN_ONLY = new Set(['Button', 'IconButton', 'Badge', 'Callout.Root', 'Select.Trigger', 'TextField.Root', 'TextArea', 'Separator', 'Checkbox', 'Switch', 'Table.Root', 'Spinner', 'Avatar', 'SegmentedControl.Root', 'Tabs.Root', 'RadioGroup.Root', 'Code', 'Kbd', 'Link', 'Progress', 'Slider', 'Skeleton', 'DataList.Root', 'Inset']);
const TW_CELL_TAGS = new Set(['Table.Cell', 'Table.ColumnHeaderCell', 'Table.RowHeaderCell']);
// What a Text's block display is redundant or impossible in: phrasing content.
const TW_PHRASING = new Set(['label', 'p', 'span', 'a', 'button', 'Text', 'Link', 'Button', 'Heading', 'Strong', 'Em']);
const CLASS_WORD = /^[!a-z0-9:[\]()_\-./%#&>*=,@~]+$/i;

function twNum(s) {
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}
/** A Tailwind size's value as a Radix size prop takes it ('4' → 16px, 'full' → 100%, '1/2' → 50%), or null. */
function twSize(s) {
  const named = { full: '100%', auto: 'auto', fit: 'fit-content', min: 'min-content', max: 'max-content', px: '1px' };
  if (named[s]) return named[s];
  const fraction = s.match(/^(\d+)\/(\d+)$/);
  if (fraction) {
    const v = (Number(fraction[1]) / Number(fraction[2])) * 100;
    return Number.isInteger(v * 1e4) ? `${+v.toFixed(6)}%` : null;
  }
  const arbitrary = s.match(/^\[([^\]]+)\]$/);
  if (arbitrary) return /^[0-9.]+(px|rem|%|vh|vw|dvh|ch|em)$/.test(arbitrary[1]) ? arbitrary[1] : null;
  const n = twNum(s);
  return n === null ? null : `${n * 4}px`;
}
function twSpace(s, allowAuto) {
  if (allowAuto && s === 'auto') return 'auto';
  const n = twNum(s);
  return n !== null && TW_SPACE[n] !== undefined ? TW_SPACE[n] : null;
}
/** A class split into [breakpoint, utility] when its variant is none or a plain breakpoint; else null (a state variant, an important). */
function twSplit(cls) {
  const m = cls.match(/^(?:(sm|md|lg|xl|2xl):)?(-?[a-z0-9][a-z0-9-./[\]%]*)$/);
  return m ? [m[1] ?? '', m[2]] : null;
}

/** The Radix props one utility becomes on a component of `kind` ('layout', 'text', 'card', 'cell', 'margin'), as [[prop, value], …], or null. */
function twProps(u, kind, tag) {
  const layout = kind === 'layout';
  const isFlex = tag === 'Flex';
  const isGrid = tag === 'Grid';
  let m;
  if ((m = u.match(/^(-?)m([trblxy]?)-(.+)$/))) {
    const t = twSpace(m[3], true);
    if (t === null || (m[1] && t === 'auto')) return null;
    return [[`m${m[2]}`, m[1] && t !== '0' ? `-${t}` : t]];
  }
  if (kind === 'margin') return null;
  if (kind === 'card') {
    // A Card's padding is its size: size 1 (the default) is space 3, size 2 space 4, both radius 4.
    if (u === 'p-3') return [['size', '1']];
    if (u === 'p-4') return [['size', '2']];
    return null;
  }
  if ((m = u.match(/^p([trblxy]?)-(.+)$/)) && (layout || kind === 'cell')) {
    const t = twSpace(m[2], false);
    return t === null ? null : [[`p${m[1]}`, t]];
  }
  if (kind === 'text') {
    if ((m = u.match(/^text-(left|center|right)$/))) return [['align', m[1]]];
    if (u === 'block') return [['as', 'div']];
    return null;
  }
  if (kind === 'cell') {
    if ((m = u.match(/^text-(left|center|right)$/))) return [['justify', { left: 'start', center: 'center', right: 'end' }[m[1]]]];
    if ((m = u.match(/^(min-|max-)?w-(.+)$/))) {
      const v = m[1] === 'max-' && TW_NAMED_MAX[m[2]] ? TW_NAMED_MAX[m[2]] : twSize(m[2]);
      return v ? [[m[1] === 'min-' ? 'minWidth' : m[1] === 'max-' ? 'maxWidth' : 'width', v]] : null;
    }
    return null;
  }
  if (!layout) return null;
  if ((m = u.match(/^(min-|max-)?([wh])-(.+)$/))) {
    const dim = m[2] === 'w' ? 'Width' : 'Height';
    let v = m[1] === 'max-' && m[2] === 'w' && TW_NAMED_MAX[m[3]] ? TW_NAMED_MAX[m[3]] : twSize(m[3]);
    if (m[3] === 'screen') v = m[2] === 'w' ? '100vw' : '100vh';
    if (m[3] === 'none' && m[1] === 'max-') v = 'none';
    if (!v) return null;
    return [[m[1] ? `${m[1] === 'min-' ? 'min' : 'max'}${dim}` : dim.toLowerCase(), v]];
  }
  if ((m = u.match(/^size-(.+)$/))) {
    const v = twSize(m[1]);
    return v ? [['width', v], ['height', v]] : null;
  }
  const FLEX_ITEM = {
    'flex-1': [['flexGrow', '1'], ['flexBasis', '0%']],
    'flex-auto': [['flexGrow', '1'], ['flexShrink', '1'], ['flexBasis', 'auto']],
    'flex-none': [['flexGrow', '0'], ['flexShrink', '0'], ['flexBasis', 'auto']],
    'shrink-0': [['flexShrink', '0']],
    shrink: [['flexShrink', '1']],
    grow: [['flexGrow', '1']],
    'grow-0': [['flexGrow', '0']],
  };
  if (FLEX_ITEM[u]) return FLEX_ITEM[u];
  if (['relative', 'absolute', 'fixed', 'sticky', 'static'].includes(u)) return [['position', u]];
  if ((m = u.match(/^(inset|top|right|bottom|left)-(.+)$/))) {
    let v = twSpace(m[2], true);
    if (v === null) {
      const s = twSize(m[2]);
      v = s && s.endsWith('%') ? s : null;
    }
    return v === null ? null : [[m[1], v]];
  }
  if ((m = u.match(/^overflow(?:-([xy]))?-(visible|hidden|clip|scroll|auto)$/))) return [[m[1] ? `overflow${m[1].toUpperCase()}` : 'overflow', m[2]]];
  if ((m = u.match(/^col-span-(\d+|full)$/))) return [['gridColumn', m[1] === 'full' ? '1 / -1' : `span ${m[1]} / span ${m[1]}`]];
  const display = isFlex ? ['flex', 'inline-flex'] : isGrid ? ['grid', 'inline-grid'] : ['block', 'inline', 'inline-block', 'contents'];
  if (u === 'hidden') return [['display', 'none']];
  if (display.includes(u)) return [['display', u]];
  if (isFlex) {
    if ((m = u.match(/^flex-(row|col|row-reverse|col-reverse)$/))) return [['direction', m[1].replace('col', 'column')]];
    if ((m = u.match(/^flex-(wrap|nowrap|wrap-reverse)$/))) return [['wrap', m[1]]];
  }
  if (isFlex || isGrid) {
    if ((m = u.match(/^items-(start|center|end|baseline|stretch)$/))) return [['align', m[1]]];
    if ((m = u.match(/^justify-(start|center|end|between)$/))) return [['justify', m[1]]];
    if ((m = u.match(/^gap(?:-([xy]))?-(.+)$/))) {
      const t = twSpace(m[2], false);
      return t === null ? null : [[m[1] ? `gap${m[1].toUpperCase()}` : 'gap', t]];
    }
  }
  if (isGrid && (m = u.match(/^grid-cols-(\d+)$/))) return [['columns', m[1]]];
  if (isGrid && (m = u.match(/^grid-rows-(\d+)$/))) return [['rows', m[1]]];
  return null;
}

/** The property group a class belongs to by its shape (whether it can move or not), or null. */
function twGroup(cls) {
  const u = cls.replace(/^(?:[^:]*:)*!?/, '');
  let m;
  if (/^p[trblxyse]?-/.test(u)) return 'padding';
  if (/^-?m[trblxyse]?-/.test(u)) return 'margin';
  if (/^gap(-[xy])?-/.test(u) || /^space-[xy]-/.test(u)) return 'gap';
  if ((m = u.match(/^(min-|max-)?([wh])-/))) return `${m[1] ?? ''}${m[2]}`;
  if (/^size-/.test(u)) return 'w';
  if (['flex', 'inline-flex', 'grid', 'inline-grid', 'block', 'inline-block', 'inline', 'hidden', 'contents', 'table'].includes(u)) return 'display';
  if (/^(flex-(1|auto|none|initial)$|grow|shrink|basis-)/.test(u)) return 'flexItem';
  if (['relative', 'absolute', 'fixed', 'sticky', 'static'].includes(u)) return 'position';
  if ((m = u.match(/^-?(inset|top|right|bottom|left)-/))) return m[1];
  if ((m = u.match(/^overflow(?:-([xy]))?-/))) return `overflow${m[1] ? m[1].toUpperCase() : ''}`;
  if (/^items-/.test(u)) return 'align';
  if (/^justify-/.test(u)) return 'justify';
  if (/^grid-cols-/.test(u)) return 'columns';
  if (/^grid-rows-/.test(u)) return 'rows';
  if (/^flex-(row|col)/.test(u)) return 'direction';
  if (/^flex-(wrap|nowrap)/.test(u)) return 'wrap';
  if (/^text-(left|center|right|justify|start|end)$/.test(u)) return 'textAlign';
  if (/^col-/.test(u)) return 'gridColumn';
  return null;
}
/** The group a Radix prop belongs to (p and px share padding). */
const twPropGroup = (prop) =>
  /^p[trblxy]?$/.test(prop) ? 'padding' : /^m[trblxy]?$/.test(prop) ? 'margin' : /^gap/.test(prop) ? 'gap' : /^flex(Grow|Shrink|Basis)$/.test(prop) ? 'flexItem'
    : { width: 'w', height: 'h', minWidth: 'min-w', maxWidth: 'max-w', minHeight: 'min-h', maxHeight: 'max-h', size: 'padding' }[prop] ?? prop;

/**
 * The class words an expression can give, each as { word, runtime }: a string, a template's pieces,
 * cn(…)/clsx(…)'s arguments (an object's keys among them), a join(), and what a const or a map of
 * this file holds.
 * `runtime` is a word only some runs have: a ternary's branch, `&&`/`||`'s right side, an object's
 * key, a map read by a value.
 */
function classWords(expression, runtime = false, seen = new Set()) {
  const node = unwrap(expression);
  if (!node || seen.has(node)) return [];
  seen.add(node);
  const words = (text, rt) => text.split(/\s+/).filter((w) => w && CLASS_WORD.test(w)).map((word) => ({ word, runtime: rt }));
  const again = (e, rt = runtime) => classWords(e, rt, seen);
  if (ts.isStringLiteralLike(node)) return words(node.text, runtime);
  if (ts.isTemplateExpression(node)) return [...words(node.head.text, runtime), ...node.templateSpans.flatMap((s) => [...again(s.expression), ...words(s.literal.text, runtime)])];
  if (ts.isConditionalExpression(node)) return [...again(node.whenTrue, true), ...again(node.whenFalse, true)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) return [...again(node.left), ...again(node.right)];
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return again(node.right, true);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return [...again(node.left), ...again(node.right, true)];
    return [];
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((e) => again(e));
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? words(p.name.text, true) : []));
  }
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    // `[…].join(' ')`: its array; `cn(…)`, `clsx(…)`: its arguments.
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'join') return again(callee.expression);
    if (ts.isIdentifier(callee) && /^(?:cn|clsx|classNames|cx|twMerge)$/.test(callee.text)) return node.arguments.flatMap((a) => again(a));
    return [];
  }
  // This file's own consts and maps: a class constant another module exports is laid on elements of
  // many kinds (ABOVE_STRETCHED_LINK on Buttons and Flexes alike), which no one prop serves.
  const own = (d) => d !== PARAMETER && !ts.isFunctionLike(d) && d.getSourceFile() === node.getSourceFile();
  if (ts.isIdentifier(node)) return resolve(node).filter(own).flatMap((d) => again(d));
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const values = (mapValues(node) ?? []).filter(own);
    return values.flatMap((v) => again(v, runtime || values.length > 1));
  }
  return [];
}

/** Each Tailwind layout class the file's JSX could carry as a Radix prop, as { line, msg }. */
function tailwindLayoutProblems(sf, imports, lineOf) {
  const found = [];
  const report = (node, what) => found.push({ line: lineOf(node.getStart(sf)), msg: `${TAILWIND_LAYOUT_MSG}: ${what}.` });
  const prop = (p, v, bp) => (bp === 'initial' ? `${p}="${v}"` : `${p}={{ ${bp}: '${v}' }}`);
  /** A tag's Radix name ('Box', 'Dialog.Title') through the file's imports, aliases and namespaces; or null. */
  const radixTag = (tagName) => {
    if (ts.isIdentifier(tagName)) return imports.radix.get(tagName.text) ?? null;
    if (!ts.isPropertyAccessExpression(tagName)) return null;
    const inner = tagName.expression;
    if (ts.isIdentifier(inner)) {
      if (imports.radixNamespaces.has(inner.text)) return tagName.name.text;
      return imports.radix.has(inner.text) ? `${imports.radix.get(inner.text)}.${tagName.name.text}` : null;
    }
    if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression) && imports.radixNamespaces.has(inner.expression.text)) return `${inner.name.text}.${tagName.name.text}`;
    return null;
  };
  const attr = (element, name) => element.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === name);
  /** An attribute's string value, '?' for any other value, null when absent. */
  const attrText = (element, name) => {
    const a = attr(element, name);
    if (!a) return null;
    return a.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : '?';
  };
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) checkElement(node);
    ts.forEachChild(node, visit);
  };
  const checkElement = (element) => {
    const props = element.attributes.properties;
    const cls = attr(element, 'className');
    const chosen = props.find((a) => ts.isJsxSpreadAttribute(a) && ts.isCallExpression(unwrap(a.expression)) && unwrap(unwrap(a.expression).expression).getText(sf) === 'chosenColourProps');
    const sources = [];
    if (cls?.initializer) sources.push(ts.isJsxExpression(cls.initializer) ? cls.initializer.expression : cls.initializer);
    if (chosen && unwrap(chosen.expression).arguments[2]) sources.push(unwrap(chosen.expression).arguments[2]);
    const rawTag = element.tagName.getText(sf);
    const tag = radixTag(element.tagName);
    // 9. A negative inset token on a Radix layout prop, which Radix 3.3 has no CSS for.
    if (tag && TW_LAYOUT_TAGS.has(tag)) {
      for (const side of ['top', 'right', 'bottom', 'left', 'inset']) {
        const value = attrText(element, side);
        if (value && /^-[1-9]$/.test(value)) report(attr(element, side), `${side}="${value}" does nothing (Radix has no negative inset token) → ${side}="-${RADIX_SPACE_PX[value.slice(1)]}px"`);
      }
    }
    if (!sources.length) return;
    // A spread after the classes may replace them; sr-only/not-sr-only set padding and position of their own.
    if (cls && props.slice(props.indexOf(cls) + 1).some((a) => ts.isJsxSpreadAttribute(a) && a !== chosen)) return;
    const all = sources.flatMap((s) => classWords(s));
    if (all.some(({ word }) => /(?:^|:)!?(?:not-)?sr-only$/.test(word))) return;
    const moves = [];
    // 8. A static radius, on any element: the theme's radius variable.
    for (const { word } of all) {
      const r = word.match(/^((?:[^:\s]*:)*)rounded(?:-(t|b|l|r|tl|tr|bl|br|s|e))?(?:-(xs|sm|md|lg|xl|2xl|3xl|full|none))?$/);
      if (r && TW_RADIUS[r[3] ?? ''] !== undefined) moves.push(`${word} → ${r[1]}rounded${r[2] ? `-${r[2]}` : ''}-[var(--radius-${TW_RADIUS[r[3] ?? '']})]`);
    }
    // What the element is: Radix's layout, text, card, cell or margin-taking control; a lucide icon; a raw div or span.
    const isIcon = imports.lucide.has(rawTag) || (ts.isIdentifier(element.tagName) && !imports.other.has(rawTag) && !imports.radix.has(rawTag) && /^(?:Icon|IconComponent|[A-Z]\w*Icon)$/.test(rawTag));
    let kind = null;
    let target = tag;
    const base = all.filter(({ runtime }) => !runtime).map(({ word }) => twSplit(word)).filter((s) => s && s[0] === '').map(([, u]) => u);
    if (!tag && !isIcon && (rawTag === 'div' || rawTag === 'span')) {
      // 7. A raw div, or a span with a display of its own: Box, Flex or Grid.
      if (rawTag === 'span' && !base.some((u) => ['flex', 'inline-flex', 'grid', 'inline-grid', 'block', 'inline-block', 'hidden'].includes(u))) kind = null;
      else {
        kind = 'layout';
        target = base.some((u) => u.includes('flex')) ? 'Flex' : base.some((u) => u.includes('grid')) ? 'Grid' : 'Box';
      }
    } else if (tag === 'Box' && base.some((u) => u === 'flex' || u === 'inline-flex')) {
      moves.push('a Box with flex → Flex');
      kind = 'layout';
      target = 'Flex';
    } else if (tag && TW_LAYOUT_TAGS.has(tag)) kind = 'layout';
    else if (tag && TW_TEXT_TAGS.has(tag)) kind = 'text';
    else if (tag === 'Card') kind = 'card';
    else if (tag && TW_CELL_TAGS.has(tag)) kind = 'cell';
    else if (tag && TW_MARGIN_ONLY.has(tag)) kind = 'margin';
    else if (isIcon) kind = 'icon';
    if (kind === 'icon') {
      // 6. A lucide icon's equal width and height, or size-N: its size prop, in px.
      if (!attr(element, 'size') && !attr(element, 'width') && !attr(element, 'height')) {
        const px = (v) => (v.startsWith('[') ? Number(v.slice(1, -3)) : Number(v) * 4);
        const fixed = all.filter(({ runtime }) => !runtime).map(({ word }) => word);
        const sz = fixed.find((t) => /^size-(\d+(\.\d+)?|\[\d+px\])$/.test(t));
        const w = fixed.find((t) => /^w-(\d+(\.\d+)?|\[\d+px\])$/.test(t));
        const h = fixed.find((t) => /^h-(\d+(\.\d+)?|\[\d+px\])$/.test(t));
        if (sz) moves.push(`${sz} → size={${px(sz.slice(5))}}`);
        else if (w && h && px(w.slice(2)) === px(h.slice(2))) moves.push(`${w} ${h} → size={${px(w.slice(2))}}`);
      }
    } else if (kind) {
      const radii = moves.length;
      const variant = attrText(element, 'variant');
      const ghost = ['Button', 'IconButton', 'Card'].includes(tag) && variant !== null && (variant === 'ghost' || variant === '?');
      const candidates = [];
      const legalGroups = new Set();
      for (const { word, runtime } of all) {
        const group = twGroup(word);
        const split = twSplit(word);
        const entries = !runtime && split && TW_BP[split[0]] !== undefined ? twProps(split[1], kind, target) : null;
        if (!entries || (ghost && /^-?[mp]/.test(split[1]))) {
          if (group) legalGroups.add(group);
          continue;
        }
        candidates.push({ word, bp: TW_BP[split[0]], entries, group: group ?? twPropGroup(entries[0][0]) });
      }
      // A prop the element sets already keeps its group's classes (a Text's align, a cell's justify: its text-align).
      for (const a of props) {
        if (!ts.isJsxAttribute(a)) continue;
        const name = a.name.getText(sf);
        legalGroups.add(twPropGroup(name));
        if ((name === 'align' && kind === 'text') || (name === 'justify' && kind === 'cell')) legalGroups.add('textAlign');
      }
      const ownDisplay = { Flex: 'flex', Grid: 'grid', Box: 'block' }[target];
      for (const c of candidates) {
        if (legalGroups.has(c.group)) continue;
        if (kind === 'card' && c.entries[0][0] === 'size') {
          if (attr(element, 'size') || c.bp !== 'initial') continue;
          moves.push(c.word === 'p-3' ? 'p-3 → nothing (a Card’s default size, 1, pads 12px)' : 'p-4 → size="2" (same radius)');
          continue;
        }
        if (kind === 'text' && c.entries[0][0] === 'as') {
          if (c.bp !== 'initial') continue;
          if (tag === 'Heading') {
            moves.push('block → nothing (a Heading is a block)');
            continue;
          }
          if (tag !== 'Text') continue;
          const as = attrText(element, 'as');
          let up = ts.isJsxOpeningElement(element) ? element.parent.parent : element.parent;
          while (up && !ts.isJsxElement(up)) up = up.parent;
          const parentTag = up ? up.openingElement.tagName.getText(sf) : '';
          const parentName = (up && radixTag(up.openingElement.tagName)) ?? parentTag;
          if ((as !== null && as !== 'div') || TW_PHRASING.has(parentName) || TW_PHRASING.has(parentTag) || /^h[1-6]$/.test(parentTag)) continue;
          moves.push(as === 'div' ? 'block → nothing (as="div" is a block)' : 'block → as="div"');
          continue;
        }
        if (c.entries[0][0] === 'display' && c.bp === 'initial' && c.entries[0][1] === ownDisplay) {
          moves.push(`${c.word} → nothing (a ${target} is ${ownDisplay})`);
          continue;
        }
        moves.push(`${c.word} → ${c.entries.map(([p, v]) => prop(p, v, c.bp)).join(' ')}`);
      }
      // A raw element with layout to move becomes the component (its radius alone doesn't need one).
      if (moves.length > radii && (rawTag === 'div' || rawTag === 'span') && !tag) moves.unshift(`a ${rawTag} → ${target}${rawTag === 'span' ? ' as="span"' : ''}`);
    }
    if (moves.length) report(element, `on <${rawTag}>, ${moves.join(', ')}`);
  };
  visit(sf);
  return found;
}
// Radix's space tokens in px (at 100% scaling), for a negative inset written as its px.
const RADIX_SPACE_PX = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 40, 8: 48, 9: 64 };

/** Each <Text color="green"> (or a kin) without highContrast in the parsed file, as { line, msg }. */
function lowContrastTextProps(sf, imports, lineOf) {
  const found = [];
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = radixName(node.tagName, imports);
      // A solid badge's text is its fill's --<color>-contrast, not step 11.
      const solid = name === 'Badge' && attribute(node, 'variant')?.initializer?.text === 'solid';
      const init = name && TEXT_COMPONENTS.has(name) && !solid ? attribute(node, 'color')?.initializer : undefined;
      if (init) {
        const values = ts.isStringLiteral(init)
          ? [init.text]
          : ts.isJsxExpression(init) && init.expression
            ? colourLiterals(init.expression)
            : [];
        if (values.some((v) => LOW_CONTRAST_SCALES.has(v)) && !isHighContrast(node)) {
          found.push({ line: lineOf(node.getStart(sf)), msg: TEXT_PROP_MSG });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// The page-width standard: a page's width comes from <PageContainer width=…> (wide by
// default; form, editor or auth by its kind), never from a wrapper written in the page, and each
// page component renders inside it in every state (loading, error, empty), so it doesn't change
// width as it loads. Read only in a page file (pages/*.tsx).
const isPageFile = (rel) => /^pages\/[^/]+\.tsx$/.test(rel);
const PAGE_WRAPPER_MSG =
  'A page-level width wrapper written by hand — wrap the page in <PageContainer> (components/PageContainer.tsx): wide by default, width="form" | "editor" | "auth" by the page\'s kind (CLAUDE.md "Layout & width").';
const PAGE_RETURN_MSG =
  'A page component that renders without <PageContainer> — every state of a page (loading, error, empty) renders inside it, so the page keeps its width as it loads (CLAUDE.md "Layout & width").';
// What a page may render in place of PageContainer: a component that renders one itself (LoadError,
// and SetupStatusError, which is a LoadError), a redirect or the router's outlet, or nothing. A
// component of the same file counts when what it returns does; another page counts as itself.
const PAGE_ROOTS = new Set(['PageContainer', 'LoadError', 'SetupStatusError', 'Navigate', 'Routes', 'Outlet']);
// A width at page scale: 768px (Radix's `sm`, Tailwind's max-w-3xl) or more.
const PAGE_SCALE_PX = 768;
// Text's max-width is a reading measure (`max-w-3xl` on a paragraph) while it's narrower than a
// form page (PageContainer's `form`, ~880px); as wide as one or wider it's a page's.
const READING_MEASURE_PX = 880;
// Tailwind's named max-widths, which a reading measure is read against.
const TAILWIND_MAX_WIDTH_PX = { '3xl': 768, '4xl': 896, '5xl': 1024, '6xl': 1152, '7xl': 1280, 'screen-sm': 640, 'screen-md': 768, 'screen-lg': 1024, 'screen-xl': 1280, 'screen-2xl': 1536 };
// Tailwind's max-w-3xl…7xl and max-w-screen-*, an arbitrary max-w-[…] (a length, a share of the
// viewport, min()/calc()/var(); Tailwind writes a space in one as `_`) and Tailwind 4's
// max-w-(--var).
const TAILWIND_PAGE_MAX_WIDTH = /(?<![\w-])max-w-(?:[3-7]xl|screen(?:-\w+)?|\[([^\]\s]+)\]|\((--[\w-]+)\))(?![\w-])/g;
// A fixed width, which is a page's when the element centres itself: `w-[1200px] mx-auto`.
const TAILWIND_WIDTH = /(?<![\w-])w-\[([^\]\s]+)\](?![\w-])/g;
const TAILWIND_CENTRED = /(?<![\w-])mx-auto(?![\w-])/;
// A length, in a unit the guard reads.
const LENGTH = String.raw`(\d+(?:\.\d+)?)\s*(px|rem|em|vw|dvw|svw|lvw|vi|vmax)?`;

/** The arguments of a CSS function's body, split at its top-level commas. */
function cssArguments(body) {
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
    else if (body[i] === ',' && depth === 0) {
      args.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(body.slice(start).trim());
  return args;
}

/**
 * Whether a CSS width is at page scale: a length of `min` px or more (768 unless given; a rem
 * or an em as 16px, a bare number as px), half the viewport or more (`90vw`), a variable (a page's
 * own width, which only PageContainer sets), or a function of them: min() when each bound is one or
 * a share (`100%` bounds nothing), max() or calc() when a term is, clamp() when its upper bound is.
 */
function atPageScale(text, min = PAGE_SCALE_PX) {
  const value = String(text).trim();
  const fn = /^(min|max|clamp|calc)\(([\s\S]*)\)$/i.exec(value);
  if (fn) {
    const name = fn[1].toLowerCase();
    if (name === 'min') {
      const args = cssArguments(fn[2]);
      return args.some((a) => atPageScale(a, min)) && args.every((a) => atPageScale(a, min) || /^(?:\d+(?:\.\d+)?%|auto|none|(?:fit|max|min)-content)$/i.test(a));
    }
    if (name === 'clamp') return atPageScale(cssArguments(fn[2])[2] ?? '', min);
    return [...fn[2].matchAll(new RegExp(String.raw`var\([^)]*\)|(?<![\w.-])${LENGTH}(?![\w%])`, 'gi'))].some((m) => atPageScale(m[0], min));
  }
  if (/^var\(/i.test(value)) return true;
  const match = new RegExp(`^${LENGTH}$`, 'i').exec(value);
  if (!match) return false;
  const n = Number(match[1]);
  const unit = (match[2] ?? 'px').toLowerCase();
  if (unit === 'px') return n >= min;
  if (unit === 'rem' || unit === 'em') return n * 16 >= min;
  return n >= 50;
}

/** The literal lengths a JSX prop or style value can be (`"1600px"`, `{{ sm: '60rem' }}`, a const's). */
function lengthsOf(expression) {
  return valueLiterals(expression).concat(ts.isNumericLiteral(unwrap(expression)) ? [unwrap(expression).text] : []);
}

/** The lengths a JSX element's own prop `name` can be. */
function propLengths(element, name) {
  const init = attribute(element, name)?.initializer;
  if (!init) return [];
  return ts.isStringLiteral(init) ? [init.text] : ts.isJsxExpression(init) && init.expression ? lengthsOf(init.expression) : [];
}

/** The style properties of a JSX element's own `style` whose name is in `names`, each with its lengths. */
function styleLengths(element, names) {
  const style = attribute(element, 'style')?.initializer;
  if (!style || !ts.isJsxExpression(style) || !style.expression) return [];
  return styleObjects(style.expression).flatMap((object) =>
    object.properties.filter((p) => ts.isPropertyAssignment(p) && names.includes(styleKey(p))).map((p) => ({ property: p, lengths: lengthsOf(p.initializer) }))
  );
}

/** The class strings a JSX element's own className can be. */
function classesOf(element) {
  const init = attribute(element, 'className')?.initializer;
  if (!init) return [];
  return ts.isStringLiteral(init) ? [init.text] : ts.isJsxExpression(init) && init.expression ? valueLiterals(init.expression).concat(literals(init.expression)) : [];
}

/** Whether a JSX element centres itself: mx="auto", an auto margin in its style, or mx-auto. */
function isCentred(element) {
  if (propLengths(element, 'mx').some((v) => v === 'auto')) return true;
  const margins = ['margin', 'marginInline', 'marginLeft', 'marginRight', 'marginInlineStart', 'marginInlineEnd'];
  if (styleLengths(element, margins).some(({ lengths }) => lengths.some((v) => /\bauto\b/.test(v)))) return true;
  return classesOf(element).some((c) => TAILWIND_CENTRED.test(c));
}

// An overlay's content is sized for the overlay, not the page: <Dialog.Content maxWidth="800px">,
// and everything in it.
const OVERLAY_ROOTS = new Set(['Dialog', 'AlertDialog', 'Popover', 'HoverCard', 'DropdownMenu', 'ContextMenu', 'Tooltip']);
// Text, whose max-width is a reading measure (`max-w-3xl` on a paragraph), not a page's,
// while it's narrower than a form page (READING_MEASURE_PX).
const PROSE_ELEMENTS = new Set(['Text', 'Heading', 'Blockquote', 'Code', 'Strong', 'Em', 'Quote', 'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'label', 'figcaption']);

/** Whether a JSX tag is an overlay's content (`Dialog.Content`, `AD.Content` for an alias, `Themes.Dialog.Content`). */
function isOverlayContent(tagName, imports) {
  if (!ts.isPropertyAccessExpression(tagName) || tagName.name.text !== 'Content') return false;
  const part = tagName.expression;
  if (ts.isIdentifier(part)) {
    const base = imports.radix.get(part.text) ?? (imports.other.has(part.text) ? null : part.text);
    return OVERLAY_ROOTS.has(base);
  }
  return ts.isPropertyAccessExpression(part) && ts.isIdentifier(part.expression) && imports.radixNamespaces.has(part.expression.text) && OVERLAY_ROOTS.has(part.name.text);
}

/** The JSX element whose className a string (or a template's piece) is part of, through ternaries, joins and `cn(…)`, or null. */
function classOwner(node) {
  for (let up = node.parent; up; up = up.parent) {
    if (ts.isJsxAttribute(up)) return up.name.getText() === 'className' ? up.parent.parent : null;
    if (
      !ts.isConditionalExpression(up) &&
      !ts.isBinaryExpression(up) &&
      !ts.isParenthesizedExpression(up) &&
      !ts.isTemplateExpression(up) &&
      !ts.isTemplateSpan(up) &&
      !ts.isCallExpression(up) &&
      !ts.isArrayLiteralExpression(up) &&
      !ts.isAsExpression(up) &&
      !ts.isJsxExpression(up)
    ) {
      return null;
    }
  }
  return null;
}

// A page-level width wrapper anywhere else: a Radix Container outside PageContainer. A component
// that stands in for a page (an error boundary's fallback, a ledger or settings refusal) takes its
// width from PageContainer too.
const CONTAINER_MSG =
  'A Radix <Container> outside PageContainer — a component that stands in for a page (an error, a refusal, a choice of ledger) renders <PageContainer width="…"> by its kind (CLAUDE.md "Layout & width").';

/** Each Radix Container in a file that isn't a page, a test or PageContainer itself, as { line, msg }. */
function containerProblems(sf, imports, lineOf) {
  const found = [];
  const visit = (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && imports.radix.get(node.tagName.getText(sf)) === 'Container') {
      found.push({ line: lineOf(node.getStart(sf)), msg: CONTAINER_MSG });
    } else if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isPropertyAccessExpression(node.tagName)) {
      const root = node.tagName.expression;
      if (ts.isIdentifier(root) && imports.radixNamespaces.has(root.text) && node.tagName.name.text === 'Container') found.push({ line: lineOf(node.getStart(sf)), msg: CONTAINER_MSG });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * The page-width findings in a page file, as { line, msg }: a hand-written width wrapper (a Radix
 * Container, a maxWidth prop or style at page scale, a max-w-* class at page scale, a fixed width at
 * page scale on an element that centres itself), and a page component that returns without
 * PageContainer. A page component is the file's default export and each top-level component whose
 * name ends in "Page", through memo() and forwardRef(). An overlay's content, and text, have widths
 * of their own.
 */
function pageWidthProblems(sf, imports, lineOf) {
  const found = [];
  const report = (node, msg) => found.push({ line: lineOf(node.getStart(sf)), msg });
  const visit = (node) => {
    if (ts.isJsxElement(node) && isOverlayContent(node.openingElement.tagName, imports)) return;
    if (ts.isJsxSelfClosingElement(node) && isOverlayContent(node.tagName, imports)) return;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = radixName(node.tagName, imports);
      if (name === 'Container') report(node, PAGE_WRAPPER_MSG);
      // Text's width is a reading measure up to a form page's.
      const wide = (v) => atPageScale(v, PROSE_ELEMENTS.has(name) ? READING_MEASURE_PX : PAGE_SCALE_PX);
      if (propLengths(node, 'maxWidth').some(wide)) report(node, PAGE_WRAPPER_MSG);
      for (const { property, lengths } of styleLengths(node, ['maxWidth', 'maxInlineSize'])) {
        if (lengths.some(wide)) report(property, PAGE_WRAPPER_MSG);
      }
      // A fixed width, centred, is a page wrapper too: <Box width="1200px" mx="auto">.
      const widths = [...propLengths(node, 'width'), ...styleLengths(node, ['width', 'inlineSize']).flatMap((s) => s.lengths)];
      if (widths.some(wide) && isCentred(node)) report(node, PAGE_WRAPPER_MSG);
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      const owner = classOwner(node);
      const prose = !!owner && PROSE_ELEMENTS.has(radixName(owner.tagName, imports));
      const min = prose ? READING_MEASURE_PX : PAGE_SCALE_PX;
      for (const match of node.text.matchAll(TAILWIND_PAGE_MAX_WIDTH)) {
        // A named width (max-w-5xl, max-w-screen-lg) is a page's, but on text narrower than a form page.
        const named = match[1] === undefined && !match[2] ? match[0].slice('max-w-'.length) : null;
        const atScale = match[2] ? true : named !== null ? !prose || (TAILWIND_MAX_WIDTH_PX[named] ?? Infinity) >= min : atPageScale(match[1].replace(/_/g, ' '), min);
        if (atScale) report(node, PAGE_WRAPPER_MSG);
      }
      if (TAILWIND_CENTRED.test(node.text)) {
        for (const match of node.text.matchAll(TAILWIND_WIDTH)) {
          if (atPageScale(match[1].replace(/_/g, ' '), min)) report(node, PAGE_WRAPPER_MSG);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // The page components: the default export, and each top-level component named *Page, through
  // memo() and forwardRef(), and `export default () => …`.
  const components = new Map();
  const aliases = new Map();
  let defaultName = null;
  const componentOf = (expression) => {
    const node = unwrap(expression);
    if (!node) return null;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { fn: node };
    if (ts.isIdentifier(node)) return { name: node.text };
    if (ts.isCallExpression(node) && node.arguments[0]) {
      const callee = unwrap(node.expression);
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name === 'memo' || name === 'forwardRef') return componentOf(node.arguments[0]);
    }
    return null;
  };
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement)) {
      const component = componentOf(statement.expression);
      if (component?.fn) components.set('default', { fn: component.fn, page: true });
      else if (component?.name) defaultName = component.name;
    }
    const isDefault = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      const name = statement.name?.text ?? 'default';
      components.set(name, { fn: statement, page: isDefault || /Page$/.test(name) });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const component = componentOf(declaration.initializer);
        if (component?.fn) components.set(declaration.name.text, { fn: component.fn, page: /Page$/.test(declaration.name.text) });
        else if (component?.name) aliases.set(declaration.name.text, component.name);
      }
    }
  }
  /** The component a name is, through aliases (`const XPage = memo(Inner)`). */
  const componentNamed = (name) => {
    for (let n = name, i = 0; n && i < 8; n = aliases.get(n), i++) if (components.has(n)) return components.get(n);
    return undefined;
  };
  for (const name of [defaultName, ...[...aliases.keys()].filter((n) => /Page$/.test(n))]) {
    const component = name && componentNamed(name);
    if (component) component.page = true;
  }

  // The values a name can hold where it's used: what it's declared as, and what the function it's
  // used in assigns to it (`let content; if (…) content = <Flex />;`).
  const valuesOf = (identifier) => {
    const values = resolve(identifier);
    let scope = identifier.parent;
    while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    const visitAssignments = (node) => {
      if (node !== scope && ts.isFunctionLike(node)) return;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(unwrap(node.left)) && unwrap(node.left).text === identifier.text) values.push(node.right);
      ts.forEachChild(node, visitAssignments);
    };
    if (scope) visitAssignments(scope);
    return values;
  };
  // What a call of this file's function (or useMemo's callback) returns; [] for one it can't read.
  const callReturns = (call) => {
    const callee = unwrap(call.expression);
    const name = ts.isIdentifier(callee) ? callee.text : null;
    if ((name === 'useMemo' || name === 'useCallback') && call.arguments[0] && ts.isFunctionLike(unwrap(call.arguments[0]))) return returnedExpressions(unwrap(call.arguments[0]));
    if (!name) return [];
    return resolve(callee).filter((d) => d !== PARAMETER && ts.isFunctionLike(d)).flatMap(returnedExpressions);
  };
  // An empty fragment (`<></>`) renders nothing, as null does.
  const isEmpty = (node) =>
    (ts.isJsxFragment(node) || (ts.isJsxElement(node) && /^(?:React\.)?Fragment$/.test(node.openingElement.tagName.getText(sf)))) &&
    node.children.every((child) => ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces);

  // Whether what a page returns renders inside PageContainer: the wrapper itself (or a PAGE_ROOTS
  // component, or another page), or an element or fragment with one among its children. `strict`
  // (a child): what the guard can't read doesn't count as the wrapper.
  const checking = new Set();
  const isPageTag = (tag, seen) => {
    const text = tag.getText(sf);
    if (PAGE_ROOTS.has(text) || /Page$/.test(text)) return true;
    const local = componentNamed(text);
    if (!local || checking.has(local.fn)) return false;
    checking.add(local.fn);
    const ok = returnedExpressions(local.fn).every((e) => wrapped(e, seen));
    checking.delete(local.fn);
    return ok;
  };
  const wrapped = (expression, seen = new Set(), strict = false) => {
    const node = unwrap(expression);
    if (!node || seen.has(node)) return true;
    seen.add(node);
    if (node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined')) return true;
    if (isEmpty(node)) return true;
    if (ts.isConditionalExpression(node)) return wrapped(node.whenTrue, seen, strict) && wrapped(node.whenFalse, seen, strict);
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return wrapped(node.right, seen, strict);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return wrapped(node.left, seen, strict) && wrapped(node.right, seen, strict);
      return !strict;
    }
    if (ts.isIdentifier(node)) {
      const values = valuesOf(node);
      if (!values.length) return !strict;
      return values.every((d) => (d === PARAMETER || ts.isFunctionLike(d) ? !strict : wrapped(d, seen, strict)));
    }
    // A helper's result (`return renderBody()`, `{renderRows()}`) is what it returns.
    if (ts.isCallExpression(node)) {
      const returned = callReturns(node);
      return returned.length ? returned.every((e) => wrapped(e, seen, strict)) : !strict;
    }
    if (ts.isJsxSelfClosingElement(node)) return isPageTag(node.tagName, seen);
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      if (ts.isJsxElement(node) && isPageTag(node.openingElement.tagName, seen)) return true;
      return node.children.some((child) =>
        ts.isJsxText(child) ? false : ts.isJsxExpression(child) ? Boolean(child.expression) && wrappedChild(child.expression, seen) : !isEmpty(child) && wrapped(child, seen)
      );
    }
    // Anything else (a string, a number) isn't JSX this file can read.
    return !strict;
  };
  // A child counts when it renders the wrapper: JSX that does (`{ok && <PageContainer/>}`), or a
  // name or a helper call whose value does (`{content}`). Nothing (`{null}`, `{false}`) doesn't.
  const wrappedChild = (expression, seen) => {
    const node = unwrap(expression);
    const nothing = [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind) || (ts.isIdentifier(node) && node.text === 'undefined');
    return !nothing && !isEmpty(node) && wrapped(node, seen, true);
  };
  for (const { fn, page } of components.values()) {
    if (!page) continue;
    for (const returned of returnedExpressions(fn)) {
      if (!wrapped(returned)) report(returned, PAGE_RETURN_MSG);
    }
  }
  return found;
}

const SVG_ELEMENTS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'g']);

// Instants (timestamptz) whose names end in `_date`; `new Date(...)` is right for them.
const INSTANT_DATE_FIELDS = ['import_balance_date', 'import_posted_date', 'balance_date'];

// Matched against the whole file, so a chain split across lines is caught too.
const DATE_RULES = [
  {
    re: /\.(?:toISOString|toJSON)\(\)\s*\.\s*(?:slice|substring|substr)\(\s*0\s*,\s*(?:10|7)\s*\)/g,
    msg: '`toISOString()` day/month is the UTC one (tomorrow on a US evening) — use todayLocal() / toCalendarDateString() from utils/dateUtils.',
  },
  {
    re: /\.(?:toISOString|toJSON)\(\)\s*\.\s*split\(\s*(['"`])T\1\s*\)/g,
    msg: '`toISOString().split(\'T\')` is the UTC day (tomorrow on a US evening) — use todayLocal() / toCalendarDateString() from utils/dateUtils.',
  },
  {
    re: /new Date\(\s*(['"`])\d{4}-\d{2}-\d{2}\1\s*\)/g,
    msg: '`new Date(\'YYYY-MM-DD\')` is midnight UTC (the day before in the Americas) — use parseCalendarDate() from utils/dateUtils.',
  },
  {
    re: new RegExp(`new Date\\(\\s*(?![\\w.?!]*\\b(?:${INSTANT_DATE_FIELDS.join('|')})\\s*\\))[\\w.?!]*_date\\s*\\)`, 'g'),
    msg: '`new Date(<…_date>)` reads a calendar date as midnight UTC — use parseCalendarDate() / formatCalendarDate() / compareCalendarDates() from utils/dateUtils (if the field is a timestamptz, add it to INSTANT_DATE_FIELDS here).',
  },
];

const isDateRuleExempt = (rel) =>
  rel === 'utils/dateUtils.ts' || rel.startsWith('test/') || rel.includes('__tests__/') || /\.test\.tsx?$/.test(rel);

// A comment line: `//`, a block comment's line (`*`, `/*`), but not code after a block comment
// that closes on the line (`/* note */ <div className="dark:…">`).
const isComment = (line) => {
  let t = line.trim();
  while (t.startsWith('/*') && t.includes('*/')) t = t.slice(t.indexOf('*/') + 2).trim();
  if (t === '' && line.trim() !== '') return true;
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

/** Whether the JSX element whose opening tag holds `index` is hidden from assistive technology (aria-hidden). */
function ariaHiddenAt(sf, index) {
  for (let node = nodeAt(sf, index); node; node = node.parent) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attr = attribute(node, 'aria-hidden');
      if (!attr) return false;
      if (!attr.initializer) return true;
      const value = ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : attr.initializer;
      return value?.kind === ts.SyntaxKind.TrueKeyword || (ts.isStringLiteral(value) && value.text === 'true');
    }
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) return false;
  }
  return false;
}

/**
 * Where the JSX opening tag starting at `start` (its `<`) ends: the index after its `>`,
 * or -1. A `>` inside a `{…}` expression (an arrow function's `=>`, a comparison) or a
 * string doesn't end it.
 */
export function tagEnd(text, start) {
  let depth = 0;
  let quote = null;
  const limit = Math.min(text.length, start + 5000);
  for (let i = start + 1; i < limit; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    } else if (ch === '>' && depth === 0) {
      return i + 1;
    }
  }
  return -1;
}

/** The name of the JSX element whose opening tag holds `index` ('Text', 'Callout.Icon', 'svg'), or null. */
function elementAt(text, index) {
  for (let i = index; i >= 0 && i > index - 5000; i--) {
    if (text[i] !== '<') continue;
    const name = /^[A-Za-z][\w.]*/.exec(text.slice(i + 1, i + 80))?.[0];
    if (!name) continue;
    const end = tagEnd(text, i);
    if (end > index) return name;
    // The nearest tag before it is closed: `index` is in no tag's attributes.
    return null;
  }
  return null;
}

/**
 * What the guards find in one file's text: `styling` (Idiom A), `dates` (the calendar-date
 * guard; none for a file `rel` exempts) and `pages` (the page-width guard, for a page file),
 * each a list of { line, msg }, the line counted from 1. `rel` is the file's path under src/.
 * `files` (path under src/ → source) stands in for the disk when it reads a module the file
 * imports from (a test's).
 */
export function findViolations(source, rel, { files } = {}) {
  if (!files) return findIn(source, rel);
  readModule = (path) => files[path] ?? null;
  modules.clear();
  try {
    return findIn(source, rel);
  } finally {
    readModule = DISK_READER;
    modules.clear();
  }
}

function findIn(source, rel) {
  const sf = parse(source, rel);
  // What the pattern rules read: the source with its JSX comments blanked (line comments are
  // skipped below), at the same offsets. The rules that read the parsed file see no comments.
  const text = withoutJsxComments(source, sf);
  const lines = text.split('\n');
  const lineOf = (index) => sf.getLineAndCharacterOfPosition(index).line + 1;
  const styling = [];
  const dates = [];

  const isTest = isTestFile(rel);
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    for (const { re, msg, skipTests, exempt } of RULES) {
      if ((skipTests && isTest) || exempt?.(rel)) continue;
      if (re.test(line)) styling.push({ line: i + 1, msg });
    }
  });

  const imports = importsOf(sf);
  const isIcon = (name) => name !== null && (imports.lucide.has(name) || SVG_ELEMENTS.has(name));
  const heldForIcon = (index) => /icon/i.test(holderName(sf, index) ?? '');
  for (const { re, msg, letHidden } of TEXT_RULES) {
    for (const match of text.matchAll(re)) {
      const line = lineOf(match.index);
      if (isComment(lines[line - 1]) || isIcon(elementAt(text, match.index)) || heldForIcon(match.index)) continue;
      if (letHidden && ariaHiddenAt(sf, match.index)) continue;
      styling.push({ line, msg });
    }
  }

  styling.push(...lowContrastTextProps(sf, imports, lineOf));
  styling.push(...cardFillProblems(sf, imports, lineOf));
  if (!isTest && /^(?:pages|components)\//.test(rel)) styling.push(...tailwindLayoutProblems(sf, imports, lineOf));
  if (!isTest && !MONEY_TEXT_EXEMPT.has(rel)) styling.push(...handFormattedMoney(sf, lineOf));
  styling.push(...inlineColourStyles(sf, rel, lineOf));
  styling.push(...shortMarkers(sf, lineOf));

  for (const { re, msg, skip } of FILE_RULES) {
    for (const match of text.matchAll(re)) {
      const line = lineOf(match.index);
      if (skip?.(match[0])) continue;
      if (!isComment(lines[line - 1])) styling.push({ line, msg });
    }
  }

  if (!isDateRuleExempt(rel)) {
    for (const { re, msg } of DATE_RULES) {
      for (const match of text.matchAll(re)) {
        const line = lineOf(match.index);
        if (!isComment(lines[line - 1])) dates.push({ line, msg });
      }
    }
  }

  const pages = isPageFile(rel)
    ? pageWidthProblems(sf, imports, lineOf)
    : isTest || rel === 'components/PageContainer.tsx'
      ? []
      : containerProblems(sf, imports, lineOf);

  styling.sort((a, b) => a.line - b.line);
  pages.sort((a, b) => a.line - b.line);
  return { styling, dates, pages };
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      out.push(...walk(p));
    } else if (['.ts', '.tsx'].includes(extname(name))) {
      out.push(p);
    }
  }
  return out;
}

function main() {
  let violations = 0;
  let dateViolations = 0;
  let pageViolations = 0;
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const rel = file.slice(file.indexOf('/src/') + 1);
    const found = findViolations(text, relative(SRC, file).split(sep).join('/'));
    for (const { line, msg } of found.styling) {
      violations++;
      console.error(`${rel}:${line}  ${msg}\n    ${lines[line - 1].trim().slice(0, 120)}`);
    }
    for (const { line, msg } of found.dates) {
      dateViolations++;
      console.error(`${rel}:${line}  ${msg}\n    ${lines[line - 1].trim().slice(0, 120)}`);
    }
    for (const { line, msg } of found.pages) {
      pageViolations++;
      console.error(`${rel}:${line}  ${msg}\n    ${lines[line - 1].trim().slice(0, 120)}`);
    }
  }

  if (violations > 0) {
    console.error(`\n✖ Idiom A guard: ${violations} violation(s). See CLAUDE.md "UI / theming / a11y".`);
  }
  if (dateViolations > 0) {
    console.error(`\n✖ Calendar-date guard: ${dateViolations} violation(s). See src/utils/dateUtils.ts and CLAUDE.md "Temporal types".`);
  }
  if (pageViolations > 0) {
    console.error(`\n✖ Page-width guard: ${pageViolations} violation(s). See components/PageContainer.tsx and CLAUDE.md "Layout & width".`);
  }
  if (violations > 0 || dateViolations > 0 || pageViolations > 0) process.exit(1);
  console.log('✓ Idiom A guard: no banned styling patterns found.');
  console.log('✓ Calendar-date guard: no UTC-day or UTC-midnight date idioms found.');
  console.log('✓ Page-width guard: every page renders inside PageContainer.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
