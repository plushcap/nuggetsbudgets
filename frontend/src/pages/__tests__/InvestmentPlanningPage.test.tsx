import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import { apiError, mockApi, type ApiRoute } from '../../test/apiServer';
import { account, accountsResponse, noConcentration, noTaxLossHarvest, security } from '../../test/fixtures';
import InvestmentPlanningPage from '../InvestmentPlanningPage';

/**
 * A sell-tax calculation that fails says why: the API's reason when it answered, else
 * the page's own words, never an error's own text (a failed fetch's "Failed to fetch"), as
 * apiErrorMessage gives it.
 */

Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

pinTimeZone('UTC', '2026-10-15T12:00:00Z');

const brokerage = account({ id: 1, name: 'Brokerage', account_type: 'investment', account_group: 'investments' });
const stockFund = security({ id: 1, ticker: 'STKIDX', name: 'Total Stock Market' });
const FALLBACK = 'Could not calculate — check that a price exists.';

const calculate = async (sellTaxImpact: ApiRoute) => {
  mockApi({
    'GET /accounts': accountsResponse([brokerage]),
    'GET /investments/securities': [stockFund],
    'GET /investments/reports/tax-loss-harvest': noTaxLossHarvest,
    'GET /investments/reports/concentration': noConcentration,
    'GET /investments/reports/sell-tax-impact': sellTaxImpact,
  });
  const user = userEvent.setup();
  renderWithProviders(<Theme><InvestmentPlanningPage /></Theme>);
  await user.click(await screen.findByRole('combobox', { name: 'Account' }));
  await user.click(await screen.findByRole('option', { name: 'Brokerage' }));
  await user.click(screen.getByRole('combobox', { name: 'Security' }));
  await user.click(await screen.findByRole('option', { name: 'STKIDX' }));
  await user.type(screen.getByRole('spinbutton', { name: 'Shares' }), '10');
  // The rates start empty: the page asks for them.
  await user.type(screen.getByRole('spinbutton', { name: 'Short-term rate' }), '0.3');
  await user.type(screen.getByRole('spinbutton', { name: 'Long-term rate' }), '0.2');
  await user.click(screen.getByRole('button', { name: 'Calculate' }));
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('InvestmentPlanningPage', () => {
  it("shows the page's own words, not the error's text, when the request fails", async () => {
    await calculate(() => { throw new TypeError('Failed to fetch'); });
    expect(await screen.findByText(FALLBACK)).toBeInTheDocument();
    expect(screen.queryByText('Failed to fetch')).toBeNull();
  });

  it("shows the API's reason when it refuses the calculation", async () => {
    await calculate(apiError(400, 'Insufficient shares: requested 10, available 4', 'INVALID_REQUEST'));
    expect(await screen.findByText('Insufficient shares: requested 10, available 4')).toBeInTheDocument();
  });

  // On react-hook-form, Calculate stays enabled (it was disabled until the form was
  // complete) and one pressed too soon says what's missing beside each field, focusing the first.
  it('says what is missing beside each field when Calculate is pressed too soon, and asks nothing', async () => {
    const api = mockApi({
      'GET /accounts': accountsResponse([brokerage]),
      'GET /investments/securities': [stockFund],
      'GET /investments/reports/tax-loss-harvest': noTaxLossHarvest,
      'GET /investments/reports/concentration': noConcentration,
    });
    const user = userEvent.setup();
    renderWithProviders(<Theme><InvestmentPlanningPage /></Theme>);
    const calculateButton = await screen.findByRole('button', { name: 'Calculate' });
    expect(calculateButton).toBeEnabled();
    const rate = screen.getByRole('spinbutton', { name: 'Short-term rate' });
    await user.clear(rate);
    await user.type(rate, '24');
    await user.click(calculateButton);

    const accountField = screen.getByRole('combobox', { name: 'Account' });
    await waitFor(() => expect(accountField).toHaveFocus());
    expect(accountField).toHaveAccessibleDescription('Choose an investment account.');
    expect(screen.getByRole('combobox', { name: 'Security' })).toHaveAccessibleDescription('Choose a security.');
    expect(screen.getByRole('spinbutton', { name: 'Shares' })).toHaveAccessibleDescription('Enter a number.');
    expect(rate).toHaveAccessibleDescription('Enter the rate as a fraction from 0 to 1, like 0.25.');
    expect(api.calls('GET /investments/reports/sell-tax-impact')).toHaveLength(0);
  });
});
