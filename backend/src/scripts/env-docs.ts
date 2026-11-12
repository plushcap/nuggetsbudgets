/**
 * The deployment docs' settings table, from config.ts: `npm run docs:env` prints it, and
 * `npm run docs:env -- <file>` writes it into that Markdown file between the env-table
 * markers below (the docs are kept outside this repository).
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { getDirname } from '../utils/esm-compat.js';
import { settingsMarkdown, type ComposeEnvEntry } from '../config.js';

export const ENV_TABLE_START = '<!-- env-table:start (generated from backend/src/config.ts by `npm run docs:env`; do not edit) -->';
export const ENV_TABLE_END = '<!-- env-table:end -->';

/**
 * The `backend` service's `environment:` block: each variable it names, with the stack
 * variables its value reads (`CLIENT_URL: ${CLIENT_URL:-${DOMAIN_URL}}` reads both names;
 * `NODE_ENV: production` reads none). A container gets only the
 * variables its block names, so setting any other in the stack changes nothing for the
 * backend. Reads the file's layout (two-space indents, the block as a map) rather than
 * parsing YAML, and throws when it can't find the block, so a reshaped file fails the docs
 * check instead of reading as empty.
 */
export function composeBackendEnv(compose: string): Map<string, ComposeEnvEntry> {
  const lines = compose.split('\n');
  const service = lines.findIndex((l) => /^ {2}backend:\s*$/.test(l));
  const env = service < 0 ? -1 : lines.findIndex((l, i) => i > service && /^ {4}environment:\s*$/.test(l));
  if (env < 0) throw new Error('no backend environment: block in the compose file');
  const entries = new Map<string, ComposeEnvEntry>();
  for (const line of lines.slice(env + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const entry = /^ {6}([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!entry) break;
    const [, name = '', raw = ''] = entry; // both groups are mandatory, so a match has them
    const value = raw.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
    const reads = [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].flatMap((m) => m[1] ?? []);
    entries.set(name, { reads, value });
  }
  if (entries.size === 0) throw new Error('the backend environment: block in the compose file is empty');
  return entries;
}

/** The Portainer compose file, whose backend block the table's notes follow. */
export const PORTAINER_COMPOSE = path.join(getDirname(import.meta.url), '../../../docker-compose.portainer.yml');

/** `doc` with the generated table between the markers. */
export function withEnvTable(doc: string, compose: string = readFileSync(PORTAINER_COMPOSE, 'utf8')): string {
  const start = doc.indexOf(ENV_TABLE_START);
  const end = doc.indexOf(ENV_TABLE_END);
  if (start < 0 || end < start) throw new Error('the file has no env-table markers');
  const table = settingsMarkdown(composeBackendEnv(compose));
  return `${doc.slice(0, start + ENV_TABLE_START.length)}\n\n${table}\n\n${doc.slice(end)}`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.join(getDirname(import.meta.url), 'env-docs.js');
if (isMain) {
  // npm runs the script in backend/, so a relative path is read from there.
  const file = process.argv[2];
  if (file === undefined) {
    process.stdout.write(`${settingsMarkdown(composeBackendEnv(readFileSync(PORTAINER_COMPOSE, 'utf8')))}\n`);
  } else {
    const before = readFileSync(file, 'utf8');
    const after = withEnvTable(before);
    if (after !== before) writeFileSync(file, after);
    process.stdout.write(after === before ? `${file} is up to date\n` : `${file} updated\n`);
  }
}
