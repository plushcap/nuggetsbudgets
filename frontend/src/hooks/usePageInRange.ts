import { useEffect } from 'react';

/**
 * Brings a paged list back in range when it shrinks under the page shown: after
 * deletions or reassignments while a later page is open, the list said "Page 3 of 2" with
 * nothing in it, and nothing brought it back. `totalPages` is undefined while it isn't known
 * (loading, or a placeholder kept from another page); an emptied list goes back to page 1.
 */
export function usePageInRange(page: number, totalPages: number | undefined, setPage: (page: number) => void): void {
  const lastPage = totalPages === undefined ? undefined : Math.max(1, totalPages);
  useEffect(() => {
    if (lastPage !== undefined && page > lastPage) setPage(lastPage);
  }, [page, lastPage, setPage]);
}
