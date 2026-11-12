import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Toaster } from 'react-hot-toast';
import { Route, Routes } from 'react-router-dom';
import { loginSchema } from '@nuggets/shared';
import { renderWithProviders } from '../../test/renderWithProviders';
import { loginAnswer, membership as noLedgers, ownAccount } from '../../test/fixtures';
import { apiError, mockApi } from '../../test/apiServer';
import { AuthProvider } from '../../contexts/AuthContext';
import LoginPage from '../LoginPage';

/**
 * Signing in through the real AuthProvider, against the API: what the form
 * sends, where a good sign-in lands, and that a refused one shows the server's
 * reason and is not taken for an expired session.
 */

vi.mock('../../utils/pushNotifications', () => ({
  disablePushOnSignOut: vi.fn(async () => {}),
  syncPushSubscription: vi.fn(async () => {}),
}));

/** GET/POST /auth/*, from the shared schemas (fixtures.ts). */
const ada = ownAccount({ id: 1, uuid: '0190a000-0006-7000-8000-000000000001', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' });
const membership = noLedgers();

let api: ReturnType<typeof mockApi>;
const routes = (overrides: Parameters<typeof mockApi>[0] = {}) => ({
  // Not signed in yet.
  'GET /auth/me': apiError(401, 'Not signed in', 'UNAUTHENTICATED'),
  'GET /auth/setup-status': { setupComplete: true, requiresSetup: false },
  'GET /auth/tenants': membership,
  'GET /auth/password-policy': { minLength: 12 },
  'POST /auth/login': loginAnswer(ada),
  ...overrides,
});

const renderLogin = () =>
  renderWithProviders(
    <Theme>
      <Toaster />
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<p>Dashboard</p>} />
        </Routes>
      </AuthProvider>
    </Theme>,
    { route: '/login' },
  );

const signIn = async (email: string, password: string) => {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email address'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
};

const expired = vi.fn();
afterEach(() => {
  window.removeEventListener('session-expired', expired);
  expired.mockClear();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('LoginPage signing in', () => {
  it('sends the email and password the API takes, and lands on the dashboard', async () => {
    api = mockApi(routes());
    renderLogin();

    await signIn('ada@example.com', 'correct horse battery staple');

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    const [request] = api.calls('POST /auth/login');
    expect(request.body).toEqual({ email: 'ada@example.com', password: 'correct horse battery staple' });
    expect(loginSchema.safeParse(request.body).success).toBe(true);
    // Sign-in takes JSON only, and must keep the session cookie it sets.
    expect(request.headers.get('Content-Type')).toBe('application/json');
    expect(request.credentials).toBe('include');
    expect(api.unhandled).toEqual([]);
  });

  it("shows the server's reason for a wrong password and stays, without calling it an expired session", async () => {
    api = mockApi(routes({ 'POST /auth/login': apiError(401, 'Invalid email or password', 'INVALID_CREDENTIALS') }));
    window.addEventListener('session-expired', expired);
    renderLogin();

    await signIn('ada@example.com', 'wrong');

    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
    expect(screen.queryByText(/session has expired/i)).toBeNull();
    expect(expired).not.toHaveBeenCalled();
    expect(screen.queryByText('Dashboard')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled());
  });

  it('shows a throttled sign-in as the server words it', async () => {
    api = mockApi(routes({ 'POST /auth/login': apiError(429, 'Too many sign-in attempts. Try again in 15 minutes.', 'LOGIN_THROTTLED') }));
    renderLogin();

    await signIn('ada@example.com', 'wrong');

    expect(await screen.findByText('Too many sign-in attempts. Try again in 15 minutes.')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).toBeNull();
  });
});
