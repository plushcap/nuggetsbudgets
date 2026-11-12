import type { CSSProperties } from 'react';
import { readableOn } from '../hooks/useChartTheme';

/**
 * Radix colours whose step 11 (what `<Text color>` draws) is under WCAG AA's 4.5:1 on
 * the app's gray-2 page in light mode (4.26–4.46:1). Text in them takes step 12.
 */
export const LOW_CONTRAST_TEXT_COLORS = ['green', 'amber', 'yellow', 'orange', 'teal', 'jade'] as const;

/**
 * The props for text in `color`: `highContrast` (step 12) for the colours above, so a
 * value computed at run time ('green' for a gain) is as readable as a literal one.
 */
export function textColorProps<C extends string | undefined>(color: C): { color: C; highContrast?: true } {
  return (LOW_CONTRAST_TEXT_COLORS as readonly string[]).includes(color ?? '') ? { color, highContrast: true } : { color };
}

/**
 * A tint of a colour someone chose (an icon's circle), and the icon drawn on it in that hue
 * mixed toward the page's text colour (gray-12, which swaps with the appearance), so it reads on
 * the tint whatever the colour: a pale yellow icon on its own pale tint was all but invisible.
 * Nothing (the element's own colours) with no colour chosen.
 */
export function chosenTintStyle(color: string | null | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  return /* lint:guard colour: the chosen colour, as a tint and an icon that reads on it */ {
    backgroundColor: `color-mix(in srgb, ${color} 12.5%, transparent)`,
    color: `color-mix(in srgb, ${color} 40%, var(--gray-12))`,
  };
}

// The fills for no colour chosen, as classes the theme picker drives (they were inline
// `var(--${fallback}-9)` styles). Written out whole, so Tailwind generates them. Gray is a
// tint with step-12 text (a person's initials): white on gray-9 was 3.30:1 on slate.
const FALLBACK_FILL = {
  gray: 'bg-[var(--gray-5)] text-[var(--gray-12)]',
  accent: 'bg-[var(--accent-9)] text-[var(--accent-contrast)]',
} as const;

/**
 * The props for a fill in a colour someone chose (a person's, a budget item's, a tag's) and the
 * text or icon drawn on it: black or white, whichever reads on the chosen colour
 * (readableOn). White on any chosen colour was under AA's 4.5:1 on the lighter ones (33 of the
 * colour picker's 59). With no colour chosen: a gray tint with step-12 text, or the accent's
 * step-9 fill and its contrast colour, as classes, or nothing (the element keeps its own colours) without a fallback. `className` is
 * the element's own; spread the result on it (`{...chosenColourProps(c, 'gray', 'w-6 h-6')}`).
 */
export function chosenColourProps(
  color: string | null | undefined,
  fallback?: 'gray' | 'accent',
  className = '',
): { className: string; style?: CSSProperties } {
  if (color) {
    return {
      className,
      style: /* lint:guard colour: the chosen colour, and black or white text that reads on it */ {
        backgroundColor: color,
        color: readableOn(color),
      },
    };
  }
  return { className: fallback ? `${className} ${FALLBACK_FILL[fallback]}`.trim() : className };
}
