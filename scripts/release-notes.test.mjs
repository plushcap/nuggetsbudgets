// The cases release-notes.mjs must get right: node --test scripts/release-notes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
  // A bare heading, with no date, and Windows line endings.
  assert.equal(versionSection('## 4.0.0\r\n\r\n- Four.\r\n', '4.0.0'), '- Four.');
});

test('the Unreleased section', () => {
  assert.equal(unreleasedSection(changelog), '### Fixed\n\n- Something not released yet.');
  assert.equal(unreleasedSection('# Changelog\n\n## 1.0.0 (2026-01-01)\n'), null);
});

test('headings move down, not past six, and not inside a code fence', () => {
  assert.equal(demoteHeadings('### Fixed\n\n- x', 1), '#### Fixed\n\n- x');
  assert.equal(demoteHeadings('###### Deep', 2), '###### Deep');
  assert.equal(demoteHeadings('```\n# a comment\n```\n## Real', 1), '```\n# a comment\n```\n### Real');
  // Not a heading: no space after the hashes.
  assert.equal(demoteHeadings('#hashtag', 1), '#hashtag');
});

test('wrapped lines join into one per paragraph; lists, blank lines and code stay apart', () => {
  assert.equal(
    unwrap('- One, which\n  wraps.\n\n  **Upgrading:** do\n  this.\n- Two.\n\n```\nkeep\nthese\n```\n### Head\ntext\nmore'),
    '- One, which wraps.\n\n  **Upgrading:** do this.\n- Two.\n\n```\nkeep\nthese\n```\n### Head\ntext more',
  );
  assert.equal(unwrap('1. first\n2. second\n| a |\n| b |'), '1. first\n2. second\n| a |\n| b |');
});

test("GitHub's list of pull requests loses its own heading and moves down", () => {
  const generated = "## What's Changed\n* A change by someone\n\n## New Contributors\n* Someone\n\n**Full Changelog**: compare";
  assert.equal(pullRequestList(generated), '* A change by someone\n\n#### New Contributors\n* Someone\n\n**Full Changelog**: compare');
  assert.equal(pullRequestList(''), '');
  assert.equal(pullRequestList("## What's Changed\n"), '');
});

test("the part for a version with a section: its entries, then the pull requests", () => {
  const block = releaseNotesBlock(changelog, '3.1.0', "## What's Changed\n* A change");
  assert.equal(
    block,
    [START, '### What changed', '', '#### Security', '', '- One, which wraps onto a second line.', '', '#### Fixed', '', '- Two.',
      '', '### Pull requests', '', '* A change', END].join('\n'),
  );
  // Without a list of pull requests, no heading for one.
  assert.ok(!releaseNotesBlock(changelog, '3.1.0').includes('Pull requests'));
});

test('a release cut before its heading was written takes the Unreleased entries, and says so', () => {
  const block = releaseNotesBlock(changelog, '3.2.0');
  assert.match(block, /no 3\.2\.0 heading yet: these are its Unreleased entries/);
  assert.match(block, /#### Fixed\n\n- Something not released yet\./);
  // With neither, it says the changelog lists nothing, rather than nothing at all.
  assert.match(releaseNotesBlock('# Changelog\n', '9.9.9'), /The changelog lists nothing for 9\.9\.9\./);
});

test('the part goes into a description: over an earlier one, else the old link line, else under the heading', () => {
  const block = `${START}\nnew\n${END}`;
  const existing = `## Nuggets 3.1.0\n\n${START}\nold\n${END}\n\n### Container images\n- one`;
  assert.equal(mergeIntoDescription(existing, block), `## Nuggets 3.1.0\n\n${block}\n\n### Container images\n- one`);
  // Run again, nothing changes.
  assert.equal(mergeIntoDescription(mergeIntoDescription(existing, block), block), mergeIntoDescription(existing, block));
  // The descriptions released before this had a link line.
  const linked = '## Nuggets 3.0.0\n\nWhat changed: [CHANGELOG.md](https://example.invalid/CHANGELOG.md).\n\n### Deploy\nstuff';
  assert.equal(mergeIntoDescription(linked, block), `## Nuggets 3.0.0\n\n${block}\n\n### Deploy\nstuff`);
  // Neither: under the heading.
  assert.equal(mergeIntoDescription('## Nuggets 1.0.0\n\n### Deploy\nstuff', block), `## Nuggets 1.0.0\n\n${block}\n\n### Deploy\nstuff`);
  // No heading, or nothing at all.
  assert.equal(mergeIntoDescription('Some notes.', block), `${block}\n\nSome notes.`);
  assert.equal(mergeIntoDescription('', block), block);
  // A "$" in the part is taken as text, not as a replacement pattern.
  assert.equal(mergeIntoDescription(linked, `${START}\ncosts $& and $1\n${END}`).includes('costs $& and $1'), true);
});

test('the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
  const script = fileURLToPath(new URL('./release-notes.mjs', import.meta.url));
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  writeFileSync(join(dir, 'prs.md'), "## What's Changed\n* A change");
  const block = execFileSync('node', [script, 'block', '3.1.0', join(dir, 'CHANGELOG.md'), join(dir, 'prs.md')], { encoding: 'utf8' });
  assert.equal(block, `${releaseNotesBlock(changelog, '3.1.0', "## What's Changed\n* A change")}\n`);
  writeFileSync(join(dir, 'block.md'), block);
  writeFileSync(join(dir, 'description.md'), '## Nuggets 3.1.0\n\nWhat changed: [CHANGELOG.md](https://example.invalid/x).\n');
  const merged = execFileSync('node', [script, 'merge', join(dir, 'description.md'), join(dir, 'block.md')], { encoding: 'utf8' });
  assert.equal(merged, `## Nuggets 3.1.0\n\n${block.trim()}\n`);
  // A version that isn't one, and a usage mistake, exit 2.
  assert.throws(() => execFileSync('node', [script, 'block', 'v3.1.0', join(dir, 'CHANGELOG.md')], { stdio: 'pipe' }), (err) => err.status === 2);
  assert.throws(() => execFileSync('node', [script, 'nonsense'], { stdio: 'pipe' }), (err) => err.status === 2);
});
