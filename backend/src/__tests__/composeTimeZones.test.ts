import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Every container the compose files start runs UTC unless the deployment says otherwise:
 * the household's zone is a setting, not TZ. Dozzle's once defaulted to a
 * local zone instead.
 */
describe('the compose files’ time zones', () => {
  // The tests run from backend/.
  const files = ['docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.portainer.yml'];

  it.each(files)('%s sets TZ to UTC, or to TZ with UTC as its default', (file) => {
    const compose = readFileSync(path.resolve(process.cwd(), '..', file), 'utf8');
    const zones = [...compose.matchAll(/^\s*-?\s*TZ\s*[:=]\s*(\S+)\s*$/gm)].map((m) => m[1]);
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.filter((zone) => zone !== 'UTC' && zone !== '${TZ:-UTC}')).toEqual([]);
  });
});
