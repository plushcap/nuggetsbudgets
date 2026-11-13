#!/usr/bin/env node
// The "What changed" part of a GitHub Release's description, from CHANGELOG.md: the release's
// own section (its Security, Changed and Fixed entries), then the pull requests merged since the
// release before it, as GitHub lists them. docker-build-deploy.yml writes it into each new
// release, and release-notes.yml into one that already exists.
//
//   node scripts/release-notes.mjs block <version> <changelog> [<pull-requests.md>] [--strict]
//     prints the part, between the markers below. <version> is X.Y.Z; its section is the one
//     under "## X.Y.Z (date)", as cut-release.yml looks for it. Without one (a release cut
//     before the changelog gave it a heading), the Unreleased entries at the tag stand in, and
//     the part says so; with --strict, it refuses instead (exit 3), as for a changelog read
//     later than the tag, whose Unreleased entries came after the release.
//   node scripts/release-notes.mjs merge <description.md> <block.md>
//     prints the description with the part put in: in place of an earlier one (between the
//     markers), else of the old "What changed: [CHANGELOG.md](…)" line, else under its heading.
//
// The runner's own Node runs it; it has no dependencies.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const START = '<!-- release-notes:start -->';
export const END = '<!-- release-notes:end -->';

/** Past this, a description is near GitHub's limit (125,000 characters): the part links instead. */
const MAX_BLOCK = 100_000;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * For each line, whether it is inside a fenced code block (or is one of its fences): a fence is
 * three or more backticks or tildes, closed by the same character, at least as many.
 */
function fencedLines(lines) {
  let open = null;
  return lines.map((line) => {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      // A backtick fence's info string has no backtick (CommonMark): "``` a`b" is text.
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) open = fence[1];
      return open !== null;
    }
    if (fence && fence[1][0] === open[0] && fence[1].length >= open.length && /^ {0,3}[`~]+\s*$/.test(line)) open = null;
    return true;
  });
}

/** The text under a "## " heading of the changelog, outside code, up to the next one; or null. */
function sectionUnder(changelog, heading) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const fenced = fencedLines(lines);
  const isHeading = (i, test) => !fenced[i] && test(lines[i]);
  const start = lines.findIndex((_, i) => isHeading(i, (line) => heading.test(line)));
  if (start === -1) return null;
  let end = lines.findIndex((_, i) => i > start && isHeading(i, (line) => /^## /.test(line)));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

/** A version's section: the text under "## X.Y.Z (…)", or null. */
export function versionSection(changelog, version) {
  return sectionUnder(changelog, new RegExp(`^## ${escapeRegExp(version)} \\(`));
}

/** The Unreleased section's text, or null. */
export function unreleasedSection(changelog) {
  return sectionUnder(changelog, /^## Unreleased\s*$/);
}

/** Headings `levels` deeper, so a changelog's "### Fixed" sits under the description's own. */
export function demoteHeadings(markdown, levels) {
  const lines = markdown.split('\n');
  const fenced = fencedLines(lines);
  const extra = '#'.repeat(levels);
  return lines
    .map((line, i) => (!fenced[i] && /^#{1,6} /.test(line) ? `${extra}${line}`.replace(/^#{7,} /, '###### ') : line))
    .join('\n');
}

/**
 * Paragraphs on one line each: the changelog wraps its lines at about 95 characters, which a
 * release description can show as a break in mid-sentence. Cautious: a line joins the one before
 * only when both are text of a paragraph or list item. Never code (fenced, or indented code: four
 * spaces after a blank line or more code, since it can't interrupt a paragraph), a new list item,
 * a heading, a quote, a table, HTML, a rule or a hard break: those keep their line, which at worst
 * leaves a break where one was.
 */
/**
 * The HTML that can interrupt a paragraph (CommonMark's HTML blocks 1 to 6): a comment, a
 * processing instruction, a declaration, CDATA, or a block-level tag. Any other tag at the start of
 * a line (`<package>` in a wrapped command) carries the paragraph on.
 */
const htmlInterrupts =
  /^\s{0,3}<(?:!--|\?|![A-Za-z]|!\[CDATA\[|\/?(?:script|pre|style|textarea|address|article|aside|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$))/i;

export function unwrap(markdown) {
  const lines = markdown.split('\n');
  const fenced = fencedLines(lines);
  const blank = (line) => /^\s*$/.test(line);
  const indented = (line) => /^(?: {4,}|\t)/.test(line);
  // Indented code: an indented line after a blank line or another such line, outside a fence.
  const code = [];
  lines.forEach((line, i) => {
    code[i] = !fenced[i] && !blank(line) && indented(line) && (i === 0 || blank(lines[i - 1]) || code[i - 1] === true);
  });
  const opensBlock = (line) =>
    /^\s*(?:[-*+] |\d+[.)] |#{1,6} |>|\|)/.test(line) ||
    htmlInterrupts.test(line) ||
    line.includes('|') ||
    /^\s*(?:[-=_*]\s*){3,}$/.test(line) ||
    /^\s*=+\s*$/.test(line);
  const ends = (line) => / {2,}$/.test(line) || /\\$/.test(line);
  const out = [];
  const kinds = [];
  lines.forEach((line, i) => {
    const previous = out[out.length - 1];
    const previousKind = kinds[kinds.length - 1];
    const carriesOn =
      i > 0 && previous !== undefined && previousKind === 'text' && !ends(previous) &&
      !fenced[i] && !code[i] && !blank(line) && !opensBlock(line);
    if (carriesOn) {
      out[out.length - 1] = `${previous.trimEnd()} ${line.trim()}`;
      return;
    }
    out.push(line);
    // What a following line may join: a paragraph's or a list item's text.
    const item = /^\s*(?:[-*+] |\d+[.)] )/.test(line);
    kinds.push(!fenced[i] && !code[i] && !blank(line) && (item || !opensBlock(line)) && !line.includes('|') ? 'text' : 'other');
  });
  return out.join('\n');
}

/**
 * GitHub's list of the pull requests in a release (the generate-notes API's body), under a
 * heading of the description's: its leading comment and "## What's Changed" heading go, the
 * rest move down. Null when it lists no pull request.
 */
export function pullRequestList(generated) {
  const body = generated
    .replace(/\r\n/g, '\n')
    .replace(/^\s*(?:<!--[\s\S]*?-->\s*)+/, '')
    .replace(/^## What's Changed\s*\n/, '')
    .trim();
  if (!body) return null;
  // The pull requests are the list before any other heading (New Contributors) or the link.
  const listed = body.split(/^(?:#{1,6} |\*\*Full Changelog\*\*)/m)[0] ?? '';
  return /^\s*[*-] /m.test(listed) ? demoteHeadings(body, 2) : `None.\n\n${demoteHeadings(body, 2)}`;
}

/**
 * The part, between the markers, for `version`; null when `strict` and the changelog has no
 * section for it.
 */
export function releaseNotesBlock(changelog, version, pullRequests = '', { strict = false } = {}) {
  const own = versionSection(changelog, version);
  if (own === null && strict) return null;
  const entries = own ?? unreleasedSection(changelog);
  const parts = [START, '### What changed', ''];
  if (own === null && entries) {
    parts.push(`_The changelog has no ${version} heading yet: these are its Unreleased entries at this release._`, '');
  }
  parts.push(entries ? demoteHeadings(unwrap(entries), 1) : `_The changelog lists nothing for ${version}._`);
  const withoutPrs = parts.slice(1).join('\n');
  const prs = pullRequestList(pullRequests);
  let block = prs ? `${withoutPrs}\n\n### Pull requests\n\n${prs}` : withoutPrs;
  // Too long for GitHub: the pull requests go first, then the entries give way to a link.
  if (block.length > MAX_BLOCK) block = withoutPrs;
  if (block.length > MAX_BLOCK) block = `### What changed\n\n_Too long for this description: see ${version} in CHANGELOG.md._`;
  return `${START}\n${block}\n${END}`;
}

/** The release description with `block` put in (see the top of this file). */
export function mergeIntoDescription(description, block) {
  const text = description.replace(/\r\n/g, '\n');
  // The first start and the last end: the part's own text may quote a marker (a changelog entry
  // about this script), but it opens with the real start, and nothing after the part (the images,
  // the deploy notes) has one.
  const start = text.indexOf(START);
  const end = text.lastIndexOf(END);
  if (start !== -1 && end > start) {
    return text.slice(0, start) + block + text.slice(end + END.length);
  }
  // The descriptions released before had a link line: the part takes its place, and the link
  // stays under it, as new releases have it.
  const oldLink = /^What changed: (\[CHANGELOG\.md\]\([^)\n]*\))\.?[ \t]*$/m;
  const link = oldLink.exec(text);
  if (link) return text.replace(oldLink, () => `${block}\n\nEvery release: ${link[1]}.`);
  const lines = text.split('\n');
  if (/^#{1,6} /.test(lines[0] ?? '')) {
    return [lines[0], '', block, '', ...lines.slice(1)].join('\n').replace(/\n{3,}/g, '\n\n');
  }
  return text ? `${block}\n\n${text}` : block;
}

function main(argv) {
  const strict = argv.includes('--strict');
  const [command, ...args] = argv.filter((arg) => arg !== '--strict');
  if (command === 'block' && (args.length === 2 || args.length === 3)) {
    const [version, changelogPath, prsPath] = args;
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      console.error(`release-notes: '${version}' is not a version (X.Y.Z)`);
      return 2;
    }
    const pullRequests = prsPath ? readFileSync(prsPath, 'utf8') : '';
    const block = releaseNotesBlock(readFileSync(changelogPath, 'utf8'), version, pullRequests, { strict });
    if (block === null) {
      console.error(`release-notes: ${changelogPath} has no '## ${version} (YYYY-MM-DD)' heading`);
      return 3;
    }
    process.stdout.write(`${block}\n`);
    return 0;
  }
  if (command === 'merge' && args.length === 2 && !strict) {
    const [descriptionPath, blockPath] = args;
    const block = readFileSync(blockPath, 'utf8').trim();
    if (!block.startsWith(START) || !block.endsWith(END)) {
      console.error(`release-notes: ${blockPath} is not a part this script wrote`);
      return 3;
    }
    process.stdout.write(mergeIntoDescription(readFileSync(descriptionPath, 'utf8'), block));
    return 0;
  }
  console.error(
    'usage: release-notes.mjs block <version> <changelog> [<pull-requests.md>] [--strict]\n' +
      '       release-notes.mjs merge <description.md> <block.md>',
  );
  return 2;
}

// Run as a command (not imported by the tests), through a symlink too: Node gives
// import.meta.url its real path.
const invoked = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return null; } })() : null;
if (invoked !== null && invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
