import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { toast } from 'react-hot-toast';
import { handleResponse } from '../../services/api/base';
import EditAccountPage from '../EditAccountPage';

// An org admin by default, who may connect the account to the bank.
const auth = vi.hoisted(() => ({ orgRole: 'admin' as string | null, isDeploymentAdmin: false }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const updateAccount = vi.fn().mockResolvedValue({});

// Stable reference so the seed effect (deps include `account`) doesn't re-fire
// every render and loop.
const account = {
  id: 5,
  uuid: 'account-1',
  name: 'Checking',
  type: 'Asset',
  account_type: 'checking',
  account_group: 'cash',
  institution_id: null,
  account_number: '1234',
  routing_number: '',
  calculated_balance: 250,
  close_account: false,
  notes: 'main account',
  instructions: '',
  account_image: null,
  icon: 'CreditCard',
  custom_sort: null,
  subtype: '',
  hide_transactions: false,
  hide_account: false,
  exclude_account_balance: false,
  is_envelope_account: false,
  require_zero_balance: false,
  import_account_id: null,
  import_enabled: false,
  import_account_rebalance: false,
};
const emptyArr: never[] = [];

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  const noop = () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  return {
    ...actual,
    useAccountQuery: () => ({ data: account, isLoading: false }),
    useInstitutionsQuery: () => ({ data: emptyArr, isLoading: false }),
    useUsersQuery: () => ({ data: emptyArr, isLoading: false }),
    useUpdateAccountWithImageMutation: () => ({ mutateAsync: updateAccount, isPending: false }),
    useUpdateAccountImportSettingsMutation: noop,
  };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate, useParams: () => ({ uuid: 'account-1' }) };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const renderPage = () => renderWithProviders(<Theme><EditAccountPage /></Theme>);

describe('EditAccountPage (react-hook-form)', () => {
  beforeEach(() => {
    updateAccount.mockClear();
    navigate.mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it('seeds the form from the loaded account and saves edits as multipart', async () => {
    renderPage();
    const nameInput = await screen.findByDisplayValue('Checking');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Primary Checking');
    await userEvent.click(screen.getByRole('button', { name: /update account/i }));
    await waitFor(() => expect(updateAccount).toHaveBeenCalledTimes(1));
    const arg = updateAccount.mock.calls[0][0];
    expect(arg.uuid).toBe('account-1');
    expect(arg.formData).toBeInstanceOf(FormData);
    expect(arg.formData.get('name')).toBe('Primary Checking');
    expect(arg.formData.get('account_type')).toBe('checking');
    expect(navigate).toHaveBeenCalledWith('/accounts');
  });

  it('offers bank discovery to an org admin only', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: /discover bank accounts/i })).toBeInTheDocument();
  });

  it('tells a ledger member that an org admin connects the bank', async () => {
    auth.orgRole = 'member';
    try {
      renderPage();
      expect(await screen.findByText(/an organization admin can connect this account/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /discover bank accounts/i })).not.toBeInTheDocument();
    } finally {
      auth.orgRole = 'admin';
    }
  });

  it('draws the connected-to-bank tick in a circle at any theme radius', async () => {
    const connected = account as { import_account_id: string | null };
    connected.import_account_id = 'ACT-1';
    try {
      renderPage();
      const tile = (await screen.findByText('Connected to Bank')).parentElement?.previousElementSibling as HTMLElement;
      // var(--radius-full) is 0px unless the theme's radius is "full": the tile was a square.
      expect(tile.className).toMatch(/(?:^|\s)rounded-full(?:\s|$)/);
      expect(tile.className).not.toMatch(/radius-full/);
    } finally {
      connected.import_account_id = null;
    }
  });

  it('blocks save when the name is cleared', async () => {
    renderPage();
    const nameInput = await screen.findByDisplayValue('Checking');
    await userEvent.clear(nameInput);
    await userEvent.click(screen.getByRole('button', { name: /update account/i }));
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(updateAccount).not.toHaveBeenCalled();
    // The blocked submit must surface feedback — the bug was a silent no-op (no toast).
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('seeds a valid default for a null type instead of rendering blank and silently failing', async () => {
    // Legacy/drifted accounts can have a null `type`; the form schema requires it.
    // Without coalescing this seeded null, the Select renders blank and save is a
    // silent no-op. With the fix it seeds 'Asset' and saves normally.
    account.type = null as unknown as string;
    try {
      renderPage();
      await screen.findByDisplayValue('Checking');
      await userEvent.click(screen.getByRole('button', { name: /update account/i }));
      await waitFor(() => expect(updateAccount).toHaveBeenCalledTimes(1));
      expect(updateAccount.mock.calls[0][0].formData.get('type')).toBe('Asset');
      expect(toast.error).not.toHaveBeenCalled();
    } finally {
      account.type = 'Asset';
    }
  });

  // An account with incomes can't become a liability; the server says how many, and
  // what to do. The page said only "Failed to update account".
  it("shows the server's reason when it refuses the change, and stays on the page", async () => {
    const reason =
      'This account has 2 incomes, and a liability account takes no income. Change them to a payment or an expense first (money paid toward a card or loan is a payment, a charge on it an expense), then make the account a liability.';
    updateAccount.mockImplementationOnce(() =>
      handleResponse(new Response(JSON.stringify({ error: reason, code: 'ACCOUNT_HAS_INCOME', incomeCount: 2 }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })),
    );
    renderPage();
    await screen.findByDisplayValue('Checking');
    await userEvent.click(screen.getByRole('button', { name: /update account/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(reason));
    expect(navigate).not.toHaveBeenCalled();
  });
});

// The image's checks were toasts, and took any image type the server then refused.
describe('EditAccountPage image', () => {
  it("says beside the image's button why a file wasn't taken", async () => {
    vi.mocked(toast.error).mockClear();
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    await screen.findByDisplayValue('Checking');
    const button = screen.getByRole('button', { name: 'Upload Image' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    // The file dialog offers the four types the server takes, as My Profile's does, not image/*.
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/gif,image/webp');
    await user.upload(input, new File(['svg'], 'logo.svg', { type: 'image/svg+xml' }));
    expect(button).toHaveAccessibleDescription('Choose a JPEG, PNG, GIF or WebP image. JPG, PNG, GIF or WebP (max 5MB)');
    const big = new File(['x'], 'logo.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 });
    await user.upload(input, big);
    expect(button).toHaveAccessibleDescription(/^Choose an image of 5 MB or less\./);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
