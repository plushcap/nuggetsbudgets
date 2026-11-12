import { Theme } from '@radix-ui/themes';
import { ReactNode } from 'react';
import { useTheme } from './contexts/ThemeContext';

/**
 * Custom Radix Theme configuration for Nuggets
 *
 * This wraps the Radix Theme component with our custom brand colors and settings.
 * We use 'blue' as the accent color to match our Trust Blue primary color.
 *
 * Supports both light and dark modes via ThemeContext.
 *
 * Every colour comes from this theme (CLAUDE.md, Idiom A): Radix props, or its CSS
 * variables (`var(--accent-9)`, `var(--gray-11)`) in an arbitrary Tailwind class, so the
 * runtime theme picker drives it. No static Tailwind colours.
 */

interface NuggetsThemeProps {
  children: ReactNode;
}

export function NuggetsTheme({ children }: NuggetsThemeProps) {
  const { prefs } = useTheme();

  // All knobs come from ThemeContext so the runtime theme picker drives them.
  // Defaults (blue / slate / medium / 100% / translucent) preserve the original look.
  return (
    <Theme
      appearance={prefs.appearance}
      accentColor={prefs.accentColor}
      grayColor={prefs.grayColor}
      radius={prefs.radius}
      scaling={prefs.scaling}
      panelBackground={prefs.panelBackground}
    >
      {children}
    </Theme>
  );
}

/**
 * Usage (Idiom A — see CLAUDE.md):
 *
 * Radix components (Button, Card, Dialog, etc.) get colour/size from props.
 * Tailwind is a thin utility layer only:
 * - Layout via Radix primitives (Flex/Grid/Box/Container); Tailwind for gradients,
 *   keyframe animations, and text/render effects (truncate, line-clamp, object-cover).
 * - Residual raw elements take colour from Radix CSS vars via arbitrary classes
 *   (e.g. text-[var(--gray-11)], bg-[var(--accent-3)]) — never dark-mode classes or static colours.
 */
