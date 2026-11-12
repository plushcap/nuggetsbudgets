import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/** How long the search waits after the last keystroke before it asks the server. */
export const MERCHANT_SEARCH_DEBOUNCE_MS = 500;

export interface MerchantListPaging {
  /** The search box's text, as typed. */
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  /** The search the list asks for: the typed text once it has settled. */
  debouncedSearchTerm: string;
  currentPage: number;
  setCurrentPage: (page: number) => void;
}

/** The URL's `page`: a whole number from 1, else 1. */
const pageOf = (param: string | null): number => {
  const page = Number(param);
  return Number.isInteger(page) && page >= 1 ? page : 1;
};

/**
 * The merchant list's search and page. The page is the URL's `page` param (left out on page 1),
 * read on every render, so a link to the list or to another of its pages while it is open is
 * followed (kept in state, it was put back). It goes back to 1 when the (debounced)
 * search changes.
 */
export function useMerchantListPaging(): MerchantListPaging {
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const currentPage = pageOf(searchParams.get('page'));

  // The list's own page changes replace the URL, as before: Back leaves the list.
  const setCurrentPage = useCallback(
    (page: number) =>
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);
          if (page > 1) next.set('page', String(page));
          else next.delete('page');
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );

  // Once the typing settles, the list asks for the search, from its first page.
  useEffect(() => {
    if (searchTerm === debouncedSearchTerm) return;
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
      setCurrentPage(1);
    }, MERCHANT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchTerm, debouncedSearchTerm, setCurrentPage]);

  return { searchTerm, setSearchTerm, debouncedSearchTerm, currentPage, setCurrentPage };
}
