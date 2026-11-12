import { describe, it, expect } from 'vitest';
import { assignableBudgetItems } from '../budgetItems';

describe('assignableBudgetItems', () => {
  const items = [
    { id: 1, status: 'active' as const },
    { id: 2, status: 'archived' as const },
    { id: 3, status: undefined },
  ];

  it('leaves out archived items', () => {
    expect(assignableBudgetItems(items).map((item) => item.id)).toEqual([1, 3]);
  });

  it("keeps the current item even when it's archived, so an existing assignment still shows", () => {
    expect(assignableBudgetItems(items, 2).map((item) => item.id)).toEqual([1, 2, 3]);
  });
});
