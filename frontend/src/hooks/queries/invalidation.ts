import { useMemo, useSyncExternalStore } from 'react';
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import { setFormatMoneyDefaults } from '@nuggets/shared';
import { clearTimezoneCache } from '../../utils/timezone';
import { authKeys } from './auth';
import { billKeys } from './bills';
import {
  accountKeys,
  budgetKeys,
  dashboardKeys,
  goalKeys,
  investmentKeys,
  merchantKeys,
  netWorthKeys,
  reportKeys,
  tagKeys,
  tenantKeys,
  transactionKeys,
} from './keys';

/**
 * Everything a write to transactions can change: the transactions, account balances and
 * budget spend, and every total derived from them (tag and merchant totals, bills paid,
 * net worth, goal progress, reports, investment cash). Invalidating only marks the
 * queries not on screen as stale, so a broad list costs nothing until they're shown.
 */
const TRANSACTION_DERIVED = [
  transactionKeys.all,
  accountKeys.all,
  budgetKeys.all,
  tagKeys.all,
  merchantKeys.all,
  billKeys.all,
  netWorthKeys.all,
  dashboardKeys.all,
  goalKeys.all,
  reportKeys.all,
  investmentKeys.all,
];

/** Refresh every screen a transaction write (create, edit, delete, tag, split, import, rule) can change. */
export function invalidateTransactionData(qc: QueryClient): void {
  for (const queryKey of TRANSACTION_DERIVED) void qc.invalidateQueries({ queryKey });
}

const AUTH_ROOT = authKeys.me()[0];
const MEMBERSHIP_KEY = tenantKeys.mine();

/** The session itself; every other query belongs to one person's view of one ledger. */
const isSessionQuery = (query: Query) => query.queryKey[0] === AUTH_ROOT;
const isMembershipQuery = (query: Query) =>
  query.queryKey.length === MEMBERSHIP_KEY.length && MEMBERSHIP_KEY.every((part, i) => query.queryKey[i] === part);

/**
 * Drop everything the previous session loaded, on sign-in, sign-out and expiry, so the
 * next person never sees it (the cache outlives a sign-out by minutes otherwise).
 */
export function removeSessionData(qc: QueryClient): void {
  qc.removeQueries({ predicate: (query) => !isSessionQuery(query) });
  clearTimezoneCache();
  // The last ledger's currency and locale (LedgerMoneyFormat) go too.
  setFormatMoneyDefaults({});
}

// Counts ledger switches, so paged lists can tell their previous page came from
// another ledger (useKeepPreviousLedgerData).
let ledgerGeneration = 0;
const generationListeners = new Set<() => void>();
const subscribeToGeneration = (listener: () => void) => {
  generationListeners.add(listener);
  return () => generationListeners.delete(listener);
};

/**
 * `placeholderData` for paged lists: keep the previous page on screen while the next
 * loads, like keepPreviousData, but never across a ledger switch. React Query reuses
 * a placeholder it already shows for as long as the option is the same function, so
 * a page change in flight at a switch kept showing the old ledger's rows until the
 * new ledger answered. A new function per ledger generation, which
 * also declines a previous page that the switch reset, ends that.
 *
 * `listOf` names whose list a query key holds (a merchant's transactions, say), and
 * `queryKey` is the key being shown. With them, a previous page is kept only from the
 * same list: a page whose route moves to another merchant without remounting shows its
 * loader, not the last merchant's rows and total. `listOf` is a module-level
 * function; the placeholder is a new function for each list, for the reason above.
 */
export function useKeepPreviousLedgerData<T>(queryKey?: QueryKey, listOf?: (queryKey: QueryKey) => string) {
  const generation = useSyncExternalStore(subscribeToGeneration, () => ledgerGeneration);
  const list = queryKey && listOf ? listOf(queryKey) : undefined;
  // One function per generation (and list). A function from an earlier generation (one
  // still held somewhere after a switch) declines too: the previous page is another
  // ledger's.
  return useMemo(
    () => (
      previousData: T | undefined,
      previousQuery: { queryKey: QueryKey; state: { data: unknown } } | undefined,
    ): T | undefined =>
      generation === ledgerGeneration
      && previousQuery?.state.data !== undefined
      && (listOf === undefined || listOf(previousQuery.queryKey) === list)
        ? previousData
        : undefined,
    [generation, list, listOf],
  );
}

/**
 * After a ledger switch: empty every query of the old ledger, so a screen shows its
 * loader rather than the old ledger's data, and refetch the ones on screen. The
 * membership summary only refetches, keeping the switcher in place meanwhile. Each
 * ledger has its own time zone, so the cached one goes too.
 */
export async function resetLedgerData(qc: QueryClient): Promise<void> {
  ledgerGeneration += 1;
  generationListeners.forEach((listener) => listener());
  clearTimezoneCache();
  await Promise.all([
    qc.resetQueries({ predicate: (query) => !isSessionQuery(query) && !isMembershipQuery(query) }),
    qc.invalidateQueries({ queryKey: MEMBERSHIP_KEY }),
  ]);
}
