import { useCallback, useState } from 'react';
import { readStored, writeStored } from '../utils/storage';

/**
 * How many rows a page of a transaction table shows: the choice in the table's footer, one
 * for every transaction table (All Transactions, an account's register, Tasks, and a tag's,
 * a merchant's and a budget item's list). It is a preference of this browser, kept in local
 * storage like the theme's, so it outlives the tab; while storage refuses it, it lasts until
 * the page reloads.
 *
 * A table reads it when it opens, and its size changes only through its own footer, which
 * first moves to the page that keeps the rows in view. A choice made elsewhere (another tab)
 * applies from the next table opened: changing the size under a table on screen would leave
 * its page showing other rows, or none.
 */

/** The sizes offered; 200 is the most rows a transaction list's route answers. */
export const TRANSACTION_PAGE_SIZES = [25, 50, 100, 200] as const;

/** The size until one is chosen. */
export const DEFAULT_TRANSACTION_PAGE_SIZE = 50;

/** The smallest size: a list of no more rows than this fits one page whatever is chosen. */
export const SMALLEST_TRANSACTION_PAGE_SIZE = TRANSACTION_PAGE_SIZES[0];

const STORAGE_KEY = 'transaction-page-size';

const isPageSize = (n: number): boolean => (TRANSACTION_PAGE_SIZES as readonly number[]).includes(n);

/** This tab's last choice while storage refused to keep it (null once storage has it). */
let unsaved: number | null = null;

function chosenSize(): number {
  if (unsaved !== null) return unsaved;
  const stored = Number(readStored('local', STORAGE_KEY));
  return isPageSize(stored) ? stored : DEFAULT_TRANSACTION_PAGE_SIZE;
}

/** The rows per page of a transaction table, and the setter its footer's picker calls. */
export function useTransactionPageSize(): [number, (size: number) => void] {
  const [size, setSize] = useState(chosenSize);
  const choose = useCallback((next: number) => {
    if (!isPageSize(next)) return;
    unsaved = writeStored('local', STORAGE_KEY, String(next)) ? null : next;
    setSize(next);
  }, []);
  return [size, choose];
}
