import { useSyncExternalStore } from 'react';
import type { ComponentProps } from 'react';
import type { ResponsiveLine } from '@nivo/line';

/** Nivo's theme type (`@nivo/theming`'s PartialTheme, which no declared package exports). */
type PartialTheme = NonNullable<ComponentProps<typeof ResponsiveLine>['theme']>;

/**
 * The colours a chart draws with, read from the Radix theme, so a chart follows
 * the accent, gray and appearance the person picked, as the rest of the page does.
 *
 * Nivo can't take `var(--…)`: it derives shades from a colour string and some charts
 * paint a canvas. So these are the variables' values, resolved in the theme's element
 * and converted to sRGB hex, and read again when the theme changes.
 */
export interface ChartColors {
  /** Axis and label text: gray 11 (≥ 4.5:1 on the page in both appearances). */
  text: string;
  /** Emphasised text: gray 12. */
  textStrong: string;
  /** Grid lines. */
  grid: string;
  /** Axis lines and ticks. */
  axis: string;
  /** Tooltip and point fill: the solid panel. */
  panel: string;
  /** Tooltip border. */
  border: string;
  /** One series' colour: the accent, step 9. */
  accent: string;
  /** Income, a gain: green 9. */
  positive: string;
  /** Spending, a loss: red 9. */
  negative: string;
  /** A target or limit line: amber 9. */
  warning: string;
  /** Distinct colours for categories (pie slices, Sankey nodes), all step 9. */
  series: string[];
  /** The text colour to put on each `series` colour (Radix's `--{hue}-contrast`). */
  seriesText: string[];
  /** The text for a label on `color`: Radix's contrast colour for a role or series colour, else black or white by WCAG contrast. */
  textOn: (color: string) => string;
  /** A nivo `theme` built from the above. */
  nivo: PartialTheme;
}

const ROLES = {
  text: '--gray-11',
  textStrong: '--gray-12',
  grid: '--gray-5',
  axis: '--gray-7',
  panel: '--color-panel-solid',
  border: '--gray-6',
  accent: '--accent-9',
  positive: '--green-9',
  negative: '--red-9',
  warning: '--amber-9',
} as const;

/** Hues far enough apart to tell neighbours apart, in both appearances. */
export const SERIES_HUES = ['blue', 'orange', 'grass', 'purple', 'cyan', 'crimson', 'amber', 'teal', 'pink', 'brown', 'indigo', 'lime'];

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/**
 * A colour's red, green and blue (0-255): #rgb, #rgba, #rrggbb, #rrggbbaa, or rgb()/rgba()
 * with commas or spaces. Alpha is left out. Null for anything else.
 */
const rgbOf = (color: string): [number, number, number] | null => {
  const value = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((digit) => digit + digit).join('') : hex.slice(0, 6);
    const byte = (at: number) => parseInt(full.slice(at, at + 2), 16);
    return [byte(0), byte(2), byte(4)];
  }
  const rgb = /^rgba?\(\s*(\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(\d{1,3}(?:\.\d+)?)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(value);
  if (!rgb) return null;
  const part = (text: string | undefined) => Math.min(255, Number(text));
  return [part(rgb[1]), part(rgb[2]), part(rgb[3])];
};

/**
 * Black or white, whichever has more WCAG contrast with `color` (a colour someone chose for a
 * tag, say), as #rgb, #rrggbb (with or without alpha) or rgb(). A colour it can't read gets
 * black, and so does none (a tag's colour is nullable). Pure black, not near-black: with
 * #111111 a mid-tone (luminance 0.18–0.20, the picker's #8B5CF6) read at 4.46:1 either way;
 * with black every colour gets 4.58:1 or more.
 */
export const readableOn = (color: string | null | undefined): string => {
  const rgb = typeof color === 'string' ? rgbOf(color) : null;
  if (!rgb) return '#000000';
  const [r, g, b] = rgb;
  const lum = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  // Contrast with white is 1.05 / (lum + 0.05); with black, (lum + 0.05) / 0.05.
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.05 ? '#ffffff' : '#000000';
};

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * A CSS colour as #rrggbb in sRGB. Radix gives wide-gamut screens `color(display-p3 …)`,
 * which nivo's colour library can't read; a 1px canvas converts it. Without a canvas
 * (tests), the value is returned as it is.
 */
const toHex = (value: string): string => {
  if (probe === undefined) {
    try {
      probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    } catch {
      probe = null;
    }
  }
  if (!probe || !value) return value;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  // A 1px image's data is its 4 bytes (RGBA).
  const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
};

const themeElement = (): Element =>
  document.querySelector('[data-is-root-theme="true"]') ?? document.querySelector('.radix-themes') ?? document.documentElement;

const nivoTheme = (c: Pick<ChartColors, keyof typeof ROLES>): PartialTheme => ({
  background: 'transparent',
  text: { fontSize: 12, fill: c.text },
  axis: {
    domain: { line: { stroke: c.axis, strokeWidth: 1 } },
    ticks: { line: { stroke: c.axis, strokeWidth: 1 }, text: { fontSize: 11, fill: c.text } },
    legend: { text: { fontSize: 12, fill: c.textStrong } },
  },
  grid: { line: { stroke: c.grid, strokeWidth: 1 } },
  legends: { text: { fill: c.text } },
  labels: { text: { fill: c.textStrong } },
  tooltip: {
    container: {
      background: c.panel,
      color: c.textStrong,
      fontSize: 12,
      borderRadius: 8,
      border: `1px solid ${c.border}`,
      boxShadow: 'var(--shadow-4)',
    },
  },
  crosshair: { line: { stroke: c.text } },
});

/** Reads the chart colours from the theme element as it is now. */
export const readChartColors = (): ChartColors => {
  const style = getComputedStyle(themeElement());
  const read = (name: string) => {
    const value = style.getPropertyValue(name).trim();
    return value ? toHex(value) : `var(${name})`;
  };
  const roles = Object.fromEntries(Object.entries(ROLES).map(([role, name]) => [role, read(name)])) as Record<
    keyof typeof ROLES,
    string
  >;
  const series = SERIES_HUES.map((hue) => read(`--${hue}-9`));
  const seriesText = SERIES_HUES.map((hue) => read(`--${hue}-contrast`));
  const onColor = new Map<string, string>([
    [roles.accent, read('--accent-contrast')],
    [roles.positive, read('--green-contrast')],
    [roles.negative, read('--red-contrast')],
    [roles.warning, read('--amber-contrast')],
  ]);
  series.forEach((color, at) => {
    const text = seriesText[at];
    if (text !== undefined) onColor.set(color, text);
  });
  const textOn = (color: string) => onColor.get(color) ?? readableOn(toHex(color));
  const colors = { ...roles, series, seriesText, textOn };
  return { ...colors, nivo: nivoTheme(colors) };
};

const sameColors = (a: ChartColors, b: ChartColors) =>
  (Object.keys(ROLES) as (keyof typeof ROLES)[]).every((role) => a[role] === b[role]) &&
  a.series.every((color, i) => color === b.series[i] && a.seriesText[i] === b.seriesText[i]);

// The theme as an external store: Radix applies a theme change as attributes on its root
// element (and the appearance's class on <html>), so an observer on those re-reads the
// colours, and charts re-render only when one changed. A new <Theme> replaces the root
// element: the observer watches its parent's children too, and moves to the new root.
// Before any root is there, it watches the page for one.
let cached: ChartColors | null = null;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
let watchedRoot: Element | null = null;

const refresh = () => {
  const next = readChartColors();
  if (cached && sameColors(cached, next)) return;
  cached = next;
  listeners.forEach((listener) => listener());
};

const HTML_ATTRIBUTES: MutationObserverInit = { attributes: true, attributeFilter: ['class', 'style'] };

/** Observe the theme's root as it is now, and where a new one would appear. */
const watch = (into: MutationObserver) => {
  into.disconnect();
  const html = document.documentElement;
  watchedRoot = themeElement();
  if (watchedRoot === html) {
    into.observe(html, HTML_ATTRIBUTES);
    if (document.body) into.observe(document.body, { childList: true, subtree: true });
    return;
  }
  into.observe(watchedRoot, { attributes: true });
  const parent = watchedRoot.parentNode;
  if (parent === html) {
    into.observe(html, { ...HTML_ATTRIBUTES, childList: true });
  } else {
    into.observe(html, HTML_ATTRIBUTES);
    if (parent) into.observe(parent, { childList: true });
  }
};

const onMutations = (records: MutationRecord[], into: MutationObserver) => {
  const rootChanged = !watchedRoot?.isConnected || themeElement() !== watchedRoot;
  if (rootChanged) watch(into);
  // Children coming and going change no colour; a new root or an attribute may.
  if (rootChanged || records.some((record) => record.type === 'attributes')) refresh();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(onMutations);
    watch(observer);
    // Anything that changed before this subscription (a picker change while no chart was shown).
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
      watchedRoot = null;
    }
  };
};

const getSnapshot = (): ChartColors => (cached ??= readChartColors());

/** The theme's chart colours, current with the theme picker and the appearance. */
export function useChartTheme(): ChartColors {
  return useSyncExternalStore(subscribe, getSnapshot);
}
