import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import InvestmentsPage from '../InvestmentsPage';

const state = vi.hoisted(() => ({ holdings: [] as unknown[] }));

vi.mock('../../hooks/queries/investments', () => ({
  useHoldingsQuery: () => ({ data: state.holdings, isLoading: false }),
  useLookthroughQuery: () => ({ data: { buckets: [] } }),
  useDataFreshnessQuery: () => ({ data: undefined }),
}));

const holding = (id: number, ticker: string, gain: number) => ({
  account_id: id, security_uuid: `0190a6f2-7c1e-7b3a-9f00-00000000000${id}`, ticker, name: ticker,
  total_shares: 1, average_cost_per_share: 10, latest_price: 10, market_value: 10, total_cost_basis: 10,
  unrealized_gain_loss: gain,
});

/** The figure of a summary card, by its label. */
const summary = (label: string) => screen.getAllByText(label)[0]?.nextElementSibling as HTMLElement;

describe('InvestmentsPage', () => {
  // The totals were float sums, so gains of -0.10, -0.20 and +0.30 came to
  // -5.6e-17, a red $0.00. In whole cents they are $0.00, in gray; a real loss is still red.
  it('adds the totals in whole cents and colours them by their cents', () => {
    state.holdings = [holding(1, 'AAA', -0.1), holding(2, 'BBB', -0.2), holding(3, 'CCC', 0.3)];
    renderWithProviders(<Theme><InvestmentsPage /></Theme>);
    expect(summary('Unrealized G/L')).toHaveTextContent('$0.00');
    expect(summary('Unrealized G/L')).toHaveAttribute('data-accent-color', 'gray');
    expect(summary('Market value')).toHaveTextContent('$30.00');
    // Each holding's own gain keeps its colour.
    expect(screen.getByText('-$0.20').closest('[data-accent-color]')).toHaveAttribute('data-accent-color', 'red');
  });

  it('colours a sub-cent gain as none', () => {
    state.holdings = [holding(1, 'AAA', -0.004)];
    renderWithProviders(<Theme><InvestmentsPage /></Theme>);
    for (const zero of screen.getAllByText('$0.00')) expect(zero.closest('[data-accent-color]')).toHaveAttribute('data-accent-color', 'gray');
  });
});
