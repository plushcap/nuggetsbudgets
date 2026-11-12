import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { getDirname } from '../utils/esm-compat.js';

/**
 * The backend's text calls the isolation unit a "tenant" (CLAUDE.md); only the UI calls it
 * a "ledger", and it rewrites the error text it shows (toLedgerWording, frontend
 * services/api/base.ts). Error answers and log lines said "ledger" in places.
 * This finds the word in any string in the backend's source, comments aside.
 */

const SRC = path.join(getDirname(import.meta.url), '..');

// The one string that is a person's copy, not error or log text: the name a new deployment
// gives its first ledger, which its members see as the ledger's name. Text the settings
// pages show (the setting descriptions) says "tenant" and the frontend rewrites it, as it
// does the errors; config.ts's descriptions are an operator's (the settings table
// `npm run docs:env` prints) and say "tenant" too.
// And the names of v2.4.0's migrations, as its databases' schema_migrations rows hold them.
const ALLOWED = [
  { file: 'services/DeploymentAdminService.ts', text: "'My Ledger'" },
  ...['ledger vocabulary', 'ledger not null', 'ledger money rules', 'ledger references', 'rename seeded ledger'].map((name) => ({
    file: 'db/v240Migrations.ts',
    text: `'${name}'`,
  })),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'test' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'schema.generated.ts' ? [full] : [];
  });
}

/** Each string literal on a line of code (not a comment or an import) that says "ledger". */
function tenantStrings(file: string): string[] {
  const found: string[] = [];
  for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*') || code.startsWith('import ')) continue;
    const withoutComment = code.replace(/\s\/\/ .*$/, '');
    for (const match of withoutComment.matchAll(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
      // A template's ${…} is code (MAX_REGEX_RULES_PER_TENANT), not text.
      if (/ledger/i.test(match[0].replace(/\$\{[^}]*\}/g, ''))) found.push(`${path.relative(SRC, file)}:${i + 1}: ${match[0]}`);
    }
  }
  return found;
}

describe("the backend's text", () => {
  it('says "tenant", not "ledger", in its errors and log lines', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap(tenantStrings).filter(
      (hit) => !ALLOWED.some(({ file, text }) => hit.startsWith(`${file}:`) && hit.includes(text))
    );
    expect(found).toEqual([]);
  });

  it('allows only strings that are still there', () => {
    const all = sourceFiles(SRC).flatMap(tenantStrings);
    const stale = ALLOWED.filter(({ file, text }) => !all.some((hit) => hit.startsWith(`${file}:`) && hit.includes(text)));
    expect(stale).toEqual([]);
  });
});
