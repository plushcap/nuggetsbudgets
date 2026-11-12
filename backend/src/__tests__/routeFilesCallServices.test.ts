import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { getDirname } from '../utils/esm-compat.js';

/**
 * A route parses its input and calls a service (CLAUDE.md "A route parses its input and
 * calls a service"): it reads its query string through validateQuery
 * and parsedQuery with a schema from @nuggets/shared, never `req.query` itself, and it runs no
 * queries: getDb(), getOrgDb() and globalDb are the services'. routes/test-data.ts (dev
 * tooling) is the one route file that may query directly.
 *
 * `bodyKeys(req.query)` (the query's field names, for a log line) is allowed: it reads no value.
 */
const ROUTES = path.join(getDirname(import.meta.url), '..', 'routes');
const ALLOWED = new Set(['test-data.ts']);

/** The text with its comments blanked out, each kept to its line breaks (so line numbers hold). */
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`\\])\/\/[^\n]*/g, (match, lead: string | undefined) =>
    lead === undefined ? match.replace(/[^\n]/g, ' ') : lead + ' '.repeat(match.length - lead.length)
  );

const RAW = [/\breq\.query\b/g, /\bgetDb\s*\(/g, /\bgetOrgDb\s*\(/g, /\bglobalDb\b/g];
const ALLOWED_USE = /\bbodyKeys\(\s*req\.query\s*\)/g;

/** The 1-based lines of `text` that read the query raw or run a query. */
const rawLines = (text: string) => {
  const code = withoutComments(text).replace(ALLOWED_USE, (m) => ' '.repeat(m.length));
  return [...new Set(RAW.flatMap((re) => [...code.matchAll(re)].map((m) => code.slice(0, m.index).split('\n').length)))].sort((a, b) => a - b);
};

describe('route files', () => {
  it('read the query through a schema and leave queries to services', () => {
    const hits = readdirSync(ROUTES)
      .filter((name) => name.endsWith('.ts') && !ALLOWED.has(name))
      .flatMap((name) => rawLines(readFileSync(path.join(ROUTES, name), 'utf8')).map((line) => `routes/${name}:${line}`));
    expect(hits).toEqual([]);
  });

  it('catches a raw query read and a query in a route, not a mention or a log of field names', () => {
    expect(rawLines(`const { code } = req.query;`)).toEqual([1]);
    expect(rawLines(`offsetParams(req.query, { defaultLimit: 50 })`)).toEqual([1]);
    expect(rawLines(`\nconst image = await getImage(getDb(), uuid);`)).toEqual([2]);
    expect(rawLines(`await globalDb.selectFrom('users')`)).toEqual([1]);
    expect(rawLines(`getOrgDb ()`)).toEqual([1]);
    expect(rawLines(`logger.info({ filters: bodyKeys(req.query) }, 'listed')`)).toEqual([]);
    expect(rawLines(`/**\n * Runs under tenantHandler so getDb() is RLS-scoped (req.query is parsed).\n */`)).toEqual([]);
    expect(rawLines(`const url = 'http://localhost:3000'; // getDb() is the service's`)).toEqual([]);
    expect(rawLines(`const { limit } = parsedQuery(req, priceSyncRunsQuery);`)).toEqual([]);
  });
});
