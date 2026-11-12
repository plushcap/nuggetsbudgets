import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Theme } from '@radix-ui/themes';
import { makeTestQueryClient } from '../../test/renderWithProviders';
import toast from 'react-hot-toast';
import ProfilePage from '../ProfilePage';

const auth = vi.hoisted(() => ({
  user: {
    id: 1,
    uuid: 'u-1',
    email: 'ada@example.com',
    first_name: 'Ada',
    last_name: 'Lovelace',
    default_color: '#3B82F6',
    icon: 'User',
    profile_image: undefined as string | undefined,
    created_at: '2026-01-01T00:00:00Z',
  } as Record<string, unknown> | null,
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user, setUser: vi.fn() }) }));
const passkeys = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  useUserPasskeysQuery: () => ({ data: passkeys.list, isLoading: false, refetch: vi.fn() }),
  usePasswordPolicy: () => ({ minLength: 12, maxBytes: 72, requireComplexity: false }),
}));
const api = vi.hoisted(() => ({ updateProfile: vi.fn(), changePassword: vi.fn() }));
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  updateProfile: api.updateProfile,
  changePassword: api.changePassword,
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../components/PushNotificationsCard', () => ({ PushNotificationsCard: () => null }));
vi.mock('../../components/NotificationChoicesCard', () => ({ NotificationChoicesCard: () => null }));

const renderProfile = () =>
  render(
    <QueryClientProvider client={makeTestQueryClient()}>
      <Theme>
        <MemoryRouter initialEntries={['/profile']}>
          <Routes>
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/login" element={<div>login page</div>} />
          </Routes>
        </MemoryRouter>
      </Theme>
    </QueryClientProvider>,
  );

describe('ProfilePage', () => {
  const signedIn = auth.user;
  afterEach(() => {
    auth.user = signedIn;
    passkeys.list = [];
  });

  // Sign-in asks for no email, which only a discoverable passkey can answer.
  describe('passkeys that may not sign in without an email', () => {
    const passkey = (deviceName: string, discoverable: boolean | null) => ({
      id: `cred-${deviceName}`,
      deviceName,
      deviceType: 'singleDevice',
      createdAt: '2026-01-01T00:00:00Z',
      discoverable,
    });

    it('says nothing when every passkey is known to', async () => {
      passkeys.list = [passkey('Phone', true), passkey('Laptop', true)];
      renderProfile();
      expect(await screen.findByText('Phone')).toBeInTheDocument();
      expect(screen.queryByText(/no longer asks for your email/)).toBeNull();
      expect(screen.queryByText(/without your email/)).toBeNull();
    });

    it('tells the person to add a new one, naming the ones that may not', async () => {
      passkeys.list = [passkey('Phone', true), passkey('Old key', null), passkey('Older key', false)];
      renderProfile();
      expect(await screen.findByText(/Signing in with a passkey no longer asks for your email/)).toHaveTextContent(
        /2 of your passkeys aren't known to work that way.*add a new one on that device or key, then delete the old one\. Your password still works\./
      );
      expect(screen.getByText('Not yet known to sign in without your email')).toBeInTheDocument();
      expect(screen.getByText("Can't sign in without your email: add a new passkey to replace it")).toBeInTheDocument();
    });

    it('counts one in the singular', async () => {
      passkeys.list = [passkey('Old key', null)];
      renderProfile();
      expect(await screen.findByText(/One of your passkeys isn't known to work that way/)).toBeInTheDocument();
    });
  });

  it("starts the form from the signed-in user's profile", async () => {
    renderProfile();
    expect(await screen.findByDisplayValue('Ada')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Lovelace')).toBeInTheDocument();
  });

  // These were toasts; they show beside the picture's button, read with it.
  it("says beside the picture's button why a file wasn't taken, and takes the next one", async () => {
    // A chooser set to "All files" lets any file through the input's accept.
    const user = userEvent.setup({ applyAccept: false });
    renderProfile();
    const button = await screen.findByRole('button', { name: 'Upload Image' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    // Out of the tab order: the button is the control.
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input.accept).toBe('image/jpeg,image/png,image/gif,image/webp');

    await user.upload(input, new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    expect(button).toHaveAccessibleDescription('Choose a JPEG, PNG, GIF or WebP image. JPEG, PNG, GIF, or WebP. Max 5MB.');
    const big = new File(['x'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 });
    await user.upload(input, big);
    expect(button).toHaveAccessibleDescription('Choose an image of 5 MB or less. JPEG, PNG, GIF, or WebP. Max 5MB.');
    // Windows offers a JPEG named .jfif for the JPEG type, which the server refuses
    // by its name; the page said only that the save failed.
    await user.upload(input, new File(['jpg'], 'photo.JFIF', { type: 'image/jpeg' }));
    expect(button).toHaveAccessibleDescription(
      "A picture named .jfif isn't taken: choose a .jpg, .jpeg, .png, .gif or .webp file (a JPEG can be renamed .jpg). JPEG, PNG, GIF, or WebP. Max 5MB.",
    );
    await user.upload(input, new File(['jpg'], 'photo', { type: 'image/jpeg' }));
    expect(button).toHaveAccessibleDescription(/^A picture needs its type at the end of its name/);
    expect(toast.error).not.toHaveBeenCalled();

    // Refused, neither is sent; a picture that fits is, and the message goes.
    await user.upload(input, new File(['png'], 'face.png', { type: 'image/png' }));
    expect(button).toHaveAccessibleDescription('JPEG, PNG, GIF, or WebP. Max 5MB.');
    expect(screen.queryByText(/Choose a JPEG/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
    expect((api.updateProfile.mock.calls[0]![0] as FormData).get('profile_image')).toHaveProperty('name', 'face.png');
  });

  it('sends someone signed out to the login page', async () => {
    auth.user = null;
    renderProfile();
    expect(await screen.findByText('login page')).toBeInTheDocument();
  });

  // On react-hook-form, a problem shows beside its field (it was a toast, or for
  // a name only the browser's own check), the first is focused, and nothing is sent.
  describe('refusing a save', () => {
    it('asks for a first name, and keeps it to what the profile route takes', async () => {
      const user = userEvent.setup();
      renderProfile();
      const first = await screen.findByRole('textbox', { name: /First Name/ });
      await user.clear(first);
      await user.click(screen.getByRole('button', { name: /Save Changes/ }));
      await waitFor(() => expect(first).toHaveFocus());
      expect(first).toHaveAccessibleDescription('Enter your first name.');

      await user.type(first, 'A'.repeat(101));
      expect(first).toHaveAccessibleDescription('Keep the first name to 100 characters');
      expect(api.updateProfile).not.toHaveBeenCalled();
    });

    it('says beside each password field what is wrong', async () => {
      const user = userEvent.setup();
      renderProfile();
      await user.click(await screen.findByRole('button', { name: /Change Password/ }));
      await user.type(screen.getByLabelText(/^New Password/), 'too short');
      const submit = () => {
        const buttons = screen.getAllByRole('button', { name: /Change Password/ });
        return user.click(buttons[buttons.length - 1]!);
      };
      await submit();
      const current = screen.getByLabelText(/Current Password/);
      await waitFor(() => expect(current).toHaveFocus());
      expect(current).toHaveAccessibleDescription('Enter your current password.');
      expect(screen.getByLabelText(/^New Password/)).toHaveAccessibleDescription('Password must be at least 12 characters long');

      await user.type(current, 'the old one');
      await user.clear(screen.getByLabelText(/^New Password/));
      await user.type(screen.getByLabelText(/^New Password/), 'a long enough passphrase');
      await user.type(screen.getByLabelText(/Confirm New Password/), 'a long enough passphrasf');
      await submit();
      const confirm = screen.getByLabelText(/Confirm New Password/);
      await waitFor(() => expect(confirm).toHaveFocus());
      expect(confirm).toHaveAccessibleDescription('Passwords do not match');
      expect(api.changePassword).not.toHaveBeenCalled();
    });

    // The icon and colour pickers took no aria-describedby, so their messages were shown
    // under them but not read with them.
    it('reads the icon and colour messages with their pickers', async () => {
      auth.user = { ...signedIn, default_color: '#3B82F6FF', icon: 'I'.repeat(101) };
      const user = userEvent.setup();
      renderProfile();
      await user.click(await screen.findByRole('button', { name: /Save Changes/ }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /^Profile Color/ })).toHaveAccessibleDescription('Give the colour as #RRGGBB'),
      );
      expect(screen.getByRole('button', { name: /^Profile Icon/ })).toHaveAccessibleDescription('Keep the icon name to 100 characters');
      expect(api.updateProfile).not.toHaveBeenCalled();
    });
  });
});
