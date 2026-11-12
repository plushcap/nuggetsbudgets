import type { ReactElement } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Route, Routes } from 'react-router-dom';
import { dividendEventSchema, feeEventSchema, priceUpsertSchema } from '@nuggets/shared';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import { mockApi } from '../../test/apiServer';
import { account, accountsResponse, created, investmentAnswers, security } from '../../test/fixtures';
import RecordDividendPage from '../RecordDividendPage';
import AddPricePage from '../AddPricePage';
import RecordFeePage from '../RecordFeePage';

/**
 * The dividend, price and fee pages keep their button enabled, as the buy and sell
 * pages do: pressing it too soon says what is missing beside each field and focuses
 * the first, and nothing is sent. They disabled it, which said nothing.
 */

Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});

pinTimeZone('UTC', '2026-10-15T12:00:00Z');

const brokerage = account({ id: 1, name: 'Brokerage', account_type: 'investment', account_group: 'investments' });
const stockFund = security({ id: 1, ticker: 'STKIDX', name: 'Total Stock Market' });

const routes = {
  'GET /accounts': accountsResponse([brokerage]),
  'GET /investments/securities': [stockFund],
  'POST /investments/events/dividend': created(investmentAnswers.dividend),
  'POST /investments/prices': created(investmentAnswers.price),
  'POST /investments/events/fee': created(investmentAnswers.fee),
};

const renderAt = (path: string, page: ReactElement) =>
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path={path} element={page} />
        <Route path="*" element={<p>Left the form</p>} />
      </Routes>
    </Theme>,
    { route: path },
  );

type User = ReturnType<typeof userEvent.setup>;
const choose = async (user: User, field: RegExp, option: RegExp | string) => {
  await user.click(await screen.findByRole('combobox', { name: field }));
  await user.click(await screen.findByRole('option', { name: option }));
};

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  vi.clearAllMocks();
  api = mockApi(routes);
});
afterEach(() => vi.unstubAllGlobals());

describe('RecordDividendPage', () => {
  it('says what is missing beside each field, and focuses the first', async () => {
    const user = userEvent.setup();
    renderAt('/investments/dividend', <RecordDividendPage />);

    const save = await screen.findByRole('button', { name: 'Record dividend' });
    expect(save).toBeEnabled();
    await user.click(save);
    const accountField = screen.getByRole('combobox', { name: /Account/ });
    await waitFor(() => expect(accountField).toHaveFocus());
    expect(accountField).toHaveAccessibleDescription('Choose an investment account.');
    expect(screen.getByRole('combobox', { name: /Security/ })).toHaveAccessibleDescription('Choose a security.');
    expect(screen.getByRole('textbox', { name: 'Total amount' })).toHaveAccessibleDescription('Enter the total amount paid, more than 0.');
    expect(api.calls('POST /investments/events/dividend')).toHaveLength(0);
  });

  it('asks for the reinvestment price of a reinvested dividend, then sends it', async () => {
    const user = userEvent.setup();
    renderAt('/investments/dividend', <RecordDividendPage />);

    await choose(user, /Account/, 'Brokerage');
    await choose(user, /Security/, /STKIDX/);
    await user.type(screen.getByRole('textbox', { name: 'Total amount' }), '15');
    await user.click(screen.getByRole('switch', { name: /Reinvest/ }));
    await user.click(screen.getByRole('button', { name: 'Record dividend' }));
    const price = screen.getByRole('textbox', { name: 'Reinvestment price per share' });
    await waitFor(() => expect(price).toHaveFocus());
    expect(price).toHaveAccessibleDescription('Enter the price the dividend was reinvested at, more than 0.');
    expect(api.calls('POST /investments/events/dividend')).toHaveLength(0);

    await user.type(price, '37.5');
    await user.click(screen.getByRole('button', { name: 'Record dividend' }));
    await waitFor(() => expect(api.calls('POST /investments/events/dividend')).toHaveLength(1));
    const body = api.calls('POST /investments/events/dividend')[0].body;
    expect(body).toMatchObject({ account_uuid: brokerage.uuid, security_uuid: stockFund.uuid, total_amount: 15, reinvest: true, price_per_share: 37.5 });
    expect(dividendEventSchema.safeParse(body).success).toBe(true);
    expect(await screen.findByText('Left the form')).toBeInTheDocument();
  });
});

describe('AddPricePage', () => {
  it('says what is missing beside each field, focuses the first, and sends the price once filled in', async () => {
    const user = userEvent.setup();
    renderAt('/investments/prices/new', <AddPricePage />);

    const save = await screen.findByRole('button', { name: 'Save price' });
    expect(save).toBeEnabled();
    await user.click(save);
    const securityField = screen.getByRole('combobox', { name: /Security/ });
    await waitFor(() => expect(securityField).toHaveFocus());
    expect(securityField).toHaveAccessibleDescription('Choose a security.');
    expect(screen.getByRole('textbox', { name: 'Close price' })).toHaveAccessibleDescription('Enter the closing price.');
    expect(api.calls('POST /investments/prices')).toHaveLength(0);

    await choose(user, /Security/, /STKIDX/);
    await user.type(screen.getByRole('textbox', { name: 'Close price' }), '250.1234');
    await user.click(save);
    await waitFor(() => expect(api.calls('POST /investments/prices')).toHaveLength(1));
    const body = api.calls('POST /investments/prices')[0].body;
    expect(body).toMatchObject({ security_uuid: stockFund.uuid, price_date: '2026-10-15', close: 250.1234 });
    expect(priceUpsertSchema.safeParse(body).success).toBe(true);
  });
});

describe('RecordFeePage', () => {
  it('says what is missing beside each field, focuses the first, and sends the fee once filled in', async () => {
    const user = userEvent.setup();
    renderAt('/investments/fees/new', <RecordFeePage />);

    const save = await screen.findByRole('button', { name: 'Record fee' });
    expect(save).toBeEnabled();
    await user.click(save);
    const accountField = screen.getByRole('combobox', { name: /Account/ });
    await waitFor(() => expect(accountField).toHaveFocus());
    expect(accountField).toHaveAccessibleDescription('Choose an investment account.');
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveAccessibleDescription('Enter the fee, more than 0.');
    expect(api.calls('POST /investments/events/fee')).toHaveLength(0);

    await choose(user, /Account/, 'Brokerage');
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '12.50');
    await user.click(save);
    await waitFor(() => expect(api.calls('POST /investments/events/fee')).toHaveLength(1));
    const body = api.calls('POST /investments/events/fee')[0].body;
    expect(body).toMatchObject({ account_uuid: brokerage.uuid, security_uuid: null, amount: 12.5 });
    expect(feeEventSchema.safeParse(body).success).toBe(true);
  });
});
