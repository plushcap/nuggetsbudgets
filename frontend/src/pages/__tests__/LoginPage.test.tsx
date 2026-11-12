import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Theme } from '@radix-ui/themes';
import { makeTestQueryClient } from '../../test/renderWithProviders';
import LoginPage from '../LoginPage';

const auth = vi.hoisted(() => ({ user: { id: 1, email: 'me@example.com' } as { id: number; email: string } | null }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ login: vi.fn(), user: auth.user }) }));
const setup = vi.hoisted(() => ({
  ok: { isLoading: false, isError: false, data: { setupComplete: true } } as Record<string, unknown>,
  query: {} as Record<string, unknown>,
  refetch: vi.fn(),
}));
setup.query = setup.ok;
vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  return { ...actual, useSetupStatusQuery: () => setup.query };
});

const Where = () => {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}${location.hash}`}</div>;
};

const renderLogin = () =>
  render(
    <QueryClientProvider client={makeTestQueryClient()}>
      <Theme>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </MemoryRouter>
      </Theme>
    </QueryClientProvider>
  );

describe('LoginPage', () => {
  afterEach(() => {
    localStorage.clear();
    auth.user = { id: 1, email: 'me@example.com' };
    setup.query = setup.ok;
  });

  // A slow restart used to send a signed-out visitor to "Set up your admin account".
  it("shows a retry, not first-run setup, when the server doesn't say whether setup ran", async () => {
    auth.user = null;
    setup.query = { isLoading: false, isError: true, error: new TypeError('Failed to fetch'), data: undefined, isFetching: false, refetch: setup.refetch };
    render(
      <QueryClientProvider client={makeTestQueryClient()}>
        <Theme>
          <MemoryRouter initialEntries={['/login']}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </Theme>
      </QueryClientProvider>
    );
    expect(screen.getByRole('heading', { name: "Can't reach Nuggets", level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId('where')).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(setup.refetch).toHaveBeenCalled();
  });

  it('fills in a remembered email, with "Remember my email" ticked', async () => {
    auth.user = null;
    localStorage.setItem('nuggets_remembered_email', 'ada@example.com');
    renderLogin();
    expect(await screen.findByLabelText('Email address')).toHaveValue('ada@example.com');
    expect(screen.getByRole('checkbox', { name: 'Remember my email' })).toBeChecked();
  });

  it('starts empty without one', async () => {
    auth.user = null;
    renderLogin();
    expect(await screen.findByLabelText('Email address')).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Remember my email' })).not.toBeChecked();
  });

  it('returns to the page that sent here with its query and hash (an invitation link’s token)', async () => {
    const from = { pathname: '/invitations/accept', search: '?x=1', hash: '#aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-abcde' };
    render(
      <QueryClientProvider client={makeTestQueryClient()}>
        <Theme>
          <MemoryRouter initialEntries={[{ pathname: '/login', state: { from } }]}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </Theme>
      </QueryClientProvider>
    );
    expect((await screen.findByTestId('where')).textContent).toBe(`${from.pathname}${from.search}${from.hash}`);
  });

  // The page that sent here is a path on this app; https://app//evil.example came back
  // to the sign-in page as the pathname //evil.example, which the browser reads as another host.
  it.each(['//evil.example', '/\\evil.example/x'])('goes home, not to %j', async (pathname) => {
    render(
      <QueryClientProvider client={makeTestQueryClient()}>
        <Theme>
          <MemoryRouter initialEntries={[{ pathname: '/login', state: { from: { pathname, search: '', hash: '' } } }]}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </Theme>
      </QueryClientProvider>
    );
    expect((await screen.findByTestId('where')).textContent).toBe('/');
  });
});
