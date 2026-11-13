// The cases release-notes.mjs must get right: node --test scripts/release-notes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  END,
  START,
  demoteHeadings,
  mergeIntoDescription,
  pullRequestList,
  releaseNotesBlock,
  unreleasedSection,
  unwrap,
  versionSection,
} from './release-notes.mjs';

const changelog = `# Changelog

Notable changes, newest first.

## Unreleased

### Fixed

- Something not released yet.

## 3.10.0 (2026-12-01)

### Changed

- Ten.

## 3.1.0 (2026-11-13)

### Security

- One, which
  wraps onto a second line.

### Fixed

- Two.

## 3.0.0 (2026-11-12)

The first public release.

### Fixed

- Three.
`;

test("a version's section is the text under its heading, up to the next", () => {
  assert.equal(versionSection(changelog, '3.1.0'), '### Security\n\n- One, which\n  wraps onto a second line.\n\n### Fixed\n\n- Two.');
  // The last section runs to the end of the file.
  assert.equal(versionSection(changelog, '3.0.0'), 'The first public release.\n\n### Fixed\n\n- Three.');
  // 3.1.0 is not 3.10.0, nor a dot any character.
  assert.equal(versionSection(changelog, '3.10.0'), '### Changed\n\n- Ten.');
  assert.equal(versionSection(changelog, '3x1x0'), null);
  assert.equal(versionSection(changelog, '3.2.0'), null);
  // "## X.Y.Z (date)", as cut-release.yml looks for it; Windows line endings.
  assert.equal(versionSection('## 4.0.0 (2026-01-01)\r\n\r\n- Four.\r\n', '4.0.0'), '- Four.');
  assert.equal(versionSection('## 4.0.0\n\n- Four.\n', '4.0.0'), null);
});

test('a heading inside a code fence is code: it neither starts nor ends a section', () => {
  const fenced = '## 2.0.0 (2026-02-01)\n\n- An example:\n\n```md\n## Old heading\n## 1.0.0 (2026-01-01)\n```\n\n- After it.\n\n~~~\n## Unreleased\n~~~\n\n## 1.0.0 (2026-01-01)\n\n- The real one.\n';
  assert.equal(versionSection(fenced, '2.0.0'), '- An example:\n\n```md\n## Old heading\n## 1.0.0 (2026-01-01)\n```\n\n- After it.\n\n~~~\n## Unreleased\n~~~');
  assert.equal(versionSection(fenced, '1.0.0'), '- The real one.');
  assert.equal(unreleasedSection(fenced), null);
});

test('the Unreleased section', () => {
  assert.equal(unreleasedSection(changelog), '### Fixed\n\n- Something not released yet.');
  assert.equal(unreleasedSection('# Changelog\n\n## 1.0.0 (2026-01-01)\n'), null);
});

test('headings move down, not past six, and not inside a code fence', () => {
  assert.equal(demoteHeadings('### Fixed\n\n- x', 1), '#### Fixed\n\n- x');
  assert.equal(demoteHeadings('###### Deep', 2), '###### Deep');
  assert.equal(demoteHeadings('```\n# a comment\n```\n## Real', 1), '```\n# a comment\n```\n### Real');
  assert.equal(demoteHeadings('~~~\n# a comment\n~~~\n## Real', 1), '~~~\n# a comment\n~~~\n### Real');
  // A longer fence holds a shorter one.
  assert.equal(demoteHeadings('````\n```\n# a comment\n```\n````\n## Real', 1), '````\n```\n# a comment\n```\n````\n### Real');
  // Not a heading: no space after the hashes.
  assert.equal(demoteHeadings('#hashtag', 1), '#hashtag');
});

test('wrapped lines join into one per paragraph; whatever else is in the way keeps its line', () => {
  assert.equal(
    unwrap('- One, which\n  wraps.\n\n  **Upgrading:** do\n  this.\n- Two.\n\n```\nkeep\nthese\n```\n### Head\ntext\nmore'),
    '- One, which wraps.\n\n  **Upgrading:** do this.\n- Two.\n\n```\nkeep\nthese\n```\n### Head\ntext more',
  );
  const kept = [
    '1. first\n2. second',
    '| a |\n| b |',
    'a | b\n--|--',
    'text\n\n    code1\n    code2',
    '~~~\nkeep\nthese\n~~~',
    'Title\n---',
    'Title\n===',
    'a hard break  \nnext',
    'a hard break\\\nnext',
    'text\n<details>',
    'text\n> quoted',
    '- item\n    nested continuation',
  ];
  for (const text of kept) assert.equal(unwrap(text), text, JSON.stringify(text));
});

test("GitHub's list of pull requests loses its own heading and comment, and moves down", () => {
  const generated = "## What's Changed\n* A change by someone\n\n## New Contributors\n* Someone\n\n**Full Changelog**: compare";
  assert.equal(pullRequestList(generated), '* A change by someone\n\n#### New Contributors\n* Someone\n\n**Full Changelog**: compare');
  assert.equal(pullRequestList(`<!-- Release notes generated using configuration in .github/release.yml -->\n\n${generated}`), pullRequestList(generated));
  // None: it says so, and keeps the comparison link.
  assert.equal(pullRequestList('**Full Changelog**: compare'), 'None.\n\n**Full Changelog**: compare');
  assert.equal(pullRequestList(''), null);
  assert.equal(pullRequestList("## What's Changed\n"), null);
});

test('the part for a version with a section: its entries, then the pull requests', () => {
  const block = releaseNotesBlock(changelog, '3.1.0', "## What's Changed\n* A change");
  assert.equal(
    block,
    [START, '### What changed', '', '#### Security', '', '- One, which wraps onto a second line.', '', '#### Fixed', '', '- Two.',
      '', '### Pull requests', '', '* A change', END].join('\n'),
  );
  // Without a list of pull requests, no heading for one.
  assert.ok(!releaseNotesBlock(changelog, '3.1.0').includes('Pull requests'));
});

test('a release cut before its heading was written takes the Unreleased entries, and says so; strict refuses', () => {
  const block = releaseNotesBlock(changelog, '3.2.0');
  assert.match(block, /no 3\.2\.0 heading yet: these are its Unreleased entries/);
  assert.match(block, /#### Fixed\n\n- Something not released yet\./);
  // A changelog read after the tag (main's) has later entries under Unreleased.
  assert.equal(releaseNotesBlock(changelog, '3.2.0', '', { strict: true }), null);
  assert.notEqual(releaseNotesBlock(changelog, '3.1.0', '', { strict: true }), null);
  // With neither, it says the changelog lists nothing, rather than nothing at all.
  assert.match(releaseNotesBlock('# Changelog\n', '9.9.9'), /The changelog lists nothing for 9\.9\.9\./);
});

test("a marker in the changelog's text can't end the part early, run after run", () => {
  const tricky = `## 5.0.0 (2026-01-01)\n\n- Writes \`${END}\` and \`${START}\` into descriptions.\n- Second entry.\n`;
  const block = releaseNotesBlock(tricky, '5.0.0');
  assert.equal(block.split(END).length, 2);
  assert.equal(block.split(START).length, 2);
  let description = '## Nuggets 5.0.0\n\nWhat changed: [CHANGELOG.md](https://example.invalid/c).\n\n### Deploy\nstuff';
  const once = mergeIntoDescription(description, block);
  for (let run = 0; run < 3; run++) description = mergeIntoDescription(description, block);
  assert.equal(description, once);
  assert.equal(description.split('Second entry').length, 2);
  assert.match(description, /### Deploy\nstuff$/);
});

test('a description too long for GitHub links to the changelog instead', () => {
  const long = `## 6.0.0 (2026-01-01)\n\n${'- An entry.\n'.repeat(12_000)}`;
  const block = releaseNotesBlock(long, '6.0.0');
  assert.ok(block.length < 1000);
  assert.match(block, /Too long for this description: see 6\.0\.0 in CHANGELOG\.md/);
});

test('the part goes into a description: over an earlier one, else the old link line, else under the heading', () => {
  const block = `${START}\nnew\n${END}`;
  const existing = `## Nuggets 3.1.0\n\n${START}\nold\n${END}\n\n### Container images\n- one`;
  assert.equal(mergeIntoDescription(existing, block), `## Nuggets 3.1.0\n\n${block}\n\n### Container images\n- one`);
  // Run again, nothing changes.
  assert.equal(mergeIntoDescription(mergeIntoDescription(existing, block), block), mergeIntoDescription(existing, block));
  // The descriptions released before this had a link line: the part takes its place, and the
  // link stays under it, as a new release has it.
  const linked = '## Nuggets 3.0.0\n\nWhat changed: [CHANGELOG.md](https://example.invalid/CHANGELOG.md).\n\n### Deploy\nstuff';
  const merged = mergeIntoDescription(linked, block);
  assert.equal(merged, `## Nuggets 3.0.0\n\n${block}\n\nEvery release: [CHANGELOG.md](https://example.invalid/CHANGELOG.md).\n\n### Deploy\nstuff`);
  assert.equal(mergeIntoDescription(merged, block), merged);
  // Neither: under the heading.
  assert.equal(mergeIntoDescription('## Nuggets 1.0.0\n\n### Deploy\nstuff', block), `## Nuggets 1.0.0\n\n${block}\n\n### Deploy\nstuff`);
  // No heading, or nothing at all.
  assert.equal(mergeIntoDescription('Some notes.', block), `${block}\n\nSome notes.`);
  assert.equal(mergeIntoDescription('', block), block);
  // A "$" in the part is taken as text, not as a replacement pattern.
  assert.equal(mergeIntoDescription(linked, `${START}\ncosts $& and $1\n${END}`).includes('costs $& and $1'), true);
});

test('the command line, through a symlink too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
  const script = fileURLToPath(new URL('./release-notes.mjs', import.meta.url));
  const linkedScript = join(dir, 'linked-release-notes.mjs');
  symlinkSync(script, linkedScript);
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  writeFileSync(join(dir, 'prs.md'), "## What's Changed\n* A change");
  for (const path of [script, linkedScript]) {
    const block = execFileSync('node', [path, 'block', '3.1.0', join(dir, 'CHANGELOG.md'), join(dir, 'prs.md')], { encoding: 'utf8' });
    assert.equal(block, `${releaseNotesBlock(changelog, '3.1.0', "## What's Changed\n* A change")}\n`, path);
  }
  const block = execFileSync('node', [script, 'block', '3.1.0', join(dir, 'CHANGELOG.md'), '--strict'], { encoding: 'utf8' });
  writeFileSync(join(dir, 'block.md'), block);
  writeFileSync(join(dir, 'description.md'), '## Nuggets 3.1.0\n\nWhat changed: [CHANGELOG.md](https://example.invalid/x).\n');
  const merged = execFileSync('node', [script, 'merge', join(dir, 'description.md'), join(dir, 'block.md')], { encoding: 'utf8' });
  assert.equal(merged, `## Nuggets 3.1.0\n\n${block.trim()}\n\nEvery release: [CHANGELOG.md](https://example.invalid/x).\n`);
  const status = (args) => {
    try {
      execFileSync('node', [script, ...args], { stdio: 'pipe' });
      return 0;
    } catch (err) {
      return err.status;
    }
  };
  // Strict, with no heading for the version: refused.
  assert.equal(status(['block', '3.2.0', join(dir, 'CHANGELOG.md'), '--strict']), 3);
  // Merging something that isn't a part this script wrote (an empty file): refused.
  writeFileSync(join(dir, 'empty.md'), '');
  assert.equal(status(['merge', join(dir, 'description.md'), join(dir, 'empty.md')]), 3);
  // A version that isn't one, and a usage mistake.
  assert.equal(status(['block', 'v3.1.0', join(dir, 'CHANGELOG.md')]), 2);
  assert.equal(status(['nonsense']), 2);
});
