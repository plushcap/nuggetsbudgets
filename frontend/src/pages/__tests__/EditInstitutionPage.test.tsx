import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import EditInstitutionPage from '../EditInstitutionPage';

const mutateAsync = vi.fn().mockResolvedValue({});
const institution = { name: 'Old Bank', notes: 'old notes' };
vi.mock('../../hooks/queries/referenceData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries/referenceData')>();
  return {
    ...actual,
    useInstitutionQuery: () => ({ data: institution, isLoading: false, error: null }),
    useUpdateInstitutionMutation: () => ({ mutateAsync, isPending: false }),
  };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate, useParams: () => ({ uuid: 'inst-1' }) };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const renderPage = () => renderWithProviders(<Theme><EditInstitutionPage /></Theme>);

describe('EditInstitutionPage (react-hook-form)', () => {
  beforeEach(() => { mutateAsync.mockClear(); navigate.mockClear(); });

  it('seeds the form from the loaded institution and saves edits', async () => {
    renderPage();
    const nameInput = await screen.findByDisplayValue('Old Bank');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'New Bank');
    await userEvent.click(screen.getAllByRole('button', { name: /save changes/i })[0]);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({ uuid: 'inst-1', data: { name: 'New Bank', notes: 'old notes' } });
    expect(navigate).toHaveBeenCalledWith('/settings/institutions');
  });
});
