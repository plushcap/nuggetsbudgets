import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { findViolations } from '../check-idiom-a.mjs';

/**
 * What `npm run lint:guard` (scripts/check-idiom-a.mjs) catches, each case a fixture. The
 * cases under "the gaps it had" are: a tag with `=>` in an attribute, a `color:`
 * ternary split across lines, Tailwind 3's text-[--x-9], a hex picked by
 * `appearance === 'dark'`, and step 9 on an icon (which is fine: an icon isn't text). The
 * cases under "the gaps it still missed" are the ones a later fix still left. "Inline colour
 * styles" is the rule that keeps colours out of inline styles. These fixtures live here, not in
 * src/, which the guard scans.
 *
 * `caught` and `messages` leave out the inline-colour rule's findings, so each older case
 * still shows what its own rule reads (many of them are written as inline styles); `inline`
 * gives that rule's alone. They leave out the Tailwind layout rule's too (an older
 * fixture's `w-4 h-4` on an icon), which its own table below reads.
 */

const INLINE = /An inline colour style/;
const TAILWIND_LAYOUT = /^A Tailwind layout class/;
const styling = (source) => findViolations(source, 'components/Fixture.tsx').styling.filter((v) => !TAILWIND_LAYOUT.test(v.msg));
const caught = (source) => styling(source).filter((v) => !INLINE.test(v.msg)).map((v) => v.line);
const inline = (source) => styling(source).filter((v) => INLINE.test(v.msg)).map((v) => v.line);
const STEP_9 = /step-9\/10/;
const STEP_11 = /step 11/;
const messages = (source) => styling(source).filter((v) => !INLINE.test(v.msg)).map((v) => v.msg);

describe('the Idiom A guard', () => {
  describe('the gaps it had', () => {
    it('reads a whole <Text> tag, though an attribute holds an arrow function', () => {
      expect(caught(`<Text onClick={() => setOpen(true)} color="green">Paid</Text>`)).toEqual([1]);
      expect(caught(`<Text\n  onClick={() => setOpen(n > 1)}\n  color="amber"\n>Due</Text>`)).toEqual([1]);
      expect(caught(`<Heading as="h2" onClick={() => go()} color={'teal'}>Total</Heading>`)).toEqual([1]);
      // With highContrast it is step 12, which is fine.
      expect(caught(`<Text onClick={() => setOpen(true)} color="green" highContrast>Paid</Text>`)).toEqual([]);
      expect(caught(`<Text onClick={() => setOpen(true)} color="red">Late</Text>`)).toEqual([]);
    });

    it('reads a color: ternary split across lines', () => {
      const split = [
        `<Text style={{`,
        `  marginLeft: '8px',`,
        `  color: isIncome`,
        `    ? 'var(--green-9)'`,
        `    : 'var(--red-9)'`,
        `}}>`,
      ].join('\n');
      expect(caught(split)).toEqual([3]);
      expect(messages(split)).toEqual([expect.stringMatching(STEP_9)]);
      const greens = `<Text style={{\n  color: ok\n    ? 'var(--green-11)'\n    : 'var(--amber-11)'\n}}>Residual</Text>`;
      expect(messages(greens)).toEqual([expect.stringMatching(STEP_11)]);
      // A value ends at its comma: the next property's variable isn't this colour's.
      expect(caught(`<Box style={{ color: 'var(--gray-12)',\n  backgroundColor: 'var(--red-9)' }} />`)).toEqual([]);
    });

    it("reads Tailwind 3's text-[--x-9] shorthand", () => {
      expect(messages(`<span className="text-[--red-9]">x</span>`)).toEqual([expect.stringMatching(STEP_9)]);
      expect(messages(`<span className="text-[color:--accent-a10]">x</span>`)).toEqual([expect.stringMatching(STEP_9)]);
      expect(messages(`<span className="text-[--green-11]">x</span>`)).toEqual([expect.stringMatching(STEP_11)]);
      expect(caught(`<span className="text-[--red-11]">x</span>`)).toEqual([]);
    });

    it('catches a hex picked by the appearance, however it is read', () => {
      expect(caught(`const ink = appearance === 'dark' ? '#e5e7eb' : '#111827';`)).toEqual([1]);
      expect(caught(`const ink = prefs.appearance === 'light' ? "#111827" : "#e5e7eb";`)).toEqual([1]);
      expect(caught(`const ink = theme !== 'dark' ? \`#fff\` : '#000';`)).toEqual([1]);
      expect(caught(`const ink = isDark ? '#e5e7eb' : '#111827';`)).toEqual([1]);
      expect(caught(`const label = appearance === 'dark' ? 'Dark' : 'Light';`)).toEqual([]);
    });

    it('lets an icon be step 9, and only an icon', () => {
      const icons = `import { CheckCircle, AlertTriangle as Warn } from 'lucide-react';\n`;
      expect(caught(`${icons}<CheckCircle className="w-4 h-4" style={{ color: 'var(--green-9)' }} />`)).toEqual([]);
      expect(caught(`${icons}<Warn style={{ color: 'var(--amber-9)' }} aria-hidden="true" />`)).toEqual([]);
      expect(caught(`${icons}<CheckCircle className="text-[var(--green-9)]" />`)).toEqual([]);
      expect(caught(`<svg className="h-5 w-5" style={{ color: 'var(--red-9)' }} viewBox="0 0 20 20" fill="currentColor" />`)).toEqual([]);
      // Text beside it is still text.
      expect(caught(`${icons}<CheckCircle style={{ color: 'var(--green-9)' }} /><Text style={{ color: 'var(--green-9)' }}>Paid</Text>`)).toEqual([2]);
      // A component not imported from lucide-react isn't taken for an icon.
      expect(caught(`<StatusIcon style={{ color: 'var(--green-9)' }} />`)).toEqual([1]);
    });
  });

  describe('the gaps it once had', () => {
    const TEXT_PROP = /<Text color>/;

    it('reads a color={…} expression, not only a quoted colour', () => {
      // Live in BackupPage: green step-11 text for a key long enough.
      expect(messages(`<Text color={paid ? 'green' : 'red'}>Paid</Text>`)).toEqual([expect.stringMatching(TEXT_PROP)]);
      expect(caught(`<Text\n  size="1"\n  color={n >= 32 ? 'green' : n > 0 ? 'red' : 'gray'}\n>{n} chars</Text>`)).toEqual([1]);
      expect(caught(`<Text color={"amber" as const}>Due</Text>`)).toEqual([1]);
      expect(caught(`<Text color={paid ? 'green' : 'red'} highContrast>Paid</Text>`)).toEqual([]);
      expect(caught(`<Text color={late ? 'red' : 'gray'}>Due</Text>`)).toEqual([]);
      // Computed elsewhere it can't be read; textColorProps is the way (a spread, no color=).
      expect(caught(`<Text {...textColorProps(paid ? 'green' : 'red')}>Paid</Text>`)).toEqual([]);
      // Only the tag's own color: a nested element's, in an expression, isn't it.
      expect(caught(`<Text title={<Avatar color="green" />} color="gray">x</Text>`)).toEqual([]);
    });

    it('reads <Link>, <Code>, <Strong> and <Em> as text, but not a lucide icon of that name', () => {
      expect(caught(`<Link color="green" href="/x">Paid</Link>`)).toEqual([1]);
      expect(caught(`<Code color="teal">npm run setup</Code>`)).toEqual([1]);
      expect(caught(`<Strong color="amber">Due</Strong>`)).toEqual([1]);
      expect(caught(`<Em color="jade">note</Em>`)).toEqual([1]);
      expect(caught(`<Link color="green" highContrast href="/x">Paid</Link>`)).toEqual([]);
      // Not text: an icon's color="green" is CSS's green written out, its only finding.
      expect(messages(`import { Link, Code } from 'lucide-react';\n<Link color="green" size={16} /><Code color="amber" />`).map((m) => /colour written out where/.test(m))).toEqual([true, true]);
      // A name that only starts like one isn't one.
      expect(caught(`<LinkCard color="green" />`)).toEqual([]);
    });

    it('catches dark: before a breakpoint that starts with a digit', () => {
      expect(caught(`<div className="dark:2xl:text-white" />`)).toEqual([1]);
      expect(caught(`<div className="md:2xl:text-[var(--gray-12)]" />`)).toEqual([]);
    });

    it('catches a colour picked by any theme or appearance name, as hex, rgb() or hsl()', () => {
      expect(caught(`const ink = resolvedTheme === 'dark' ? '#fff' : '#000';`)).toEqual([1]);
      expect(caught(`const ink = props.colorTheme !== 'light' ? '#fff' : '#000';`)).toEqual([1]);
      expect(caught(`const ink = isDark ? 'rgb(255,255,255)' : 'rgb(0,0,0)';`)).toEqual([1]);
      expect(caught(`const ink = resolvedAppearance === 'dark' ? "hsl(0 0% 100%)" : 'black';`)).toEqual([1]);
      expect(caught(`const label = resolvedTheme === 'dark' ? 'Dark' : 'Light';`)).toEqual([]);
    });

    it('skips a JSX comment, on one line or several, and nothing after it', () => {
      expect(caught(`{/* <Text color="green"> */}`)).toEqual([]);
      expect(caught(`<Flex>\n  {/*\n    <Text color="amber">Due</Text>\n    <span className="dark:text-white" />\n  */}\n</Flex>`)).toEqual([]);
      expect(caught(`{/* note */}<Text color="green">x</Text>`)).toEqual([1]);
      expect(caught(`{/* note */}\n<Text\n  color="green">x</Text>`)).toEqual([2]);
    });

    // A `{` before a block comment that isn't a JSX comment (an interface's doc comment, an
    // empty catch) ran the blanking on to the next `*/ }`, hiding every line between.
    it("doesn't take a block comment after a brace, and the code after it, for a JSX comment", () => {
      expect(caught(`interface Props {\n  /** The label. */\n  label: string;\n}\nconst x = <Text color="green">x</Text>;\n{/* note */}`)).toEqual([5]);
      expect(caught(`try { run(); } catch { /* ignore */ }\n<span className="dark:text-white" />\n{/* later */}`)).toEqual([2]);
    });
  });

  describe('the gaps it still missed', () => {
    it('reads color = "…" with spaces around the =', () => {
      expect(caught(`<Text color = "green">Paid</Text>`)).toEqual([1]);
      expect(caught(`<Text\n  size="2"\n  color =\n    {'amber'}\n>Due</Text>`)).toEqual([1]);
      expect(caught(`<Text color = "green" highContrast>Paid</Text>`)).toEqual([]);
    });

    it('takes highContrast={false} for no highContrast', () => {
      expect(caught(`<Text color="green" highContrast={false}>Paid</Text>`)).toEqual([1]);
      expect(caught(`<Text color="teal" highContrast={wide}>Paid</Text>`)).toEqual([1]);
      expect(caught(`<Text color="green" highContrast={true}>Paid</Text>`)).toEqual([]);
      // Only the tag's own highContrast counts, not one in a string or a nested element.
      expect(caught(`<Text color="green" title="highContrast">Paid</Text>`)).toEqual([1]);
      expect(caught(`<Text color="green" aside={<Text highContrast />}>Paid</Text>`)).toEqual([1]);
    });

    it('reads a text component imported under another name, or through a namespace', () => {
      expect(caught(`import { Flex, Text as RText } from '@radix-ui/themes';\n<RText color="green">Paid</RText>`)).toEqual([2]);
      expect(caught(`import { Heading as H } from "@radix-ui/themes";\n<H as="h2" color={'jade'}>Total</H>`)).toEqual([2]);
      expect(caught(`import * as Themes from '@radix-ui/themes';\n<Themes.Text color="teal">x</Themes.Text>`)).toEqual([2]);
      expect(caught(`import { Text as RText } from '@radix-ui/themes';\n<RText color="green" highContrast>Paid</RText>`)).toEqual([]);
      // A dialog's title and description are a Heading and a Text.
      expect(caught(`import { Dialog } from '@radix-ui/themes';\n<Dialog.Description color="green">Saved</Dialog.Description>`)).toEqual([2]);
      expect(caught(`import { AlertDialog as AD } from '@radix-ui/themes';\n<AD.Title color={'amber'}>Careful</AD.Title>`)).toEqual([2]);
      expect(caught(`import { Dialog } from '@radix-ui/themes';\n<Dialog.Description color="gray">x</Dialog.Description>`)).toEqual([]);
      // An alias of a component that isn't text, or a name imported from elsewhere, isn't text.
      expect(caught(`import { Avatar as Tag } from '@radix-ui/themes';\n<Tag color="green">Paid</Tag>`)).toEqual([]);
    });

    it('catches a colour picked by isDarkMode, or by a comparison written the other way round', () => {
      expect(caught(`const ink = isDarkMode ? '#e5e7eb' : '#111827';`)).toEqual([1]);
      expect(caught(`const ink = prefs.darkMode ? 'rgb(255,255,255)' : 'rgb(0,0,0)';`)).toEqual([1]);
      expect(caught(`const ink = 'dark' === theme ? '#fff' : '#000';`)).toEqual([1]);
      expect(caught(`const ink = "light" !== props.appearance ? "hsl(0 0% 0%)" : '#fff';`)).toEqual([1]);
      expect(caught(`const ink = (resolvedTheme === 'dark') ? '#fff' : '#000';`)).toEqual([1]);
      expect(caught(`const label = 'dark' === theme ? 'Dark' : 'Light';`)).toEqual([]);
      expect(caught(`const label = isDarkMode ? 'Dark mode' : 'Light mode';`)).toEqual([]);
    });

    it('catches dark: before a negative value', () => {
      expect(caught(`<div className="mt-2 dark:-mt-1" />`)).toEqual([1]);
      expect(caught(`<div className="-mt-1" />`)).toEqual([]);
    });

    it("doesn't take a '{/*' and a '*/}' in strings for a JSX comment", () => {
      expect(caught(`const open = '{/*';\nconst x = <Text color="green">x</Text>;\nconst close = '*/}';`)).toEqual([2]);
      expect(caught('const a = `{/*`;\n<span className="dark:text-white" />\nconst b = `*/}`;')).toEqual([2]);
      expect(caught(`const a = "{ /* ";\n<span className="text-gray-500" />\nconst b = " */ }";`)).toEqual([2]);
      // A real JSX comment after one is still skipped, and an apostrophe in JSX text opens no string.
      const after = [
        `const open = '{/*';`,
        `const x = (`,
        `  <Flex>`,
        `    <Text>Don't</Text>`,
        `    {/* <span className="dark:text-white" /> */}`,
        `    <Text color="amber">y</Text>`,
        `  </Flex>`,
        `);`,
        `const close = '*/}';`,
      ].join('\n');
      expect(caught(after)).toEqual([6]);
    });

    it('reads a colour held in a const in the same file', () => {
      expect(caught(`const c = 'green';\n<Text color={c}>Paid</Text>`)).toEqual([2]);
      expect(caught(`const tone = paid ? 'green' : 'red';\nreturn <Text color={tone}>Paid</Text>;`)).toEqual([2]);
      expect(caught(`const STATUS = { paid: { color: 'amber' }, late: { color: 'red' } } as const;\n<Text color={STATUS[s].color}>x</Text>`)).toEqual([2]);
      expect(caught(`const c = 'green';\n<Text color={c} highContrast>Paid</Text>`)).toEqual([]);
      expect(caught(`const c = 'red';\n<Text color={c}>Late</Text>`)).toEqual([]);
      // A name declared nowhere in the file can't be read (a prop, a parameter): textColorProps is the way.
      expect(caught(`<Text color={tone}>Paid</Text>`)).toEqual([]);
    });

    it("catches isDark ? 'white' : 'black', a named colour picked by the appearance", () => {
      expect(caught(`const ink = isDark ? 'white' : 'black';`)).toEqual([1]);
      expect(caught(`<Text color={isDark ? 'gray' : 'blue'}>x</Text>`)).toEqual([1]);
      expect(caught(`const fill = theme === 'dark' ? 'var(--gray-1)' : 'var(--gray-12)';`)).toEqual([1]);
      expect(caught(`const mode = isDark ? 'dark' : 'light';`)).toEqual([]);
    });
  });

  describe('inline colour styles', () => {
    it('refuses a colour in an inline style, on any element', () => {
      expect(inline(`<Text size="2" style={{ color: 'var(--gray-11)' }}>x</Text>`)).toEqual([1]);
      expect(inline(`<Box style={{ backgroundColor: 'var(--gray-3)', padding: 8 }} />`)).toEqual([1]);
      expect(inline(`<Card style={{ borderColor: 'var(--red-7)' }} />`)).toEqual([1]);
      expect(inline(`<Flex\n  gap="2"\n  style={{\n    padding: 12,\n    background: 'var(--color-panel)',\n  }}\n/>`)).toEqual([5]);
      expect(inline(`<Heading style={{ color: ok ? 'var(--green-12)' : 'var(--red-11)' }}>x</Heading>`)).toEqual([1]);
      expect(inline(`<span style={{ color }}>x</span>`)).toEqual([1]);
      expect(inline(`<CheckCircle style={{ color: 'var(--green-9)' }} />`)).toEqual([1]);
      expect(inline(`<div style={{ 'background-color': '#fff' }} />`)).toEqual([1]);
      expect(inline(`<svg style={{ fill: 'currentColor', stroke: 'var(--gray-9)' }} />`)).toEqual([1]);
      expect(inline(`<Box style={({ color: 'var(--red-11)' }) as React.CSSProperties} />`)).toEqual([1]);
      // A style picked by a condition, or spread into one.
      expect(inline(`<Box style={on ? { color: 'var(--red-11)' } : undefined} />`)).toEqual([1]);
      expect(inline(`<Box style={(on && { backgroundColor: c }) || undefined} />`)).toEqual([1]);
      expect(inline(`<Box style={{ padding: 4, ...(on ? { borderColor: 'var(--red-7)' } : {}) }} />`)).toEqual([1]);
      expect(inline(`<Box style={on ? { /* lint:guard colour: the tag's own */ color: c } : undefined} />`)).toEqual([]);
    });

    it('reads a shorthand as a colour only when its value holds one', () => {
      expect(inline(`<Flex style={{ borderTop: '1px solid var(--gray-6)' }} />`)).toEqual([1]);
      expect(inline(`<Box style={{ boxShadow: '0 0 0 2px var(--accent-9)' }} />`)).toEqual([1]);
      expect(inline("<Box style={{ border: `1px solid ${'#ccc'}` }} />")).toEqual([1]);
      expect(inline(`<Box style={{ borderTop: '1px solid', borderRadius: 8, boxShadow: 'none', outline: 0 }} />`)).toEqual([]);
    });

    it('lets a colour from data stay inline when the style says why', () => {
      expect(inline(`<Box style={{ /* lint:guard colour: the item's own colour */ backgroundColor: item.color }} />`)).toEqual([]);
      expect(inline(`<div\n  style={{\n    width: 12,\n    // lint:guard colour: the chart slice's colour\n    backgroundColor: d.color,\n  }}\n/>`)).toEqual([]);
      // The marker needs a reason, and only marks its own style.
      expect(inline(`<Box style={{ /* lint:guard colour: */ backgroundColor: item.color }} />`)).toEqual([1]);
      expect(inline(`<Box style={{ /* lint:guard colour: the tag's own colour */ color: c }}><Text style={{ color: 'var(--red-11)' }} /></Box>`)).toEqual([1]);
    });

    it('leaves a style without a colour, and a style it can’t read, alone', () => {
      expect(inline(`<Box style={{ padding: 8, width: '100%', marginInline: 'auto' }} />`)).toEqual([]);
      expect(inline(`<Box style={chartStyle} />`)).toEqual([]);
      expect(inline(`<Box className="bg-[var(--gray-3)] text-[var(--gray-11)]" />`)).toEqual([]);
      // Text in a comment isn't a style.
      expect(inline(`// <Box style={{ color: 'red' }} />\n{/* <Box style={{ color: 'red' }} /> */}`)).toEqual([]);
    });
  });

  // The inline-colour rule's edge cases: what still got through, and what it refused that it shouldn't.
  describe('inline colour styles, edge cases', () => {
    const inlineIn = (source, rel) => findViolations(source, rel).styling.filter((v) => INLINE.test(v.msg)).map((v) => v.line);
    const MARK = '/* lint:guard colour: the budget item’s own colour */';

    it('reads a shorthand whose colour is computed, named, or held in a const', () => {
      // DashboardSummaryCard's left border before this rule, which a revert brought back unseen.
      expect(inline('<Card style={{ borderLeft: `4px solid ${borderColor}` }} />')).toEqual([1]);
      expect(inline('<Box style={{ boxShadow: `0 0 0 2px ${c}` }} />')).toEqual([1]);
      expect(inline(`const b = '1px solid red';\n<Box style={{ border: b }} />`)).toEqual([2]);
      expect(inline(`<Box style={{ border: '1px solid crimson' }} />`)).toEqual([1]);
      expect(inline(`<Box style={{ border: '1px solid transparent' }} />`)).toEqual([1]);
      expect(inline(`<Box style={{ filter: 'drop-shadow(0 0 2px red)' }} />`)).toEqual([1]);
      expect(inline(`<Box style={{ borderImage: 'linear-gradient(red, blue) 1' }} />`)).toEqual([1]);
      expect(inline('<Box style={{ border: `${w}px solid red` }} />')).toEqual([1]);
      // A computed colour may stay when it's marked; a computed width isn't a colour.
      expect(inline(`<Box style={{ ${MARK} borderLeft: \`3px solid \${c}\` }} />`)).toEqual([]);
      expect(inline('<Box style={{ border: `${w}px solid` , filter: \'blur(2px)\' }} />')).toEqual([]);
    });

    it('reads a custom property that holds a colour', () => {
      expect(inline(`<Box style={{ '--tag-bg': c } as React.CSSProperties} />`)).toEqual([1]);
      expect(inline(`<Box style={{ '--accent-9': '#f00' } as React.CSSProperties} />`)).toEqual([1]);
      expect(inline(`<Box style={{ '--gap': '8px' } as React.CSSProperties} />`)).toEqual([]);
    });

    it('reads a style held in a const, a function, useMemo or a spread', () => {
      expect(inline(`const s = { color: 'red' };\nconst A = () => <div style={s}>x</div>;`)).toEqual([1]);
      expect(inline(`const s = { color: 'red' };\nconst A = () => <div style={{ ...s, margin: 0 }}>x</div>;`)).toEqual([1]);
      expect(inline(`const mk = () => ({ color: 'red' });\nconst A = () => <div style={mk()}>x</div>;`)).toEqual([1]);
      expect(inline(`function mk() {\n  return { color: 'red' };\n}\nconst A = () => <div style={mk()}>x</div>;`)).toEqual([2]);
      expect(inline(`const A = () => {\n  const s = useMemo(() => ({ color: 'red' }), []);\n  return <div style={s}>x</div>;\n};`)).toEqual([2]);
      expect(inline(`const A = () => <div {...{ style: { color: 'red' } }}>x</div>;`)).toEqual([1]);
      expect(inline(`const props = { style: { color: 'red' } };\nconst A = () => <div {...props}>x</div>;`)).toEqual([1]);
      // AccountFormFields' sectionStyle, used on six sections: found once, where it is written.
      expect(inline(`const sectionStyle = { borderTop: '1px solid var(--gray-6)' };\n<Box style={sectionStyle} />\n<Box style={sectionStyle} />`)).toEqual([1]);
      // A parameter of the same name is another value: it isn't the const.
      expect(inline(`function F() { const s = { color: 'red' }; return s; }\nconst A = ({ s }) => <div style={s} />;`)).toEqual([]);
    });

    it('takes the marker only from a comment on the colour, or on its object', () => {
      // Outside the style, in a string, or in a nested function, it marks nothing.
      expect(inline(`<div /* lint:guard colour: the tag's own colour */ style={{ color: c }} />`)).toEqual([1]);
      expect(inline(`<div\n  // lint:guard colour: the tag's own colour\n  style={{ color: c }}\n/>`)).toEqual([3]);
      expect(inline(`<div style={{ color: c, fontFamily: 'lint:guard colour: the tag own colour' }} />`)).toEqual([1]);
      expect(inline(`<div style={{ color: c, width: (() => { /* lint:guard colour: the tag own colour */ return 1; })() }} />`)).toEqual([1]);
      // A reason is a few words.
      expect(inline(`<div style={{ /* lint:guard colour: x */ color: c }} />`)).toEqual([1]);
      expect(inline(`<div style={{ /* lint:guard colour: tag */ color: c }} />`)).toEqual([1]);
      // On the property, or on the object it's in.
      expect(inline(`<div style={{ ${MARK} color: c }} />`)).toEqual([]);
      expect(inline(`<div style={${MARK} { color: c, backgroundColor: d }} />`)).toEqual([]);
      expect(inline(`const s = ${MARK} { color: c };\n<div style={s} />`)).toEqual([]);
      // It marks its own property: the next one needs its own.
      expect(inline(`<div style={{ ${MARK} color: c, backgroundColor: d }} />`)).toEqual([1]);
    });

    it('refuses a static colour under a marker', () => {
      expect(inline(`<div style={{ ${MARK} color: t.color, borderColor: 'var(--gray-6)' }} />`)).toEqual([1]);
      expect(inline(`<div style={${MARK} { color: t.color, borderColor: 'var(--gray-6)' }} />`)).toEqual([1]);
      expect(inline(`<div style={on ? { ${MARK} color: t.color } : { color: 'red' }} />`)).toEqual([1]);
      expect(inline(`<div style={{ ${MARK} color: on ? t.color : 'red' }} />`)).toEqual([1]);
      expect(inline(`<div style={{ ${MARK} color: 'var(--red-11)' }} />`)).toEqual([1]);
      // A const map in the file is read where it's written: its colours are written out.
      expect(inline(`const STATUS = { ok: { color: 'var(--green-9)' } };\n<div style={{ ${MARK} color: STATUS[s].color }} />`)).toEqual([2]);
      expect(inline(`const TONES = ['var(--red-9)', 'var(--green-9)'];\n<div style={{ ${MARK} color: TONES[i] }} />`)).toEqual([2]);
      // A fallback after a colour from data is part of it, as is a parameter's default, and a
      // piece written beside one (a tint's alpha, a scale's step) isn't a colour of its own.
      expect(inline(`<div style={{ ${MARK} color: t.color || 'var(--accent-11)' }} />`)).toEqual([]);
      expect(inline(`const A = ({ color = '#3B82F6' }) => <div style={{ ${MARK} backgroundColor: color }} />;`)).toEqual([]);
      expect(inline(`const A = ({ color = '#3B82F6' }) => <div style={{ backgroundColor: color }} />;`)).toEqual([1]);
      expect(inline(`<div style={{ ${MARK} backgroundColor: item.color + '20' }} />`)).toEqual([]);
      expect(inline('<div style={{ ' + MARK + ' backgroundColor: `var(--${c}-9)` }} />')).toEqual([]);
      expect(inline(`<div style={{ ${MARK} backgroundColor: item.color + ' #fff' }} />`)).toEqual([1]);
    });

    it('lets the Nuggets artwork keep its fixed gold, and only there', () => {
      const art = `<div style={{ background: 'linear-gradient(135deg, #FFD700 0%, #FF8C00 100%)', color: '#78350f' }} />`;
      expect(inlineIn(art, 'components/NuggetsLogo.tsx')).toEqual([]);
      expect(inlineIn(art, 'components/NuggetSpinner.tsx')).toEqual([]);
      expect(inlineIn(art, 'components/Fixture.tsx')).toEqual([1, 1]);
      // A colour from data there still needs its marker.
      expect(inlineIn(`<div style={{ color: c }} />`, 'components/NuggetsLogo.tsx')).toEqual([1]);
    });

    it('leaves properties that hold no colour alone', () => {
      expect(inline('<div style={{ backgroundImage: `url(${src})` }} />')).toEqual([]);
      expect(inline(`<div style={{ backgroundImage: "url('/a.png')", backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }} />`)).toEqual([]);
      expect(inline(`<div style={{ colorScheme: 'light dark' }} />`)).toEqual([]);
      expect(inline(`<div style={{ outline: 'none', border: '1px solid currentColor', color: 'currentColor', fill: 'inherit' }} />`)).toEqual([]);
      expect(inline(`<div style={{ border: 'none', textDecoration: 'line-through', borderRadius: 4 }} />`)).toEqual([]);
      expect(inline('<div style={{ filter: `brightness(${b}) blur(${r}px)` }} />')).toEqual([]);
      // A gradient in backgroundImage is colour, though.
      expect(inline(`<div style={{ backgroundImage: 'linear-gradient(#fff, #000000)' }} />`)).toEqual([1]);
    });
  });

  describe('a colour held in a const, by its scope', () => {
    it('reads the declaration the name refers to, not another of the same name', () => {
      expect(caught(`function F() { const c = 'green'; return c; }\nconst A = ({ c }) => <Text color={c}>x</Text>;`)).toEqual([]);
      expect(caught(`const c = 'green';\nconst A = () => <Text color={c}>x</Text>;`)).toEqual([2]);
      // A parameter's default is a colour it may hold.
      expect(caught(`const A = ({ c = 'green' }) => <Text color={c}>x</Text>;`)).toEqual([1]);
      // A callback's comparison isn't a value the call gives.
      expect(caught(`const row = rows.find((r) => r.status === 'green');\n<Text color={row.color}>x</Text>`)).toEqual([]);
    });
  });

  // More edge cases, around the fixes for the ones above.
  describe('inline colour styles, more edge cases', () => {
    const MARK = '/* lint:guard colour: the tag’s own colour */';

    it("doesn't throw on a spread in a spread props object, and reads the props it spreads", () => {
      expect(caught(`const A = (field) => {\n  const inputProps = { ...field, 'aria-invalid': true };\n  return <TextField.Root {...inputProps} />;\n};`)).toEqual([]);
      expect(inline(`const A = (p) => <Input {...{ ...p, id: 'x' }} />;`)).toEqual([]);
      expect(inline(`const A = () => <Input {...{ onClick() {}, get id() { return 'x'; }, [k]: 1 }} />;`)).toEqual([]);
      expect(inline(`const base = { style: { color: 'red' } };\nconst props = { ...base, id: 'x' };\nconst A = () => <div {...props} />;`)).toEqual([1]);
    });

    it('reads <Text color> from a const set by a call, useMemo, a hoisted var or a for statement', () => {
      expect(caught(`const A = ({ ok }) => {\n  const tone = useMemo(() => (ok ? 'green' : 'red'), [ok]);\n  return <Text color={tone}>x</Text>;\n};`)).toEqual([3]);
      expect(caught(`const A = ({ ok }) => {\n  const tone = pick(ok, 'green', 'red');\n  return <Text color={tone}>x</Text>;\n};`)).toEqual([3]);
      expect(caught(`const toneFor = (ok) => (ok ? 'green' : 'red');\nconst A = ({ ok }) => {\n  const tone = toneFor(ok);\n  return <Text color={tone}>x</Text>;\n};`)).toEqual([4]);
      expect(caught(`function A({ ok }) {\n  if (ok) { var tone = 'green'; }\n  return <Text color={tone}>x</Text>;\n}`)).toEqual([3]);
      expect(caught(`function A() {\n  for (let tone = 'green'; ;) { return <Text color={tone}>x</Text>; }\n}`)).toEqual([2]);
    });

    it('takes a for-of, for-in or catch binding for its own name', () => {
      expect(caught(`const c = 'green';\nfunction A(cs) { for (const c of cs) { return <Text color={c}>x</Text>; } }`)).toEqual([]);
      expect(caught(`const c = 'green';\nfunction A(m) { for (const c in m) { return <Text color={c}>x</Text>; } }`)).toEqual([]);
      expect(caught(`const e = 'green';\nfunction A() { try { run(); } catch (e) { return <Text color={e}>x</Text>; } }`)).toEqual([]);
    });

    it('gives a comment between two properties to the one after it, and a line-ending one to the one before', () => {
      expect(inline(`const A = ({ c, d }) => <div style={{ color: c, ${MARK} backgroundColor: d }} />;`)).toEqual([1]);
      expect(inline(`const A = ({ c, d }) => <div style={{\n  color: c, ${MARK} backgroundColor: d,\n}} />;`)).toEqual([2]);
      // Ending its line, it's the property before it's.
      expect(inline(`const A = ({ c }) => <div style={{\n  color: c, // lint:guard colour: the tag’s own colour\n  margin: 0,\n}} />;`)).toEqual([]);
      expect(inline(`const A = ({ c }) => <div style={{\n  color: c // lint:guard colour: the tag’s own colour\n}} />;`)).toEqual([]);
      expect(inline(`const A = ({ c }) => <div style={{\n  margin: 0, ${MARK}\n  color: c,\n}} />;`)).toEqual([3]);
      // On a line of its own, it's the property below it's.
      expect(inline(`const A = ({ c }) => <div style={{\n  margin: 0,\n  ${MARK}\n  color: c,\n}} />;`)).toEqual([]);
    });

    it('reads a computed key that is a string', () => {
      expect(inline(`<div style={{ ['color']: 'red' }} />`)).toEqual([1]);
      expect(inline("<div style={{ [`backgroundColor`]: 'red' }} />")).toEqual([1]);
      expect(inline(`<div style={{ ['--tag-bg']: c }} />`)).toEqual([1]);
      // A key from data can't be read.
      expect(inline(`<div style={{ [k]: 'red' }} />`)).toEqual([]);
    });
  });

  it('lets a step-9 class held for an icon through, and only for an icon', () => {
    expect(caught(`const STATUS = { ok: { iconClass: 'text-[var(--green-9)]' } };`)).toEqual([]);
    expect(caught(`const iconColor = paid ? 'text-[var(--green-9)]' : 'text-[var(--red-9)]';`)).toEqual([]);
    expect(caught(`<Card iconClassName="text-[var(--amber-9)]" />`)).toEqual([]);
    expect(caught(`const STATUS = { ok: { textClass: 'text-[var(--green-9)]' } };`)).toEqual([1]);
    expect(caught(`const label = 'text-[var(--red-10)]';`)).toEqual([1]);
  });

  it('still catches what it caught before', () => {
    expect(caught(`<div className="dark:text-white" />`)).toEqual([1]);
    expect(caught(`<div className="text-gray-500 bg-white" />`)).toEqual([1, 1]);
    expect(caught(`<span style={{ color: 'var(--red-9)' }}>x</span>`)).toEqual([1]);
    expect(caught(`<span className="text-(--red-10)">x</span>`)).toEqual([1]);
    expect(caught(`<Text color="green">Paid</Text>`)).toEqual([1]);
    // A comment line is skipped.
    expect(caught(`// <span style={{ color: 'var(--red-9)' }}>x</span>`)).toEqual([]);
  });

  describe('what it traced, what a marker let through, false positives', () => {
    const MARK = '/* lint:guard colour: the tag’s own colour */';
    const HUE = /whatever its hue/;
    const SHORT = /under three words/;

    it('traces a style through a map, Object.assign, an import, another style prop and a DOM write', () => {
      expect(inline(`const styles = { card: { color: 'red' }, row: { margin: 0 } };\nconst A = () => <div style={styles.card} />;`)).toEqual([1]);
      expect(inline(`const STYLES = { a: { backgroundColor: '#fff' } };\nconst A = ({ v }) => <div style={STYLES[v]} />;`)).toEqual([1]);
      expect(inline(`const A = ({ c }) => <div style={Object.assign({}, { margin: 0 }, { color: 'red' })} />;`)).toEqual([1]);
      expect(inline(`const A = () => <Tooltip labelStyle={{ color: 'red' }} contentStyle={{ background: '#000' }} />;`)).toEqual([1, 1]);
      expect(inline(`function paint(el, c) {\n  el.style.color = '#f00';\n  el.style.backgroundColor = c;\n  el.style.setProperty('border-color', 'red');\n  Object.assign(el.style, { color: 'blue' });\n}`)).toEqual([2, 3, 4, 5]);
      // A DOM write from data, marked on its statement, is let through.
      expect(inline(`function paint(el, c) {\n  ${MARK}\n  el.style.backgroundColor = c;\n}`)).toEqual([]);
      // An imported style object: reported where this file uses it; its marker counts where it's written.
      const files = {
        'components/styles.ts': `export const cardStyle = { color: 'red' };\nexport const tagStyle = (c) => (${MARK} { backgroundColor: c });\nconst inner = { fill: '#000' };\nexport { inner as iconStyle };`,
      };
      const imported = (code) =>
        findViolations(code, 'components/Fixture.tsx', { files }).styling.filter((v) => INLINE.test(v.msg)).map((v) => v.line);
      expect(imported(`import { cardStyle } from './styles';\nconst A = () => <div style={cardStyle} />;`)).toEqual([2]);
      expect(imported(`import { tagStyle } from './styles';\nconst A = ({ c }) => <div style={tagStyle(c)} />;`)).toEqual([]);
      expect(imported(`import { iconStyle as s } from './styles';\nconst A = () => <svg style={s} />;`)).toEqual([2]);
      // A package's export can't be read; it isn't refused for that.
      expect(imported(`import { cardStyle } from 'some-package';\nconst A = () => <div style={cardStyle} />;`)).toEqual([]);
    });

    it('refuses step-9/10 text whatever its hue, as a class or behind a marker', () => {
      expect(caught('const A = ({ c }) => <span className={`text-[var(--${c}-9)]`}>x</span>;')).toEqual([1]);
      expect(caught('const A = ({ c }) => <span className={`text-[var(--${c}-11)]`}>x</span>;')).toEqual([]);
      const marked = styling(`const A = ({ hue }) => <span style={{ ${MARK} color: \`var(--\${hue}-9)\` }}>x</span>;`);
      expect(marked.filter((v) => HUE.test(v.msg)).map((v) => v.line)).toEqual([1]);
      // A fill in it is fine.
      expect(styling(`const A = ({ hue }) => <span style={{ ${MARK} backgroundColor: \`var(--\${hue}-9)\` }} />;`)).toEqual([]);
    });

    it("reads what a marker can't keep: a const in a template, a function's or useMemo's return, an alias, destructuring", () => {
      expect(inline(`const BRAND = '#f5a623';\nconst A = () => <div style={{ ${MARK} border: \`1px solid \${BRAND}\` }} />;`)).toEqual([2]);
      expect(inline(`function brand() { return '#f5a623'; }\nconst A = () => <div style={{ ${MARK} color: brand() }} />;`)).toEqual([2]);
      expect(inline(`const A = () => {\n  const c = useMemo(() => '#f5a623', []);\n  return <div style={{ ${MARK} color: c }} />;\n};`)).toEqual([3]);
      expect(inline(`const COLOURS = { brand: '#f5a623' };\nconst M = COLOURS;\nconst A = ({ k }) => <div style={{ ${MARK} color: M[k] }} />;`)).toEqual([3]);
      expect(inline(`const COLOURS = { brand: '#f5a623' };\nconst { brand } = COLOURS;\nconst A = () => <div style={{ ${MARK} color: brand }} />;`)).toEqual([3]);
      // The same with the value from data stays let through.
      expect(inline(`const A = ({ tag }) => <div style={{ ${MARK} border: \`1px solid \${tag.color}\` }} />;`)).toEqual([]);
      expect(inline(`function pick(c) { return c; }\nconst A = ({ c }) => <div style={{ ${MARK} color: pick(c) }} />;`)).toEqual([]);
    });

    it('reads destructured <Text color>, Badge and Callout.Text, and the appearance in more forms', () => {
      expect(caught(`const TONES = { ok: 'green' };\nconst { ok } = TONES;\nconst A = () => <Text color={ok}>x</Text>;`)).toEqual([3]);
      expect(caught(`<Badge color="amber" variant="soft">due</Badge>`)).toEqual([1]);
      expect(caught(`<Badge color="amber" variant="soft" highContrast>due</Badge>`)).toEqual([]);
      // A solid badge's text is its fill's contrast colour.
      expect(caught(`<Badge color="amber" variant="solid">3</Badge>`)).toEqual([]);
      expect(caught(`<Callout.Root><Callout.Text color="green">Saved</Callout.Text></Callout.Root>`)).toEqual([1]);
      expect(caught(`const c = colorScheme === 'dark' ? '#fff' : '#000';`)).toEqual([1]);
      expect(caught(`const c = isDark && '#fff';`)).toEqual([1]);
      expect(caught(`const c = COLORS[appearance];`)).toEqual([1]);
      expect(caught(`const c = PALETTE[props.resolvedTheme];`)).toEqual([1]);
      expect(caught(`const c = ROWS[index];`)).toEqual([]);
    });

    it('reads code after a leading block comment, steps 3–8 text, text-white and vendor-prefixed properties', () => {
      expect(caught(`/* note */ <div className="dark:bg-black" />`)).toEqual([1]);
      expect(caught(`/* a whole comment */`)).toEqual([]);
      expect(caught(`<Text className="text-[var(--gray-7)]">•</Text>`)).toEqual([1]);
      // An icon, and a mark hidden from assistive technology, may be one.
      expect(caught(`import { Tag } from 'lucide-react';\n<Tag className="text-[var(--gray-6)]" />`)).toEqual([]);
      expect(caught(`<Text className="text-[var(--gray-7)]" aria-hidden="true">•</Text>`)).toEqual([]);
      expect(caught(`<span className="bg-[var(--red-9)] text-white">3</span>`)).toEqual([1]);
      expect(caught(`<span className="text-[var(--red-contrast)]">3</span>`)).toEqual([]);
      expect(inline(`<div style={{ WebkitBoxShadow: '0 0 4px red', MozBoxShadow: '0 0 4px #000000' }} />`)).toEqual([1, 1]);
    });

    it('lets through what is no colour: a custom property of data, url(), a mask, color-mix of a marked colour', () => {
      expect(inline(`const A = ({ pct }) => <div style={{ '--progress': pct }} />;`)).toEqual([]);
      expect(inline(`const A = ({ c }) => <div style={{ '--tag-bg': c }} />;`)).toEqual([1]);
      expect(inline(`<div style={{ backgroundImage: 'url(/img/red.svg)' }} />`)).toEqual([]);
      expect(inline(`<div style={{ backgroundImage: 'url(/img/red.svg), linear-gradient(red, blue)' }} />`)).toEqual([1]);
      expect(inline(`<div style={{ maskImage: 'linear-gradient(black 80%, transparent)', WebkitMaskImage: 'linear-gradient(black, transparent)' }} />`)).toEqual([]);
      expect(inline(`const A = ({ c }) => <div style={{ ${MARK} background: \`color-mix(in srgb, \${c} 20%, transparent)\` }} />;`)).toEqual([]);
      expect(inline(`const A = ({ c }) => <div style={{ ${MARK} background: \`color-mix(in srgb, red 20%, transparent)\` }} />;`)).toEqual([1]);
    });

    it('takes a marker whose reason starts on the next line, or that comes before return ({ … })', () => {
      expect(inline(`const A = ({ c }) => <div style={{\n  /* lint:guard colour:\n   * the tag’s own colour */\n  color: c,\n}} />;`)).toEqual([]);
      expect(inline(`const tagStyle = (c) => {\n  ${MARK}\n  return ({ backgroundColor: c });\n};\nconst A = ({ c }) => <div style={tagStyle(c)} />;`)).toEqual([]);
      expect(inline(`const tagStyle = (c) => {\n  return ({ backgroundColor: c });\n};\nconst A = ({ c }) => <div style={tagStyle(c)} />;`)).toEqual([2]);
    });

    it('refuses a marker whose reason is under three words, which marks nothing', () => {
      const found = styling(`const A = ({ c }) => <div style={{ /* lint:guard colour: tag colour */ color: c }} />;`);
      expect(found.filter((v) => SHORT.test(v.msg)).map((v) => v.line)).toEqual([1]);
      expect(found.filter((v) => INLINE.test(v.msg)).map((v) => v.line)).toEqual([1]);
      expect(styling(`// lint:guard colour:\nconst x = 1;`).filter((v) => SHORT.test(v.msg)).map((v) => v.line)).toEqual([1]);
      expect(styling(`const A = ({ c }) => <div style={{ ${MARK} color: c }} />;`)).toEqual([]);
    });
  });

  it("refuses a bg class on a Card, which the card's own fill hides", () => {
    expect(caught(`<Card className="bg-[var(--red-3)] border-[var(--red-7)]">x</Card>`)).toEqual([1]);
    expect(caught(`<Card\n  key={k}\n  className={ok ? 'p-4' : 'p-4 bg-[var(--yellow-3)]'}\n>x</Card>`)).toEqual([1]);
    expect(caught(`import { Card as Panel } from '@radix-ui/themes';\n<Panel className="hover:bg-[var(--gray-3)]" />`)).toEqual([2, 2]);
    // The card's own variable is the layer that shows; another element may take a bg class.
    expect(caught(`<Card className="p-4 [--card-background-color:var(--yellow-3)]">x</Card>`)).toEqual([]);
    expect(caught(`<Box className="bg-[var(--gray-3)]" />`)).toEqual([]);
  });

  it('refuses a hand-written gray-3 hover, for the row-hover class', () => {
    expect(caught(`<Flex className="rounded-sm cursor-pointer hover:bg-[var(--gray-3)]" />`)).toEqual([1]);
    expect(caught(`<Flex className="hover:bg-[var(--gray-a3)]" />`)).toEqual([1]);
    expect(caught(`<Flex className="rounded-sm cursor-pointer row-hover" />`)).toEqual([]);
    expect(caught(`<Flex className="hover:bg-[var(--accent-3)]" />`)).toEqual([]);
  });

  it('refuses a money format written by hand', () => {
    expect(caught(`const usd = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });`)).toEqual([1]);
    expect(caught(`const f = new Intl.NumberFormat('en-US', {\n  style: "currency",\n  currency: 'EUR',\n});`)).toEqual([2]);
    expect(caught(`const p = new Intl.NumberFormat('en-US', { style: 'percent' });`)).toEqual([]);
    // A test may build the text it expects.
    expect(findViolations(`const f = n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });`, 'utils/__tests__/x.test.ts').styling).toEqual([]);
  });

  describe('the page-width standard', () => {
    const pages = (source, rel = 'pages/FixturePage.tsx') => findViolations(source, rel).pages.map((v) => v.line);
    const HEAD = `import { Box, Container, Flex } from '@radix-ui/themes';\nimport PageContainer from '../components/PageContainer';\n`;

    it('refuses a width wrapper written by hand in a page', () => {
      expect(pages(`${HEAD}const XPage = () => <Container size="4" px="4"><PageContainer /></Container>;`)).toEqual([3]);
      expect(pages(`${HEAD}const XPage = () => (\n  <PageContainer>\n    <Box width="100%" maxWidth="1600px" style={{ marginInline: 'auto' }} />\n  </PageContainer>\n);`)).toEqual([5]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><Box maxWidth={{ initial: '100%', md: '60rem' }} /></PageContainer>;`)).toEqual([3]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><div style={{ maxWidth: 1200 }} /></PageContainer>;`)).toEqual([3]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><div className="max-w-7xl mx-auto" /></PageContainer>;`)).toEqual([3]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><div className="max-w-[1200px]" /></PageContainer>;`)).toEqual([3]);
      // Under an alias, it's still Radix's Container.
      expect(pages(`import { Container as C } from '@radix-ui/themes';\nconst XPage = () => <C size="3"><PageContainer /></C>;`)).toEqual([2]);
    });

    it('lets a narrow maxWidth (a search box, a dialog) through', () => {
      expect(pages(`${HEAD}const XPage = () => <PageContainer><Box maxWidth={{ sm: '28rem' }} /><Box maxWidth="420px" /><div className="max-w-md max-w-[60%]" /></PageContainer>;`)).toEqual([]);
    });

    it('refuses a page state (loading, error, not found) that renders without PageContainer', () => {
      const page = [
        HEAD,
        `const XPage = () => {`,
        `  if (loading) return <Flex justify="center"><Text>Loading…</Text></Flex>;`,
        `  if (!item) return <Text color="red">Not found</Text>;`,
        `  return <PageContainer>ok</PageContainer>;`,
        `};`,
      ].join('\n');
      expect(pages(page)).toEqual([5, 6]);
      // The default export is a page whatever its name; a helper component isn't.
      expect(pages(`${HEAD}const Settings = () => <Flex />;\nconst Row = () => <Flex />;\nexport default Settings;`)).toEqual([3]);
      expect(pages(`${HEAD}export default function Thing() { return <Flex />; }`)).toEqual([3]);
      // A ternary's branches both count.
      expect(pages(`${HEAD}const XPage = () => (ok ? <PageContainer /> : <Spinner />);`)).toEqual([3]);
      // A JSX value held in a const is read.
      expect(pages(`${HEAD}const XPage = () => {\n  const body = <Flex />;\n  return body;\n};`)).toEqual([5]);
    });

    it('takes PageContainer anywhere in what a page returns, or a component that renders it', () => {
      expect(pages(`${HEAD}const XPage = () => (\n  <Flex style={{ minHeight: '100vh' }}>\n    <PageContainer width="auth" />\n  </Flex>\n);`)).toEqual([]);
      expect(pages(`${HEAD}const XPage = () => <><PageContainer /><Dialog /></>;`)).toEqual([]);
      expect(pages(`${HEAD}const XPage = () => (ok ? null : <Navigate to="/" />);`)).toEqual([]);
      expect(pages(`${HEAD}const XPage = () => (failed ? <LoadError title="t" /> : <PageContainer />);`)).toEqual([]);
      // Another page, and a same-file component whose own returns are wrapped.
      expect(pages(`${HEAD}const XPage = () => <EditIncomePage />;`)).toEqual([]);
      expect(pages(`${HEAD}const Form = () => <PageContainer width="form" />;\nconst XPage = () => <Form />;`)).toEqual([]);
      expect(pages(`${HEAD}const Form = () => <Flex />;\nconst XPage = () => <Form />;`)).toEqual([4]);
    });

    it('reads only page files', () => {
      expect(pages(`${HEAD}const XPage = () => <Box maxWidth="1600px" />;`, 'components/XPage.tsx')).toEqual([]);
      expect(pages(`${HEAD}const XPage = () => <Container size="4" />;`, 'pages/__tests__/XPage.test.tsx')).toEqual([]);
    });
  });

  // What the guards still let through, and what they refused that they shouldn't.
  describe('what the guards still let through', () => {
    const MARK = '/* lint:guard colour: the tag’s own colour */';
    const pages = (source, rel = 'pages/FixturePage.tsx') => findViolations(source, rel).pages.map((v) => v.line);
    const HEAD = `import { Box, Dialog, Flex, Text } from '@radix-ui/themes';\nimport React, { memo } from 'react';\nimport PageContainer from '../components/PageContainer';\n`;

    it('reads a colour written out beside data in color-mix() or light-dark() (a regression)', () => {
      expect(inline(`const A = ({ c }) => <div style={{ ${MARK} background: \`color-mix(in srgb, \${c} 20%, white)\` }} />;`)).toEqual([1]);
      expect(inline(`const A = ({ c }) => <div style={{ ${MARK} color: \`light-dark(\${c}, #000000)\` }} />;`)).toEqual([1]);
      expect(inline(`const A = ({ c }) => <div style={{ ${MARK} color: \`color-mix(in srgb, \${c} 40%, rgb(0 0 0))\` }} />;`)).toEqual([1]);
      // Beside a theme variable or transparent it's the data's alone; so is a colour function's channels.
      expect(inline(`const A = ({ c }) => <div style={{ ${MARK} color: \`color-mix(in srgb, \${c} 40%, var(--gray-12))\` }} />;`)).toEqual([]);
      expect(inline(`const A = ({ a, b }) => <div style={{ ${MARK} color: \`light-dark(\${a}, \${b})\` }} />;`)).toEqual([]);
      expect(inline(`const A = ({ r, g, b }) => <div style={{ ${MARK} color: \`rgb(\${r} \${g} \${b} / 50%)\` }} />;`)).toEqual([]);
    });

    it("reads a Card's class from a const map or a function's result", () => {
      expect(caught(`const S = { ok: { cardClass: 'p-4 bg-[var(--green-3)]' } };\n<Card className={S[s].cardClass}>x</Card>`)).toEqual([2]);
      expect(caught(`const config = (ok) => (ok ? { cardClass: 'bg-[var(--green-3)]' } : { cardClass: 'p-4' });\nconst status = config(ok);\n<Card className={status.cardClass}>x</Card>`)).toEqual([3]);
      expect(caught("const S = { ok: { cardClass: 'bg-[var(--green-3)]' } };\n<Card className={`p-4 ${S[s].cardClass}`}>x</Card>")).toEqual([2]);
      // Only the class it reads: another entry's background is another element's.
      expect(caught(`const S = { ok: { cardClass: '[--card-background-color:var(--green-3)]', badgeClass: 'bg-[var(--green-3)]' } };\n<Card className={S[s].cardClass}>x</Card>`)).toEqual([]);
    });

    it('reads a text colour a const map gives, read into a const', () => {
      expect(caught(`const STATUS_COLOR = { ok: 'green', late: 'red' };\nconst color = STATUS_COLOR[s];\n<Badge variant="soft" color={color}>x</Badge>`)).toEqual([3]);
      expect(caught(`const STATUS_COLOR = { ok: 'green', late: 'red' };\nconst color = STATUS_COLOR[s];\n<Badge variant="soft" color={color} highContrast>x</Badge>`)).toEqual([]);
    });

    it('takes a custom property from data for a colour, unless its name says it holds a measure', () => {
      expect(inline(`const A = ({ c }) => <div style={{ '--swatch': c }} />;`)).toEqual([1]);
      expect(inline(`const A = ({ c }) => <div style={{ ${MARK} '--swatch': c }} />;`)).toEqual([]);
      expect(inline(`const A = ({ w, n }) => <div style={{ '--bar-width': w, '--count': n, '--progress': n }} />;`)).toEqual([]);
      // A measure word inside another word isn't one ("order" in --border).
      for (const name of ['--border', '--tag-border', '--namespace-bg', '--triangle-fill']) {
        expect(inline(`const A = ({ c }) => <div style={{ '${name}': c }} />;`), name).toEqual([1]);
      }
      expect(inline(`const A = ({ c }) => <div style={{ '--border-color': c }} />;`)).toEqual([1]);
    });

    it("reads el.style['color'] =, el.style.cssText = and setAttribute('style', …)", () => {
      expect(inline(`function paint(el, c) {\n  el.style['color'] = '#f00';\n  el.style['background-color'] = c;\n}`)).toEqual([2, 3]);
      const css = [
        `function paint(el, c, saved) {`,
        `  el.style.cssText = 'padding: 4px; color: red';`,
        `  el.style.cssText = \`width: 4px; background: \${c}\`;`,
        `  el.setAttribute('style', 'border: 1px solid #000000');`,
        `  el.style.cssText = saved;`,
        `}`,
      ].join('\n');
      expect(inline(css)).toEqual([2, 3, 4, 5]);
      // Marked, a colour from data may stay; CSS text with no colour is no finding.
      expect(inline(`function paint(el, c) {\n  ${MARK}\n  el.style.cssText = \`background: \${c}\`;\n  el.style.cssText = 'padding: 4px; width: 50%';\n}`)).toEqual([]);
    });

    it('reads <Callout.Root color> as text, as it reads Callout.Text', () => {
      expect(caught(`<Callout.Root color="amber"><Callout.Text>Due</Callout.Text></Callout.Root>`)).toEqual([1]);
      expect(caught(`import { Callout as C } from '@radix-ui/themes';\n<C.Root color={late ? 'green' : 'red'}>x</C.Root>`)).toEqual([2]);
      expect(caught(`<Callout.Root color="amber" highContrast><Callout.Text>Due</Callout.Text></Callout.Root>`)).toEqual([]);
      expect(caught(`<Callout.Root color="red"><Callout.Text>Late</Callout.Text></Callout.Root>`)).toEqual([]);
    });

    it('reads a page that returns a helper call or a {content} child, a memo() page and an anonymous default export', () => {
      expect(pages(`${HEAD}const XPage = () => {\n  const renderBody = () => <Flex />;\n  return renderBody();\n};`)).toEqual([6]);
      expect(pages(`${HEAD}function body() {\n  return <Flex />;\n}\nconst XPage = () => body();`)).toEqual([7]);
      expect(pages(`${HEAD}const XPage = () => {\n  let content;\n  if (ok) content = <Flex />;\n  else content = <PageContainer />;\n  return <>{content}</>;\n};`)).toEqual([8]);
      expect(pages(`${HEAD}const XPage = React.memo(() => <Flex />);`)).toEqual([4]);
      expect(pages(`${HEAD}const Inner = () => <Flex />;\nexport default memo(Inner);`)).toEqual([4]);
      expect(pages(`${HEAD}export default () => <Flex />;`)).toEqual([4]);
      // Each rendering PageContainer passes: a {content} child that is the wrapper counts.
      expect(pages(`${HEAD}const XPage = () => {\n  const content = <PageContainer />;\n  return <Box>{content}</Box>;\n};`)).toEqual([]);
      expect(pages(`${HEAD}const XPage = () => {\n  const renderBody = () => <PageContainer />;\n  return <Box>{renderBody()}</Box>;\n};`)).toEqual([]);
      expect(pages(`${HEAD}const XPage = memo(() => <PageContainer />);\nexport default () => <XPage />;`)).toEqual([]);
    });

    it('reads a width in vw, min(), calc() or var(), and a fixed width on an element that centres itself', () => {
      expect(pages(`${HEAD}const XPage = () => <PageContainer><Box maxWidth="90vw" /></PageContainer>;`)).toEqual([4]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><Box maxWidth="min(1200px, 100%)" /></PageContainer>;`)).toEqual([4]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><div style={{ maxWidth: 'calc(100vw - 2rem)' }} /></PageContainer>;`)).toEqual([4]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><Box maxWidth="var(--page-max)" /></PageContainer>;`)).toEqual([4]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><div className="max-w-[min(1200px,100%)] max-w-(--page-max)" /></PageContainer>;`)).toEqual([4, 4]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><Box width="1200px" mx="auto" /></PageContainer>;`)).toEqual([4]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><div style={{ width: 1200, margin: '0 auto' }} /></PageContainer>;`)).toEqual([4]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><div className="w-[1200px] mx-auto" /></PageContainer>;`)).toEqual([4]);
      // Narrow ones, and a wide one that doesn't centre itself (a chart), pass.
      expect(pages(`${HEAD}const XPage = () => (\n  <PageContainer>\n    <Box maxWidth="min(400px, 90vw)" />\n    <Box maxWidth="30vw" />\n    <Box maxWidth="clamp(200px, 50%, 600px)" />\n    <Box width="1200px" />\n  </PageContainer>\n);`)).toEqual([]);
    });

    it("doesn't take an overlay's width, a reading measure or an empty early return for a page's", () => {
      expect(pages(`${HEAD}const XPage = () => (\n  <PageContainer>\n    <Dialog.Root><Dialog.Content maxWidth="800px"><Box maxWidth="900px" /></Dialog.Content></Dialog.Root>\n  </PageContainer>\n);`)).toEqual([]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><Text as="p" className="max-w-3xl">Long prose</Text><p className="max-w-3xl" /></PageContainer>;`)).toEqual([]);
      expect(pages(`${HEAD}const XPage = () => {\n  if (!ready) return <></>;\n  return <PageContainer />;\n};`)).toEqual([]);
      // A box's max-w-3xl is still a page's wrapper, and an empty fragment isn't PageContainer.
      expect(pages(`${HEAD}const XPage = () => <PageContainer><Box className="max-w-3xl" /></PageContainer>;`)).toEqual([4]);
      expect(pages(`${HEAD}const XPage = () => <Flex><></></Flex>;`)).toEqual([4]);
    });

    it('refuses a Radix Container in a component that stands in for a page', () => {
      const elsewhere = (source, rel = 'components/Fixture.tsx') => findViolations(source, rel).pages.map((v) => v.line);
      expect(elsewhere(`import { Container } from '@radix-ui/themes';\nconst Refusal = () => <Container size="1"><Text>No</Text></Container>;`)).toEqual([2]);
      expect(elsewhere(`import * as Themes from '@radix-ui/themes';\nconst Refusal = () => <Themes.Container />;`)).toEqual([2]);
      expect(elsewhere(`import { Container } from '@radix-ui/themes';\nconst P = () => <Container />;`, 'components/PageContainer.tsx')).toEqual([]);
      expect(elsewhere(`import { Container } from '@radix-ui/themes';\nconst P = () => <Container />;`, 'components/__tests__/X.test.tsx')).toEqual([]);
    });
  });

  describe('what the fixes before still left', () => {
    const pages = (source, rel = 'pages/FixturePage.tsx') => findViolations(source, rel).pages.map((v) => v.line);
    const HEAD = `import { Text } from '@radix-ui/themes';\nimport PageContainer from '../components/PageContainer';\n`;
    const WRITTEN = /colour written out/;
    const written = (source, rel) => findViolations(source, rel ?? 'components/Fixture.tsx').styling.filter((v) => WRITTEN.test(v.msg)).map((v) => v.line);

    // Where a component, a chart or a toast draws a colour the style rule doesn't read, case by
    // case: what is refused (the lines reported) and what is allowed ([]).
    // Allowed includes what the rule doesn't read, said so in the case's name.
    const NIVO = `import { ResponsivePie, ResponsiveLine } from '@nivo/pie';\nimport toast, { Toaster } from 'react-hot-toast';\nimport { Badge, Theme } from '@radix-ui/themes';\nimport { AlertCircle } from 'lucide-react';\n`;
    const drawnAt = (source, rel) => written(NIVO + source, rel).map((line) => line - 4);
    const COLOUR_REFUSED = [
      ['a lucide icon’s colour', `const A = () => <AlertCircle color="#f00" />;`, [1]],
      ['a lucide icon’s named colour (CSS’s there)', `const A = () => <AlertCircle color="red" />;`, [1]],
      ['a colour prop through a const', `const RED = '#f00';\nconst A = () => <AlertCircle color={RED} />;`, [2]],
      ['a component’s colour prop', `const A = () => <><Card borderColor="#fff" /><Sparkline stroke="#3B82F6" /></>;`, [1, 1]],
      ['a hex, or a CSS colour that is no Radix scale, on a Radix color prop', `const A = () => <><Badge color={'#f00'} /><Badge color="white" /></>;`, [1, 1]],
      ['a literal colour as a component’s colour prop, data or not', `const A = () => <TagPreview name="New" color="#6B7280" />;`, [1]],
      ['an SVG element’s fill and stopColor', `const A = () => <svg><circle fill="white" /><stop stopColor="#f00" /></svg>;`, [1, 1]],
      ['colors: an array', `const A = () => <ResponsivePie colors={['#ef4444', 'var(--accent-9)']} />;`, [1]],
      ['colors: a function', `const A = () => <ResponsivePie colors={() => '#ef4444'} />;`, [1]],
      ['colors: a function’s fallback after data', `const A = () => <><ResponsivePie colors={(d) => d.data.color ?? '#999'} /><ResponsiveLine colors={(d) => d.color || 'red'} /></>;`, [1, 1]],
      ['colors: an array’s map()', `const A = ({ rows }) => <ResponsivePie colors={rows.map(() => '#f00')} />;`, [1]],
      ['colors: a const map read by the datum', `const C = { a: '#f00', b: '#0f0' };\nconst A = () => <ResponsivePie colors={(d) => C[d.id]} />;`, [2]],
      ['a …Colors prop’s object', `const A = () => <Chart tooltipColors={{ color: '#f00', background: 'white' }} />;`, [1, 1]],
      ['a chart’s theme', `const A = () => <ResponsivePie theme={{ labels: { text: { fill: '#333' } } }} />;`, [1]],
      ['a Radix scale’s name in a theme (CSS’s there)', `const A = () => <ResponsivePie theme={{ background: 'red', grid: { line: { stroke: 'blue' } } }} />;`, [1, 1]],
      ['a theme by name, spread, from a helper and from useMemo', `const THEME = { text: { fill: '#333' } };\nconst BASE = { text: { stroke: '#444' } };\nconst mk = () => ({ grid: { line: { stroke: 'blue' } } });\nconst A = () => {\n  const t = useMemo(() => ({ tooltip: { container: { background: '#fff' } } }), []);\n  return <><ResponsiveLine theme={THEME} /><ResponsiveLine theme={{ ...BASE }} /><ResponsiveLine theme={mk()} /><ResponsivePie theme={t} /></>;\n};`, [1, 2, 3, 5]],
      ['a chart’s legends', `const A = () => <ResponsivePie legends={[{ anchor: 'top-left', itemTextColor: '#999999', effects: [{ on: 'hover', style: { itemTextColor: '#000' } }] }]} />;`, [1, 1]],
      ['a chart’s defs', `const A = () => <ResponsivePie defs={[{ id: 'dots', type: 'patternDots', background: 'inherit', color: '#38bcb2' }, { id: 'g', type: 'linearGradient', colors: [{ offset: 0, color: '#f00' }] }]} />;`, [1, 1]],
      ['a chart’s markers', `const A = () => <ResponsiveLine markers={[{ axis: 'y', value: 0, lineStyle: { stroke: '#b0413e' } }]} />;`, [1]],
      ['a toast’s style, written in place, by name or in options by name', `const S = { background: '#333' };\nconst OPTS = { style: { color: '#fff' } };\nconst A = () => { toast('x', { style: { background: '#333' } }); toast.error('x', { style: S }); toast.success('x', OPTS); };`, [1, 2, 3]],
      ['a toast’s icon colours', `const A = () => toast.success('Saved', { iconTheme: { primary: '#10b981', secondary: 'white' } });`, [1, 1]],
      ['a Toaster’s options', `const A = () => <Toaster toastOptions={{ style: { background: '#222' }, success: { iconTheme: { primary: '#10b981' } } }} />;`, [1, 1]],
      ['createElement()’s and cloneElement()’s props', `const A = ({ el }) => [createElement('div', { style: { color: '#f00' } }), React.cloneElement(el, { fill: '#0f0' })];`, [1, 1]],
      ['props spread in', `const P = { fill: '#f00' };\nconst A = () => <><path {...P} /><ResponsivePie {...{ colors: ['#f00'] }} /></>;`, [1, 2]],
    ];
    const COLOUR_ALLOWED = [
      ['a colour from data, in a prop or a theme', `const A = ({ name, color, c }) => <><TagChip tag={{ name, color }} /><ResponsivePie theme={{ text: { fill: c } }} colors={[c]} /></>;`],
      ['a colour prop’s fallback after data (the data’s)', `const A = ({ tag }) => <TagChip color={tag.color ?? '#6B7280'} />;`],
      ['a theme’s value: a variable, a color-mix() of them, transparent, currentColor, a url()', `const A = () => <><ResponsiveLine theme={{ background: 'transparent', grid: { line: { stroke: 'color-mix(in srgb, var(--gray-6) 50%, transparent)' } }, text: { fill: 'var(--gray-11)' } }} /><AlertCircle color="currentColor" /><svg><path fill="url(#g)" stroke="none" /></svg></>;`],
      ['nivo’s colour references', `const A = () => <><ResponsivePie colors={{ scheme: 'nivo' }} arcLabelsTextColor={{ from: 'color', modifiers: [['darker', 2]] }} borderColor={{ theme: 'background' }} /><ResponsiveLine colors={{ datum: 'color' }} /></>;`],
      ['a Radix scale’s name as a component’s colour prop', `const A = ({ over }) => <><Badge color="green">Paid</Badge><DashboardSummaryCard borderColor={over ? 'red' : 'green'} /><Theme accentColor="iris" grayColor="slate" /></>;`],
      ['saved preferences, even under theme', `const DEFAULTS = { appearance: 'light', accentColor: 'blue' };\nconst A = () => { apiPut('/me/preferences', { theme: { appearance: 'dark', accentColor: 'iris' } }); useState({ theme: { accentColor: 'blue' } }); writeStorage('prefs', JSON.stringify({ theme: DEFAULTS })); };`],
      ['a request body or a form’s values, even under colors or style', `const A = () => { useForm({ defaultValues: { name: '', colors: ['#3B82F6'] } }); apiPut('/settings/palette', { colors: ['#ef4444'] }); apiPost('/notes', { style: { color: '#ef4444' } }); apiPost('/tags', { name: 'x', color: '#6B7280' }); };`],
      ['a form’s and a mutation’s colour', `const A = () => { useState({ name: '', color: '#3B82F6' }); reset({ name: '', color: '#3B82F6' }); setValue('color', '#3B82F6'); createTag.mutate({ color: '#6B7280' }); };`],
      ['a picker’s starting value and choices, a theme provider’s default', `const PRESET = ['#ef4444', '#22c55e'];\nconst A = () => <><RadixColorPicker defaultColor="#3B82F6" presetColors={PRESET} /><ColorList items={[{ label: 'Red', value: '#ef4444' }]} /><ThemeProvider defaultTheme={{ accentColor: 'blue' }} /></>;`],
      ['a chart’s data (data, not drawn here)', `const A = () => <ResponsiveLine data={[{ id: 'a', color: '#f00', data: [] }]} />;`],
      ['data made in a module (handlers, fixtures)', `export const handlers = [http.get('/api/tags', () => HttpResponse.json([{ id: 1, color: '#f00' }]))];\nexport const sample = makeTag({ name: 'x', theme: { color: '#f00' } });`],
      ['not read: a call that isn’t a toast or createElement, an unnamed prop', `const A = () => <><Chart t={{ background: 'red' }} />{renderIcon(v, { color: '#f00' })}</>;`],
      ['not read: a theme assigned later, mutated, or merged by an imported function', `import merge from 'lodash/merge';\nconst A = () => { let t; t = { text: { fill: '#333' } }; const u = {}; u.text = { fill: '#333' }; return <><ResponsivePie theme={t} /><ResponsivePie theme={u} /><ResponsivePie theme={merge({}, { text: { fill: '#333' } })} /></>; };`],
      ['not read: a canvas’s fillStyle', `const draw = (ctx) => { ctx.fillStyle = '#f00'; };`],
    ];
    it.each(COLOUR_REFUSED)('refuses a colour written out: %s', (_label, source, lines) => {
      expect(drawnAt(source)).toEqual(lines);
    });
    it.each(COLOUR_ALLOWED)('allows %s', (_label, source) => {
      expect(drawnAt(source)).toEqual([]);
    });
    it('reads a theme in another module where this file uses it, and skips a test’s fixtures', () => {
      const files = { 'components/chartTheme.ts': `export const THEME = { text: { fill: '#333' } };` };
      const imported = findViolations(`import { THEME } from './chartTheme';\nconst A = () => <Line theme={THEME} />;`, 'components/Fixture.tsx', { files }).styling;
      expect(imported.map((v) => v.line)).toEqual([2]);
      expect(imported[0].msg).toMatch(/In components\/chartTheme\.ts/);
      expect(written(`mockApi({ 'GET /tags': [tag({ name: 'Rent', color: '#ef4444' })] });\nconst A = () => <AlertCircle color="#f00" />;`, 'pages/__tests__/X.test.tsx')).toEqual([]);
    });

    // Money formatted by hand: ZeroBalanceAccountCard showed a balance with
    // toLocaleString, which the `style: 'currency'` rule doesn't read. Case by case.
    const MONEY = /Money formatted by hand/;
    const money = (source, rel = 'components/Fixture.tsx') => findViolations(source, rel).styling.filter((v) => MONEY.test(v.msg)).map((v) => v.line);
    const MONEY_REFUSED = [
      ['an amount by its name', `const A = ({ amount, balance, item }) => <Text>{amount.toFixed(2)} {balance.toLocaleString('en-US', { minimumFractionDigits: 2 })} {item.total.toFixed(2)} {item.calculated_budget.toFixed(2)}</Text>;`, [1, 1, 1, 1]],
      ['a price, a cost, a sum', `const A = ({ price, cost, rows }) => { const sum = rows.reduce((a, r) => a + r.x, 0); return <Text>{price.toFixed(2)} {cost.toLocaleString('en-US', { minimumFractionDigits: 2 })} {sum.toFixed(2)}</Text>; };`, [1, 1, 1]],
      ['spent, remaining, available', `const A = ({ spent, remaining, fromItemAvailable }) => <Text>{spent.toFixed(2)} {remaining.toFixed(2)} {fromItemAvailable.toFixed(2)}</Text>;`, [1, 1, 1]],
      ['income, expenses, a payment, debt', `const A = ({ income, expenses, payment, debt }) => <Text>{income.toFixed(2)}{expenses.toFixed(2)}{payment.toFixed(2)}{debt.toFixed(2)}</Text>;`, [1, 1, 1, 1]],
      ['net worth, market value, a gain, a cost basis', `const A = ({ netWorth, h }) => <Text>{netWorth.toLocaleString()} {h.marketValue.toFixed(2)} {h.gain.toFixed(2)} {h.cost_basis.toFixed(2)}</Text>;`, [1, 1, 1, 1]],
      ['cents', `const s = centsToAmount(Math.abs(currentCents)).toLocaleString('en-US');`, [1]],
      ['an amount through Math.abs(), Number() or a const', `const abs = Math.abs(bankBalance);\nconst A = ({ t }) => <Text>{abs.toLocaleString()} {Math.abs(t.amount).toFixed(2)} {Number(t.amount).toFixed(2)}</Text>;`, [2, 2, 2]],
      ['toFixed’s 2 in parentheses or a const', `const D = 2;\nconst A = ({ amount }) => <Text>{amount.toFixed(D)} {amount.toFixed((2))} {amount?.toFixed(2)}</Text>;`, [2, 2, 2]],
      ['any figure beside a $: a template, JSX text, {\'$\'}, <span>$</span>, + and String()', "const A = ({ v }) => <Box aria-label={`Spent $${v.toFixed(2)}`}>Available: ${v.toFixed(2)}{'$'}{v.toFixed(2)}<span>$</span>{v.toFixed(2)}{'$' + v.toFixed(2) + ' left'}{'Available: $' + String(v.toFixed(2))}</Box>;", [1, 1, 1, 1, 1, 1]],
      ['a whole figure beside a $ (an axis’s), a toast’s', "const A = ({ amount }) => <><ResponsiveLine axisLeft={{ format: (v) => `$${v.toFixed(0)}` }} /><Text>${amount.toFixed()}</Text>{toast.success(`Moved $${amount.toFixed(2)}`)}</>;", [1, 1, 1]],
      ['a figure before a currency code', "const A = ({ v }) => <Text>{`${v.toFixed(2)} USD`}</Text>;", [1]],
      ['an Intl.NumberFormat: made in place, held in a const, made in useMemo', "const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 });\nconst A = ({ amount, value }) => {\n  const fmt = useMemo(() => new Intl.NumberFormat('en-US'), []);\n  return <Text>{new Intl.NumberFormat('en-US').format(amount)} {usd.format(amount)} {fmt.format(amount)} ${usd.format(value)}</Text>;\n};", [4, 4, 4, 4]],
      ['a d3 format with a $ (nivo’s)', `const A = () => <><ResponsivePie valueFormat=" >-$.2f" /><ResponsiveLine axisLeft={{ format: '$,.0f' }} /></>;`, [1, 1]],
    ];
    const MONEY_ALLOWED = [
      ['a count: total, length, a …Count with toLocaleString() and no fraction digits', `const A = ({ data, budgets, totalCount }) => <Text>{data.total.toLocaleString()} {budgets.length.toLocaleString()} {totalCount.toLocaleString()}</Text>;`],
      ['a percentage, a share: …Pct, …Percentage, …shares, a % after it', "const A = ({ budgetPct, totalPercentage, h, amount }) => <Text>{budgetPct.toFixed(2)}% {totalPercentage.toFixed(2)} {h.total_shares.toFixed(2)} shares {`${amount.toFixed(2)}%`}</Text>;"],
      ['a date, a size', `const A = ({ budget, budgetDate, file }) => <Text>{new Date(budget.created_at).toLocaleString()} {budgetDate.toLocaleString()} {(file.size / 1024).toFixed(2)} {\`$HOME is \${file.size.toFixed(2)}\`}</Text>;`],
      ['a figure handed on: a request body, a form’s value, a setter (an input’s editable text)', `const save = (amount, setText) => { apiPost('/transactions', { amount: amount.toFixed(2) }); setText(amount.toFixed(2)); };`],
      ['value alone (it’s everywhere), and a figure with no money name, without a $', `const A = ({ value, x, v }) => <Text>{value.toFixed(2)} {Math.abs(x).toFixed(2)} {Number(v).toFixed(2)} {value.toLocaleString('en-US', { useGrouping: false })}</Text>;`],
      ['a figure to other digits, formatMoney', `const A = ({ amount }) => <Text>{amount.toFixed(1)} {amount.toFixed(0)} {formatMoney(amount, { negative: 'parentheses' })}</Text>;`],
      ['not read: a formatter behind a function, formatToParts, a call through the prototype, element access', "const usd = new Intl.NumberFormat('en-US');\nconst fmt = (n) => usd.format(n);\nconst A = ({ amount }) => [fmt(amount), new Intl.NumberFormat('en-US').formatToParts(amount), Number.prototype.toLocaleString.call(amount), amount['toFixed'](2)];"],
    ];
    it.each(MONEY_REFUSED)('refuses money formatted by hand: %s', (_label, source, lines) => {
      expect(money(source)).toEqual(lines);
    });
    it.each(MONEY_ALLOWED)('allows %s', (_label, source) => {
      expect(money(source)).toEqual([]);
    });
    it('exempts a test, the CSV export and the money helpers’ own file, and says a count isn’t money', () => {
      expect(money(`const s = balance.toLocaleString();`, 'components/__tests__/X.test.tsx')).toEqual([]);
      expect(money(`const cells = [budget.toFixed(2), actual.toFixed(2)];`, 'pages/DataExportPage.tsx')).toEqual([]);
      expect(money(`export const centsText = (cents) => (cents / 100).toFixed(2);`, 'utils/currency.ts')).toEqual([]);
      expect(money(`export const centsText = (cents) => (cents / 100).toFixed(2);`)).toEqual([1]);
      const [finding] = findViolations(`const s = amount.toFixed(2);`, 'components/Fixture.tsx').styling.filter((v) => MONEY.test(v.msg));
      expect(finding.msg).toMatch(/A count, a percentage or a share isn't money: a name that says so/);
    });

    it('reads <T.Dialog.Title color> through a namespace import', () => {
      expect(caught(`import * as T from '@radix-ui/themes';\n<T.Dialog.Title color="green">Saved</T.Dialog.Title>`)).toEqual([2]);
      expect(caught(`import * as T from '@radix-ui/themes';\n<T.AlertDialog.Description color={'amber'}>x</T.AlertDialog.Description>`)).toEqual([2]);
      expect(caught(`import * as T from '@radix-ui/themes';\n<T.Callout.Root color="jade"><T.Callout.Text>x</T.Callout.Text></T.Callout.Root>`)).toEqual([2]);
      expect(caught(`import * as T from '@radix-ui/themes';\n<T.Dialog.Title color="green" highContrast>Saved</T.Dialog.Title>`)).toEqual([]);
      // Another namespace's Dialog.Title isn't Radix's.
      expect(caught(`import * as Other from 'some-dialogs';\n<Other.Dialog.Title color="green">x</Other.Dialog.Title>`)).toEqual([]);
    });

    // A colour picked by the app's appearance, case by case.
    const PICKED = /picked by appearance/;
    const picked = (source) => findViolations(source, 'components/Fixture.tsx').styling.filter((v) => PICKED.test(v.msg)).map((v) => v.line);
    const APPEARANCE_REFUSED = [
      ['a mode compared with dark, or the other way round', `const c = mode === 'dark' ? '#fff' : '#000';\nconst d = 'light' !== props.mode ? 'white' : 'black';`, [1, 2]],
      ['with &&', `const c = mode === 'dark' && '#fff';`, [1]],
      ['a call’s result, nested calls in it', `const c = getMode() === 'dark' ? '#fff' : '#000';\nconst d = getMode(prefs.get('x')) === 'dark' ? '#000' : '#fff';`, [1, 2]],
      ['a member: bracketed, optional, non-null', `const c = prefs['mode'] === 'dark' ? '#fff' : '#000';\nconst d = prefs?.['mode'] === 'dark' ? '#000' : '#fff';\nconst e = mode! === 'dark' ? '#000' : '#fff';`, [1, 2, 3]],
      ['the word in a template, capitalised, or a const', "const DARK = 'dark';\nconst c = mode === `dark` ? '#fff' : '#000';\nconst d = mode === 'Dark' ? '#000' : '#fff';\nconst e = mode === DARK ? '#000' : '#fff';\nconst f = theme === Appearance.Light ? 'white' : 'black';", [2, 3, 4, 5]],
      ['a comment or a new line before the ?', `const c = mode === 'dark' /* x */ ? '#000' : '#fff';\nconst d = mode === 'dark'\n  ? '#000'\n  : '#fff';`, [1, 2]],
      ['a name that reads the mode, though it says weight too', `const c = prefs.weightedMode === 'light' ? '#fff' : '#000';`, [1]],
      ['isDark, a scheme', `const c = isDark && '#fff';\nconst d = colorScheme === 'dark' ? '#fff' : '#000';`, [1, 2]],
    ];
    const APPEARANCE_ALLOWED = [
      ['a choice that isn’t a colour, or a value that isn’t dark or light', `const label = mode === 'dark' ? 'Dark' : 'Light';\nconst c = mode === 'compact' ? '#fff' : '#000';`],
      ['a font weight', `const c = weight === 'light' ? 'gray' : 'blue';\nconst d = props.fontWeight === 'light' && 'gray';\nconst e = 'light' === weight ? '#999' : '#000';\nconst f = fontWeightName === 'light' ? 'var(--gray-11)' : 'var(--gray-12)';`],
      ['a data colour’s own contrast pick', `const ink = (c) => (luminanceOf(c) === 'light' ? '#000' : '#fff');\nconst tone = (tag) => (tag.tone === 'dark' ? 'white' : 'black');`],
      ['an image, a word that only starts like one', `const src = logo === 'dark' ? '/logo-dark.svg' : '/logo.svg';\nconst w = weight === 'lightest' ? '#999' : '#000';`],
    ];
    it.each(APPEARANCE_REFUSED)('refuses a colour picked by appearance: %s', (_label, source, lines) => {
      expect(picked(source)).toEqual(lines);
    });
    it.each(APPEARANCE_ALLOWED)('allows %s', (_label, source) => {
      expect(picked(source)).toEqual([]);
    });

    it("takes text set as wide as a form page or wider for a page's width", () => {
      expect(pages(`${HEAD}const XPage = () => <PageContainer><Text as="div" style={{ maxWidth: 1600 }}>x</Text></PageContainer>;`)).toEqual([3]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><Text as="div" className="max-w-7xl">x</Text><p className="max-w-[1200px]" /></PageContainer>;`)).toEqual([3, 3]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><Text as="div" style={{ maxWidth: 880 }}>x</Text></PageContainer>;`)).toEqual([3]);
      expect(pages(`${HEAD}const XPage = () => <PageContainer><p style={{ width: 1200, margin: '0 auto' }} /></PageContainer>;`)).toEqual([3]);
      // A reading measure narrower than a form page is the text's own.
      expect(pages(`${HEAD}const XPage = () => <PageContainer><Text as="p" className="max-w-3xl">x</Text><p style={{ maxWidth: '50rem' }} /><Text style={{ maxWidth: '65ch' }} /></PageContainer>;`)).toEqual([]);
    });
  });

  // Tailwind layout classes where a Radix prop carries the same, case by
  // case: what is refused, on which line, with the prop the message names; and what is allowed.
  describe('Tailwind layout classes', () => {
    const TW_HEAD = `import { Box, Flex, Grid, Text, Heading, Card, Button, Badge, Table, Dialog } from '@radix-ui/themes';\nimport { X, Calendar } from 'lucide-react';\n`;
    const TW = /^A Tailwind layout class — use the Radix prop/;
    const layout = (source, rel = 'components/Fixture.tsx', files) =>
      findViolations(TW_HEAD + source, rel, files ? { files } : {}).styling.filter((v) => TW.test(v.msg)).map((v) => ({ line: v.line - 2, msg: v.msg }));
    const REFUSED = [
      ['a Box’s padding and margin', `const A = () => <Box className="p-4 mt-2" />;`, ['p-4 → p="4"', 'mt-2 → mt="2"']],
      ['a Flex’s direction, gap, alignment and wrap', `const A = () => <Flex className="flex-col gap-2 items-center justify-between flex-wrap" />;`, ['flex-col → direction="column"', 'gap-2 → gap="2"', 'items-center → align="center"', 'justify-between → justify="between"', 'flex-wrap → wrap="wrap"']],
      ['a Grid’s columns, and a gap at Radix’s sm (Tailwind’s md)', `const A = () => <Grid className="grid-cols-2 md:gap-6" />;`, ['grid-cols-2 → columns="2"', "md:gap-6 → gap={{ sm: '5' }}"]],
      ['sizes, named and arbitrary', `const A = () => <Box className="w-full max-w-md h-[200px] min-h-screen" />;`, ['w-full → width="100%"', 'max-w-md → maxWidth="448px"', 'h-[200px] → height="200px"', 'min-h-screen → minHeight="100vh"']],
      ['a flex item', `const A = () => <Box className="flex-1 shrink-0" />;`, ['flex-1 → flexGrow="1" flexBasis="0%"', 'shrink-0 → flexShrink="0"']],
      ['position, an inset and overflow', `const A = () => <Box className="absolute top-0 right-1/2 overflow-y-auto" />;`, ['absolute → position="absolute"', 'top-0 → top="0"', 'right-1/2 → right="50%"', 'overflow-y-auto → overflowY="auto"']],
      ['display, at a breakpoint too', `const A = () => <Box className="hidden lg:block" />;`, ['hidden → display="none"', "lg:block → display={{ md: 'block' }}"]],
      ['a grid item’s span', `const A = () => <Box className="col-span-2" />;`, ['col-span-2 → gridColumn="span 2 / span 2"']],
      ['a Box with flex', `const A = () => <Box className="flex gap-2" />;`, ['a Box with flex → Flex', 'flex → nothing (a Flex is flex)', 'gap-2 → gap="2"']],
      ['a Text’s margin, alignment and block', `const A = () => <Text className="mt-2 text-center block">x</Text>;`, ['mt-2 → mt="2"', 'text-center → align="center"', 'block → as="div"']],
      ['a Heading’s block (it is one)', `const A = () => <Heading className="block">x</Heading>;`, ['block → nothing (a Heading is a block)']],
      ['a Card’s margin and padding', `const A = () => <><Card className="mb-4 p-4" /><Card className="p-3" /></>;`, ['mb-4 → mb="4"', 'p-4 → size="2" (same radius)', 'p-3 → nothing (a Card’s default size, 1, pads 12px)']],
      ['a control’s margin', `const A = () => <><Button className="mt-2">x</Button><Badge className="ml-1">y</Badge></>;`, ['mt-2 → mt="2"', 'ml-1 → ml="1"']],
      ['a table cell’s padding, width and alignment', `const A = () => <Table.Cell className="p-2 w-32 text-right" />;`, ['p-2 → p="2"', 'w-32 → width="128px"', 'text-right → justify="end"']],
      ['a lucide icon’s size, and an icon’s by its name', `const A = ({ icon: Icon }) => <><X className="w-4 h-4" /><Calendar className="size-5" /><Icon className="h-6 w-6" /></>;`, ['w-4 h-4 → size={16}', 'size-5 → size={20}', 'w-6 h-6 → size={24}']],
      ['a raw div, and a span with a display', `const A = () => <><div className="flex items-center gap-2" /><span className="inline-block mr-2" /></>;`, ['a div → Flex', 'items-center → align="center"', 'a span → Box as="span"', 'inline-block → display="inline-block"', 'mr-2 → mr="2"']],
      ['a static radius, on any element', `const A = () => <><span className="rounded-md md:rounded-xl" /><Badge className="rounded">x</Badge></>;`, ['rounded-md → rounded-[var(--radius-3)]', 'md:rounded-xl → md:rounded-[var(--radius-5)]', 'rounded → rounded-[var(--radius-2)]']],
      ['a negative inset token', `const A = () => <Box position="absolute" top="-2" />;`, ['top="-2" does nothing (Radix has no negative inset token) → top="-8px"']],
      ['classes from cn(), a template, this file’s const and map, chosenColourProps()', "const PAD = 'p-4';\nconst SIZE = { sm: 'mt-2' };\nconst A = ({ extra, c }) => <><Box className={cn(PAD, SIZE.sm)} /><Flex className={`gap-2 ${extra}`} /><Box {...chosenColourProps(c, 'gray', 'p-2')} /></>;", ['p-4 → p="4"', 'mt-2 → mt="2"', 'gap-2 → gap="2"', 'p-2 → p="2"']],
    ];
    const ALLOWED = [
      ['a group with a Tailwind sm: class (Radix has no 640px)', `const A = () => <Box className="p-4 sm:p-6 lg:p-8" />;`],
      ['a group with a step that has no token', `const A = () => <Box className="mt-3 ml-7" />;`],
      ['a 2xl: class, a state variant’s group', `const A = () => <><Box className="2xl:p-4" /><Box className="p-4 hover:p-2" /></>;`],
      ['a class chosen at run time', `const A = ({ open }) => <Box className={open ? 'block' : 'hidden'} />;`],
      ['a group the element sets a prop of', `const A = () => <Box p="2" className="px-4" />;`],
      ['what Radix has no prop for: space-*, z-index, a Box’s text-align, vertical-align', `const A = () => <Box className="space-y-2 z-50 text-center align-middle" />;`],
      ['a Text’s padding, a Text’s block in a label or as one, a dialog title’s block', `const A = () => <><Text className="pt-2">x</Text><label><Text className="block">y</Text></label><Text as="label" className="block">z</Text><Dialog.Title className="block">t</Dialog.Title></>;`],
      ['a Card’s display, its 24px padding, padding beside a size, a ghost Card’s margin', `const A = () => <><Card className="hidden md:block" /><Card className="p-6" /><Card size="1" className="p-4" /><Card variant="ghost" className="mb-2" /></>;`],
      ['a Button’s layout (it takes margin props only), a ghost or computed variant’s margin', `const A = ({ v }) => <><Button className="flex-1 w-full">a</Button><Button variant="ghost" className="m-0">b</Button><Button variant={v} className="mt-2">c</Button></>;`],
      ['an icon’s size at a breakpoint, unequal, beside its size prop; its other classes', `const A = () => <><X className="md:w-16 md:h-16" /><X className="w-4 h-5" /><X size={16} className="w-4 h-4" /><Calendar className="shrink-0 inline mr-1" /></>;`],
      ['a span with no display, raw semantic elements', `const A = () => <><span className="mr-2" /><button className="text-left" /><nav className="z-40" /></>;`],
      ['a radius with no token or one already', `const A = () => <Box className="rounded-full rounded-none rounded-xs rounded-3xl rounded-[var(--radius-3)]" />;`],
      ['a spread after the classes, a skip link’s sr-only', `const A = (props) => <><Box className="p-4" {...props} /><a className="sr-only focus:not-sr-only px-4 py-2">Skip</a></>;`],
      ['a negative inset in px', `const A = () => <Box position="absolute" top="-8px" />;`],
    ];
    it.each(REFUSED)('refuses %s, naming the prop', (_label, source, moves) => {
      const found = layout(source);
      expect(found.length).toBeGreaterThan(0);
      const text = found.map((v) => v.msg).join(' ');
      for (const move of moves) expect(text).toContain(move);
    });
    it.each(ALLOWED)('allows %s', (_label, source) => {
      expect(layout(source)).toEqual([]);
    });
    it('reads a class constant of this file, not another module’s; not tests, nor outside pages/ and components/', () => {
      const files = { 'components/links.ts': `export const ABOVE = 'relative z-[1]';` };
      expect(layout(`import { ABOVE } from './links';\nconst A = () => <Flex className={ABOVE} />;`, 'components/Fixture.tsx', files)).toEqual([]);
      expect(layout(`const ABOVE = 'relative z-[1]';\nconst A = () => <Flex className={ABOVE} />;`).map((v) => v.line)).toEqual([2]);
      expect(layout(`const A = () => <Box className="p-4" />;`, 'components/__tests__/X.test.tsx')).toEqual([]);
      expect(layout(`const A = () => <Box className="p-4" />;`, 'utils/x.tsx')).toEqual([]);
      expect(layout(`const A = () => <Box className="p-4" />;`, 'pages/XPage.tsx').map((v) => v.line)).toEqual([1]);
    });
  });

  // It parses every file in the app: about 10 s alone, more on a loaded machine.
  it('finds nothing in the app (no false positive)', () => {
    const src = join(import.meta.dirname, '..', '..', 'src');
    const files = (dir) =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return files(path);
        return /\.tsx?$/.test(name) ? [path] : [];
      });
    const found = files(src).flatMap((file) => {
      const rel = relative(src, file).split(sep).join('/');
      const { styling, dates, pages } = findViolations(readFileSync(file, 'utf8'), rel);
      return [...styling, ...dates, ...pages].map((v) => `${rel}:${v.line} ${v.msg}`);
    });
    expect(found).toEqual([]);
  }, 60_000);
});
