import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import AddGoalPage from '../AddGoalPage';

const createGoal = vi.fn().mockResolvedValue({ goal: { uuid: 'g1' } });
const uploadImage = vi.fn().mockResolvedValue({});
vi.mock('../../hooks/queries/goals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries/goals')>();
  return {
    ...actual,
    useCreateGoalMutation: () => ({ mutateAsync: createGoal, isPending: false }),
    useUploadGoalImageMutation: () => ({ mutateAsync: uploadImage, isPending: false }),
  };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const renderPage = () => renderWithProviders(<Theme><AddGoalPage /></Theme>);

describe('AddGoalPage (react-hook-form)', () => {
  beforeEach(() => { createGoal.mockClear(); navigate.mockClear(); });

  it('blocks submit and surfaces shared-schema validation on an empty form', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /create goal/i }));
    // name + target_amount + target_date all fail; their messages render.
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(screen.getByText(/target amount must be greater than 0/i)).toBeInTheDocument();
    expect(screen.getByText(/target_date is required/i)).toBeInTheDocument();
    expect(createGoal).not.toHaveBeenCalled();
  });

  // A target the box can't read was 0 in the form ("must be greater than 0"); it
  // is NaN (so a reset empties the box), refused as text that isn't an amount.
  it('refuses a target amount it cannot read, saying so beside it', async () => {
    renderPage();
    const target = screen.getByRole('textbox', { name: /target amount/i });
    await userEvent.type(target, '1,00o');
    await userEvent.click(screen.getByRole('button', { name: /create goal/i }));
    expect(await screen.findByText('Not an amount: enter it like 1,234.56.')).toBeInTheDocument();
    expect(target).toHaveAccessibleDescription('Not an amount: enter it like 1,234.56.');
    expect(createGoal).not.toHaveBeenCalled();
  });
});

// The goal's image checks were toasts, and took any image type the server then refused.
describe('AddGoalPage image', () => {
  it("says beside the image's button why a file wasn't taken, and takes the next one", async () => {
    const { default: toast } = await import('react-hot-toast');
    vi.mocked(toast.error).mockClear();
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    const button = screen.getByRole('button', { name: 'Choose Image' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    // The file dialog offers the four types the server takes, as My Profile's does, not image/*.
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/gif,image/webp');
    await user.upload(input, new File(['svg'], 'house.svg', { type: 'image/svg+xml' }));
    expect(button).toHaveAccessibleDescription('Choose a JPEG, PNG, GIF or WebP image. PNG, JPG, GIF or WebP up to 5MB');
    await user.upload(input, new File(['jpg'], 'house.pjpeg', { type: 'image/jpeg' }));
    expect(button).toHaveAccessibleDescription(/^A picture named \.pjpeg isn't taken/);
    expect(toast.error).not.toHaveBeenCalled();
    // One that fits is taken: its preview replaces the button.
    await user.upload(input, new File(['png'], 'house.png', { type: 'image/png' }));
    expect(await screen.findByRole('img')).toBeInTheDocument();
  });
});
