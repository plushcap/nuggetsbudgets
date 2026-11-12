#!/usr/bin/env node
// Checks the built app as browsers get it, after `npm run build`: build/index.html
// loads browser-support.js, copied from public/ as it is, as a classic deferred script ahead
// of the app's module (deferred scripts and modules run in document order), and holds the
// notice the script shows. src/__tests__/browserSupport.test.ts runs the script against the
// source index.html, which Vite rewrites: this is the check of what it wrote.
//
// Usage: node scripts/check-build.mjs [build directory]   (default: build; CI runs it)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(root, process.argv[2] ?? 'build');
const problems = [];

const builtScript = join(build, 'browser-support.js');
if (!existsSync(builtScript)) {
  problems.push(`${builtScript} is missing: public/browser-support.js wasn't copied into the build`);
} else if (!readFileSync(builtScript).equals(readFileSync(join(root, 'public/browser-support.js')))) {
  problems.push(`${builtScript} differs from public/browser-support.js: the build changed it`);
}

const indexPath = join(build, 'index.html');
const html = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
if (!html) problems.push(`${indexPath} is missing: run npm run build first`);
// The page as the browser reads it: a commented-out tag or element isn't there.
const page = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
// Every <script> tag, in document order, with its attributes.
const scripts = [...page.matchAll(/<script\b([^>]*)>/gi)].map((m) => {
  const attributes = m[1];
  const has = (name) => new RegExp(`(?:^|\\s)${name}(?:\\s|=|$)`, 'i').test(attributes);
  const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1] ?? null;
  return { src, module: /\btype\s*=\s*["']?module(?:["'\s]|$)/i.test(attributes), defer: has('defer'), async: has('async') };
});
const support = scripts.findIndex((s) => s.src === '/browser-support.js');
const firstModule = scripts.findIndex((s) => s.module);
if (html && support === -1) problems.push('index.html loads no /browser-support.js');
if (html && firstModule === -1) problems.push("index.html loads no module script: where is the app's entry?");
if (support !== -1) {
  const tag = scripts[support];
  if (tag.module) problems.push('browser-support.js is loaded as a module: a browser too old for the app may not run it');
  if (!tag.defer || tag.async) problems.push('browser-support.js must be deferred (defer, not async), so it runs in document order with the app');
  if (firstModule !== -1 && firstModule < support) problems.push("browser-support.js comes after the app's module script, so it would run after the app starts");
}
for (const id of ['unsupported-browser', 'unsupported-browser-continue', 'root']) {
  if (html && !new RegExp(`\\bid=["']${id}["']`).test(page)) problems.push(`index.html has no element with id="${id}"`);
}

if (problems.length > 0) {
  for (const problem of problems) console.log(`::error file=frontend/build/index.html::${problem}`);
  process.exit(1);
}
console.log(`The build loads browser-support.js before the app's module (${scripts.length} scripts in index.html).`);
