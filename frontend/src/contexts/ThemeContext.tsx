import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { readStored, writeStored } from '../utils/storage';

// Appearance (light/dark) plus the Radix Theme knobs the runtime picker drives.
export type Appearance = 'light' | 'dark';
export type AccentColor =
  | 'tomato' | 'red' | 'ruby' | 'crimson' | 'pink' | 'plum' | 'purple' | 'violet'
  | 'iris' | 'indigo' | 'blue' | 'cyan' | 'teal' | 'jade' | 'green' | 'grass'
  | 'orange' | 'brown' | 'sky' | 'mint' | 'lime' | 'yellow' | 'amber' | 'gold'
  | 'bronze' | 'gray';
export type GrayColor = 'gray' | 'mauve' | 'slate' | 'sage' | 'olive' | 'sand' | 'auto';
export type ThemeRadius = 'none' | 'small' | 'medium' | 'large' | 'full';
export type PanelBackground = 'solid' | 'translucent';
export type Scaling = '90%' | '95%' | '100%' | '105%' | '110%';

export interface ThemePrefs {
  appearance: Appearance;
  accentColor: AccentColor;
  grayColor: GrayColor;
  radius: ThemeRadius;
  panelBackground: PanelBackground;
  scaling: Scaling;
}

// Defaults preserve today's look (Trust Blue / slate / medium / translucent).
export const DEFAULT_THEME_PREFS: ThemePrefs = {
  appearance: 'light',
  accentColor: 'blue',
  grayColor: 'slate',
  radius: 'medium',
  panelBackground: 'translucent',
  scaling: '100%',
};

const PREFS_KEY = 'nuggets-theme-prefs';
const LEGACY_APPEARANCE_KEY = 'nuggets-theme';

interface ThemeContextType {
  /** Back-compat alias for prefs.appearance (existing consumers read `theme`). */
  theme: Appearance;
  toggleTheme: () => void;
  setTheme: (theme: Appearance) => void;
  /** Full theme preferences driving the Radix <Theme>. */
  prefs: ThemePrefs;
  setAccentColor: (c: AccentColor) => void;
  setGrayColor: (c: GrayColor) => void;
  setRadius: (r: ThemeRadius) => void;
  setPanelBackground: (p: PanelBackground) => void;
  setScaling: (s: Scaling) => void;
  resetThemePrefs: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function systemAppearance(): Appearance {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// What the user set: the theme knobs they changed, and an appearance only if they chose
// one; without it the appearance follows the system's. Falls back to the legacy
// appearance key, so existing users keep their setting.
function loadStoredPrefs(): Partial<ThemePrefs> {
  try {
    const raw = readStored('local', PREFS_KEY);
    if (raw) return JSON.parse(raw) as Partial<ThemePrefs>;
  } catch {
    // ignore malformed JSON and fall through to the legacy key
  }
  const legacy = readStored('local', LEGACY_APPEARANCE_KEY);
  return legacy === 'light' || legacy === 'dark' ? { appearance: legacy } : {};
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [stored, setStored] = useState<Partial<ThemePrefs>>(loadStoredPrefs);
  const [system, setSystem] = useState<Appearance>(systemAppearance);
  const prefs = useMemo<ThemePrefs>(
    () => ({ ...DEFAULT_THEME_PREFS, appearance: system, ...stored }),
    [stored, system],
  );

  // Apply the appearance class to <html>.
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(prefs.appearance);
  }, [prefs.appearance]);

  // Persist only what the user set. Once the prefs are stored, the legacy appearance key
  // (folded into them by loadStoredPrefs) is never read again, so it goes.
  useEffect(() => {
    if (writeStored('local', PREFS_KEY, JSON.stringify(stored))) {
      writeStored('local', LEGACY_APPEARANCE_KEY, null);
    }
  }, [stored]);

  // Track the system appearance; it applies while the user hasn't chosen one.
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => setSystem(e.matches ? 'dark' : 'light');
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    } else if (mediaQuery.addListener) {
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }
  }, []);

  const update = <K extends keyof ThemePrefs>(key: K, value: ThemePrefs[K]) =>
    setStored((prev) => ({ ...prev, [key]: value }));

  const value: ThemeContextType = {
    theme: prefs.appearance,
    toggleTheme: () => update('appearance', prefs.appearance === 'light' ? 'dark' : 'light'),
    setTheme: (t) => update('appearance', t),
    prefs,
    setAccentColor: (c) => update('accentColor', c),
    setGrayColor: (c) => update('grayColor', c),
    setRadius: (r) => update('radius', r),
    setPanelBackground: (p) => update('panelBackground', p),
    setScaling: (s) => update('scaling', s),
    resetThemePrefs: () => setStored({}),
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
