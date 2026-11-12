import React from 'react';
import { Callout } from '@radix-ui/themes';
import { useBudgetItemUsageQuery } from '../../hooks/queries';

/**
 * Whether a budget item rolls over can't change once it has history: money
 * recorded in a period before the current one, a budget change or a transaction. The server
 * refuses the change (409 ROLLOVER_LOCKED); the edit pages and dialogs say so before saving.
 */

/** Whether the item's rolling over is fixed by its history: false until its usage has loaded. */
export function useRolloverLocked(uuid: string | null | undefined): { locked: boolean; loading: boolean } {
  const usage = useBudgetItemUsageQuery(uuid ?? null);
  return { locked: usage.data?.history_before_current_period === true, loading: usage.isLoading };
}

/** The reason, in the server's words. */
export const rolloverLockedText = (name: string): string =>
  `${name} has money recorded in an earlier period (a budget change or a transaction in a period before this one), ` +
  'so whether it rolls over can’t change: that would change what those periods show. ' +
  'Keep it as it is, or make a new budget item for the new way.';

/** Shown where a choice would change whether the item rolls over, once its history fixes that. */
export const RolloverLockedNote: React.FC<{ name: string; id?: string }> = ({ name, id }) => (
  <Callout.Root highContrast color="amber" role="status" {...(id ? { id } : {})}>
    <Callout.Text>{rolloverLockedText(name)}</Callout.Text>
  </Callout.Root>
);
