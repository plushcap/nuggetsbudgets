import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Toaster } from 'react-hot-toast';
import { Route, Routes } from 'react-router-dom';
import { transferCreateSchema } from '@nuggets/shared';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import { apiError, mockApi } from '../../test/apiServer';
import { account, accountsResponse, budgetPeriod, uuidFor } from '../../test/fixtures';
import TransferMoneyPage from '../TransferMoneyPage';

/**
 * Transfer Money against the API: the transfer it sends is one POST /transfer
 * takes (transferCreateSchema), between the accounts chosen, in today's budget period;
 * and a refusal is shown, not swallowed.
 */

Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
});

// Mid-October, so October's period is today's.
pinTimeZone('UTC', '2026-10-15T12:00:00Z');

const checking = account({ id: 1, name: 'Everyday checking', calculated_balance: '2000.00' });
const savings = account({ id: 2, name: 'Rainy day savings', account_type: 'savings', calculated_balance: '500.00' });
const card = account({ id: 3, name: 'Travel card', type: 'Liability', account_type: 'credit_card', account_group: 'credit cards', calculated_balance: '-300.00' });
const closed = account({ id: 4, name: 'Old checking', close_account: true });
const periods = [budgetPeriod(2026, 9), budgetPeriod(2026, 10), budgetPeriod(2026, 11)];

let api: ReturnType<typeof mockApi>;
const routes = (overrides: Parameters<typeof mockApi>[0] = {}) => ({
  'GET /accounts': accountsResponse([checking, savings, card, closed]),
  'GET /budgets/periods': periods,
  // What POST /transfer answers (transferResponseSchema): the two sides written.
  'POST /transfer': { success: true, source_transaction_uuid: uuidFor(5, 1), destination_transaction_uuid: uuidFor(5, 2) },
  ...overrides,
});

const renderPage = (route = '/transfertransaction') =>
  renderWithProviders(
    <Theme>
      <Toaster />
      <Routes>
        <Route path="/transfertransaction" element={<TransferMoneyPage />} />
        <Route path="/transactions" element={<p>Transactions list</p>} />
      </Routes>
    </Theme>,
    { route },
  );

const choose = async (user: ReturnType<typeof userEvent.setup>, field: RegExp, option: string) => {
  await user.click(await screen.findByRole('combobox', { name: field }));
  await user.click(await screen.findByRole('option', { name: option }));
};

afterEach(() => vi.unstubAllGlobals());

describe('TransferMoneyPage', () => {
  beforeEach(() => {
    api = mockApi(routes());
  });

  it('sends the transfer POST /transfer takes, and goes back to the list', async () => {
    const user = userEvent.setup();
    renderPage();

    await choose(user, /From Account/, 'Everyday checking');
    await choose(user, /To Account/, 'Rainy day savings');
    await user.type(screen.getByRole('textbox', { name: /Amount/ }), '1,250.75');
    await user.click(screen.getByRole('button', { name: 'Create Transfer' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Transfer $1,250.75 from Everyday checking to Rainy day savings?');
    await user.click(within(dialog).getByRole('button', { name: 'Transfer' }));

    await waitFor(() => expect(api.calls('POST /transfer')).toHaveLength(1));
    const body = api.calls('POST /transfer')[0].body as Record<string, unknown>;
    expect(transferCreateSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      source_account_id: checking.id,
      destination_account_id: savings.id,
      amount: 1250.75,
      type: 'transfer',
      transaction_date: '2026-10-15',
      // Today's period, not the newest one.
      budget_period_id: periods[1].id,
    });
    expect(await screen.findByText('Transactions list')).toBeInTheDocument();
  });

  it('offers neither a closed account nor the source account as the destination', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('combobox', { name: /From Account/ }));
    expect(screen.queryByRole('option', { name: 'Old checking' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Everyday checking' }));

    await user.click(screen.getByRole('combobox', { name: /To Account/ }));
    const offered = screen.getAllByRole('option').map((option) => option.textContent);
    expect(offered).toContain('Rainy day savings');
    expect(offered).not.toContain('Everyday checking');
    expect(offered).not.toContain('Old checking');
  });

  it('sends nothing until the form is complete, and says what is missing', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Create Transfer' }));

    expect(await screen.findByText('Source account is required')).toBeInTheDocument();
    expect(screen.getByText('Destination account is required')).toBeInTheDocument();
    expect(screen.getByText('Amount must be greater than zero')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.calls('POST /transfer')).toHaveLength(0);
  });

  it("shows the server's reason when it refuses the transfer, and stays on the form", async () => {
    api = mockApi(routes({ 'POST /transfer': apiError(400, 'Destination account is closed', 'VALIDATION_ERROR') }));
    const user = userEvent.setup();
    renderPage();

    await choose(user, /From Account/, 'Everyday checking');
    await choose(user, /To Account/, 'Travel card');
    await user.type(screen.getByRole('textbox', { name: /Amount/ }), '300');
    await user.click(screen.getByRole('button', { name: 'Create Transfer' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Transfer' }));

    expect(await screen.findByText('Destination account is closed')).toBeInTheDocument();
    expect(screen.queryByText('Transactions list')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create Transfer' })).toBeEnabled();
  });

  it('starts from the account a link names as the source', async () => {
    const user = userEvent.setup();
    renderPage(`/transfertransaction?source=${savings.uuid}`);

    await choose(user, /To Account/, 'Everyday checking');
    await user.type(screen.getByRole('textbox', { name: /Amount/ }), '20');
    await user.click(screen.getByRole('button', { name: 'Create Transfer' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Transfer' }));

    await waitFor(() => expect(api.calls('POST /transfer')).toHaveLength(1));
    expect(api.calls('POST /transfer')[0].body).toMatchObject({ source_account_id: savings.id, destination_account_id: checking.id });
  });
});
