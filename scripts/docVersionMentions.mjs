// The versions a doc states, as check-doc-versions.mjs reads them, kept apart
// from the checks so the reading can be tested (backend/src/__tests__/repositoryScripts.test.ts).
// No dependencies.

// A space, or a line break, so a mention wrapped across two lines is still found (a list
// item's number on the next line is told apart below, isListNumber).
const SEP = String.raw`(?:[ \t]+|[ \t]*\r?\n[ \t]*)`;
const mention = (source) => new RegExp(source.replaceAll('<SEP>', SEP), 'g');

/** [tech, the regex whose first group is the version a mention states]. */
export const MENTIONS = [
  ['node', mention(String.raw`\bNode(?:\.js)?<SEP>v?(\d+)\b`)],
  // Postgres and PostgreSQL.
  ['postgres', mention(String.raw`\bPostgre(?:SQL|s)<SEP>v?(\d+)\b`)],
  // An image tag (postgres:18, postgres:18-alpine), not a host and port (postgres:5432).
  ['postgres', /\bpostgres:(\d{1,3})(?![\d:])/g],
  ['react', mention(String.raw`\bReact<SEP>v?(\d+)\b`)],
  ['react-router', mention(String.raw`\bReact<SEP>Router<SEP>v?(\d+)\b`)],
  ['react-router', mention(String.raw`\`?\breact-router(?:-dom)?\`?<SEP>v?(\d+)\b`)],
  ['vite', mention(String.raw`\bVite<SEP>v?(\d+)\b`)],
  ['tailwind', mention(String.raw`\bTailwind(?:<SEP>CSS)?<SEP>v?(\d+)\b`)],
  ['express', mention(String.raw`\bExpress<SEP>v?(\d+)\b`)],
  ['safari', mention(String.raw`\bSafari<SEP>(\d+(?:\.\d+)?)`)],
  ['chrome', mention(String.raw`\bChrome(?:<SEP>and<SEP>Edge)?<SEP>(\d+)\b`)],
  ['edge', mention(String.raw`\bEdge<SEP>(\d+)\b`)],
  ['firefox', mention(String.raw`\bFirefox<SEP>(\d+)\b`)],
];

/** A line that is a list item: `1. `, `2) `, `- `, `* ` or `+ `, after any indent. */
const LIST_ITEM = /^[ \t]*(?:\d+[.)]|[-*+])[ \t]/;

/**
 * Whether the "version" a mention ends with is the number of a list item on the next line
 * ("Install Node.js" then "2. Run …"): the version starts that line, followed by `.` or `)`
 * and a space. As CommonMark reads it, such a line is a list item only when its number is 1
 * (a list starts inside a paragraph only at 1) or the line before is a list item itself;
 * otherwise it is the paragraph wrapped ("needs Node.js" then "26. It …"), and the version
 * is checked. It used to be skipped whatever it was.
 */
function isListNumber(text, match) {
  const end = match.index + match[0].length;
  if (!/\n[ \t]*v?\d[\d.]*$/.test(match[0]) || !/^[.)][ \t]/.test(text.slice(end, end + 2))) return false;
  const lineStart = text.lastIndexOf('\n', match.index) + 1;
  return match[1] === '1' || LIST_ITEM.test(text.slice(lineStart, text.indexOf('\n', match.index)));
}

/**
 * What follows a version when the text names something of that version's own, not the version
 * in use: the npm a Node release comes with, Tailwind's shorthand or class names
 * ("Tailwind 3's shorthand", "Node 22's npm"), or a possessive whose thing was named just
 * before it ("npm 10, Node 22's, crashed"), which punctuation ends. Only these: any other
 * possessive, a version's runtime or image say, states the version and is checked. Every
 * possessive was skipped, so a doc could name a version that isn't used, and pass. A
 * wrapped one in a comment ("'s" then "// shorthand" on the next line) is checked: keep it on
 * one line.
 */
const OWN_THING = /^['’]s(?:\s+(?:npm|npx|corepack|shorthand|syntax|text-)|[,;:.)\]]|$)/i;

/** Whether the text right after a version names that version's own thing ({@link OWN_THING}). */
export const namesOwnThing = (after) => OWN_THING.test(after);

/** The mentions of `re` in `text` that state a version in use, as { value, line }. */
export function versionsStated(text, re) {
  const found = [];
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length;
    if (namesOwnThing(text.slice(end, end + 40))) continue;
    if (isListNumber(text, m)) continue;
    found.push({ value: m[1], line: text.slice(0, m.index).split('\n').length });
  }
  return found;
}
