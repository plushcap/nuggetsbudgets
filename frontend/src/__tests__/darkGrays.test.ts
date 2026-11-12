import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The dark theme overrides the solid gray steps (index.css) but left Radix's
 * alpha ones, so `color="gray"` text (gray-a11) and var(--gray-11) were two greys.
 */
const css = fs.readFileSync(path.resolve(import.meta.dirname, '../index.css'), 'utf8');
const darkBlock = /\.dark,\s*\.dark-theme\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
const variable = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]+)`, 'i').exec(darkBlock)?.[1];

const channels = (hex: string) => {
  const h = hex.slice(1);
  const full = h.length <= 4 ? [...h].map((d) => d + d).join('') : h;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
  const a = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
};
/** `top` (with its alpha) over the opaque `bottom`, as 0-255 channels. */
const over = (top: string, bottom: string) => {
  const t = channels(top);
  const u = channels(bottom);
  return [t.r * t.a + u.r * (1 - t.a), t.g * t.a + u.g * (1 - t.a), t.b * t.a + u.b * (1 - t.a)];
};
const luminance = ([r, g, b]: number[]) => {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const rgbOf = (hex: string) => {
  const { r, g, b } = channels(hex);
  return [r, g, b];
};

describe('the dark theme has one grey', () => {
  const page = variable('gray-1')!;

  it('the page background is gray-1', () => {
    expect(variable('color-background')).toBe(page);
  });

  it.each([1, 2, 3, 4, 5, 6, 11, 12])('gray-a%i over the page is gray-%i', (step) => {
    const alpha = variable(`gray-a${step}`);
    const solid = variable(`gray-${step}`);
    expect(alpha, `--gray-a${step}`).toBeDefined();
    const composite = over(alpha!, page);
    rgbOf(solid!).forEach((channel, i) => expect(Math.abs(composite[i] - channel)).toBeLessThanOrEqual(1));
  });

  it("leaves Radix's input borders, solid fills and placeholders (steps 7-10) alone", () => {
    for (const step of [7, 8, 9, 10]) expect(variable(`gray-a${step}`), `--gray-a${step}`).toBeUndefined();
  });

  it('gray text reads on the page, a card and a hovered row', () => {
    const text = variable('gray-a11')!;
    for (const surface of ['gray-1', 'gray-2', 'gray-3']) {
      const bg = rgbOf(variable(surface)!);
      expect(contrast(over(text, variable(surface)!), bg), surface).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('text on a solid gray fill reads on it', () => {
    expect(contrast(rgbOf(variable('gray-contrast')!), rgbOf(variable('gray-9')!))).toBeGreaterThanOrEqual(4.5);
  });
});
