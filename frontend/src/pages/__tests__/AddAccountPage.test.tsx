import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { UNREADABLE_AMOUNT_MESSAGE } from '../../components/forms/optionalAmount';
import AddAccountPage from '../AddAccountPage';

const renderPage = () => renderWithProviders(<Theme><AddAccountPage /></Theme>);

// Capture what the create mutation receives.
const mutateAsync = vi.fn().mockResolvedValue({});
vi.mock('../../hooks/queries', () => ({
  useInstitutionsQuery: () => ({ data: [], isLoading: false }),
  useCreateAccountWithImageMutation: () => ({ mutateAsync, isPending: false }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('AddAccountPage (react-hook-form)', () => {
  beforeEach(() => {
    mutateAsync.mockClear();
    navigate.mockClear();
  });

  it('blocks submit and shows a validation error when the name is empty', async () => {
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    // The shared accountCreateSchema's name message is surfaced.
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('submits a FormData payload with the entered + default values', async () => {
    renderPage();

    await userEvent.type(screen.getByPlaceholderText(/Primary Checking/i), 'My Checking');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const fd = mutateAsync.mock.calls[0][0] as FormData;
    expect(fd.get('name')).toBe('My Checking');
    expect(fd.get('type')).toBe('Asset');
    expect(fd.get('account_type')).toBe('checking');
    expect(fd.get('account_group')).toBe('cash');
    // close_account defaults false -> is_active true
    expect(fd.get('is_active')).toBe('true');
    expect(fd.get('hide_account')).toBe('false');
    expect(navigate).toHaveBeenCalledWith('/accounts');
  });

  it('refuses an initial balance it can\'t read, beside the field, and sends nothing', async () => {
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/Primary Checking/i), 'My Checking');
    const box = screen.getByLabelText(/initial balance/i);
    await userEvent.type(box, '1,2oo');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText(UNREADABLE_AMOUNT_MESSAGE)).toBeInTheDocument();
    await waitFor(() => expect(box).toHaveFocus());
    expect(mutateAsync).not.toHaveBeenCalled();

    await userEvent.clear(box);
    await userEvent.type(box, '1,200');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect((mutateAsync.mock.calls[0][0] as FormData).get('initial_balance')).toBe('1200');
  });
});

// The image's checks were toasts, and took any image type the server then refused; they
// show beside its button, read with it, by the server's types, names and size.
describe('AddAccountPage image', () => {
  it("says beside the image's button why a file wasn't taken, and sends the next one", async () => {
    mutateAsync.mockClear();
    const { toast } = await import('react-hot-toast');
    vi.mocked(toast.error).mockClear();
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    const button = screen.getByRole('button', { name: 'Upload Image' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    // The file dialog offers the four types the server takes, as My Profile's does, not image/*.
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/gif,image/webp');
    const hint = 'JPG, PNG, GIF or WebP (max 5MB)';
    await user.upload(input, new File(['svg'], 'logo.svg', { type: 'image/svg+xml' }));
    expect(button).toHaveAccessibleDescription(`Choose a JPEG, PNG, GIF or WebP image. ${hint}`);
    await user.upload(input, new File(['jpg'], 'logo.jfif', { type: 'image/jpeg' }));
    expect(button).toHaveAccessibleDescription(/^A picture named \.jfif isn't taken/);
    expect(toast.error).not.toHaveBeenCalled();

    await user.upload(input, new File(['png'], 'logo.png', { type: 'image/png' }));
    expect(screen.queryByText(/isn't taken/)).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Primary Checking/i), 'My Checking');
    await user.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(JSON.stringify([...(mutateAsync.mock.calls[0][0] as FormData).values()].map((v) => (v instanceof File ? v.name : v)))).toContain('logo.png');
  });
});
