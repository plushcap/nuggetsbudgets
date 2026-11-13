#!/usr/bin/env node
// The "What changed" part of a GitHub Release's description, from CHANGELOG.md: the release's
// own section (its Security, Changed and Fixed entries), then the pull requests merged since the
// release before it, as GitHub lists them. docker-build-deploy.yml writes it into each new
// release, and release-notes.yml into one that already exists.
//
//   node scripts/release-notes.mjs block <version> <changelog> [<pull-requests.md>]
//     prints the part, between the markers below. <version> is X.Y.Z; its section is the one
//     under "## X.Y.Z (date)". Without one (a release cut before the changelog gave it a
//     heading), the Unreleased entries at the tag stand in, and the part says so.
//   node scripts/release-notes.mjs merge <description.md> <block.md>
//     prints the description with the part put in: in place of an earlier one (between the
//     markers), else of the old "What changed: [CHANGELOG.md](…)" line, else under its heading.
//
// The runner's own Node runs it; it has no dependencies.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const START = '<!-- release-notes:start -->';
export const END = '<!-- release-notes:end -->';

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text under a "## " heading of the changelog, up to the next one; null without it. */
function sectionUnder(changelog, heading) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

/** A version's section: the text under "## X.Y.Z (…)" (or a bare "## X.Y.Z"), or null. */
export function versionSection(changelog, version) {
  return sectionUnder(changelog, new RegExp(`^## ${escapeRegExp(version)}(?: \\(|\\s*$)`));
}

/** The Unreleased section's text, or null. */
export function unreleasedSection(changelog) {
  return sectionUnder(changelog, /^## Unreleased\s*$/);
}

/** Headings `levels` deeper, so a changelog's "### Fixed" sits under the description's own. */
export function demoteHeadings(markdown, levels) {
  const extra = '#'.repeat(levels);
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      return !fenced && /^#{1,6} /.test(line) ? `${extra}${line}`.replace(/^#{7,} /, '###### ') : line;
    })
    .join('\n');
}

/**
 * Paragraphs on one line each: the changelog wraps its lines at about 95 characters, which a
 * release description can show as a break in mid-sentence. A line carries on the one before
 * when both have text and it starts no list item, heading, table row or code fence; a blank
 * line still ends a paragraph, and a fenced block is left alone.
 */
export function unwrap(markdown) {
  const out = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    const fence = /^\s*```/.test(line);
    const previous = out[out.length - 1];
    const carriesOn =
      !fenced && !fence && previous !== undefined && previous.trim() !== '' && line.trim() !== '' &&
      !/^\s*(?:[-*+] |\d+[.)] |#{1,6} |\||>)/.test(line) && !/^\s*(?:#{1,6} |```)/.test(previous);
    if (carriesOn) out[out.length - 1] = `${previous.trimEnd()} ${line.trim()}`;
    else out.push(line);
    if (fence) fenced = !fenced;
  }
  return out.join('\n');
}

/**
 * GitHub's list of the pull requests in a release (the generate-notes API's body), under a
 * heading of the description's: its own "## What's Changed" heading goes, the rest move down.
 */
export function pullRequestList(generated) {
  const body = generated.replace(/\r\n/g, '\n').replace(/^## What's Changed\s*\n/, '').trim();
  return body ? demoteHeadings(body, 2) : '';
}

/** The part, between the markers, for `version`. */
export function releaseNotesBlock(changelog, version, pullRequests = '') {
  const own = versionSection(changelog, version);
  const unreleased = own === null ? unreleasedSection(changelog) : null;
  const entries = own ?? unreleased;
  const parts = [START, '### What changed', ''];
  if (own === null && entries) {
    parts.push(`_The changelog has no ${version} heading yet: these are its Unreleased entries at this release._`, '');
  }
  parts.push(entries ? demoteHeadings(unwrap(entries), 1) : `_The changelog lists nothing for ${version}._`);
  const prs = pullRequestList(pullRequests);
  if (prs) parts.push('', '### Pull requests', '', prs);
  parts.push(END);
  return parts.join('\n');
}

/** The release description with `block` put in (see the top of this file). */
export function mergeIntoDescription(description, block) {
  const text = description.replace(/\r\n/g, '\n');
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start !== -1 && end > start) {
    return text.slice(0, start) + block + text.slice(end + END.length);
  }
  const oldLink = /^What changed: \[CHANGELOG\.md\]\([^)\n]*\)\.?[ \t]*$/m;
  if (oldLink.test(text)) return text.replace(oldLink, () => block);
  const lines = text.split('\n');
  if (/^#{1,6} /.test(lines[0] ?? '')) {
    return [lines[0], '', block, '', ...lines.slice(1)].join('\n').replace(/\n{3,}/g, '\n\n');
  }
  return text ? `${block}\n\n${text}` : block;
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'block' && (args.length === 2 || args.length === 3)) {
    const [version, changelogPath, prsPath] = args;
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      console.error(`release-notes: '${version}' is not a version (X.Y.Z)`);
      return 2;
    }
    const pullRequests = prsPath ? readFileSync(prsPath, 'utf8') : '';
    process.stdout.write(`${releaseNotesBlock(readFileSync(changelogPath, 'utf8'), version, pullRequests)}\n`);
    return 0;
  }
  if (command === 'merge' && args.length === 2) {
    const [descriptionPath, blockPath] = args;
    const block = readFileSync(blockPath, 'utf8').trim();
    process.stdout.write(mergeIntoDescription(readFileSync(descriptionPath, 'utf8'), block));
    return 0;
  }
  console.error('usage: release-notes.mjs block <version> <changelog> [<pull-requests.md>]\n       release-notes.mjs merge <description.md> <block.md>');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
