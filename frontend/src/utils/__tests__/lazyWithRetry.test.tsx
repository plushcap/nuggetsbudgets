import React, { Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lazyWithRetry } from '../lazyWithRetry';

vi.mock('../logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <p>failed</p> : this.props.children;
  }
}

const reload = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  sessionStorage.clear();
  reload.mockReset();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  vi.restoreAllMocks();
});

const renderLazy = (factory: () => Promise<{ default: React.FC }>) => {
  const Lazy = lazyWithRetry(factory);
  render(
    <Boundary>
      <Suspense fallback={<p>loading</p>}>
        <Lazy />
      </Suspense>
    </Boundary>,
  );
};

describe('lazyWithRetry', () => {
  it('reloads once when the import keeps failing', async () => {
    renderLazy(() => Promise.reject(new Error('chunk 404')));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem('nuggets:chunk-reloaded')).toBe('1');
  });

  it('shows the error instead of reloading when it already reloaded', async () => {
    sessionStorage.setItem('nuggets:chunk-reloaded', '1');
    renderLazy(() => Promise.reject(new Error('chunk 404')));
    expect(await screen.findByText('failed')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("doesn't reload when storage can't hold the flag, so it can't loop", async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    renderLazy(() => Promise.reject(new Error('chunk 404')));
    expect(await screen.findByText('failed')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('renders the component once the import succeeds', async () => {
    renderLazy(() => Promise.resolve({ default: () => <p>loaded</p> }));
    expect(await screen.findByText('loaded')).toBeInTheDocument();
  });

  it('renders a successful import even when storage throws', async () => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
    }
    const factory = vi.fn(() => Promise.resolve({ default: () => <p>loaded</p> }));
    renderLazy(factory);
    expect(await screen.findByText('loaded')).toBeInTheDocument();
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
