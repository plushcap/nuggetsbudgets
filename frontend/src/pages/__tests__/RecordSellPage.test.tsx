import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Route, Routes } from 'react-router-dom';
import { sellEventSchema } from '@nuggets/shared';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import { mockApi } from '../../test/apiServer';
import { account, accountsResponse, created, investmentAnswers, security, taxLot } from '../../test/fixtures';
import RecordSellPage from '../RecordSellPage';

/**
 * Recording a sale: its share counts are plain decimals sent as typed (a number field
 * takes 1e2, which the API refuses), a specific-ID sale's lots must add up to the shares sold,
 * exactly, and the price takes 4 decimal places. A problem shows beside its field, and the
 * button, which stays enabled, focuses the first.
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
const lot = (id: number, acquisition_date: string, shares: number) => taxLot({ id, acquisition_date, shares });
const lots = [lot(1, '2025-01-02', 10), lot(2, '2025-02-03', 5)];

const routes = () => ({
  'GET /accounts': accountsResponse([brokerage]),
  'GET /investments/securities': [stockFund],
  'GET /investments/holdings/:uuid/lots': lots,
  'POST /investments/events/sell': created(investmentAnswers.sell),
});

const renderPage = () =>
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path="/investments/sell" element={<RecordSellPage />} />
        <Route path="/investments" element={<p>Investments overview</p>} />
      </Routes>
    </Theme>,
    { route: '/investments/sell' },
  );

const choose = async (user: ReturnType<typeof userEvent.setup>, field: RegExp, option: RegExp | string) => {
  await user.click(await screen.findByRole('combobox', { name: field }));
  await user.click(await screen.findByRole('option', { name: option }));
};

const fill = async (user: ReturnType<typeof userEvent.setup>, shares: string) => {
  await choose(user, /Account/, 'Brokerage');
  await choose(user, /^Security/, /STKIDX/);
  await user.type(screen.getByRole('spinbutton', { name: 'Shares' }), shares);
  await user.type(screen.getByRole('textbox', { name: 'Price per share' }), '12.3456');
};

const lotField = (acquired: string) => screen.findByRole('spinbutton', { name: `Sell qty, lot acquired ${acquired}` });

let api: ReturnType<typeof mockApi>;
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('RecordSellPage', () => {
  it('refuses fees it cannot read, beside the field, rather than send no fees', async () => {
    // The fee box reported unreadable text as no amount (null), and the page sent fees: 0.
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await fill(user, '1');
    const fees = screen.getByRole('textbox', { name: /Commission/ });
    await user.type(fees, '2,5,0');
    await user.click(screen.getByRole('button', { name: 'Record sell' }));
    await waitFor(() => expect(fees).toHaveFocus());
    expect(fees).toHaveAttribute('aria-invalid', 'true');
    expect(fees).toHaveAccessibleDescription(expect.stringContaining('Not an amount: enter the fees like 4.95, or leave them empty.'));
    expect(api.calls('POST /investments/events/sell')).toHaveLength(0);

    await user.clear(fees);
    await user.type(fees, '4.95');
    expect(fees).not.toHaveAttribute('aria-invalid');
    await user.click(screen.getByRole('button', { name: 'Record sell' }));
    await waitFor(() => expect(api.calls('POST /investments/events/sell')).toHaveLength(1));
    expect(api.calls('POST /investments/events/sell')[0].body).toMatchObject({ fees: 4.95 });
  });

  it('sends a specific-ID sale whose lots add up exactly, with a 4-decimal price', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await fill(user, '0.3');
    await choose(user, /Cost basis method/, 'Specific lots');
    await user.type(await lotField('2025-01-02'), '0.1');
    await user.type(await lotField('2025-02-03'), '0.2');
    await user.click(screen.getByRole('button', { name: 'Record sell' }));

    await waitFor(() => expect(api.calls('POST /investments/events/sell')).toHaveLength(1));
    const body = api.calls('POST /investments/events/sell')[0].body;
    expect(body).toMatchObject({
      account_uuid: brokerage.uuid,
      security_uuid: stockFund.uuid,
      shares: '0.3',
      price_per_share: 12.3456,
      method: 'specific_id',
      specific_lots: [{ lot_uuid: lots[0].uuid, shares: '0.1' }, { lot_uuid: lots[1].uuid, shares: '0.2' }],
    });
    expect(sellEventSchema.safeParse(body).success).toBe(true);
  });

  it("shows each lot's remaining total basis beside its per-share basis", async () => {
    // After a pro-rata sale the per-share figure is rounded; the lot's total is what a sale takes from.
    api = mockApi({
      ...routes(),
      'GET /investments/holdings/:uuid/lots': [taxLot({ id: 1, acquisition_date: '2025-01-02', shares: 3, cost_basis_per_share: '33.3300', total_cost_basis: '100.00' })],
    });
    const user = userEvent.setup();
    renderPage();

    await fill(user, '1');
    await choose(user, /Cost basis method/, 'Specific lots');
    const row = (await lotField('2025-01-02')).closest('tr');
    expect(screen.getByRole('columnheader', { name: 'Total basis' })).toBeInTheDocument();
    expect(row).toHaveTextContent('$33.33');
    expect(row).toHaveTextContent('$100.00');
  });

  it('refuses shares written with an exponent, beside the field, and sends nothing', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await fill(user, '5');
    const shares = screen.getByRole('spinbutton', { name: 'Shares' });
    // What a browser's number field holds when 1e2 is typed (user-event's typing makes it 100).
    fireEvent.change(shares, { target: { value: '1e2' } });
    await user.click(screen.getByRole('button', { name: 'Record sell' }));

    await waitFor(() => expect(shares).toHaveFocus());
    expect(shares).toHaveAccessibleDescription('Enter a plain number, like 12.5, without an exponent or a sign.');
    expect(api.calls('POST /investments/events/sell')).toHaveLength(0);
  });

  it('refuses a lot\'s shares written with an exponent, on that lot', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await fill(user, '0.1');
    await choose(user, /Cost basis method/, 'Specific lots');
    const first = await lotField('2025-01-02');
    fireEvent.change(first, { target: { value: '1e-1' } });
    await user.click(screen.getByRole('button', { name: 'Record sell' }));

    await waitFor(() => expect(first).toHaveFocus());
    expect(first).toHaveAttribute('aria-invalid', 'true');
    expect(first).toHaveAccessibleDescription('Enter a plain number, like 12.5, without an exponent or a sign.');
    expect(api.calls('POST /investments/events/sell')).toHaveLength(0);
  });

  it('says the lots must add up to the shares sold, and sends nothing until they do', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await fill(user, '0.3');
    await choose(user, /Cost basis method/, 'Specific lots');
    await user.type(await lotField('2025-01-02'), '0.1');
    await user.click(screen.getByRole('button', { name: 'Record sell' }));

    const group = screen.getByRole('group', { name: 'Select lots' });
    await waitFor(() => expect(group).toHaveFocus());
    expect(group).toHaveAccessibleDescription("The lots' shares add up to 0.1; they must add up to the shares sold.");
    expect(api.calls('POST /investments/events/sell')).toHaveLength(0);

    await user.type(await lotField('2025-02-03'), '0.2');
    await user.click(screen.getByRole('button', { name: 'Record sell' }));
    await waitFor(() => expect(api.calls('POST /investments/events/sell')).toHaveLength(1));
  });
});
