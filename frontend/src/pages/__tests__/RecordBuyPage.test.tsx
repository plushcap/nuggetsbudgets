import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Route, Routes } from 'react-router-dom';
import { buyEventSchema } from '@nuggets/shared';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import { apiError, mockApi } from '../../test/apiServer';
import { account, accountsResponse, created, investmentAnswers, security } from '../../test/fixtures';
import RecordBuyPage from '../RecordBuyPage';

/**
 * Recording a buy against the API: the event it sends is one POST
 * /investments/events/buy takes (buyEventSchema), for the account and security
 * chosen, the share count as typed (the API reads it exactly); only investment
 * accounts are offered; a refusal keeps the member on the form and says why.
 */

Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
});

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});

pinTimeZone('UTC', '2026-10-15T12:00:00Z');

const brokerage = account({ id: 1, name: 'Brokerage', account_type: 'investment', account_group: 'investments' });
const ira = account({ id: 2, name: 'Roth IRA', account_type: 'retirement', account_group: 'investments' });
const checking = account({ id: 3, name: 'Everyday checking' });
const stockFund = security({ id: 1, ticker: 'STKIDX', name: 'Total Stock Market', latest_price: '250.12' });
const bondFund = security({ id: 2, ticker: 'BONDIX', name: 'Total Bond Market' });

const routes = (overrides: Parameters<typeof mockApi>[0] = {}) => ({
  'GET /accounts': accountsResponse([brokerage, ira, checking]),
  'GET /investments/securities': [stockFund, bondFund],
  'POST /investments/events/buy': created(investmentAnswers.buy),
  ...overrides,
});

const renderPage = () =>
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path="/investments/buy" element={<RecordBuyPage />} />
        <Route path="/investments" element={<p>Investments overview</p>} />
      </Routes>
    </Theme>,
    { route: '/investments/buy' },
  );

const fill = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('combobox', { name: /Account/ }));
  await user.click(await screen.findByRole('option', { name: 'Roth IRA' }));
  await user.click(screen.getByRole('combobox', { name: /Security/ }));
  await user.click(await screen.findByRole('option', { name: /STKIDX/ }));
  await user.type(screen.getByRole('spinbutton', { name: 'Shares' }), '12.5');
  await user.type(screen.getByRole('textbox', { name: 'Price per share' }), '248.37');
  await user.type(screen.getByRole('textbox', { name: /Commission/ }), '1.99');
};

let api: ReturnType<typeof mockApi>;
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('RecordBuyPage', () => {
  it('offers only investment accounts', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('combobox', { name: /Account/ }));
    const offered = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(offered).toEqual(['Brokerage', 'Roth IRA']);
  });

  it('sends the buy POST /investments/events/buy takes, and returns to Investments', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    const save = await screen.findByRole('button', { name: 'Record buy' });
    await fill(user);
    await user.click(save);

    await waitFor(() => expect(api.calls('POST /investments/events/buy')).toHaveLength(1));
    const body = api.calls('POST /investments/events/buy')[0].body;
    expect(buyEventSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      account_uuid: ira.uuid,
      security_uuid: stockFund.uuid,
      event_date: '2026-10-15',
      shares: '12.5',
      price_per_share: 248.37,
      fees: 1.99,
      acquisition_method: 'purchase',
      source: 'manual',
      adjusted_for_splits: false,
      dry_run: false,
    });
    expect(await screen.findByText('Investments overview')).toBeInTheDocument();
  });

  it('says what is missing beside each field, and focuses the first, when Record buy is pressed too soon', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    // The button stays enabled (CLAUDE.md's form rules): pressing it says what to fix.
    const save = await screen.findByRole('button', { name: 'Record buy' });
    expect(save).toBeEnabled();
    await user.click(save);
    const accountField = screen.getByRole('combobox', { name: /Account/ });
    await waitFor(() => expect(accountField).toHaveFocus());
    expect(accountField).toHaveAccessibleDescription('Choose an investment account.');
    expect(screen.getByRole('combobox', { name: /Security/ })).toHaveAccessibleDescription('Choose a security.');
    expect(screen.getByRole('spinbutton', { name: 'Shares' })).toHaveAccessibleDescription('Enter a number.');
    expect(screen.getByRole('textbox', { name: 'Price per share' })).toHaveAccessibleDescription('Enter the price per share.');
    expect(api.calls('POST /investments/events/buy')).toHaveLength(0);
  });

  it('refuses a share count written with an exponent, beside the field, and sends nothing', async () => {
    // A type="number" field takes 1e2, which the page sent as typed and the API refused
    // (with a toast); earlier still, Number() sent 100.
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await fill(user);
    const shares = screen.getByRole('spinbutton', { name: 'Shares' });
    // What a browser's number field holds when 1e2 is typed (user-event's typing makes it 100).
    fireEvent.change(shares, { target: { value: '1e2' } });
    expect(shares).toHaveValue(100);
    await user.click(screen.getByRole('button', { name: 'Record buy' }));
    await waitFor(() => expect(shares).toHaveFocus());
    expect(shares).toHaveAttribute('aria-invalid', 'true');
    expect(shares).toHaveAccessibleDescription('Enter a plain number, like 12.5, without an exponent or a sign.');
    expect(api.calls('POST /investments/events/buy')).toHaveLength(0);

    // Written plainly, it goes, as typed.
    await user.clear(shares);
    await user.type(shares, '100');
    expect(shares).not.toHaveAttribute('aria-invalid');
    await user.click(screen.getByRole('button', { name: 'Record buy' }));
    await waitFor(() => expect(api.calls('POST /investments/events/buy')).toHaveLength(1));
    expect(api.calls('POST /investments/events/buy')[0].body).toMatchObject({ shares: '100' });
  });

  it('takes a price to four decimal places, as the API keeps it', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await fill(user);
    const price = screen.getByRole('textbox', { name: 'Price per share' });
    await user.clear(price);
    await user.type(price, '248.3725');
    expect(price).not.toHaveAttribute('aria-invalid');
    await user.click(screen.getByRole('button', { name: 'Record buy' }));

    await waitFor(() => expect(api.calls('POST /investments/events/buy')).toHaveLength(1));
    const body = api.calls('POST /investments/events/buy')[0].body;
    expect(body).toMatchObject({ price_per_share: 248.3725, fees: 1.99 });
    expect(buyEventSchema.safeParse(body).success).toBe(true);
  });

  // The box's own hint was left out whenever the form had an error for the
  // field, and the price's ("Enter the price per share.") doesn't say why 1.234 was refused.
  it("keeps the price box's own reason beside the form's message after a refused submit", async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await fill(user);
    const price = screen.getByRole('textbox', { name: 'Price per share' });
    await user.clear(price);
    await user.type(price, '1.234');
    const reason = 'Not an amount: enter it like 1,234.5678 or 1.234,5678, with at most four decimals. Write three as four (1.2340): 1.234 could be 1234.';
    expect(price).toHaveAccessibleDescription(reason);
    await user.click(screen.getByRole('button', { name: 'Record buy' }));
    await waitFor(() => expect(price).toHaveFocus());
    expect(price).toHaveAccessibleDescription(`Enter the price per share. ${reason}`);
    expect(api.calls('POST /investments/events/buy')).toHaveLength(0);
  });

  it('refuses fees it cannot read, beside the field, rather than send no fees', async () => {
    // The fee box reported unreadable text as no amount (null), and the page sent fees: 0.
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await fill(user);
    const fees = screen.getByRole('textbox', { name: /Commission/ });
    await user.clear(fees);
    await user.type(fees, '1.234'); // three decimals: 1.234 or 1234?
    await user.click(screen.getByRole('button', { name: 'Record buy' }));
    await waitFor(() => expect(fees).toHaveFocus());
    expect(fees).toHaveAttribute('aria-invalid', 'true');
    // One message: the field's says why (the box's own hint is left out).
    expect(fees).toHaveAccessibleDescription('Not an amount: enter the fees like 4.95, or leave them empty.');
    expect(api.calls('POST /investments/events/buy')).toHaveLength(0);

    // Left empty, it is no fees.
    await user.clear(fees);
    await user.click(screen.getByRole('button', { name: 'Record buy' }));
    await waitFor(() => expect(api.calls('POST /investments/events/buy')).toHaveLength(1));
    expect(api.calls('POST /investments/events/buy')[0].body).toMatchObject({ fees: 0 });
  });

  it('stays on the form, still filled in, when the API refuses the buy', async () => {
    api = mockApi(routes({ 'POST /investments/events/buy': apiError(400, 'Account is closed', 'VALIDATION_ERROR') }));
    const user = userEvent.setup();
    renderPage();

    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Record buy' }));

    await waitFor(() => expect(api.calls('POST /investments/events/buy')).toHaveLength(1));
    const { default: toast } = await import('react-hot-toast');
    // Says why: the server's reason.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Account is closed'));
    expect(screen.queryByText('Investments overview')).toBeNull();
    expect(screen.getByRole('spinbutton', { name: 'Shares' })).toHaveValue(12.5);
    expect(screen.getByRole('button', { name: 'Record buy' })).toBeEnabled();
  });
});
