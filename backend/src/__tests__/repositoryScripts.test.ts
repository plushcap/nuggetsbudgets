import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The repository checks CI runs on every pull request (repository-checks.yml):
 * - check-doc-versions skipped any version followed by 's, so a doc naming a version not in
 *   use passed when it said "Node 24's runtime"; "Node 22's npm" (a version's own thing) passes;
 * - list-new-gitleaks-allows missed a file whose name git quotes in a diff (non-ASCII, a tab).
 */

// The tests run from backend/.
const SCRIPTS = path.resolve(process.cwd(), '..', 'scripts');

interface Mentions {
  MENTIONS: Array<[string, RegExp]>;
  versionsStated: (text: string, re: RegExp) => Array<{ value: string; line: number }>;
  namesOwnThing: (after: string) => boolean;
}

describe('check-doc-versions: a version followed by its possessive', () => {
  let mentions: Mentions;
  beforeAll(async () => {
    const at = path.join(SCRIPTS, 'docVersionMentions.mjs');
    mentions = (await import(at)) as Mentions;
  });
  const node = () => mentions.MENTIONS.find(([tech]) => tech === 'node')![1];
  const stated = (text: string) => mentions.versionsStated(text, node()).map((m) => m.value);

  it("checks a possessive that states the version: its runtime, its image", () => {
    expect(stated("The backend runs on Node 24's runtime.")).toEqual(['24']);
    expect(stated("Build with Node 24's image")).toEqual(['24']);
    expect(stated('Node 24’s runtime')).toEqual(['24']);
  });

  it("skips a version's own thing: the npm it comes with, and one named just before it", () => {
    expect(stated("don't write the lockfile with Node 22's npm")).toEqual([]);
    expect(stated("an older\nnpm (npm 10, Node 22's, crashed on the old links)")).toEqual([]);
    expect(stated("with Node 26's npm (11), as CI's npm ci does")).toEqual([]);
    expect(stated("Node 22's\nnpm")).toEqual([]);
    expect(mentions.namesOwnThing("'s shorthand")).toBe(true);
    expect(mentions.namesOwnThing("'s text-sm")).toBe(true);
  });

  it('still reads a plain mention, and leaves a list number alone', () => {
    expect(stated('Requires Node 26 and npm 11.')).toEqual(['26']);
    expect(stated('Install Node.js\n1. Run it')).toEqual([]);
  });

  it('passes on the repository as it is', () => {
    const run = spawnSync(process.execPath, [path.join(SCRIPTS, 'check-doc-versions.mjs')], { encoding: 'utf8' });
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });
});

describe('list-new-gitleaks-allows: a file git quotes the name of', () => {
  let repo: string;
  // A git of its own: no user or system settings (signing, hooks) reach it.
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: tmpdir(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  // Built in two parts, as the script builds it, so this file's own lines don't carry it.
  const marker = 'gitleaks:' + 'allow';

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'gitleaks-allows-'));
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'README.md'), 'base\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    for (const name of ['plain.txt', 'café.txt', 'tab\there.txt', 'quote"d.txt']) {
      writeFileSync(path.join(repo, name), `first\ntoken = "made-up" # ${marker}\n`);
    }
    git('add', '.');
    git('commit', '-q', '-m', 'head');
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('lists the marked line of every file, whatever its name', () => {
    const run = spawnSync('bash', [path.join(SCRIPTS, 'list-new-gitleaks-allows.sh'), 'HEAD~1', 'HEAD'], { cwd: repo, env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const warnings = run.stdout.split('\n').filter((l) => l.startsWith('::warning'));
    expect(warnings.map((w) => w.replace(/::This line.*$/, '')).sort()).toEqual([
      '::warning file=café.txt,line=2',
      '::warning file=plain.txt,line=2',
      '::warning file=quote"d.txt,line=2',
      '::warning file=tab\there.txt,line=2',
    ]);
    expect(run.stdout).toContain('4 new line(s) carry');
  });
});
