import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { accountResponseSchema } from '@nuggets/shared';
import { renderWithProviders } from '../../../test/renderWithProviders';
import { account } from '../../../test/fixtures';
import type { Account, EnvelopeReconciliation } from '../../../services/api';
import type { TransferFormData } from '../../transfer/TransferForm';
import EnvelopeReconciliationSection from '../EnvelopeReconciliationSection';

// The dialog's own form would round what it is given (CurrencyInput); stand in for it to
// see what the section itself pre-fills.
const prefills: Partial<TransferFormData>[] = [];
vi.mock('../../transfer/TransferModal', () => ({
  default: ({ initialValues }: { initialValues?: Partial<TransferFormData> }) => {
    if (initialValues) prefills.push(initialValues);
    return null;
  },
}));

/** An account row as the page has it: the API's, its money coerced to numbers (services/api/accounts.ts). */
const loaded = (row: ReturnType<typeof account>) => accountResponseSchema.parse(row) as unknown as Account;

const checking = loaded(account({ id: 51, name: 'Family checking' }));
const longTerm = loaded(account({
  id: 52, name: 'Reserve savings', account_type: 'savings', is_envelope_account: true,
  calculated_balance: '1880.91', default_pay_from_account_id: checking.id,
}));

const reconciliation = (amount: number, status: NonNullable<EnvelopeReconciliation['variance']>['status']): EnvelopeReconciliation => ({
  envelope_account: { uuid: longTerm.uuid, name: longTerm.name, icon: 'wallet', actual_balance: 1880.91 },
  budget_summary: { expected_balance: 850.6, envelope_items_count: 3, total_budgeted: 850.6, total_spent: 0 },
  variance: { amount, status, percentage: 121 },
});

describe('EnvelopeReconciliationSection', () => {
  // The loading and empty states drew a bare Info icon, with no tip behind it.
  it.each([
    ['loading', { isLoading: true }],
    ['with no envelope account', {}],
    ['unreconciled', { fullAccounts: [longTerm] }],
    ['reconciled', { reconciliation: reconciliation(0, 'balanced'), fullAccounts: [checking, longTerm] }],
  ])('explains the section from its tip when %s', async (_state, props) => {
    renderWithProviders(
      <Theme>
        <EnvelopeReconciliationSection reconciliation={null} {...props} />
      </Theme>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'About envelope account reconciliation' }));
    expect(await screen.findByText(/Verify that your envelope account balance matches/)).toBeInTheDocument();
  });

  // With the accounts not loaded there is no envelope account to find, and that isn't
  // "No envelope account configured".
  it('says why it is unavailable when no envelope account is known', () => {
    renderWithProviders(
      <Theme>
        <EnvelopeReconciliationSection reconciliation={null} unavailable="failed" fullAccounts={[]} />
      </Theme>,
    );
    expect(screen.getByText('Envelope reconciliation unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No envelope account configured')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Configure Envelope Account' })).toBeNull();
  });

  it("pre-fills the transfer with the variance's whole cents, at two decimals", () => {
    // 1880.91 − 850.5999999999999 (600.10 + 250.20 + 0.30 in floats) is 1030.3100000000002.
    renderWithProviders(
      <Theme>
        <EnvelopeReconciliationSection
          reconciliation={reconciliation(1880.91 - (600.1 + 250.2 + 0.3), 'overfunded')}
          fullAccounts={[checking, longTerm]}
        />
      </Theme>,
    );
    expect(prefills[prefills.length - 1]).toMatchObject({
      amount: 1030.31,
      source_account_id: longTerm.id,
      destination_account_id: checking.id,
      type: 'transfer',
    });
  });
});
