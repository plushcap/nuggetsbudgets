import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** A QueryClient configured for deterministic tests (no retries, no caching). */
export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

/** Render a component wrapped in a fresh QueryClient + MemoryRouter. */
export function renderWithProviders(
  ui: ReactElement,
  { client = makeTestQueryClient(), route = '/' }: { client?: QueryClient; route?: string } = {}
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return { client, ...render(ui, { wrapper: Wrapper }) };
}
