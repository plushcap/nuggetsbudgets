import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import UnsubscribePage from '../UnsubscribePage';

const api = vi.hoisted(() => ({ inspect: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    inspectUnsubscribeLink: (token: string) => api.inspect(token),
    unsubscribeByLink: (token: string) => api.unsubscribe(token),
  };
});

const token = 'eyJ1IjoiYSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ'; // gitleaks:allow (made-up)
const renderPage = () => renderWithProviders(<Theme><UnsubscribePage /></Theme>, { route: '/unsubscribe' });

describe('UnsubscribePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', `/unsubscribe#${token}`);
  });

  it('names the notification, stops nothing until asked, and takes the token out of the address bar', async () => {
    api.inspect.mockResolvedValue({ label: 'A large purchase' });
    api.unsubscribe.mockResolvedValue({ label: 'A large purchase' });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Stop “A large purchase”?' })).toBeInTheDocument();
    expect(api.inspect).toHaveBeenCalledWith(token);
    expect(api.unsubscribe).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');

    await userEvent.click(screen.getByRole('button', { name: 'Stop these emails' }));
    expect(await screen.findByRole('heading', { name: 'You won’t get these any more' })).toBeInTheDocument();
    expect(api.unsubscribe).toHaveBeenCalledWith(token);
  });

  it('still works after a reload, from the history state', async () => {
    window.history.replaceState({ unsubscribeToken: token }, '', '/unsubscribe');
    api.inspect.mockResolvedValue({ label: 'The week in review' });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Stop “The week in review”?' })).toBeInTheDocument();
  });

  it("shows the server's reason when the link doesn't work", async () => {
    api.inspect.mockRejectedValue(Object.assign(new Error('HTTP 404'), {
      response: { data: { error: 'This link has expired or doesn’t work. Choose what you get in My Profile.' } },
    }));
    renderPage();
    expect(await screen.findByText(/This link has expired or doesn’t work/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop these emails' })).not.toBeInTheDocument();
  });

  it('refuses a token that is obviously cut short without asking the server', async () => {
    window.history.replaceState(null, '', '/unsubscribe#short');
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'This link doesn’t work' })).toBeInTheDocument());
    expect(api.inspect).not.toHaveBeenCalled();
  });
});
