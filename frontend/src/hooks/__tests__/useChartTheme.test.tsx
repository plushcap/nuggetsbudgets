import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { readableOn, useChartTheme } from '../useChartTheme';
import { colorPresets } from '../../components/colorPresets';

/**
 * Charts take their colours from the Radix theme: the values of its variables on
 * the theme's element, read again when Radix changes that element (the accent picker,
 * the appearance), so nivo gets real colours that follow the picker.
 */

let root: HTMLDivElement;
const setVars = (vars: Record<string, string>) => {
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
};

beforeEach(() => {
  root = document.createElement('div');
  root.setAttribute('data-is-root-theme', 'true');
  root.setAttribute('data-accent-color', 'indigo');
  document.body.appendChild(root);
  setVars({ '--accent-9': '#3e63dd', '--accent-contrast': '#ffffff', '--gray-11': '#60646c', '--gray-12': '#1c2024', '--green-9': '#30a46c' });
});
afterEach(() => root.remove());

describe('useChartTheme', () => {
  it("reads the theme's colours and builds nivo's theme from them", () => {
    const { result } = renderHook(() => useChartTheme());
    expect(result.current.accent).toBe('#3e63dd');
    expect(result.current.text).toBe('#60646c');
    expect(result.current.nivo.axis?.ticks?.text?.fill).toBe('#60646c');
    expect(result.current.nivo.tooltip?.container?.color).toBe('#1c2024');
    // A label on the accent is the accent's contrast colour; on a colour someone chose,
    // near-black or white, whichever reads better (WCAG contrast).
    expect(result.current.textOn('#3e63dd')).toBe('#ffffff');
    expect(result.current.textOn('#10b981')).toBe('#000000'); // white would be 2.5:1
    expect(result.current.textOn('#1e3a8a')).toBe('#ffffff');
  });

  it('follows the accent picker: a change to the theme element re-reads the colours', async () => {
    const { result } = renderHook(() => useChartTheme());
    expect(result.current.accent).toBe('#3e63dd');
    await act(async () => {
      setVars({ '--accent-9': '#46a758' });
      root.setAttribute('data-accent-color', 'grass');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.accent).toBe('#46a758');
  });

  // It watched the first root it found, so a chart that stayed while <Theme> was
  // mounted anew kept the old root's colours.
  it('moves to a new theme root that replaces the one it watched', async () => {
    const { result } = renderHook(() => useChartTheme());
    expect(result.current.accent).toBe('#3e63dd');
    const replaced = root;
    await act(async () => {
      root = document.createElement('div');
      root.setAttribute('data-is-root-theme', 'true');
      setVars({ '--accent-9': '#e54666', '--gray-11': '#60646c', '--gray-12': '#1c2024' });
      replaced.replaceWith(root);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.accent).toBe('#e54666');

    // And it follows the new root's changes.
    await act(async () => {
      setVars({ '--accent-9': '#12a594' });
      root.setAttribute('data-accent-color', 'teal');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.accent).toBe('#12a594');
  });

  // It read only #rrggbb, and took any other colour for a light one.
  it('reads a short hex, an alpha and rgb() when picking black or white text', () => {
    expect(readableOn('#000')).toBe('#ffffff');
    expect(readableOn('#FFF')).toBe('#000000');
    expect(readableOn('#1e3a8a80')).toBe('#ffffff');
    expect(readableOn('#00f8')).toBe('#ffffff');
    expect(readableOn('rgb(30, 58, 138)')).toBe('#ffffff');
    expect(readableOn('rgba(16, 185, 129, 0.5)')).toBe('#000000');
    expect(readableOn('rgb(30 58 138 / 50%)')).toBe('#ffffff');
    expect(readableOn(' #1e3a8a ')).toBe('#ffffff');
    for (const unreadable of ['', 'blue', '#' + '12', '#' + '12345', 'rgb(1, 2)', 'hsl(0 0% 0%)']) {
      expect(readableOn(unreadable), unreadable).toBe('#000000');
    }
  });

  // Near-black (#111111) on the picker's #8B5CF6 was 4.46:1, and so was white.
  it('picks text that reads at 4.5:1 or more on every preset colour', () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const under = colorPresets
      .map((color) => ({ color, ratio: contrast(color, readableOn(color)) }))
      .filter(({ ratio }) => ratio < 4.5);
    expect(under).toEqual([]);
  });

  // A tag's colour is nullable, and the transaction page's badges pass it on.
  it('answers black for no colour at all, rather than throw', () => {
    expect(readableOn(null)).toBe('#000000');
    expect(readableOn(undefined)).toBe('#000000');
  });

  it('keeps the same object while nothing changed, so charts don\'t re-render for nothing', async () => {
    const { result } = renderHook(() => useChartTheme());
    const first = result.current;
    await act(async () => {
      root.setAttribute('data-panel-background', 'solid');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current).toBe(first);
  });
});
