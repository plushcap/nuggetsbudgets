import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import ts from 'typescript';

/**
 * Dark-mode input borders reach 3:1 against the page (WCAG 1.4.11). Radix draws a text box's,
 * a text area's and a select's border in gray-a7, and the app's own pickers draw theirs in it
 * too. In dark mode that alpha step is Radix's (index.css overrides the solid steps and a1-a6
 * only), and over the app's dark page it was 2.09:1 for a text box, whose border Radix paints
 * over what is behind it, and 2.75:1 for a select in a card.
 *
 * This measures what each border is, from the app's dark gray scale (index.css) and Radix's own
 * CSS, as the contrast checks do (darkGrays.test.ts): the lowest solid gray step that reaches 3:1
 * against the page is what dark mode gives every input border, on the page and on a card.
 * jsdom doesn't cascade Radix's variables, so this reads the CSS rather than a rendered page.
 */
const src = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(src, 'index.css'), 'utf8');
const require = createRequire(import.meta.url);
const radixCss = fs.readFileSync(require.resolve('@radix-ui/themes/styles.css'), 'utf8');

const darkBlock = /\.dark,\s*\.dark-theme\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
const variable = (block: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]+)`, 'i').exec(block)?.[1];
const appDark = (name: string) => variable(darkBlock, name);

/** Radix's own dark scale (the first `.dark, .dark-theme` block of its CSS, in sRGB hex). */
const radixDarkBlock = /\n\.dark, \.dark-theme \{([^}]*)\}/.exec(radixCss)?.[1] ?? '';

const channels = (hex: string) => {
  const h = hex.slice(1);
  const full = h.length <= 4 ? [...h].map((d) => d + d).join('') : h;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
  const a = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
};
/** `top` (with its alpha) over the opaque `bottom`, as 0-255 channels. */
const over = (top: string, bottom: string) => {
  const t = channels(top);
  const u = channels(bottom);
  return [t.r * t.a + u.r * (1 - t.a), t.g * t.a + u.g * (1 - t.a), t.b * t.a + u.b * (1 - t.a)];
};
const luminance = ([r, g, b]: number[]) => {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const rgbOf = (hex: string) => over(hex, '#000000');

const page = appDark('color-background')!;
const panel = appDark('color-panel')!;
const surface = appDark('color-surface')!;

/** The rule that sets dark mode's input borders, and its selectors (split at the commas outside parentheses). */
const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
const borderRule = /\}\s*([^{}]*\.field-border)\s*\{([^}]*)\}/.exec(uncommented);
const topLevel = (list: string) => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  [...list].forEach((ch, i) => {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  });
  return [...parts, list.slice(start)].map((s) => s.trim()).filter(Boolean);
};
const ruleSelectors = topLevel(borderRule?.[1] ?? '');
const ruleStep = /--gray-a7:\s*var\(--gray-(\d+)\);/.exec(borderRule?.[2] ?? '')?.[1];

/** The gray scales the theme picker offers (ThemeContext's GrayColor), slate the default. */
const GRAY_COLORS = ['gray', 'mauve', 'slate', 'sage', 'olive', 'sand'] as const;

/**
 * The colours an input's gray-a7 border can show on `backdrop`: the alpha over the backdrop
 * itself (a text box's border is painted in its 1px of padding, where `background-clip:
 * content-box` leaves no background) and over the field's own surface (a select, a picker).
 */
const borderColours = (a7: string, backdrop: string) => [over(a7, backdrop), over(a7, surface)];

/** What gray-a7 is on an input, in dark mode, with or without the app's rule. */
const darkA7 = (grayColor: (typeof GRAY_COLORS)[number], covered: boolean) =>
  covered && ruleStep ? appDark(`gray-${ruleStep}`)! : variable(radixDarkBlock, `${grayColor}-a7`)!;

describe('dark-mode input borders reach 3:1', () => {
  const lowestStep = Array.from({ length: 12 }, (_, i) => i + 1).find(
    (step) => contrast(rgbOf(appDark(`gray-${step}`)!), rgbOf(page)) >= 3
  );

  it('reads the app\'s dark scale and Radix\'s', () => {
    expect([page, panel, surface]).toEqual(['#111827', '#1f2937', '#374151']);
    for (const gray of GRAY_COLORS) expect(variable(radixDarkBlock, `${gray}-a7`), gray).toMatch(/^#[0-9a-f]{8}$/i);
  });

  it('takes the lowest gray step that reaches 3:1 against the page', () => {
    expect(lowestStep).toBe(5);
    expect(ruleStep).toBe(String(lowestStep));
  });

  it.each(['TextFieldRoot', 'TextAreaRoot', 'SelectTrigger'])('Radix draws a surface %s border in gray-a7', (component) => {
    const block = new RegExp(`\\n\\.rt-${component}:where\\(\\.rt-variant-surface\\) \\{([^}]*)\\}`).exec(radixCss)?.[1];
    expect(block, component).toMatch(/box-shadow: inset 0 0 0 [^;]*var\(--gray-a7\);/);
    expect(ruleSelectors.some((s) => s.includes(`.rt-${component}`) && s.includes('.rt-variant-surface'))).toBe(true);
  });

  it('covers every input, on the page and on a card, for every gray the picker offers', () => {
    const failures: string[] = [];
    for (const gray of GRAY_COLORS) {
      for (const [name, backdrop] of [['page', page], ['card', panel]] as const) {
        for (const colour of borderColours(darkA7(gray, ruleSelectors.length > 0), backdrop)) {
          const ratio = contrast(colour, rgbOf(backdrop));
          if (ratio < 3) failures.push(`${gray} on the ${name}: ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("measured today's borders under 3:1 (what the rule fixes)", () => {
    // Radix's slate a7 (the default gray) over the page: a text box's border.
    const textBox = contrast(over(darkA7('slate', false), page), rgbOf(page));
    const selectInCard = contrast(over(darkA7('slate', false), surface), rgbOf(panel));
    expect(textBox).toBeLessThan(3);
    expect(selectInCard).toBeLessThan(3);
    expect(textBox.toFixed(2)).toBe('2.09');
    expect(selectInCard.toFixed(2)).toBe('2.75');
  });

  it('is dark mode only: light mode keeps Radix\'s border', () => {
    expect(ruleSelectors.length).toBeGreaterThan(0);
    for (const selector of ruleSelectors) expect(selector.startsWith(':is(.dark, .dark-theme) ')).toBe(true);
    // Nothing else in the app's CSS sets gray-a7.
    expect(uncommented.match(/--gray-a7:/g)).toHaveLength(1);
  });

  it.each(['BaseButton'])('Radix draws a surface %s border in its colour\'s a7, gray-a7 for a gray one', (component) => {
    const block = new RegExp(`\\n\\.rt-${component}:where\\(\\.rt-variant-surface\\) \\{([^}]*)\\}`).exec(radixCss)?.[1];
    expect(block, component).toMatch(/box-shadow: inset 0 0 0 1px var\(--accent-a7\);/);
    expect(radixCss).toMatch(/\[data-accent-color='gray'\][^{]*\{[^}]*--accent-a7: var\(--gray-a7\);/);
  });

  it('marks every input-like control the app draws, so the rule reaches it', () => {
    const problems = inputLikeProblems(walk(src).map((file) => [path.relative(src, file), fs.readFileSync(file, 'utf8')]));
    expect(problems).toEqual([]);
  });

  it('finds an unmarked picker, raw field and gray-a7 border (what the check catches)', () => {
    const probe = (source: string) => inputLikeProblems([['components/Probe.tsx', source]]);
    // The color and icon pickers' triggers before the fix: a gray surface Button, unmarked.
    // (Both the picker and its button.)
    expect(probe(`const P = () => (<Popover.Root><Popover.Trigger><Button variant="surface" color="gray">x</Button></Popover.Trigger></Popover.Root>);`)).toHaveLength(2);
    expect(probe(`const P = () => <Button variant="surface" color="gray" onClick={f}>Pick</Button>;`)).toHaveLength(1);
    expect(probe(`const P = () => <input className="border border-[var(--gray-6)]" />;`)).toHaveLength(1);
    expect(probe(`const P = () => <select className="border" />;`)).toHaveLength(1);
    expect(probe(`const P = () => <div className="border border-[var(--gray-a7)]" />;`)).toHaveLength(1);
    expect(probe(`const P = () => <TextField.Root variant="classic" />;`)).toHaveLength(1);
    // Marked, inside a marked field, borderless, or Radix's own surface fields: covered.
    expect(probe(`const P = () => (<Popover.Trigger><Button variant="surface" color="gray" className="field-border">x</Button></Popover.Trigger>);`)).toEqual([]);
    expect(probe(`const P = () => (<Flex className="field-border border"><Popover.Trigger><button className="border-0">x</button></Popover.Trigger></Flex>);`)).toEqual([]);
    expect(probe(`const P = () => (<Popover.Trigger><IconButton variant="ghost" color="gray">i</IconButton></Popover.Trigger>);`)).toEqual([]);
    expect(probe(`const P = () => (<><TextField.Root /><TextArea variant="surface" /><Select.Trigger /></>);`)).toEqual([]);
  });
});

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'test' ? [] : walk(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [full] : [];
  });

/**
 * The input-like controls a file draws that the dark-mode rule doesn't reach. Input-like:
 * Radix's text fields, text areas and select triggers (the rule covers their surface variant,
 * which the app uses; a classic one draws another border); a raw input, select or textarea
 * with a border; a picker, which a Popover.Trigger opens (its trigger, or the field around
 * it, draws the border); a gray surface Button or IconButton, which looks like one; and any
 * element drawn with a gray-a7 border. Each is marked `field-border` (or sits in an element
 * that is), unless it draws no border (a ghost or soft button, `border-0`).
 */
function inputLikeProblems(files: Array<[string, string]>): string[] {
  const problems: string[] = [];
  for (const [rel, source] of files) {
    const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const at = (node: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const attrText = (el: ts.JsxOpeningLikeElement, name: string): string | undefined => {
      for (const attr of el.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.getText() !== name) continue;
        if (!attr.initializer) return '';
        return ts.isStringLiteral(attr.initializer) ? attr.initializer.text : attr.initializer.getText();
      }
      return undefined;
    };
    const classOf = (el: ts.JsxOpeningLikeElement) => attrText(el, 'className') ?? '';
    const marked = (el: ts.JsxOpeningLikeElement) => /\bfield-border\b/.test(classOf(el));
    /** The opening tags around `node`, innermost first. */
    const ancestors = (node: ts.Node): ts.JsxOpeningLikeElement[] => {
      const out: ts.JsxOpeningLikeElement[] = [];
      for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        if (ts.isJsxElement(n)) out.push(n.openingElement);
        if (ts.isJsxSelfClosingElement(n) && n !== node) out.push(n);
      }
      return out;
    };
    const covered = (el: ts.JsxOpeningLikeElement) => marked(el) || ancestors(el).some(marked);
    /** The elements inside a JSX element, depth first. */
    const inside = (node: ts.Node): ts.JsxOpeningLikeElement[] => {
      const out: ts.JsxOpeningLikeElement[] = [];
      const visit = (n: ts.Node) => {
        if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) out.push(n);
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(node, visit);
      return out;
    };
    const borderless = (el: ts.JsxOpeningLikeElement) =>
      ['ghost', 'soft', 'solid'].includes(attrText(el, 'variant') ?? '') || /\bborder-0\b/.test(classOf(el));
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText();
        const cls = classOf(node);
        const variant = attrText(node, 'variant');
        let why: string | undefined;
        if (['TextField.Root', 'TextArea', 'Select.Trigger'].includes(tag)) {
          if (variant === 'classic') why = `a classic ${tag}, whose border the rule doesn't reach`;
        } else if (['input', 'select', 'textarea'].includes(tag) && /(^|\s)border(\s|$|-)/.test(cls) && !/\bborder-0\b/.test(cls)) {
          why = `a raw ${tag} with a border`;
        } else if (/(^|[\s'"`])border-\[var\(--gray-a7\)\]/.test(cls)) {
          why = 'a gray-a7 border';
        } else if (['Button', 'IconButton'].includes(tag) && variant === 'surface' && attrText(node, 'color') === 'gray') {
          why = 'a gray surface button, drawn as an input';
        } else if (tag === 'Popover.Trigger' && ts.isJsxOpeningElement(node)) {
          // The picker's trigger: the first element inside it, or the field around it, draws its border.
          const first = inside(node.parent).find((el) => el !== node);
          if (first && !borderless(first) && !covered(node) && !inside(node.parent).some(marked)) why = 'a picker whose trigger draws a border';
        }
        if (why && !covered(node)) problems.push(`${at(node)} ${tag}: ${why}, not marked field-border`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return problems;
}
