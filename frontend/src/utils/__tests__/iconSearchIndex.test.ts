import { describe, it, expect } from 'vitest';
import { loadIconIndex } from '../iconSearchIndex';
import { iconKebabNames, kebabToPascalCase } from '../iconCatalog';

describe('the icon search index', () => {
  it('has one entry per stored name, so the picker grid has no duplicate keys', async () => {
    const index = await loadIconIndex();
    const names = index.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    // Every icon is still there by its stored name.
    expect(new Set(names)).toEqual(new Set(iconKebabNames.map(kebabToPascalCase)));
  });

  it("finds a pair that shares a name by either kebab name (arrow-down-0-1 and arrow-down-01)", async () => {
    const entry = (await loadIconIndex()).find((e) => e.name === 'ArrowDown01');
    expect(iconKebabNames.filter((k) => kebabToPascalCase(k) === 'ArrowDown01').length).toBeGreaterThan(1);
    expect(entry?.searchText).toContain('arrow-down-0-1');
    expect(entry?.searchText).toContain('arrow-down-01');
  });
});
