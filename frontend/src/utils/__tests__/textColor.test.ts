import { describe, it, expect } from 'vitest';
import { chosenColourProps, chosenTintStyle } from '../textColor';

/** WCAG contrast between two #rrggbb colours. */
const contrast = (a: string, b: string) => {
  const lum = (hex: string) => {
    const [r, g, b2] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// White text or icons on a colour someone chose, whatever the colour.
describe('chosenColourProps', () => {
  it('draws on a chosen colour in black or white, whichever reads', () => {
    // A pale yellow and a pale blue from the colour picker: white on them is 1.1–1.3:1.
    for (const pale of ['#FEF08A', '#DBEAFE', '#A7F3D0']) {
      const { style } = chosenColourProps(pale, 'gray');
      expect(style?.backgroundColor).toBe(pale);
      expect(style?.color).not.toBe('#ffffff');
      expect(contrast(pale, String(style?.color))).toBeGreaterThanOrEqual(4.5);
    }
    expect(chosenColourProps('#1E3A8A', 'gray', 'w-6')).toEqual({ className: 'w-6', style: { backgroundColor: '#1E3A8A', color: '#ffffff' } });
  });

  it("with no colour chosen, takes the fallback's fill and its text colour as classes, not an inline style", () => {
    expect(chosenColourProps('', 'accent')).toEqual({ className: 'bg-[var(--accent-9)] text-[var(--accent-contrast)]' });
  });

  // A person with no colour had white initials on gray-9, 3.30:1 on slate (AA wants 4.5:1).
  it('draws initials with no colour chosen in step-12 text on a gray tint', () => {
    expect(chosenColourProps(null, 'gray', 'w-6 h-6')).toEqual({ className: 'w-6 h-6 bg-[var(--gray-5)] text-[var(--gray-12)]' });
    // Radix slate (the default gray), light and dark: gray-12 on gray-5, against white on gray-9.
    expect(contrast('#ffffff', '#8b8d98')).toBeLessThan(4.5);
    expect(contrast('#1c2024', '#e0e1e6')).toBeGreaterThanOrEqual(7);
    expect(contrast('#edeef0', '#2e3135')).toBeGreaterThanOrEqual(7);
  });

  it('with no colour and no fallback, leaves the element its own colours', () => {
    expect(chosenColourProps(undefined, undefined, 'x')).toEqual({ className: 'x' });
  });
});

describe('chosenTintStyle', () => {
  it("draws the icon in a shade of the colour toward the page's text colour, not the colour itself", () => {
    // A pale item colour's icon on its own 12.5% tint was all but invisible.
    expect(chosenTintStyle('#FEF08A')).toEqual({
      backgroundColor: 'color-mix(in srgb, #FEF08A 12.5%, transparent)',
      color: 'color-mix(in srgb, #FEF08A 40%, var(--gray-12))',
    });
  });

  it('leaves the element its own colours with no colour chosen', () => {
    expect(chosenTintStyle(null)).toBeUndefined();
    expect(chosenTintStyle('')).toBeUndefined();
  });
});
