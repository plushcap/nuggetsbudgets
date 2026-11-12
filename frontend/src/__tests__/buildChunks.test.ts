import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveConfig } from 'vite';

/**
 * How vite.config.ts groups the build's chunks. Lucide's icons were a chunk each (1,995 files
 * under 10 KB; opening the icon picker fetched 1,029 of them): they go in six chunks by first
 * letter, the first page load's own in one more, and the icons the app imports by name in another.
 */
type Group = { name: string | ((id: string, ctx: unknown) => string | null); test?: RegExp | ((id: string) => boolean); tags?: string[] };

async function groups(): Promise<Group[]> {
  const root = path.resolve(import.meta.dirname, '../..');
  const config = await resolveConfig({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'silent' }, 'build');
  const output = config.build.rolldownOptions.output as { codeSplitting: { groups: Group[] } };
  return output.codeSplitting.groups;
}

const icon = (kebab: string) => `/app/node_modules/lucide-react/dist/esm/icons/${kebab}.mjs`;

describe('the build groups Lucide icons into a few chunks', () => {
  it('puts each icon in the chunk for its first letter', async () => {
    const letters = (await groups()).find((g) => typeof g.name === 'function' && g.test instanceof RegExp && g.test.test(icon('zap')));
    expect(letters).toBeDefined();
    const chunkOf = (kebab: string) => (letters!.name as (id: string, ctx: unknown) => string | null)(icon(kebab), {});
    expect(chunkOf('a-arrow-down')).toBe('icons-a-b');
    expect(chunkOf('circle-check')).toBe('icons-c');
    expect(chunkOf('house')).toBe('icons-d-h');
    expect(chunkOf('piggy-bank')).toBe('icons-i-p');
    expect(chunkOf('shopping-cart')).toBe('icons-q-s');
    expect(chunkOf('zap')).toBe('icons-t-z');
    // The re-export of them all stays with the picker that imports it, and other modules aren't icons.
    expect(chunkOf('index')).toBeNull();
    expect((letters!.name as (id: string, ctx: unknown) => string | null)('/app/node_modules/lucide-react/dist/esm/createLucideIcon.mjs', {})).toBeNull();
  });

  // An icon a page imports by name pulled its whole letter's chunk: login +
  // dashboard went from 254 to 339 KB gzipped.
  it('keeps the icons the app imports by name in one chunk, before the letters', async () => {
    const all = await groups();
    const named = all.find((g) => g.name === 'icons-named') as Group & { test: (id: string) => boolean; priority: number };
    expect(named).toBeDefined();
    // InfoPopover imports Info by name; no page imports AArrowDown.
    expect(named.test(icon('info'))).toBe(true);
    expect(named.test(icon('a-arrow-down'))).toBe(false);
    expect(named.test('/app/node_modules/lucide-react/dist/esm/createLucideIcon.mjs')).toBe(false);
    const priority = (name: string) => (all.find((g) => g.name === name) as { priority?: number } | undefined)?.priority ?? 0;
    const letters = all.find((g) => typeof g.name === 'function' && g.test instanceof RegExp && g.test.test(icon('zap'))) as { priority?: number };
    expect(priority('icons-initial')).toBeGreaterThan(named.priority);
    expect(named.priority).toBeGreaterThan(letters.priority ?? 0);
  });

  it("keeps the first page load's icons in a chunk of their own, and Zod's first", async () => {
    const all = await groups();
    const initialIcons = all.find((g) => g.name === 'icons-initial');
    expect(initialIcons?.tags).toEqual(['$initial']);
    expect(initialIcons?.test instanceof RegExp && initialIcons.test.test(icon('cloud-off'))).toBe(true);
    expect(all.find((g) => g.name === 'zod-core')?.tags).toEqual(['$initial']);
  });
});
