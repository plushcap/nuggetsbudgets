import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { adminUser, adminUserUpdated, type AdminUserWire } from '../../test/fixtures';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { apiError, mockApi } from '../../test/apiServer';
import UserManagementPage from '../UserManagementPage';

/**
 * Settings → Users against the API (only `fetch` is stubbed). Delete sent the user's
 * numeric id to DELETE /admin/users/:uuid, which answered 404, and every refusal showed
 * "Error deleting user": now it sends the uuid and shows the server's reason, such
 * as LAST_ADMIN naming the places the user is the only admin of.
 */

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 1 }, isDeploymentAdmin: true }) }));

const person = (id: number, uuid: string, first_name: string, extra: Partial<AdminUserWire> = {}) =>
  adminUser({ created_at: '2026-01-02T03:04:05.000Z', ...extra, id, uuid, first_name });
const me = person(1, '01900000-0000-7000-8000-000000000001', 'Admin', { is_deployment_admin: true });
const sole = person(7, '01900000-0000-7000-8000-000000000007', 'Sole');

let api: ReturnType<typeof mockApi>;
const routes = (overrides: Record<string, unknown> = {}) => ({
  'GET /admin/users': { users: [me, sole] },
  'DELETE /admin/users/:uuid': { message: 'User deleted successfully', deletedUser: { id: sole.id, email: sole.email } },
  'PUT /admin/users/:uuid': adminUserUpdated(sole),
  ...overrides,
});

const toastMock = async () => (await import('react-hot-toast')).default;

/** Delete Sole from the table, confirming in the dialog. */
const deleteSole = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Delete user Sole Doe' }));
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Delete User' }));
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('UserManagementPage', () => {
  // users.last_name is nullable; the page named such a person "Mono null".
  it('names a person with no last name by the name they have, and confirms deleting them so', async () => {
    const mono = person(9, '01900000-0000-7000-8000-000000000009', 'Mono', { last_name: null });
    api = mockApi(routes({ 'GET /admin/users': { users: [me, sole, mono] } }));
    const user = userEvent.setup();
    renderWithProviders(<Theme><UserManagementPage /></Theme>);
    await user.click(await screen.findByRole('button', { name: 'Delete user Mono' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Are you sure you want to delete Mono?')).toBeInTheDocument();
    expect(screen.queryByText(/null/)).toBeNull();
  });

  it('deletes a user by uuid', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderWithProviders(<Theme><UserManagementPage /></Theme>);
    await deleteSole(user);

    await waitFor(() => expect(api.calls('DELETE /admin/users/:uuid')).toHaveLength(1));
    expect(api.calls('DELETE /admin/users/:uuid')[0].params.uuid).toBe(sole.uuid);
    expect(api.unhandled).toEqual([]);
    const toast = await toastMock();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('User deleted successfully'));
  });

  it("shows the server's reason when it refuses, naming what the user is the only admin of", async () => {
    api = mockApi(
      routes({
        'DELETE /admin/users/:uuid': apiError(
          409,
          'This user is the only admin of the organization "Doe family" and of the tenant "Household". Make someone else an admin of each first.',
          'LAST_ADMIN'
        ),
      })
    );
    const user = userEvent.setup();
    renderWithProviders(<Theme><UserManagementPage /></Theme>);
    await deleteSole(user);

    const toast = await toastMock();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'This user is the only admin of the organization "Doe family" and of the ledger "Household". Make someone else an admin of each first.'
      )
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  // The page looked for the code in the message, which is the server's text: it never matched.
  it("shows the server's reason when it refuses a lock or sign-in change", async () => {
    api = mockApi(
      routes({
        'PUT /admin/users/:uuid': apiError(400, 'Cannot disable login on your own account', 'CANNOT_DISABLE_OWN_LOGIN'),
      })
    );
    const user = userEvent.setup();
    renderWithProviders(<Theme><UserManagementPage /></Theme>);
    const [signIn] = await screen.findAllByRole('switch', { name: 'Disable sign-in for Admin Doe' });
    await user.click(signIn);

    await waitFor(() => expect(api.calls('PUT /admin/users/:uuid')).toHaveLength(1));
    expect(api.calls('PUT /admin/users/:uuid')[0]).toMatchObject({ params: { uuid: me.uuid }, body: { login_disabled: true } });
    const toast = await toastMock();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Cannot disable login on your own account'));
  });
});
