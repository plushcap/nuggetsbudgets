import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import EditUserPage from '../EditUserPage';

const updateUserWithImage = vi.fn().mockResolvedValue({});
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    updateUserWithImage: (...args: unknown[]) => updateUserWithImage(...args),
    changeUserPassword: vi.fn().mockResolvedValue({}),
    deleteAdminUserPasskey: vi.fn().mockResolvedValue({}),
    setUserDeploymentAdmin: vi.fn().mockResolvedValue({}),
  };
});

const adminUser = {
  id: 1,
  uuid: 'user-1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
  is_deployment_admin: false,
  default_color: '#3B82F6',
  icon: 'User',
  profile_image: null,
};

// Stable references, as query data is.
const adminUsers = [adminUser];
const emptyArr: never[] = [];
const users = vi.hoisted(() => ({ list: null as unknown[] | null }));
const passkeyList = vi.hoisted(() => ({ list: null as unknown[] | null }));

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  return {
    ...actual,
    useAdminUsersQuery: () => ({ data: users.list ?? adminUsers, isLoading: false }),
    useAdminUserPasskeysQuery: () => ({ data: passkeyList.list ?? emptyArr, isLoading: false, refetch: vi.fn() }),
    usePasswordPolicy: () => ({ minLength: 12, maxBytes: 72, requireComplexity: false }),
  };
});

// Current user differs from the edited user so the admin checkbox renders.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 999 } }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate, useParams: () => ({ uuid: 'user-1' }) };
});
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
import toast from 'react-hot-toast';

const renderPage = () => renderWithProviders(<Theme><EditUserPage /></Theme>);

describe('EditUserPage (react-hook-form)', () => {
  beforeEach(() => { updateUserWithImage.mockClear(); navigate.mockClear(); });

  it('seeds the form from the loaded user and saves edits as multipart', async () => {
    renderPage();
    const firstName = await screen.findByDisplayValue('Ada');
    await userEvent.clear(firstName);
    await userEvent.type(firstName, 'Augusta');
    await userEvent.click(screen.getByRole('button', { name: /update user/i }));
    await waitFor(() => expect(updateUserWithImage).toHaveBeenCalledTimes(1));
    const [uuidArg, formArg] = updateUserWithImage.mock.calls[0];
    expect(uuidArg).toBe('user-1');
    expect(formArg).toBeInstanceOf(FormData);
    expect(formArg.get('first_name')).toBe('Augusta');
    expect(formArg.get('last_name')).toBe('Lovelace');
    expect(navigate).toHaveBeenCalledWith('/settings/users');
  });

  it("says which of the user's passkeys can't sign in without an email", async () => {
    const key = (id: string, deviceName: string, discoverable: boolean | null) => ({ id, deviceName, createdAt: '2026-01-02T00:00:00Z', discoverable });
    passkeyList.list = [key('a', 'Laptop', true), key('b', 'Old key', false), key('c', 'Phone', null)];
    try {
      renderPage();
      expect(await screen.findByText('Laptop')).toBeInTheDocument();
      expect(screen.getByText("Can't sign in without an email: they need to add a new passkey to replace it")).toBeInTheDocument();
      expect(screen.getByText('Not yet known to sign in without an email')).toBeInTheDocument();
      // One of each: the discoverable one says nothing.
      expect(screen.getAllByText(/sign in without an email/)).toHaveLength(2);
    } finally {
      passkeyList.list = null;
    }
  });

  it('names the user being edited in the header, as edited', async () => {
    renderPage();
    // The header shows it twice: one layout for phones, one for wider screens.
    expect(await screen.findAllByText('Update user information for Ada Lovelace')).not.toHaveLength(0);
    const lastName = screen.getByDisplayValue('Lovelace');
    await userEvent.clear(lastName);
    await userEvent.type(lastName, 'King');
    expect(screen.getAllByText('Update user information for Ada King')).not.toHaveLength(0);
  });

  it('says a user who is not there is not found, and goes back to the list', async () => {
    users.list = emptyArr;
    try {
      renderPage();
      expect(await screen.findByText('User not found')).toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith('User not found');
      expect(navigate).toHaveBeenCalledWith('/settings/users');
    } finally {
      users.list = null;
    }
  });

  it('blocks save when the first name is cleared', async () => {
    renderPage();
    const firstName = await screen.findByDisplayValue('Ada');
    await userEvent.clear(firstName);
    await userEvent.click(screen.getByRole('button', { name: /update user/i }));
    expect(await screen.findByText(/first name is required/i)).toBeInTheDocument();
    expect(updateUserWithImage).not.toHaveBeenCalled();
  });

  // The picture's checks were toasts, from a raw file input; they show beside its button,
  // as on My Profile, by the server's types, names and size.
  it("says beside the picture's button why a file wasn't taken, and sends the next one", async () => {
    vi.mocked(toast.error).mockClear();
    // A chooser set to "All files" lets any file through the input's accept.
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    const button = await screen.findByRole('button', { name: 'Upload Image' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).toHaveAttribute('tabindex', '-1');
    const hint = 'Upload a profile image (JPEG, PNG, GIF, WebP). Maximum size: 5MB.';

    await user.upload(input, new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    expect(button).toHaveAccessibleDescription(`Choose a JPEG, PNG, GIF or WebP image. ${hint}`);
    await user.upload(input, new File(['jpg'], 'photo.jfif', { type: 'image/jpeg' }));
    expect(button).toHaveAccessibleDescription(/^A picture named \.jfif isn't taken/);
    expect(toast.error).not.toHaveBeenCalled();

    await user.upload(input, new File(['png'], 'face.png', { type: 'image/png' }));
    expect(button).toHaveAccessibleDescription(hint);
    await user.click(screen.getByRole('button', { name: /update user/i }));
    await waitFor(() => expect(updateUserWithImage).toHaveBeenCalledTimes(1));
    expect((updateUserWithImage.mock.calls[0][1] as FormData).get('profile_image')).toHaveProperty('name', 'face.png');
  });

  // The colour and icon had no checks and no message; bounded as My Profile bounds them,
  // a problem shows beside its picker, read with it.
  it('refuses a colour My Profile would refuse, beside the colour picker', async () => {
    users.list = [{ ...adminUser, default_color: '#3B82F6FF' }];
    try {
      renderPage();
      await screen.findByDisplayValue('Ada');
      await userEvent.click(screen.getByRole('button', { name: /update user/i }));
      expect(await screen.findByText('Give the colour as #RRGGBB')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Default Color/ })).toHaveAccessibleDescription('Give the colour as #RRGGBB');
      expect(updateUserWithImage).not.toHaveBeenCalled();
    } finally {
      users.list = null;
    }
  });
});
