import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// How long findBy* and waitFor wait for what they look for: Testing Library's default is
// 1 s, which a page's first render can outlast on a loaded machine, failing the test well
// inside its own 15 s (vitest.config.ts). A call that needs longer says so.
configure({ asyncUtilTimeout: 5000 });

// Cleanup after each test case (unmount React components)
afterEach(() => {
  cleanup();
});

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {}, // deprecated
    removeListener: () => {}, // deprecated
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  takeRecords() {
    return [];
  }
  unobserve() {}
} as unknown as typeof IntersectionObserver;

// Mock scrollIntoView
Element.prototype.scrollIntoView = () => {};

// Mock ResizeObserver (used by Radix UI components; absent in jsdom).
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
