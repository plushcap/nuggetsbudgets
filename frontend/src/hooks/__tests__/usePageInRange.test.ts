import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePageInRange } from '../usePageInRange';

// A list that shrinks under the page shown goes back to its last page.
describe('usePageInRange', () => {
  const run = (page: number, totalPages: number | undefined) => {
    const setPage = vi.fn();
    renderHook(() => usePageInRange(page, totalPages, setPage));
    return setPage;
  };

  it('moves a page past the end back to the last page', () => {
    expect(run(3, 2)).toHaveBeenCalledWith(2);
  });

  it('moves an emptied list back to page 1', () => {
    expect(run(3, 0)).toHaveBeenCalledWith(1);
  });

  it('leaves a page in range, and a list whose size is not known yet', () => {
    expect(run(2, 2)).not.toHaveBeenCalled();
    expect(run(1, 0)).not.toHaveBeenCalled();
    expect(run(4, undefined)).not.toHaveBeenCalled();
  });

  it('follows the list when it shrinks after the page was chosen', () => {
    const setPage = vi.fn();
    const { rerender } = renderHook(({ total }) => usePageInRange(3, total, setPage), { initialProps: { total: 3 } });
    expect(setPage).not.toHaveBeenCalled();
    rerender({ total: 2 });
    expect(setPage).toHaveBeenCalledWith(2);
  });
});
