import { describe, it, expect } from 'vitest';
import { attributeToBranches, type Branch } from '../TagReportService.js';

/**
 * The tag breakdown puts each transaction in one slice. Its rows come from a
 * GROUP BY with no ORDER BY, so the slices mustn't depend on the order they arrive in.
 */
describe('attributeToBranches', () => {
  // Sub-tags 1, 2 and 3 are the branches; tag 10 is the viewed tag.
  const branchOfTag = new Map<number, Branch>([[1, 1], [2, 2], [3, 3], [10, 'parent']]);

  const slicesOf = (transactions: { amount: number; tagIds: number[] }[]) =>
    Object.fromEntries([...attributeToBranches(transactions, branchOfTag)].map(([key, slice]) => [key, slice]));

  it('settles ties against the unambiguous totals, whatever order the ties come in', () => {
    const settled = [
      { amount: -10, tagIds: [1] },
      { amount: -9, tagIds: [2] },
      { amount: -4, tagIds: [10] },
    ];
    // Branch 2 (9) beats branch 3 (0); branch 1 (10) beats branch 2 (9). Resolved against
    // the totals so far, the second tie saw branch 2 at 14 when it came first, and went there.
    const tieTwoThree = { amount: -5, tagIds: [2, 3] };
    const tieOneTwo = { amount: -3, tagIds: [1, 2, 10] };

    const expected = {
      1: { value: 13, net: -13, count: 2 },
      2: { value: 14, net: -14, count: 2 },
      parent: { value: 4, net: -4, count: 1 },
    };
    expect(slicesOf([...settled, tieTwoThree, tieOneTwo])).toEqual(expected);
    expect(slicesOf([...settled, tieOneTwo, tieTwoThree])).toEqual(expected);
    expect(slicesOf([tieOneTwo, ...settled.slice().reverse(), tieTwoThree])).toEqual(expected);
  });

  it('gives an exact tie to the smaller tag id, in cents, whatever order the amounts were summed in', () => {
    // 0.1 + 0.2 + 0.3 is 0.6000000000000001 as floats, and 0.3 + 0.2 + 0.1 is 0.6: summed
    // in the first order, branch 2 looked larger than branch 1's 0.6 and took the tie.
    const branchOne = [{ amount: 0.6, tagIds: [1] }];
    const branchTwo = [{ amount: 0.1, tagIds: [2] }, { amount: 0.2, tagIds: [2] }, { amount: 0.3, tagIds: [2] }];
    const tie = { amount: 1, tagIds: [2, 1] };

    for (const order of [[...branchOne, ...branchTwo, tie], [...branchOne, ...branchTwo.slice().reverse(), tie]]) {
      const slices = slicesOf(order);
      expect(slices[1]).toEqual({ value: 1.6, net: 1.6, count: 2 });
      expect(slices[2]).toEqual({ value: 0.6, net: 0.6, count: 3 });
    }
  });

  it('puts a transaction in its one branch, or the parent, and leaves out one in neither', () => {
    const slices = slicesOf([
      { amount: 25, tagIds: [3, 10] },
      { amount: -7.5, tagIds: [10] },
      { amount: 100, tagIds: [99] },
    ]);
    expect(slices).toEqual({
      3: { value: 25, net: 25, count: 1 },
      parent: { value: 7.5, net: -7.5, count: 1 },
    });
  });
});
