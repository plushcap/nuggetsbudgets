import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The development stack listens on the developer's machine only: its
 * backend runs in development mode, without rate limits or the production checks, and
 * the frontend's dev server proxies /api to it. A port published as "3000:3000" listened
 * on every interface, so anyone on the LAN reached it.
 */
describe('docker-compose.yml (development)', () => {
  // The tests run from backend/.
  const compose = readFileSync(path.resolve(process.cwd(), '..', 'docker-compose.yml'), 'utf8');
  const published = [...compose.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)]
    .map((m) => m[1])
    .filter((entry) => /^[\d.]*:?\d+:\d+$/.test(entry));

  it('publishes ports', () => {
    expect(published.length).toBeGreaterThanOrEqual(4);
  });

  it('publishes every one on 127.0.0.1 only', () => {
    expect(published.filter((entry) => !entry.startsWith('127.0.0.1:'))).toEqual([]);
  });
});
