import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { mockApi } from '../../test/apiServer';
import type { UnderlyingExposureResult } from '../../services/api/investments';
import InvestmentExposurePage from '../InvestmentExposurePage';

// What the page formats: formatMoney's amounts (the page's own Intl copy before).
const formatted = vi.hoisted(() => [] as unknown[]);
vi.mock('@nuggets/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nuggets/shared')>();
  return {
    ...actual,
    formatMoney: (amount: Parameters<typeof actual.formatMoney>[0], options?: Parameters<typeof actual.formatMoney>[1]) => {
      formatted.push(amount);
      return actual.formatMoney(amount, options);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// $0.30 in all, $0.10 of it in a fund with no holdings data.
const exposure: UnderlyingExposureResult = {
  total_value: 0.3,
  unknown_value: 0.1,
  below_a_cent: { securities: 0, amount: 0, percentage: 0 },
  exposures: [{ security_uuid: null, ticker: 'ACMEC', name: 'Acme Corp.', amount: 0.2, percentage: 66.67 }],
};

describe('InvestmentExposurePage', () => {
  // The total resolved was total − unknown as floats: 0.3 − 0.1 is 0.19999999999999998.
  // The page's currency format rounds that back to $0.20, so what it formats is checked too.
  it('works out the total resolved in whole cents', async () => {
    mockApi({ 'GET /investments/reports/underlying-exposure': exposure });
    formatted.length = 0;

    renderWithProviders(<Theme><InvestmentExposurePage /></Theme>, { route: '/investments/exposure' });

    expect(await screen.findByText('Total resolved: $0.20 of $0.30')).toBeInTheDocument();
    expect(formatted).toContain(0.2);
    expect(formatted).not.toContain(0.3 - 0.1);
  });

  // The securities worth less than a cent were dropped from the table, and their value
  // was nowhere, though "Total resolved" counted it.
  it('says how much the securities worth less than a cent each come to', async () => {
    mockApi({
      'GET /investments/reports/underlying-exposure': {
        ...exposure,
        total_value: 10,
        unknown_value: 0.2,
        below_a_cent: { securities: 2000, amount: 4.8, percentage: 48 },
        exposures: [{ security_uuid: null, ticker: 'AAA', name: null, amount: 5, percentage: 50 }],
      },
    });
    renderWithProviders(<Theme><InvestmentExposurePage /></Theme>, { route: '/investments/exposure' });
    expect(await screen.findByText(/And 2000 securities worth less than a cent each, not listed: \$4\.80 \(48\.00%\) in all\./)).toBeInTheDocument();
    expect(screen.getByText('Total resolved: $9.80 of $10.00')).toBeInTheDocument();
  });
});
