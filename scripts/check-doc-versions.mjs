#!/usr/bin/env node
// Fails when a version the docs or the scripts state (Node.js, PostgreSQL, React, Vite,
// React Router, Tailwind CSS, Express, the supported browsers) differs from the files that
// set it: package.json, .nvmrc, the Dockerfiles, the compose files, the CI workflows and the
// Vite build target. It also fails when those files disagree with each other (Node 26
// in .nvmrc, but node:24 in a Dockerfile).
//
// It reads every tracked Markdown file and script (*.md, *.sh, *.mjs, *.cjs) but CHANGELOG.md
// and the ADRs, which record history, should they come back (it once read only four docs,
// and CLAUDE.md and the scripts drifted unseen). A version followed by 's and the npm it comes with, or Tailwind's shorthand
// or class names, names that version's own thing ("Tailwind 3's shorthand", "Node 22's npm")
// and isn't checked; any other possessive is. CI runs it on every pull request, a
// Markdown-only one too (repository-checks.yml).
//
// A version change: update the files below together, then the docs this names. CLAUDE.md
// failing to state a version it is expected to state fails too, so the check can't pass by
// matching nothing; change EXPECTED_IN_ANCHOR with it.
//
// Usage: node scripts/check-doc-versions.mjs   (no dependencies; any Node from 20 on)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MENTIONS, versionsStated } from './docVersionMentions.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));

/** The files whose stated versions are checked. CHANGELOG.md and the ADRs record history. */
const DOCS = execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.sh', '*.mjs', '*.cjs'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((file) => file !== '' && file !== 'CHANGELOG.md' && !file.startsWith('docs/adr/'));
/** The doc that must state versions; the project's other docs are kept outside the repository. */
const ANCHOR = 'CLAUDE.md';
if (!DOCS.includes(ANCHOR)) {
  console.log(`::error::git ls-files listed no ${ANCHOR}; run this in a checkout of the repository`);
  process.exit(2);
}

/** What CLAUDE.md must state, so a reworded line can't make the check pass by matching nothing. */
const EXPECTED_IN_ANCHOR = ['node', 'postgres', 'react'];

const errors = [];
const fail = (message, file, line) => {
  const where = file ? ` file=${file}${line ? `,line=${line}` : ''}` : '';
  errors.push(`::error${where}::${message}`);
};

/** The major version of a package.json range: "^19.3.1" → "19", ">=26" → "26". */
function majorOf(range, label) {
  const m = /^\s*(?:\^|~|>=|=|v)?\s*(\d+)(?:\.|$|\s|-)/.exec(String(range ?? ''));
  if (!m) {
    fail(`${label}: can't read a major version from "${range}"`);
    return undefined;
  }
  return m[1];
}

/** Every match of `re` (global) in a file, as { value, line }. */
function matchesIn(file, re, group = 1) {
  const text = read(file);
  const found = [];
  for (const m of text.matchAll(re)) {
    found.push({ value: m[group], line: text.slice(0, m.index).split('\n').length });
  }
  return found;
}

// --- What the repository sets -------------------------------------------------------------

const PACKAGES = ['package.json', 'shared/package.json', 'mcp/package.json', 'backend/package.json', 'frontend/package.json', 'e2e/package.json'];
const DOCKERFILES = ['Dockerfile.postgres', 'backend/Dockerfile.dev', 'backend/Dockerfile.prod', 'frontend/Dockerfile.dev', 'frontend/Dockerfile.prod'];
const COMPOSE = ['docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.portainer.yml'];
const WORKFLOWS = ['.github/workflows/ci-cd.yml', '.github/workflows/docker-images.yml'];

/** tech → [{ value, source }] */
const actual = new Map();
const set = (tech, value, source) => {
  if (value === undefined) return;
  if (!actual.has(tech)) actual.set(tech, []);
  actual.get(tech).push({ value, source });
};

set('node', majorOf(read('.nvmrc').trim(), '.nvmrc'), '.nvmrc');
for (const file of PACKAGES) {
  const pkg = json(file);
  if (pkg.engines?.node) set('node', majorOf(pkg.engines.node, `${file} engines.node`), `${file} (engines.node ${pkg.engines.node})`);
  const types = pkg.devDependencies?.['@types/node'];
  if (types) set('node', majorOf(types, `${file} @types/node`), `${file} (@types/node ${types})`);
}
for (const file of [...DOCKERFILES, ...COMPOSE, ...WORKFLOWS]) {
  for (const { value, line } of matchesIn(file, /^\s*FROM\s+(?:--\S+\s+)*node:(\d+)/gm)) set('node', value, `${file}:${line}`);
  for (const { value, line } of matchesIn(file, /^\s*node-version:\s*['"]?(\d+)/gm)) set('node', value, `${file}:${line}`);
  for (const { value, line } of matchesIn(file, /(?:^\s*FROM\s+(?:--\S+\s+)*|^\s*image:\s*)postgres:(\d+)/gm)) set('postgres', value, `${file}:${line}`);
  for (const { value, line } of matchesIn(file, /postgresql-client-(\d+)/g)) set('postgres', value, `${file}:${line}`);
}

const frontend = json('frontend/package.json');
const frontendDeps = { ...frontend.dependencies, ...frontend.devDependencies };
const backendDeps = json('backend/package.json').dependencies;
const fromPackage = (tech, deps, name, file) => {
  if (!deps?.[name]) fail(`${file} no longer lists ${name}; update scripts/check-doc-versions.mjs`, file);
  else set(tech, majorOf(deps[name], `${file} ${name}`), `${file} (${name} ${deps[name]})`);
};
fromPackage('react', frontendDeps, 'react', 'frontend/package.json');
fromPackage('react-router', frontendDeps, frontendDeps['react-router-dom'] ? 'react-router-dom' : 'react-router', 'frontend/package.json');
fromPackage('vite', frontendDeps, 'vite', 'frontend/package.json');
fromPackage('tailwind', frontendDeps, 'tailwindcss', 'frontend/package.json');
fromPackage('express', backendDeps, 'express', 'backend/package.json');

// The browsers the build targets: build.target in frontend/vite.config.ts.
{
  const targets = matchesIn('frontend/vite.config.ts', /\btarget:\s*\[([^\]]*)\]/g);
  if (targets.length !== 1) {
    fail(`expected one build target list in frontend/vite.config.ts, found ${targets.length}; update scripts/check-doc-versions.mjs`, 'frontend/vite.config.ts');
  } else {
    const where = `frontend/vite.config.ts:${targets[0].line}`;
    const listed = new Map([...targets[0].value.matchAll(/['"]([a-z]+)(\d+(?:\.\d+)?)['"]/g)].map((m) => [m[1], m[2]]));
    for (const [browser, tech] of [['chrome', 'chrome'], ['edge', 'edge'], ['firefox', 'firefox'], ['safari', 'safari'], ['ios', 'safari']]) {
      if (!listed.has(browser)) fail(`frontend/vite.config.ts's build target has no ${browser}; update scripts/check-doc-versions.mjs`, 'frontend/vite.config.ts', targets[0].line);
      else set(tech, listed.get(browser), `${where} (${browser}${listed.get(browser)})`);
    }
  }
}

// The files that set one version must agree before the docs can match them. The docs are
// compared with the version most of them have, and the others are named.
const expectedOf = new Map();
for (const [tech, values] of actual) {
  const counts = new Map();
  for (const { value } of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const [majority] = [...counts].sort((a, b) => b[1] - a[1])[0];
  const agreeing = values.filter((v) => v.value === majority);
  expectedOf.set(tech, agreeing[0]);
  const others = values.filter((v) => v.value !== majority);
  if (others.length > 0) {
    fail(`the files that set ${tech}'s version disagree: ${others.map((v) => `${v.value} in ${v.source}`).join('; ')}, but ${majority} in ${agreeing.length} others (${agreeing[0].source}, …)`);
  }
}

// --- What the docs state ------------------------------------------------------------------

// The mentions, and how one is read (a list item's number, a version's own thing), are in
// docVersionMentions.mjs, which its tests import.

/** The mentions of `re` in `file` that state a version in use, as { value, line }. */
const statedIn = (file, re) => versionsStated(read(file), re);

const statedInAnchor = new Set();
for (const doc of DOCS) {
  for (const [tech, re] of MENTIONS) {
    for (const { value, line } of statedIn(doc, re)) {
      if (doc === ANCHOR) statedInAnchor.add(tech);
      const expected = expectedOf.get(tech);
      if (!expected) continue;
      if (value !== expected.value) {
        fail(`${doc}:${line} says ${tech} ${value}, but ${expected.source} has ${expected.value}`, doc, line);
      }
    }
  }
}
for (const tech of EXPECTED_IN_ANCHOR) {
  if (!statedInAnchor.has(tech)) {
    fail(`${ANCHOR} no longer states ${tech}'s version; update EXPECTED_IN_ANCHOR in scripts/check-doc-versions.mjs if that's intended`, ANCHOR);
  }
}

if (errors.length > 0) {
  console.log(errors.join('\n'));
  console.log(`\n${errors.length} version problem(s). The docs state the versions the packages, images and workflows use.`);
  process.exit(1);
}
const summary = [...expectedOf].map(([tech, { value }]) => `${tech} ${value}`).join(', ');
console.log(`The docs' versions match the repository: ${summary}.`);
