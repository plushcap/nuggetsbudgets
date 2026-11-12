import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '../../../test/renderWithProviders';
import { pinTimeZone } from '../../../test/timeZone';
import { apiError, mockApi } from '../../../test/apiServer';
import { account, accountsResponse, created, investmentAnswers, security } from '../../../test/fixtures';
import RecordDividendPage from '../../../pages/RecordDividendPage';
import RecordFeePage from '../../../pages/RecordFeePage';
import AddPricePage from '../../../pages/AddPricePage';

/**
 * The one investment event form on the pages that had no tests of their own:
 * a problem shows beside its field and the first is focused, the button staying enabled; the
 * shared request schema refuses on the field what the field checks let through; a refusal
 * keeps the form and gives the server's reason.
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

const render = (path: string, page: React.ReactElement, route = path) =>
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path={path} element={page} />
        <Route path="*" element={<p>Elsewhere</p>} />
      </Routes>
    </Theme>,
    { route },
  );

type User = ReturnType<typeof userEvent.setup>;
const choose = async (user: User, field: RegExp, option: RegExp | string) => {
  await user.click(await screen.findByRole('combobox', { name: field }));
  await user.click(await screen.findByRole('option', { name: option }));
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('InvestmentEventForm', () => {
  it('asks for a reinvested dividend’s price beside it, focuses the first problem, and sends nothing', async () => {
    const api = mockApi({
      'GET /accounts': accountsResponse([brokerage]),
      'GET /investments/securities': [stockFund],
      'POST /investments/events/dividend': created(investmentAnswers.dividend),
    });
    const user = userEvent.setup();
    render('/investments/dividend', <RecordDividendPage />);

    const record = await screen.findByRole('button', { name: 'Record dividend' });
    await choose(user, /Account/, 'Brokerage');
    await user.click(screen.getByRole('switch', { name: /Reinvest/ }));
    await user.click(record);

    const securityField = screen.getByRole('combobox', { name: /Security/ });
    await waitFor(() => expect(securityField).toHaveFocus());
    expect(record).toBeEnabled();
    expect(securityField).toHaveAccessibleDescription('Choose a security.');
    expect(screen.getByRole('textbox', { name: 'Total amount' })).toHaveAccessibleDescription('Enter the total amount paid, more than 0.');
    const price = screen.getByRole('textbox', { name: 'Reinvestment price per share' });
    expect(price).toHaveAccessibleDescription('Enter the price the dividend was reinvested at, more than 0.');

    // The messages follow the fields as they change.
    await user.type(price, '25.5');
    expect(price).not.toHaveAttribute('aria-invalid');
    // Turned off, the price is neither asked for nor sent.
    await user.click(screen.getByRole('switch', { name: /Reinvest/ }));
    expect(screen.queryByRole('textbox', { name: 'Reinvestment price per share' })).toBeNull();
    expect(api.calls('POST /investments/events/dividend')).toHaveLength(0);
  });

  it("refuses on the close price a price past what the API keeps, which only the request schema knows", async () => {
    const api = mockApi({
      'GET /investments/securities': [stockFund],
      'POST /investments/prices': created(investmentAnswers.price),
    });
    const user = userEvent.setup();
    render('/investments/prices/add', <AddPricePage />, `/investments/prices/add?security=${stockFund.uuid}`);

    const close = await screen.findByRole('textbox', { name: 'Close price' });
    await user.type(close, '123456789');
    await user.click(screen.getByRole('button', { name: 'Save price' }));

    await waitFor(() => expect(close).toHaveFocus());
    expect(close).toHaveAttribute('aria-invalid', 'true');
    // In words for people, not the schema's "close must be a number between …".
    expect(close).toHaveAccessibleDescription('Enter the close price, up to 99,999,999.9999.');
    expect(api.calls('POST /investments/prices')).toHaveLength(0);

    await user.clear(close);
    await user.type(close, '12345678.1234');
    expect(close).not.toHaveAttribute('aria-invalid');
    await user.click(screen.getByRole('button', { name: 'Save price' }));
    await waitFor(() => expect(api.calls('POST /investments/prices')).toHaveLength(1));
    expect(api.calls('POST /investments/prices')[0]!.body).toMatchObject({ close: 12345678.1234 });
    // A form with no account field doesn't ask for the accounts, as the page never did.
    expect(api.unhandled).toEqual([]);
  });

  it("stays on the form and gives the server's reason when the API refuses", async () => {
    mockApi({
      'GET /accounts': accountsResponse([brokerage]),
      'GET /investments/securities': [stockFund],
      'POST /investments/events/fee': apiError(400, 'Account is closed', 'VALIDATION_ERROR'),
    });
    const user = userEvent.setup();
    render('/investments/fee', <RecordFeePage />);

    await choose(user, /Account/, 'Brokerage');
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '12');
    await user.click(screen.getByRole('button', { name: 'Record fee' }));

    const { default: toast } = await import('react-hot-toast');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Account is closed'));
    expect(screen.queryByText('Elsewhere')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('12.00');
    expect(screen.getByRole('button', { name: 'Record fee' })).toBeEnabled();
  });
});
