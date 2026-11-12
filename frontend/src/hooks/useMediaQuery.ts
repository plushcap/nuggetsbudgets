import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether a CSS media query matches, kept current as the window changes size.
 * Answers false where there is no window (and wherever matchMedia isn't there).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener?.('change', onChange);
      return () => list.removeEventListener?.('change', onChange);
    },
    [query],
  );
  const matches = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, matches, () => false);
}
