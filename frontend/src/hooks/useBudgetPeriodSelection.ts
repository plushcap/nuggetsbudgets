import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { BudgetPeriod } from '../services/api';
import { periodKey, resolvePeriodIndex } from '../utils/budgetPeriods';
import { todayLocal } from '../utils/dateUtils';
import { DEFAULT_TIMEZONE } from '../utils/timezone';
import { readStored, writeStored } from '../utils/storage';
import { useGeneralSettingsQuery } from './queries';

export interface BudgetPeriodSelection {
  /** The period shown, or undefined while there is none. */
  currentPeriod: BudgetPeriod | undefined;
  /** Show `period`: it goes into the URL, and is saved for this session. */
  selectPeriod: (period: BudgetPeriod) => void;
  /** Whether the period shown is the household's month today (true while there is none). */
  isCurrentMonth: boolean;
}

/** Today in the IANA zone `timeZone`, as 'YYYY-MM-DD'; the browser's day for a zone Intl doesn't know. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    return todayLocal();
  }
}

/**
 * The household's today: the day in its application_timezone, as the server's
 * app_today() reads it (UTC until it sets one), not the browser's, which is a day off near
 * midnight for a member travelling or abroad. The browser's day while the setting loads.
 */
function useHouseholdToday(): { today: string; known: boolean } {
  const { data: settings, isPending } = useGeneralSettingsQuery();
  if (!settings) return { today: todayLocal(), known: !isPending };
  const zone = settings.find((s) => s.setting_key === 'application_timezone')?.setting_value || DEFAULT_TIMEZONE;
  return { today: todayIn(zone), known: true };
}

/**
 * The period a page shows (the Budget page's, Close-Out's), one copy of what each kept:
 * the URL's `period` (a YYYY-MM or a uuid), else this session's last choice under `storageKey`,
 * else the household's month today. The URL is rewritten to name the period shown, as its YYYY-MM.
 */
export function useBudgetPeriodSelection(budgetPeriods: BudgetPeriod[], storageKey: string): BudgetPeriodSelection {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlPeriod = searchParams.get('period');
  const { today, known: todayKnown } = useHouseholdToday();
  const currentPeriodIndex = useMemo(
    () => resolvePeriodIndex(budgetPeriods, urlPeriod, readStored('session', storageKey), today),
    [budgetPeriods, urlPeriod, storageKey, today],
  );
  const currentPeriod = budgetPeriods[currentPeriodIndex];
  const currentPeriodKey = currentPeriod ? periodKey(currentPeriod) : null;

  const selectPeriod = useCallback(
    (period: BudgetPeriod) => {
      const key = periodKey(period);
      const params = new URLSearchParams(searchParams);
      params.set('period', key);
      setSearchParams(params, { replace: true });
      // Storage unavailable: the URL still holds the selection.
      writeStored('session', storageKey, key);
    },
    [searchParams, setSearchParams, storageKey],
  );

  // A uuid, an unknown period or none at all becomes the shown period's YYYY-MM: once the
  // household's day is known, so a default month isn't the browser's.
  useEffect(() => {
    if (!todayKnown || !currentPeriodKey || urlPeriod === currentPeriodKey) return;
    const params = new URLSearchParams(searchParams);
    params.set('period', currentPeriodKey);
    setSearchParams(params, { replace: true });
  }, [todayKnown, currentPeriodKey, urlPeriod, searchParams, setSearchParams]);

  const isCurrentMonth = !currentPeriod || periodKey(currentPeriod) === today.slice(0, 7);

  return { currentPeriod, selectPeriod, isCurrentMonth };
}
