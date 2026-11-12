import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import ProtectedRoute from '../ProtectedRoute';

const auth = vi.hoisted(() => ({
  user: null as null | { id: number; email: string; must_change_password?: boolean },
  forgetSession: vi.fn(),
  logout: vi.fn(),
  sessionError: null as unknown,
  retrySession: vi.fn(),
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: false,
    mayReturnAfterSignIn: () => true,
    sessionError: auth.sessionError,
    retrySession: auth.retrySession,
    retryingSession: false,
    forgetSession: auth.forgetSession,
    logout: auth.logout,
  }),
}));
const changePassword = vi.hoisted(() => vi.fn());
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  changePassword,
}));
vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  usePasswordPolicy: () => ({ minLength: 12, maxBytes: 72, requireComplexity: false }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
import toast from 'react-hot-toast';

const renderRoute = () =>
  renderWithProviders(
    <Theme>
      <ProtectedRoute>
        <div>the app</div>
      </ProtectedRoute>
    </Theme>
  );

async function submit(current: string, next: string, confirm = next) {
  await userEvent.type(screen.getByLabelText(/^current password/i), current);
  await userEvent.type(screen.getByLabelText(/^new password/i), next);
  await userEvent.type(screen.getByLabelText(/^confirm new password/i), confirm);
  await userEvent.click(screen.getByRole('button', { name: /change password/i }));
}

/**
 * Someone whose password an admin set (a new account, or a reset) chooses their own before
 * anything else. The server refuses their session the rest (PASSWORD_CHANGE_REQUIRED).
 */
describe('ProtectedRoute: a password an admin set', () => {
  beforeEach(() => {
    changePassword.mockReset().mockResolvedValue({ success: true });
    auth.forgetSession.mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it('shows the app to a user who chose their own password', () => {
    auth.user = { id: 1, email: 'robin@example.com', must_change_password: false };
    renderRoute();
    expect(screen.getByText('the app')).toBeInTheDocument();
  });

  it('asks for a new password instead of showing the app, then signs the user out to use it', async () => {
    auth.user = { id: 1, email: 'robin@example.com', must_change_password: true };
    renderRoute();
    expect(screen.queryByText('the app')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /choose a new password/i })).toBeInTheDocument();
    expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument();

    await submit('the admin picked this', 'now one only I know');
    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith({
        currentPassword: 'the admin picked this',
        newPassword: 'now one only I know',
      })
    );
    await waitFor(() => expect(auth.forgetSession).toHaveBeenCalledTimes(1));
  });

  it("refuses, with the server's message, a password the policy doesn't allow", async () => {
    auth.user = { id: 1, email: 'robin@example.com', must_change_password: true };
    renderRoute();
    await submit('the admin picked this', 'too short');
    expect(toast.error).toHaveBeenCalledWith('Password must be at least 12 characters long');
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("shows the server's reason when the change is refused", async () => {
    auth.user = { id: 1, email: 'robin@example.com', must_change_password: true };
    changePassword.mockRejectedValue(Object.assign(new Error('Current password is incorrect'), { status: 403 }));
    renderRoute();
    await submit('not what the admin set', 'now one only I know');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Current password is incorrect'));
    expect(auth.forgetSession).not.toHaveBeenCalled();
  });
});

// The session probe failing (a restart, a 502) is not being signed out.
describe('ProtectedRoute: the server is away', () => {
  it('shows a retry instead of sending a signed-in person to sign-in', async () => {
    auth.user = null;
    auth.sessionError = Object.assign(new Error('Bad gateway'), { status: 502, requestId: 'r-7' });
    renderRoute();
    expect(screen.getByRole('heading', { name: "Can't reach Nuggets", level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Reference r-7')).toBeInTheDocument();
    expect(screen.queryByText('the app')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(auth.retrySession).toHaveBeenCalled();
    auth.sessionError = null;
  });
});
