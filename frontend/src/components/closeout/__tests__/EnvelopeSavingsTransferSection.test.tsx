import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import EnvelopeSavingsTransferSection from '../EnvelopeSavingsTransferSection';
import { parseUrlFilters } from '../../../utils/transactionFilterParams';

vi.mock('../../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/queries')>()),
  useEnvelopeTransfersQuery: () => ({
    data: { data: { envelope_account: { uuid: 'env-1', name: 'Envelopes' }, net_transfer_amount: 0, transfer_count: 2 } },
    isLoading: false,
    error: null,
  }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

describe('EnvelopeSavingsTransferSection', () => {
  // The link said ?type=transfer, which the account page doesn't read (its filter is
  // transactionType), so it showed every transaction.
  it("opens the envelope account's transactions filtered to its transfers", async () => {
    renderWithProviders(
      <Theme>
        <EnvelopeSavingsTransferSection budgetPeriodItems={[]} periodUuid="p-1" isLoading={false} />
      </Theme>,
    );
    await userEvent.click(screen.getByRole('button', { name: /View Transfer History \(2\)/ }));
    expect(navigate).toHaveBeenCalledTimes(1);
    const target = new URL(navigate.mock.calls[0][0] as string, 'http://app');
    expect(target.pathname).toBe('/accounts/env-1');
    expect(parseUrlFilters(target.searchParams)).toEqual({ transactionType: 'transfer' });
  });

  describe('adds the envelopes up in whole cents', () => {
    type Items = Parameters<typeof EnvelopeSavingsTransferSection>[0]['budgetPeriodItems'];
    // Amounts as pg sends NUMERIC: strings. Nothing has been transferred (the mock above).
    const envelopes = (...rows: [budget: string, actual: string][]) =>
      rows.map(([budget, actual]) => ({ type: 'Envelope', calculated_budget: budget, calculated_actual: actual })) as unknown as Items;
    const renderSection = (items: Items) =>
      renderWithProviders(
        <Theme>
          <EnvelopeSavingsTransferSection budgetPeriodItems={items} periodUuid="p-1" isLoading={false} />
        </Theme>,
      );

    it('shows a variance of nothing as $0.00, not ($0.00)', () => {
      // 0.10 + 0.20 − 0.30 is 5.55e-17 in floats, so the variance was −5.55e-17: "($0.00)".
      renderSection(envelopes(['0.10', '0.00'], ['0.20', '-0.30']));
      expect(screen.getByText(/Transfer Variance:/)).toHaveTextContent('Transfer Variance: $0.00');
      expect(screen.getByText('Perfectly balanced! ✓')).toBeInTheDocument();
    });

    it('takes a variance of exactly 50 cents as within its 50 cents', () => {
      // 0.10 + 1.10 − 0.70 is 0.5000000000000002 in floats, just over the tolerance.
      renderSection(envelopes(['0.10', '0.00'], ['1.10', '-0.70']));
      expect(screen.getByText(/Transfer Variance:/)).toHaveTextContent('Transfer Variance: ($0.50)');
      expect(screen.getByText('Perfectly balanced! ✓')).toBeInTheDocument();
    });
  });

  // On its blue step-3 fill, blue step-11 text measured 4.26:1, under AA.
  it('writes the variance in step-12 text on its tinted card', () => {
    const overspent = [{ type: 'Envelope', calculated_budget: 0, calculated_actual: -10 }] as unknown as Parameters<
      typeof EnvelopeSavingsTransferSection
    >[0]['budgetPeriodItems'];
    renderWithProviders(
      <Theme>
        <EnvelopeSavingsTransferSection budgetPeriodItems={overspent} periodUuid="p-1" isLoading={false} />
      </Theme>,
    );
    const variance = screen.getByText(/Transfer Variance:/);
    expect(variance).toHaveAttribute('data-accent-color', 'blue');
    expect(variance).toHaveClass('rt-high-contrast');
  });
});
