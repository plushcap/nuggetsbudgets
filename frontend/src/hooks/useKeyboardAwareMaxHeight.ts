import { useEffect, RefObject } from 'react';
import { useSeededState } from './useSeededState';

/**
 * Returns a pixel max-height for `ref` capped to the space actually visible
 * above the on-screen keyboard, using `window.visualViewport`.
 *
 * On mobile (notably iOS Safari) the keyboard overlays the page without
 * resizing the layout viewport, so a dropdown/list can extend behind it. When
 * `enabled` is true this measures the element's top against the visible
 * viewport bottom and recomputes as the keyboard shows/hides. Returns
 * `undefined` when disabled so callers can fall back to their default sizing.
 */
export function useKeyboardAwareMaxHeight(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  bottomGap = 8,
  minHeight = 120
): number | undefined {
  // Cleared whenever the hook is turned off (adjusted while rendering).
  const [maxHeight, setMaxHeight] = useSeededState<number | undefined>(
    (current) => (enabled ? current : undefined),
    [enabled],
  );

  useEffect(() => {
    if (!enabled) return;

    const vv = window.visualViewport;
    const compute = () => {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      setMaxHeight(Math.max(minHeight, visibleBottom - top - bottomGap));
    };

    compute();
    // Recompute once after layout settles (the keyboard animates in).
    const raf = requestAnimationFrame(compute);

    vv?.addEventListener('resize', compute);
    vv?.addEventListener('scroll', compute);
    window.addEventListener('resize', compute);
    return () => {
      cancelAnimationFrame(raf);
      vv?.removeEventListener('resize', compute);
      vv?.removeEventListener('scroll', compute);
      window.removeEventListener('resize', compute);
    };
  }, [ref, enabled, bottomGap, minHeight, setMaxHeight]);

  return maxHeight;
}
