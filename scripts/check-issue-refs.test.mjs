// The cases check-issue-refs.mjs must flag and must leave. Run: node --test scripts/check-issue-refs.test.mjs
// (CI runs it before the check itself, repository-checks.yml). No dependencies.
//
// The check reads this file too, so a reference here is written apart: H is the `#`, D the
// hyphen before a code's number, and a link is split before its host, so the file carries none
// itself.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CODE_FAMILIES, findReferences, isBinary, isScanned } from './check-issue-refs.mjs';

const H = '#';
const D = '-';
const GITHUB = 'github' + '.com';
const ISSUES = 'issues' + '/';
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-issue-refs.mjs');
const flagged = (text) => findReferences(text).map((r) => r.text);

describe('check-issue-refs: what is a reference', () => {
  const REFERENCES = [
    // [text, what it flags]
    [`// Money math is integer cents (${H}312)`, [`${H}312`]],
    [`${H}123 item 4`, [`${H}123`]],
    [`as ${H}123's review found`, [`${H}123`]],
    [`fixed in issue ${H}123 and PR ${H}124.`, [`${H}123`, `${H}124`]],
    [`bundle 4 (${H}321)`, [`${H}321`]],
    [`the upgrade in ${H}341/${H}342`, [`${H}341`, `${H}342`]],
    [`(${H}370, ${H}371)`, [`${H}370`, `${H}371`]],
    [`${H}351 at the start of a line`, [`${H}351`]],
    [`# Fails when (${H}351) in a shell or YAML comment`, [`${H}351`]],
    [`**${H}123**`, [`${H}123`]],
    [`describe('${H}356 drop of the retired schema', () => {`, [`${H}356`]],
    [`RAISE EXCEPTION '${H}335: expected 0'`, [`${H}335`]],
    [`expect(msg).toMatch(/levels 0 to 5 \\(${H}357\\)/)`, [`${H}357`]],
    // In quotes, but not a grey: a number, or a colour that isn't one digit three times.
    [`cases under "${H}338" are the gaps`, [`${H}338`]],
    [`'${H}123'`, [`${H}123`]],
    [`['${H}12', '${H}12345']`, [`${H}12`, `${H}12345`]],
    [`'${H}0000'`, [`${H}0000`]],
    // A grey's digits after a quote, but not a quoted grey: the quote doesn't close on it.
    [`it('${H}444 keeps the lock', () => {`, [`${H}444`]],
    [`"${H}333'`, [`${H}333`]],
    // A grey's digits, but not in quotes.
    [`(${H}555)`, [`${H}555`]],
    [`color: ${H}333;`, [`${H}333`]],
    // Two digits and five: the oldest issues, and the newest this check allows for.
    [`(${H}64)`, [`${H}64`]],
    [`(${H}99999)`, [`${H}99999`]],
    // React's error codes are "error" and the number, lower case, with one space.
    [`Error ${H}185`, [`${H}185`]],
    [`an error, ${H}185`, [`${H}185`]],
    [`fails with error ${H}312`, [`${H}312`]],
    [`see [the issue](${H}312)`, [`${H}312`]],
    [`fixed in (${H}7)`, [`(${H}7`]],
    [`issue ${H}7 and PR ${H}5, pull request ${H}9`, [`issue ${H}7`, `PR ${H}5`, `pull request ${H}9`]],
    [`Issues ${H}4`, [`Issues ${H}4`]],
    [`see ../../${ISSUES}12`, [`../../${ISSUES}12`]],
    [`${GITHUB}/plushcap/nuggetsbudgets/discussions/12`, [`${GITHUB}/plushcap/nuggetsbudgets/discussions/12`]],
    [`${GITHUB}/plushcap/nuggetsbudgets/pulls/12`, [`${GITHUB}/plushcap/nuggetsbudgets/pulls/12`]],
    [`${GITHUB}/plushcap/nuggetsbudgets/commit/abc123f`, [`${GITHUB}/plushcap/nuggetsbudgets/commit/abc123f`]],
    [`api.${GITHUB}/repos/plushcap/nuggetsbudgets/issues/12`, [`${GITHUB}/repos/plushcap/nuggetsbudgets/issues/12`]],
    [`terror ${H}185`, [`${H}185`]],
    // Another repository's form, and links.
    [`see plushcap/nuggetsbudgets${H}123`, [`nuggetsbudgets${H}123`]],
    // The repository's old name is still read.
    [`see Old-Owner/Nuggets${H}123`, [`Nuggets${H}123`]],
    [`https://${GITHUB}/Old-Owner/Nuggets/issues/123`, [`${GITHUB}/Old-Owner/Nuggets/issues/123`]],
    [`nuggets${H}7`, [`nuggets${H}7`]],
    [`https://${GITHUB}/plushcap/nuggetsbudgets/issues/123`, [`${GITHUB}/plushcap/nuggetsbudgets/issues/123`]],
    [`<https://${GITHUB}/someone-else/Nuggets/pull/45/files>`, [`${GITHUB}/someone-else/Nuggets/pull/45`]],
    [`[${H}123](https://${GITHUB}/plushcap/nuggetsbudgets/issues/123)`, [`${H}123`, `${GITHUB}/plushcap/nuggetsbudgets/issues/123`]],
  ];
  for (const [text, expected] of REFERENCES) {
    it(`flags ${JSON.stringify(text)}`, () => assert.deepEqual(flagged(text), expected));
  }

  const NOT_REFERENCES = [
    // Colours: a grey in quotes, six or eight digits, hex letters.
    `probe.fillStyle = '#000';`,
    `<path fill="#999" />`,
    "theme === 'dark' ? `#000` : '#fff'",
    `{ text: { fill: '#333' } }`,
    `--gray-a1: #00000000;`,
    `background-color: #111827;`,
    `2025-06-30,cart,#336699,active`,
    `color: '#123456'`,
    `#1a2b3c and #fff`,
    // HTML entities, URL fragments, anchors.
    `it&#39;s &#123;`,
    `ARCHITECTURE.md#36-budget-periods`,
    `https://example.com/page#123`,
    `see [the model](#8-shared-household-model) and [periods](#36-budget-periods)`,
    `file.ts#L42 and #section`,
    // Shebangs, headings, shell, Postgres, printf, regexes.
    `#!/usr/bin/env node`,
    `## 3.6 Budget periods`,
    `# Title`,
    `[ $# -eq 0 ] && echo "\${#arr[@]}"`,
    `data #>> '{a,b}', data #- '{a}'`,
    `printf '%#x %#08x'`,
    `/#\\d+/ and [#0-9] and [^#0-9]`,
    // A position in a list, or a numbered thing: one digit.
    `finding #3, step #2`,
    `**Organization #1** and **Tenant #1** (in Org #1)`,
    `the #1 recurring bug`,
    // React's error codes.
    `an effect that sets state from it loops (React error #185).`,
    `until React gives up (React error #185, "Maximum update depth exceeded")`,
    // An identifier, a word run on.
    `C#7, #123abc, #12_x`,
    // Nuggets as a word, and a link that isn't an issue's or a pull request's.
    `Nuggets #1 and Nuggets#x`,
    `https://${GITHUB}/plushcap/nuggetsbudgets/issues and /releases/tag/v3.0.0`,
  ];
  for (const text of NOT_REFERENCES) {
    it(`leaves ${JSON.stringify(text)}`, () => assert.deepEqual(flagged(text), []));
  }

  it('gives each reference its line and column', () => {
    assert.deepEqual(findReferences(`one\ntwo (${H}12) and ${H}34\r\nthree ${H}56`), [
      { line: 2, column: 6, text: `${H}12` },
      { line: 2, column: 15, text: `${H}34` },
      { line: 3, column: 7, text: `${H}56` },
    ]);
  });
});

describe('check-issue-refs: what is an audit or requirement code', () => {
  const CODES = [
    // [text, what it flags]: each family, in the places the tree had them.
    [`// The passkeys go with them (SEC-AUTH${D}9): one someone else enrolled`, [`SEC-AUTH${D}9`]],
    [` * What a request line may say (SEC-INPUT${D}15 / OPS${D}24).`, [`SEC-INPUT${D}15`, `OPS${D}24`]],
    [`describeDb('Index hygiene (DB${D}24)', () => {`, [`DB${D}24`]],
    [` * MONEY${D}8: the lot a loss was sold from is never its own replacement`, [`MONEY${D}8`]],
    [` * /api/goals through the real app under RLS (TEST${D}17): creating, listing`, [`TEST${D}17`]],
    [`  // Detail-page summaries, one request each (FE${D}22).`, [`FE${D}22`]],
    [` * The transactions domain (ARCH${D}9): what the routes call`, [`ARCH${D}9`]],
    [` * truly what it did (TENANCY${D}16(c)).`, [`TENANCY${D}16`]],
    [`  /** Spinoff (FR-CA${D}003): allocate basis to a new security. */`, [`FR-CA${D}003`]],
    [` * Pure, DB-free look-through aggregation (BRD §6.12, FR-COMP${D}004/007).`, [`FR-COMP${D}004`]],
    [` * Wash-sale detection (BRD §6.7, FR-WS${D}001..004).`, [`FR-WS${D}001`]],
    [`(FR-FEE${D}006) (FR-HIST${D}008) (FR-AI${D}001) (FR-REC${D}001)`, [`FR-FEE${D}006`, `FR-HIST${D}008`, `FR-AI${D}001`, `FR-REC${D}001`]],
    [`- **FR-SWITCH${D}4** — A Deployment Admin can enter any organization`, [`FR-SWITCH${D}4`]],
    [`**FR-TADMIN${D}4** and **FR-TADMIN${D}5**, (FR-DADMIN${D}7), FR-OADMIN${D}5, FR-USER${D}4`, [`FR-TADMIN${D}4`, `FR-TADMIN${D}5`, `FR-DADMIN${D}7`, `FR-OADMIN${D}5`, `FR-USER${D}4`]],
    [`description: 'Aggregate explicit fees paid by fee_type (RR${D}026).',`, [`RR${D}026`]],
    [` * Default thresholds (MR${D}015) live here; any error rolls back all — MR${D}003).`, [`MR${D}015`, `MR${D}003`]],
    [` * The API client calls only the API's own routes (SEC-AUTH${D}8/18):`, [`SEC-AUTH${D}8`]],
    [`MONEY${D}9 at the start of a line`, [`MONEY${D}9`]],
    [`it('loads the baseline (DB${D}8)', async () => {`, [`DB${D}8`]],
  ];
  for (const [text, expected] of CODES) {
    it(`flags ${JSON.stringify(text)}`, () => assert.deepEqual(flagged(text), expected));
  }

  it('reads each family with a number after it', () => {
    const families = ['SEC-AUTH', 'SEC-INPUT', 'OPS', 'DB', 'MONEY', 'TEST', 'FE', 'ARCH', 'TENANCY', 'FR-CA', 'FR-TADMIN', 'RR', 'MR'];
    for (const family of families) {
      assert.deepEqual(flagged(`(${family}${D}12)`), [`${family}${D}12`], family);
      assert.deepEqual(flagged(`(${family})`), [], family);
    }
    assert.deepEqual(CODE_FAMILIES, ['SEC-AUTH', 'SEC-INPUT', 'OPS', 'DB', 'MONEY', 'TEST', 'FE', 'ARCH', 'TENANCY', 'FR-[A-Z]+', 'RR', 'MR']);
  });

  const NOT_CODES = [
    // Identifiers and standards.
    `UTF-8, SHA-256, AES-256-GCM, SCRAM-SHA-256, ISO-8601, PDF-1.4, RFC-4180, CRC-32, ECMA-402`,
    `UTC-5 and GMT-0500, DNS-01 and HTTP-01, P-256, CVE-2025-8714, NIST SP 800-63B`,
    // A test's own ids: values it sends or stores.
    `{ conn_id: 'CON-1', org_id: 'ORG-1' }, 'CONN-1', 'ACT-1', 'OWN-1', 'TIP-1-a'`,
    `external_reference: 'TX-1', 'TXN-42', 'HIST-1', 'POSTED-1', 'NOOP-1', 'PENDING-1', 'CONF-12345'`,
    `external_reference: 'WA-FEE-1'`,
    // Months and periods back from today in a test's notes.
    `on the 10th of M-2: E-3, E-2, E-1 and today; P-1 and P0`,
    // A family's name alone, or in a word.
    `DB-backed tests, a DB-free module, MCP-layer failures, the FR-SWITCH section, SEC-AUTH`,
    // Run on from a word or another hyphen, or into a word.
    `MONGODB-15, NFR-1, LOAD-TEST-2, X-DB-1, FEE-1, DB-15a`,
    // Not in capitals.
    `fixtures/test-17.json, db-15, ops-22`,
    // Written apart, as a test value under one of the prefixes is.
    `'DB-' + '1'`,
  ];
  for (const text of NOT_CODES) {
    it(`leaves ${JSON.stringify(text)}`, () => assert.deepEqual(flagged(text), []));
  }

  it('gives each code its line and column, among the numbers', () => {
    assert.deepEqual(findReferences(`one (DB${D}15)\ntwo (${H}12) and FR-CA${D}003`), [
      { line: 1, column: 6, text: `DB${D}15` },
      { line: 2, column: 6, text: `${H}12` },
      { line: 2, column: 15, text: `FR-CA${D}003` },
    ]);
  });
});

describe('check-issue-refs: the files it reads', () => {
  it('skips every package-lock.json, and nothing else', () => {
    for (const file of ['package-lock.json', 'frontend/static-server/package-lock.json']) {
      assert.equal(isScanned(file), false, file);
    }
    for (const file of ['CHANGELOG.md', 'docs/history/2026-bundles.md', 'README.md', 'package.json', 'package-lock.json.bak', 'scripts/check-issue-refs.mjs']) {
      assert.equal(isScanned(file), true, file);
    }
  });

  it('takes a NUL in the first 8000 bytes for binary', () => {
    assert.equal(isBinary(Buffer.from(`PNG\0 ${H}123`)), true);
    assert.equal(isBinary(Buffer.from(`text ${H}123`)), false);
    assert.equal(isBinary(Buffer.concat([Buffer.alloc(8000, 'a'), Buffer.from('\0')])), false);
  });
});

describe('check-issue-refs: run on a checkout', () => {
  let repo;
  // A git of its own: no user or system settings reach it.
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const write = (file, text) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  };
  const git = (...args) => {
    const run = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  };
  const check = () => spawnSync(process.execPath, [SCRIPT, repo], { env, encoding: 'utf8' });

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'issue-refs-'));
    git('init', '-q');
    write('README.md', `# Nuggets\n\nA colour '#000', a list's finding #3.\n`);
    write('src/a.ts', `const x = 1;\n// cents (${H}312)\n`);
    write('src/b.ts', `// The settings registry (ARCH${D}20)\nconst utf = 'UTF-8';\n`);
    write('package-lock.json', `{ "x": "${H}123" }\n`);
    write('sub/package-lock.json', `{ "x": "${H}123" }\n`);
    write('logo.png', `PNG\0 ${H}123\n`);
    git('add', '.');
    write('untracked.md', `(${H}700)\n`);
  });

  after(() => rmSync(repo, { recursive: true, force: true }));

  it('fails on the tracked text files, naming the file and line', () => {
    const run = check();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    const lines = run.stdout.split('\n').filter((l) => l.includes(': cites '));
    assert.deepEqual(lines.map((l) => l.replace(/^::error [^:]*::/, '')), [`src/a.ts:2:11: cites ${H}312`, `src/b.ts:1:27: cites ARCH${D}20`]);
    assert.match(run.stdout, /2 issue or pull request number\(s\) or audit or requirement code\(s\) in 2 file\(s\)/);
  });

  it('passes once the reference and the code are gone', () => {
    write('src/a.ts', `const x = 1;\n// Money math is integer cents\n`);
    write('src/b.ts', `// The settings registry\nconst utf = 'UTF-8';\n`);
    const run = check();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /No issue or pull request numbers or audit or requirement codes in the 3 tracked files read/);
  });

  it('refuses a directory that is not a checkout', () => {
    const empty = mkdtempSync(join(tmpdir(), 'issue-refs-none-'));
    try {
      const run = spawnSync(process.execPath, [SCRIPT, empty], { env: { ...env, GIT_CEILING_DIRECTORIES: tmpdir() }, encoding: 'utf8' });
      assert.equal(run.status, 2, run.stdout + run.stderr);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
