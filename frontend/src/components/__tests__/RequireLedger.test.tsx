import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/renderWithProviders';
import RequireLedger from '../RequireLedger';

const auth = vi.hoisted(() => ({ membershipFailed: false, retryMembership: vi.fn(async () => {}) }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ activeTenant: null, loading: false, membershipLoading: false, ...auth }),
}));
vi.mock('../LedgerSelectionScreen', () => ({ default: () => <div>Pick a ledger</div> }));

describe('RequireLedger', () => {
  afterEach(() => {
    auth.membershipFailed = false;
  });

  it('lets someone with no ledger yet open an invitation', () => {
    renderWithProviders(<RequireLedger><div>Invitation page</div></RequireLedger>, { route: '/invitations/accept' });
    expect(screen.getByText('Invitation page')).toBeInTheDocument();
  });

  it('asks for a ledger on ledger pages', () => {
    renderWithProviders(<RequireLedger><div>Accounts page</div></RequireLedger>, { route: '/accounts' });
    expect(screen.getByText('Pick a ledger')).toBeInTheDocument();
    expect(screen.queryByText('Accounts page')).not.toBeInTheDocument();
  });

  // A server that didn't answer used to leave a spinner up for good.
  it("offers a retry when the ledgers didn't load", async () => {
    auth.membershipFailed = true;
    renderWithProviders(<RequireLedger><div>Accounts page</div></RequireLedger>, { route: '/accounts' });
    expect(screen.getByRole('heading', { name: "Your ledgers didn't load" })).toBeInTheDocument();
    expect(screen.queryByText('Accounts page')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(auth.retryMembership).toHaveBeenCalled();
  });
});
