import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import PageContainer from '../PageContainer';

const root = (ui: React.ReactElement) => {
  const { container } = render(<Theme>{ui}</Theme>);
  return container.querySelector('[data-page-width]') as HTMLElement;
};

describe('PageContainer', () => {
  it('is wide by default: 1600px at most, centred, with the page gutters', () => {
    const el = root(<PageContainer>x</PageContainer>);
    expect(el.dataset.pageWidth).toBe('wide');
    expect(el.style.getPropertyValue('--max-width')).toBe('1600px');
    // Centred by Radix's mx="auto": its margin class, with both margins auto.
    expect(el.className).toMatch(/(?:^|\s)rt-r-mx(?:\s|$)/);
    expect(el.style.getPropertyValue('--ml')).toBe('auto');
    expect(el.style.getPropertyValue('--mr')).toBe('auto');
    expect(el.className).toMatch(/rt-r-px-4/);
    expect(el.className).toMatch(/sm:rt-r-px-6/);
  });

  it.each([
    ['form', '3'],
    ['editor', '4'],
    ['auth', '1'],
  ] as const)('gives a %s page Radix Container size %s, with the same gutters', (width, size) => {
    const el = root(<PageContainer width={width}>x</PageContainer>);
    expect(el.dataset.pageWidth).toBe(width);
    expect(el.className).toMatch(new RegExp(`rt-r-size-${size}`));
    expect(el.className).toMatch(/rt-r-px-4/);
    expect(el.className).toMatch(/sm:rt-r-px-6/);
  });
});
