#!/usr/bin/env node
// Fails when a tracked file cites an issue or pull request of this repository by its number:
// a `#` and its digits, `Nuggets#` and a number, or a link to one on GitHub. It fails too on a
// finding of the security and quality audit, or a requirement of the requirement lists
// (investments, multi-tenancy), cited by its code: one of CODE_FAMILIES below, a hyphen and
// the number (SEC-AUTH-n, DB-n, FR-CA-nnn, RR-nnn). The project is published from one commit
// with no history, and those documents lived in issues, so such a number or code points at
// nothing a reader can open. Every tracked file is read, CHANGELOG.md included, except
// package-lock.json files and binary files.
//
// Of the `#` numbers it leaves these alone, and nothing else:
//   - `#` and one digit, a position in a list ("finding #3", "Tenant #1"), unless what comes
//     before it makes it an issue: an opening parenthesis, or `issue `, `PR ` or `pull request `;
//   - `#` right after a letter, a digit, `_` or `&`: a URL fragment (`page#12`), an HTML
//     entity (`&#39;`);
//   - a grey written as one digit three times, in quotes ('#000', fill="#999"); any other
//     colour of only digits is counted, so write it with six ('#112233'). Six digits or more
//     is a colour (`#336699`), never counted;
//   - a Markdown link to a heading, its number followed by a hyphen (`](#36-budget-periods)`);
//   - a number right after `React error `, React's own error codes (`React error #185`).
// A code is read only under the families' prefixes, in capitals, and not run on from a word or
// another hyphen, so an identifier or a standard (UTF-8, SHA-256, ISO-8601, CVE-…), a test's
// own ids (ACT-1, TXN-42, HIST-1, WA-FEE-1) and a family's name alone (`DB-backed`, `FR-SWITCH`)
// are left alone.
// Anything else that only looks like a reference, such as a store number in a bank's text in a
// test, or a test value under one of the prefixes, is written so the file doesn't carry it:
// `'STORE ' + '#' + '12'`, `'DB-' + '1'`.
//
// Usage: node scripts/check-issue-refs.mjs [directory]   (the checkout by default; no dependencies)
// Its cases: node --test scripts/check-issue-refs.test.mjs. CI runs both on every pull request
// (repository-checks.yml).
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `#` and two to five digits, not after a word character or `&`, and not run on into one. */
const NUMBER = /(?<![\w&])#(\d{2,5})(?!\w)/g;
/** The repository's name (its old one or its new one), a `#` and a number, as GitHub writes one from another repository. */
const NAMED = /\b(?:Nuggets|nuggetsbudgets)#\d+/gi;
/**
 * A link to an issue, pull request, discussion or commit of the repository, whoever owns it, the
 * API's form included (`api.github.com/repos/…`), or a relative one (`../`, `issues/` and a number).
 */
const LINK = /github\.com\/(?:repos\/)?[\w.-]+\/(?:Nuggets|nuggetsbudgets)\/(?:issues|pulls?|discussions|commit)\/\w+|(?<![\w/])(?:\.\.\/)+(?:issues|pulls?)\/\d+/gi;
/** `#` and one digit where it can only be an issue: after `(` (not a Markdown link's `](`), `issue `, `PR ` or `pull request `. */
const CUED = /(?:(?<!\])\(|\b(?:issues?|PRs?|pull requests?) )#\d(?!\w)/gi;
/**
 * The code families: the audit's findings (SEC-AUTH and SEC-INPUT to TENANCY) and the
 * requirement lists' (FR- and an area, such as FR-CA or FR-TADMIN; RR; MR).
 */
export const CODE_FAMILIES = ['SEC-AUTH', 'SEC-INPUT', 'OPS', 'DB', 'MONEY', 'TEST', 'FE', 'ARCH', 'TENANCY', 'FR-[A-Z]+', 'RR', 'MR'];
/** A family's prefix and its number, not after a word character or a hyphen, and not run on into a word. */
const CODE = new RegExp(`(?<![\\w-])(?:${CODE_FAMILIES.join('|')})-\\d+(?!\\w)`, 'g');

/** Whether the number at `index` of `line` is a grey in quotes: '#000', "#999", `#555`. */
function isQuotedGrey(line, index, digits) {
  const quote = line[index - 1];
  return (quote === "'" || quote === '"' || quote === '`') && /^(\d)\1\1$/.test(digits) && line[index + 4] === quote;
}

/** Whether the number at `index` of `line` is a Markdown link to a heading: `](#36-budget-periods)`. */
const isHeadingLink = (line, index, digits) => line.slice(index - 2, index) === '](' && line[index + 1 + digits.length] === '-';

/** Whether the number at `index` of `line` is one of React's error codes: `React error #185`. */
const isErrorCode = (line, index) => /(?<!\w)React error $/.test(line.slice(Math.max(0, index - 13), index));

/** The references and codes in `text`, as { line, column, text }, in the order they appear. */
export function findReferences(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    const at = (m) => found.push({ line: i + 1, column: m.index + 1, text: m[0] });
    for (const m of line.matchAll(NUMBER)) {
      if (!isQuotedGrey(line, m.index, m[1]) && !isHeadingLink(line, m.index, m[1]) && !isErrorCode(line, m.index)) at(m);
    }
    for (const m of line.matchAll(CUED)) at(m);
    for (const m of line.matchAll(NAMED)) at(m);
    for (const m of line.matchAll(LINK)) at(m);
    for (const m of line.matchAll(CODE)) at(m);
  });
  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Whether a tracked file is read: all but every package-lock.json. */
export const isScanned = (file) => basename(file) !== 'package-lock.json';

/** Whether a file's content is binary, as git judges it: a NUL in its first 8000 bytes. */
export const isBinary = (content) => content.subarray(0, 8000).includes(0);

/** Every reference and code in the files git tracks under `root`, as { file, line, column, text }. */
export function referencesIn(root) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const found = [];
  let read = 0;
  for (const file of files.filter(isScanned)) {
    const path = join(root, file);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue; // deleted in the working tree
    }
    if (!stat.isFile()) continue; // a symlink or a submodule
    const content = readFileSync(path);
    if (isBinary(content)) continue;
    read += 1;
    for (const ref of findReferences(content.toString('utf8'))) found.push({ file, ...ref });
  }
  return { found, read };
}

function main() {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  let result;
  try {
    result = referencesIn(root);
  } catch (err) {
    console.log(`::error::git ls-files failed in ${root}; run this in a checkout of the repository (${String(err.message).split('\n')[0]})`);
    process.exit(2);
  }
  const { found, read } = result;
  if (read === 0) {
    console.log(`::error::no tracked file to read in ${root}; run this in a checkout of the repository`);
    process.exit(2);
  }
  // A GitHub annotation in CI; its file= value escapes %, : and , as the command format asks.
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  for (const { file, line, column, text } of found) {
    const where = `${file}:${line}:${column}: cites ${text}`;
    const escaped = file.replaceAll('%', '%25').replaceAll(':', '%3A').replaceAll(',', '%2C');
    console.log(annotate ? `::error file=${escaped},line=${line},col=${column}::${where}` : where);
  }
  if (found.length > 0) {
    const files = new Set(found.map((r) => r.file)).size;
    console.log(
      `\n${found.length} issue or pull request number(s) or audit or requirement code(s) in ${files} file(s). The` +
        ` tree cites none: say what the change does or why, and leave the number or code to the commit message.` +
        ` A colour, a store number, a test's own id or another number that only looks like one:` +
        ` see the top of scripts/check-issue-refs.mjs.`,
    );
    process.exit(1);
  }
  console.log(`No issue or pull request numbers or audit or requirement codes in the ${read} tracked files read (package-lock.json and binary files skipped).`);
}

// Run when invoked, by any path to it: argv keeps a symlink that import.meta.url resolves.
const invoked = (path) => {
  try {
    return realpathSync(resolve(path)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (process.argv[1] && invoked(process.argv[1])) main();
