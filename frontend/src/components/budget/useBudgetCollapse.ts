import { useCallback, useEffect, useState } from 'react';
import { readStoredJson, writeStoredJson } from '../../utils/storage';

type Toggles = Record<string, boolean>;

/** A set of on/off flags kept in session storage under `key`, so they survive navigation. */
function useSessionToggles(key: string): [Toggles, (flag: string) => void] {
  const [toggles, setToggles] = useState<Toggles>(() => readStoredJson<Toggles>('session', key, {}));
  useEffect(() => {
    writeStoredJson('session', key, toggles);
  }, [key, toggles]);
  const toggle = useCallback((flag: string) => setToggles((prev) => ({ ...prev, [flag]: !prev[flag] })), []);
  return [toggles, toggle];
}

export interface BudgetCollapse {
  /** Whether a section ('Income', 'Savings', 'Expense') is collapsed. */
  section: (expenseType: string) => boolean;
  /** Whether a type (Monthly, Envelope) within a section is collapsed. */
  type: (expenseType: string, type: string) => boolean;
  /** Whether a subtype (Flexible, Fixed…) within a type is collapsed. */
  subtype: (expenseType: string, type: string, subtype: string) => boolean;
  toggleSection: (expenseType: string) => void;
  toggleType: (expenseType: string, type: string) => void;
  toggleSubtype: (expenseType: string, type: string, subtype: string) => void;
}

/** Which of the Budget page's desktop sections are collapsed, for this tab's session. */
export function useBudgetCollapse(): BudgetCollapse {
  const [sections, toggleSection] = useSessionToggles('budget-collapsed-expense-types');
  const [types, toggleTypeKey] = useSessionToggles('budget-collapsed-types');
  const [subtypes, toggleSubtypeKey] = useSessionToggles('budget-collapsed-subtypes');
  return {
    section: (expenseType) => !!sections[expenseType],
    type: (expenseType, type) => !!types[`${expenseType}-${type}`],
    subtype: (expenseType, type, subtype) => !!subtypes[`${expenseType}-${type}-${subtype}`],
    toggleSection,
    toggleType: (expenseType, type) => toggleTypeKey(`${expenseType}-${type}`),
    toggleSubtype: (expenseType, type, subtype) => toggleSubtypeKey(`${expenseType}-${type}-${subtype}`),
  };
}
