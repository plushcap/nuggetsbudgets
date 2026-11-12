import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Route, Routes } from 'react-router-dom';
import type React from 'react';
import { renderWithProviders } from '../../../test/renderWithProviders';
import { pinTimeZone } from '../../../test/timeZone';
import { mockApi } from '../../../test/apiServer';
import { account, accountsResponse, created, investmentAnswers, security, taxLot } from '../../../test/fixtures';
import RecordBuyPage from '../../../pages/RecordBuyPage';
import RecordSellPage from '../../../pages/RecordSellPage';
import RecordDividendPage from '../../../pages/RecordDividendPage';
import RecordFeePage from '../../../pages/RecordFeePage';
import CorporateActionPage from '../../../pages/CorporateActionPage';
import AddPricePage from '../../../pages/AddPricePage';

/**
 * The six investment event pages send the same requests on the one InvestmentEventForm
 * as they did each on its own useState form: every body below is what the
 * page sent before the move (this file ran green against those pages first), and where the
 * page goes once the API takes it.
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
const bondFund = security({ id: 2, ticker: 'BONDIX', name: 'Total Bond Market' });
const lot = (id: number, acquisition_date: string, shares: number) => taxLot({ id, acquisition_date, shares });
const lots = [lot(1, '2025-01-02', 10), lot(2, '2025-02-03', 5), { ...lot(3, '2025-03-04', 0), is_open: false }];

const api = () =>
  mockApi({
    'GET /accounts': accountsResponse([brokerage]),
    'GET /investments/securities': [stockFund, bondFund],
    'GET /investments/holdings/:uuid/lots': lots,
    'POST /investments/events/buy': created(investmentAnswers.buy),
    'POST /investments/events/sell': created(investmentAnswers.sell),
    'POST /investments/events/dividend': created(investmentAnswers.dividend),
    'POST /investments/events/fee': created(investmentAnswers.fee),
    'POST /investments/prices': created(investmentAnswers.price),
    'POST /investments/corporate-actions/split': created(investmentAnswers.split),
    'POST /investments/corporate-actions/return-of-capital': created(investmentAnswers.returnOfCapital),
    'POST /investments/corporate-actions/spinoff': created(investmentAnswers.spinoff),
    'POST /investments/corporate-actions/merger-cash': created(investmentAnswers.mergerCash),
    'POST /investments/corporate-actions/merger-stock': created(investmentAnswers.mergerStock),
  });

const renderAt = (path: string, page: React.ReactElement, route = path) =>
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path={path} element={page} />
        <Route path="/investments" element={<p>Investments overview</p>} />
        <Route path="/investments/costs" element={<p>Investment costs</p>} />
        <Route path="/investments/securities" element={<p>Securities list</p>} />
      </Routes>
    </Theme>,
    { route },
  );

type User = ReturnType<typeof userEvent.setup>;
const choose = async (user: User, field: RegExp, option: RegExp | string) => {
  await user.click(await screen.findByRole('combobox', { name: field }));
  await user.click(await screen.findByRole('option', { name: option }));
};
const typeInto = async (user: User, role: 'textbox' | 'spinbutton', name: RegExp | string, text: string) => {
  const box = screen.getByRole(role, { name });
  await user.clear(box);
  await user.type(box, text);
};
const sent = async (calls: ReturnType<typeof api>, route: string) => {
  await waitFor(() => expect(calls.calls(route)).toHaveLength(1));
  return calls.calls(route)[0]!.body;
};

let calls: ReturnType<typeof api>;
beforeEach(() => {
  vi.clearAllMocks();
  calls = api();
});
afterEach(() => vi.unstubAllGlobals());

describe('the investment event requests', () => {
  it('buy, without fees', async () => {
    const user = userEvent.setup();
    renderAt('/investments/buy', <RecordBuyPage />);
    await choose(user, /Account/, 'Brokerage');
    await choose(user, /Security/, /BONDIX/);
    await typeInto(user, 'spinbutton', 'Shares', ' 3.25 ');
    await typeInto(user, 'textbox', 'Price per share', '10.5');
    await user.click(screen.getByRole('button', { name: 'Record buy' }));

    expect(await sent(calls, 'POST /investments/events/buy')).toEqual({
      account_uuid: brokerage.uuid, security_uuid: bondFund.uuid, event_date: '2026-10-15', shares: '3.25',
      price_per_share: 10.5, fees: 0, acquisition_method: 'purchase', source: 'manual', adjusted_for_splits: false, dry_run: false,
    });
    expect(await screen.findByText('Investments overview')).toBeInTheDocument();
  });

  it('buy, in shares and a price already adjusted for a later split', async () => {
    const user = userEvent.setup();
    renderAt('/investments/buy', <RecordBuyPage />);
    await choose(user, /Account/, 'Brokerage');
    await choose(user, /Security/, /BONDIX/);
    await typeInto(user, 'spinbutton', 'Shares', '20');
    await typeInto(user, 'textbox', 'Price per share', '10');
    const adjusted = screen.getByRole('switch', { name: 'The shares and price are already adjusted for later splits' });
    expect(adjusted).not.toBeChecked();
    expect(screen.getByText(/enter the shares and price as your broker shows them today/)).toBeInTheDocument();
    await user.click(adjusted);
    await user.click(screen.getByRole('button', { name: 'Record buy' }));

    expect(await sent(calls, 'POST /investments/events/buy')).toMatchObject({ shares: '20', price_per_share: 10, adjusted_for_splits: true });
  });

  it('sell, by a method other than specific lots, with fees', async () => {
    const user = userEvent.setup();
    renderAt('/investments/sell', <RecordSellPage />);
    await choose(user, /Account/, 'Brokerage');
    await choose(user, /^Security/, /STKIDX/);
    await choose(user, /Cost basis method/, /LIFO/);
    await typeInto(user, 'spinbutton', 'Shares', '2');
    await typeInto(user, 'textbox', 'Price per share', '101.0001');
    await typeInto(user, 'textbox', /Commission/, '2.50');
    await user.click(screen.getByRole('button', { name: 'Record sell' }));

    const body = await sent(calls, 'POST /investments/events/sell');
    expect(body).toEqual({
      account_uuid: brokerage.uuid, security_uuid: stockFund.uuid, event_date: '2026-10-15', shares: '2',
      price_per_share: 101.0001, fees: 2.5, method: 'lifo', source: 'manual', adjusted_for_splits: false, dry_run: false,
    });
    expect(body).not.toHaveProperty('specific_lots');
    expect(await screen.findByText('Investments overview')).toBeInTheDocument();
  });

  it('sell, by specific lots: only the open lots, and only those given shares', async () => {
    const user = userEvent.setup();
    renderAt('/investments/sell', <RecordSellPage />);
    await choose(user, /Account/, 'Brokerage');
    await choose(user, /^Security/, /STKIDX/);
    await choose(user, /Cost basis method/, 'Specific lots');
    await typeInto(user, 'spinbutton', 'Shares', '4');
    await typeInto(user, 'textbox', 'Price per share', '99');
    // The closed lot isn't listed; a lot given 0 isn't sent.
    expect(screen.queryByRole('spinbutton', { name: 'Sell qty, lot acquired 2025-03-04' })).toBeNull();
    await user.type(await screen.findByRole('spinbutton', { name: 'Sell qty, lot acquired 2025-01-02' }), '0');
    await user.type(screen.getByRole('spinbutton', { name: 'Sell qty, lot acquired 2025-02-03' }), '4');
    await user.click(screen.getByRole('button', { name: 'Record sell' }));

    expect(await sent(calls, 'POST /investments/events/sell')).toEqual({
      account_uuid: brokerage.uuid, security_uuid: stockFund.uuid, event_date: '2026-10-15', shares: '4',
      price_per_share: 99, fees: 0, method: 'specific_id', specific_lots: [{ lot_uuid: lots[1]!.uuid, shares: '4' }],
      source: 'manual', adjusted_for_splits: false, dry_run: false,
    });
    // The lots asked for are the chosen account's and security's.
    const lotRequests = calls.calls('GET /investments/holdings/:uuid/lots');
    const lotRequest = lotRequests[lotRequests.length - 1]!;
    expect(lotRequest.params.uuid).toBe(stockFund.uuid);
    expect(lotRequest.query.get('account')).toBe(brokerage.uuid);
  });

  it('dividend, paid in cash and not qualified', async () => {
    const user = userEvent.setup();
    renderAt('/investments/dividend', <RecordDividendPage />);
    await choose(user, /Account/, 'Brokerage');
    await choose(user, /Security/, /STKIDX/);
    await typeInto(user, 'textbox', 'Total amount', '12.34');
    await user.click(screen.getByRole('switch', { name: 'Qualified dividend' }));
    await user.click(screen.getByRole('button', { name: 'Record dividend' }));

    expect(await sent(calls, 'POST /investments/events/dividend')).toEqual({
      account_uuid: brokerage.uuid, security_uuid: stockFund.uuid, event_date: '2026-10-15', total_amount: 12.34,
      is_qualified: false, reinvest: false, price_per_share: null, source: 'manual', adjusted_for_splits: false, dry_run: false,
    });
    expect(await screen.findByText('Investments overview')).toBeInTheDocument();
  });

  it('sell, in shares and a price already adjusted for a later split', async () => {
    const user = userEvent.setup();
    renderAt('/investments/sell', <RecordSellPage />);
    await choose(user, /Account/, 'Brokerage');
    await choose(user, /^Security/, /STKIDX/);
    await typeInto(user, 'spinbutton', 'Shares', '2');
    await typeInto(user, 'textbox', 'Price per share', '50');
    await user.click(screen.getByRole('switch', { name: 'The shares and price are already adjusted for later splits' }));
    await user.click(screen.getByRole('button', { name: 'Record sell' }));

    expect(await sent(calls, 'POST /investments/events/sell')).toMatchObject({ shares: '2', price_per_share: 50, adjusted_for_splits: true });
  });

  it('dividend: the reinvestment price adjusted for a later split, asked only when reinvested', async () => {
    const user = userEvent.setup();
    renderAt('/investments/dividend', <RecordDividendPage />);
    await choose(user, /Account/, 'Brokerage');
    await choose(user, /Security/, /STKIDX/);
    await typeInto(user, 'textbox', 'Total amount', '50');
    const name = 'The reinvestment price is already adjusted for later splits';
    expect(screen.queryByRole('switch', { name })).toBeNull();
    await user.click(screen.getByRole('switch', { name: /Reinvest/ }));
    await typeInto(user, 'textbox', 'Reinvestment price per share', '12.5');
    await user.click(screen.getByRole('switch', { name }));
    await user.click(screen.getByRole('button', { name: 'Record dividend' }));

    expect(await sent(calls, 'POST /investments/events/dividend')).toMatchObject({ reinvest: true, price_per_share: 12.5, adjusted_for_splits: true });
  });

  it('dividend, reinvested at a 4-decimal price', async () => {
    const user = userEvent.setup();
    renderAt('/investments/dividend', <RecordDividendPage />);
    await choose(user, /Account/, 'Brokerage');
    await choose(user, /Security/, /STKIDX/);
    await typeInto(user, 'textbox', 'Total amount', '1,234.50');
    await user.click(screen.getByRole('switch', { name: /Reinvest/ }));
    await typeInto(user, 'textbox', 'Reinvestment price per share', '25.1234');
    await user.click(screen.getByRole('button', { name: 'Record dividend' }));

    expect(await sent(calls, 'POST /investments/events/dividend')).toEqual({
      account_uuid: brokerage.uuid, security_uuid: stockFund.uuid, event_date: '2026-10-15', total_amount: 1234.5,
      is_qualified: true, reinvest: true, price_per_share: 25.1234, source: 'manual', adjusted_for_splits: false, dry_run: false,
    });
  });

  it('fee, on the account, with a description', async () => {
    const user = userEvent.setup();
    renderAt('/investments/fee', <RecordFeePage />);
    await choose(user, /Account/, 'Brokerage');
    await typeInto(user, 'textbox', 'Amount', '30');
    await user.type(screen.getByRole('textbox', { name: /Description/ }), 'Q1 advisory fee');
    await user.click(screen.getByRole('button', { name: 'Record fee' }));

    expect(await sent(calls, 'POST /investments/events/fee')).toEqual({
      account_uuid: brokerage.uuid, security_uuid: null, fee_type: 'advisory', amount: 30, event_date: '2026-10-15',
      description: 'Q1 advisory fee', source: 'manual',
    });
    expect(await screen.findByText('Investment costs')).toBeInTheDocument();
  });

  it('fee, on a security, of another type, without a description', async () => {
    const user = userEvent.setup();
    renderAt('/investments/fee', <RecordFeePage />);
    await choose(user, /Account/, 'Brokerage');
    await choose(user, /Fee type/, /Account maintenance/i);
    await choose(user, /Security/, /^STKIDX$/);
    await typeInto(user, 'textbox', 'Amount', '4.95');
    await user.click(screen.getByRole('button', { name: 'Record fee' }));

    expect(await sent(calls, 'POST /investments/events/fee')).toEqual({
      account_uuid: brokerage.uuid, security_uuid: stockFund.uuid, fee_type: 'account_maintenance', amount: 4.95,
      event_date: '2026-10-15', description: null, source: 'manual',
    });
  });

  it('price, for the security the link names', async () => {
    const user = userEvent.setup();
    renderAt('/investments/prices/add', <AddPricePage />, `/investments/prices/add?security=${stockFund.uuid}`);
    const chosen = await screen.findByRole('combobox', { name: /Security/ });
    await waitFor(() => expect(chosen).toHaveTextContent(/STKIDX/));
    await typeInto(user, 'textbox', 'Close price', '101.5');
    await user.click(screen.getByRole('button', { name: 'Save price' }));

    expect(await sent(calls, 'POST /investments/prices')).toEqual({
      security_uuid: stockFund.uuid, price_date: '2026-10-15', close: 101.5, source: 'mcp_manual',
    });
    expect(await screen.findByText('Securities list')).toBeInTheDocument();
  });

  describe('corporate actions', () => {
    const start = async (user: User, action: RegExp) => {
      renderAt('/investments/corporate-action', <CorporateActionPage />);
      await choose(user, /^Security/, /STKIDX/);
      await choose(user, /^Action/, action);
    };
    const apply = (user: User) => user.click(screen.getByRole('button', { name: 'Apply' }));

    it('a reverse split, from the ratio it starts with', async () => {
      const user = userEvent.setup();
      await start(user, /^Reverse split$/);
      await apply(user);
      expect(await sent(calls, 'POST /investments/corporate-actions/split')).toEqual({
        security_uuid: stockFund.uuid, action_date: '2026-10-15', numerator: '2', denominator: '1', reverse: true, dry_run: false,
      });
      expect(await screen.findByText('Investments overview')).toBeInTheDocument();
    });

    it('a return of capital', async () => {
      const user = userEvent.setup();
      await start(user, /^Return of capital$/);
      await typeInto(user, 'textbox', 'Return of capital per share', '0.5');
      await apply(user);
      expect(await sent(calls, 'POST /investments/corporate-actions/return-of-capital')).toEqual({
        security_uuid: stockFund.uuid, action_date: '2026-10-15', amount_per_share: 0.5, dry_run: false,
      });
    });

    it('a cash merger, of zero a share', async () => {
      const user = userEvent.setup();
      await start(user, /^Merger \(cash\)$/);
      await typeInto(user, 'textbox', 'Cash per share', '0');
      await apply(user);
      expect(await sent(calls, 'POST /investments/corporate-actions/merger-cash')).toEqual({
        security_uuid: stockFund.uuid, action_date: '2026-10-15', cash_per_share: 0,
      });
    });

    it('a stock merger, keeping the ratio typed for the split before', async () => {
      const user = userEvent.setup();
      renderAt('/investments/corporate-action', <CorporateActionPage />);
      await choose(user, /^Security/, /STKIDX/);
      await typeInto(user, 'spinbutton', 'New shares', '1.5');
      await choose(user, /^Action/, /^Merger \(stock\)$/);
      await choose(user, /Acquirer security/, /BONDIX/);
      expect(screen.getByRole('spinbutton', { name: /Exchange ratio/ })).toHaveValue(1.5);
      await apply(user);
      expect(await sent(calls, 'POST /investments/corporate-actions/merger-stock')).toEqual({
        security_uuid: stockFund.uuid, acquirer_security_uuid: bondFund.uuid, action_date: '2026-10-15', exchange_ratio: '1.5',
      });
    });

    it('a spinoff, with the basis share it starts with', async () => {
      const user = userEvent.setup();
      await start(user, /^Spinoff$/);
      await choose(user, /New \(spun-off\) security/, /BONDIX/);
      await apply(user);
      expect(await sent(calls, 'POST /investments/corporate-actions/spinoff')).toEqual({
        source_security_uuid: stockFund.uuid, new_security_uuid: bondFund.uuid, action_date: '2026-10-15',
        allocation_fraction: '0.2', share_ratio: '2',
      });
    });
  });
});
