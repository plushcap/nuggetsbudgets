import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import ErrorBoundary from '../ErrorBoundary';

const Boom = ({ explode }: { explode: boolean }) => {
  if (explode) throw new Error('kaboom');
  return <div>safe content</div>;
};

const renderBoundary = (ui: React.ReactElement) => render(<Theme>{ui}</Theme>);

describe('ErrorBoundary', () => {
  // React logs caught errors to console.error; silence it for clean test output.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    renderBoundary(
      <ErrorBoundary>
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('safe content')).toBeInTheDocument();
  });

  it('renders a recoverable fallback when a child throws', () => {
    renderBoundary(
      <ErrorBoundary>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload page/i })).toBeInTheDocument();
  });

  it('renders a custom fallback when provided', () => {
    renderBoundary(
      <ErrorBoundary fallback={<div>custom fallback</div>}>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByText('custom fallback')).toBeInTheDocument();
  });

  it('clears the error and re-renders children when resetKeys change', () => {
    const { rerender } = renderBoundary(
      <ErrorBoundary resetKeys={['/a']}>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    // Simulate navigating to a new route with a child that no longer throws.
    rerender(
      <Theme>
        <ErrorBoundary resetKeys={['/b']}>
          <Boom explode={false} />
        </ErrorBoundary>
      </Theme>,
    );
    expect(screen.getByText('safe content')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });
});
