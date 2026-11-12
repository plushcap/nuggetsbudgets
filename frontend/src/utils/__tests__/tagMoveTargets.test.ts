import { describe, it, expect } from 'vitest';
import { mayMoveToTop, tagMoveTargets } from '../tagMoveTargets';

const tag = (id: number, level: number, parent_id: number | null = null, is_report_root = false) => ({ id, level, parent_id, is_report_root });
const ids = (tags: { id: number }[]) => tags.map((t) => t.id);

describe('tagMoveTargets', () => {
  // 1 > 2 > 3 > 4 (levels 0 to 3); 5 > 6 > 7 (a subtree two levels deep); 8, a report root.
  const tags = [tag(1, 0), tag(2, 1, 1), tag(3, 2, 2), tag(4, 3, 3), tag(5, 0), tag(6, 1, 5), tag(7, 2, 6), tag(8, 0, null, true)];

  it('offers only the parents where the tag and the tags below it stay within level 3', () => {
    expect(ids(tagMoveTargets(tags, 5))).toEqual([1, 8]);
    expect(ids(tagMoveTargets(tags, 6))).toEqual([1, 2, 5, 8]);
    expect(ids(tagMoveTargets(tags, 7))).toEqual([1, 2, 3, 5, 6, 8]);
  });

  it('never offers the tag or a tag below it, and nothing to a subtree four levels deep', () => {
    // Under its own child it would be level 2 and the child 3: within the levels, but a loop.
    expect(ids(tagMoveTargets([tag(10, 0), tag(11, 1, 10), tag(12, 0)], 10))).toEqual([12]);
    expect(tagMoveTargets(tags, 1)).toEqual([]);
  });

  it('offers a report root no parent, and keeps the one a tag has', () => {
    expect(tagMoveTargets(tags, 8)).toEqual([]);
    expect(ids(tagMoveTargets([...tags, tag(9, 4, 4)], 9))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('ends on a loop of parents an older install may hold', () => {
    expect(ids(tagMoveTargets([tag(1, 1, 2), tag(2, 2, 1), tag(3, 0)], 1))).toEqual([2, 3]);
  });

  it('offers the top only where the tags below the tag stay within level 3, or where it is already', () => {
    const deep = [tag(1, 0), tag(2, 1, 1), tag(3, 2, 2), tag(4, 3, 3), tag(5, 4, 4)];
    expect(mayMoveToTop(deep, 2)).toBe(true);
    expect(mayMoveToTop(deep, 1)).toBe(true);
    expect(mayMoveToTop([tag(9, 1, 1), ...deep.map((t) => (t.id === 2 ? { ...t, parent_id: 9, level: 2 } : t))], 9)).toBe(false);
  });
});
