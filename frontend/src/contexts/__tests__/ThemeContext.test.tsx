import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../ThemeContext';

// A matchMedia whose "prefers dark" answer the test can flip, firing 'change'.
let systemDark = false;
let listeners: ((e: MediaQueryListEvent) => void)[] = [];
const originalMatchMedia = window.matchMedia;

const setSystemDark = (dark: boolean) => {
  systemDark = dark;
  act(() => listeners.forEach((l) => l({ matches: dark } as MediaQueryListEvent)));
};

function Probe() {
  const { theme, setTheme, setAccentColor } = useTheme();
  return (
    <>
      <span data-testid="theme">{theme}</span>
      <button onClick={() => setTheme('light')}>light</button>
      <button onClick={() => setTheme('dark')}>dark</button>
      <button onClick={() => setAccentColor('green')}>green</button>
    </>
  );
}

const renderProbe = () =>
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );

beforeEach(() => {
  systemDark = false;
  listeners = [];
  localStorage.clear();
  window.matchMedia = ((query: string) => ({
    matches: systemDark,
    media: query,
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.push(l),
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => {
      listeners = listeners.filter((x) => x !== l);
    },
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe('ThemeProvider appearance', () => {
  it('follows the system appearance until the user chooses one', () => {
    renderProbe();
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    setSystemDark(true);
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
    // Changing another theme setting doesn't pin the appearance.
    act(() => screen.getByRole('button', { name: 'green' }).click());
    setSystemDark(false);
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(JSON.parse(localStorage.getItem('nuggets-theme-prefs')!)).toEqual({ accentColor: 'green' });
  });

  it('keeps the chosen appearance when the system changes, and across reloads', () => {
    const { unmount } = renderProbe();
    act(() => screen.getByRole('button', { name: 'light' }).click());
    setSystemDark(true);
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    unmount();
    renderProbe();
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
  });

  it('keeps a legacy stored appearance, moving it into the prefs', () => {
    localStorage.setItem('nuggets-theme', 'dark');
    renderProbe();
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(JSON.parse(localStorage.getItem('nuggets-theme-prefs')!)).toEqual({ appearance: 'dark' });
    expect(localStorage.getItem('nuggets-theme')).toBeNull();
  });

  it('never writes the legacy appearance key', () => {
    renderProbe();
    act(() => screen.getByRole('button', { name: 'dark' }).click());
    expect(JSON.parse(localStorage.getItem('nuggets-theme-prefs')!)).toEqual({ appearance: 'dark' });
    expect(localStorage.getItem('nuggets-theme')).toBeNull();
  });

  it('works when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    renderProbe();
    act(() => screen.getByRole('button', { name: 'light' }).click());
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
  });
});
