/**
 * Web storage that never throws. Storage can be unavailable (a private window, blocked
 * site data, a full quota, or `window.localStorage` itself throwing): then it reads as
 * empty and writes are dropped.
 *
 * CLAUDE.md: transient UI state goes in session storage; local storage only for
 * preferences that should outlive the tab (theme, a remembered email).
 */
type Area = 'local' | 'session';

const area = (which: Area): Storage =>
  which === 'local' ? window.localStorage : window.sessionStorage;

export function readStored(which: Area, key: string): string | null {
  try {
    return area(which).getItem(key);
  } catch {
    return null;
  }
}

/** Stores `value` (or removes the key for null); false when storage refused it. */
export function writeStored(which: Area, key: string, value: string | null): boolean {
  try {
    if (value === null) area(which).removeItem(key);
    else area(which).setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** The JSON stored under `key`, or `fallback` when there is none or it doesn't parse. */
export function readStoredJson<T>(which: Area, key: string, fallback: T): T {
  const raw = readStored(which, key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStoredJson(which: Area, key: string, value: unknown): boolean {
  return writeStored(which, key, JSON.stringify(value));
}
