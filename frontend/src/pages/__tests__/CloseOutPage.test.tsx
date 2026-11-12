import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { transferCreateSchema } from '@nuggets/shared';
import { renderWithProviders } from '../../test/renderWithProviders';
import { apiError, labelledLine, mockApi } from '../../test/apiServer';
import { account, accountsResponse, budgetPeriod, budgetPeriodItem, uuidFor } from '../../test/fixtures';
import type { ZeroBalanceAccount, ZeroBalanceSummary } from '../../services/api/types';
import CloseOutPage from '../CloseOutPage';

/**
 * The reconciliation the page hands its envelope section, recorded as the section renders
 * as it is. The section rounds what it shows and pre-fills to the cent, so a float the
 * page worked out (1030.3100000000002) showed and was sent as 1030.31 all the same: only
 * the figures the page passes show the page's own sums.
 */
const reconciliations = vi.hoisted(() => [] as unknown[]);
vi.mock('../../components/closeout/EnvelopeReconciliationSection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/closeout/EnvelopeReconciliationSection')>();
  const Section = actual.default;
  const Recorded = (props: React.ComponentProps<typeof Section>) => {
    reconciliations.push(props.reconciliation);
    return <Section {...props} />;
  };
  return { ...actual, default: Recorded };
});

/**
 * Monthly Close-Out against the API: the month's figures it works out from
 * the period's items, the envelope account it reconciles against them, and the
 * banner when the data can't load. Only `fetch` is stubbed.
 */

const october = budgetPeriod(2026, 10);

// Amounts as pg sends NUMERIC (strings), pre-signed: spending is negative.
const items = [
  budgetPeriodItem(october, { id: 1, budget_item_name: 'Paycheck', expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck', calculated_budget: '5000.00', calculated_actual: '5000.00' }),
  budgetPeriodItem(october, { id: 2, budget_item_name: 'Rent', type: 'Monthly', subtype: 'Fixed', calculated_budget: '1500.00', calculated_actual: '-1500.00', calculated_remaining: '0.00' }),
  // A bill not paid yet.
  budgetPeriodItem(october, { id: 3, budget_item_name: 'Electric', type: 'Monthly', subtype: 'Fixed', calculated_budget: '120.00', calculated_actual: '0.00', calculated_remaining: '120.00' }),
  // A bill that came in $20 over: overspent, but not an unpaid bill.
  budgetPeriodItem(october, { id: 8, budget_item_name: 'Internet', type: 'Monthly', subtype: 'Fixed', calculated_budget: '60.00', calculated_actual: '-80.00', calculated_remaining: '-20.00' }),
  // A flexible item with money left: neither an unpaid bill nor overspent.
  budgetPeriodItem(october, { id: 10, budget_item_name: 'Gas', type: 'Monthly', subtype: 'Flexible', calculated_budget: '100.00', calculated_actual: '-60.00', calculated_remaining: '40.00' }),
  // Overspent by $50.
  budgetPeriodItem(october, { id: 4, budget_item_name: 'Dining out', type: 'Monthly', subtype: 'Flexible', calculated_budget: '200.00', calculated_actual: '-250.00', calculated_remaining: '-50.00' }),
  budgetPeriodItem(october, { id: 5, budget_item_name: 'Groceries', type: 'Envelope', subtype: 'Flexible', calculated_budget: '600.00', calculated_actual: '-450.00', calculated_remaining: '150.00' }),
  budgetPeriodItem(october, { id: 6, budget_item_name: 'Fun money', type: 'Envelope', subtype: 'Flexible', calculated_budget: '100.00', calculated_actual: '0.00', calculated_remaining: '100.00' }),
  budgetPeriodItem(october, { id: 7, budget_item_name: 'Emergency fund', expense_type: 'Savings', type: 'Goal', subtype: 'Goal', calculated_budget: '400.00' }),
];

// The envelopes hold $250.00 between them; the account has $200.00.
const envelopeAccount = account({ id: 9, name: 'Envelope savings', account_type: 'savings', is_envelope_account: true, calculated_balance: '200.00' });

/** GET /accounts/zero-balance/:uuid. No shared schema yet: typed from the frontend's types. */
const zeroBalance: { accounts: ZeroBalanceAccount[]; summary: ZeroBalanceSummary } = {
  accounts: [],
  summary: { total_accounts: 0, balanced_count: 0, needs_adjustment_count: 0, total_adjustment_amount: 0 },
};

const routes = (overrides: Parameters<typeof mockApi>[0] = {}) => ({
  'GET /budgets/periods': [october],
  'GET /budgets/periods/:uuid/items': { success: true, data: items },
  'GET /accounts': accountsResponse([envelopeAccount]),
  'GET /accounts/zero-balance/:uuid': zeroBalance,
  'GET /budgets/periods/:uuid/envelope-transfers': [],
  // The household's time zone, for which month is today's (useBudgetPeriodSelection).
  'GET /settings/general': [],
  ...overrides,
});

const renderPage = () => renderWithProviders(<Theme><CloseOutPage /></Theme>, { route: '/close-out?period=2026-10' });

/** A status line: its label and figure, which share one row. */
const line = (label: string) => labelledLine(screen.getByText(label));

let api: ReturnType<typeof mockApi>;
beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('CloseOutPage', () => {
  it("works out the month's remaining money from the period's items", async () => {
    api = mockApi(routes());
    renderPage();

    expect(await screen.findByText('Actual Income:')).toBeInTheDocument();
    expect(line('Actual Income:')).toBe('Actual Income:$5,000.00');
    expect(line('Spent (Monthly Expenses):')).toBe('Spent (Monthly Expenses):-$1,890.00');
    expect(line('Planned (Envelopes):')).toBe('Planned (Envelopes):-$700.00');
    expect(line('Saved (Goals):')).toBe('Saved (Goals):-$400.00');
    // 5,000 − 1,890 − 700 − 400
    expect(line('Actual Remaining:')).toBe('Actual Remaining:$2,010.00');
    // Only the unpaid fixed bill counts: not the overpaid one, nor a flexible item with money left.
    expect(line('Unpaid Bills (Remaining Fixed):')).toBe('Unpaid Bills (Remaining Fixed):-$120.00');
    expect(line('Estimated Remaining:')).toBe('Estimated Remaining:$1,890.00');
    expect(api.requests.map((r) => r.path)).toContain(`/accounts/zero-balance/${october.uuid}`);
    expect(api.unhandled).toEqual([]);
  });

  // Close-Out works the month out with the Budget page's own formula. Its copy took every
  // Envelope item's budget as a plan, so an Envelope goal came off twice (as a plan and as a
  // saving), and a Transfer envelope the Budget page doesn't list came off too.
  it('takes envelope plans from expense items only, as the Budget page does', async () => {
    api = mockApi(routes({
      'GET /budgets/periods/:uuid/items': {
        success: true,
        data: [
          ...items,
          budgetPeriodItem(october, { id: 11, budget_item_name: 'House fund', expense_type: 'Savings', type: 'Envelope', subtype: 'Flexible', calculated_budget: '250.00' }),
          budgetPeriodItem(october, { id: 12, budget_item_name: 'Card payment', expense_type: 'Transfer', type: 'Envelope', subtype: 'Flexible', calculated_budget: '300.00' }),
        ],
      },
    }));
    renderPage();

    expect(await screen.findByText('Actual Income:')).toBeInTheDocument();
    expect(line('Planned (Envelopes):')).toBe('Planned (Envelopes):-$700.00');
    // The goal's $250 comes off once, as a saving.
    expect(line('Saved (Goals):')).toBe('Saved (Goals):-$650.00');
    // 5,000 − 1,890 − 700 − 650
    expect(line('Actual Remaining:')).toBe('Actual Remaining:$1,760.00');
    expect(line('Estimated Remaining:')).toBe('Estimated Remaining:$1,640.00');
  });

  it('lists the overspent monthly expenses, and no envelope as overspent', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    // Only the monthly card has items to open; it names its count.
    const open = await screen.findByRole('button', { name: /View items/, description: 'Overspent Monthly Expenses 2' });
    expect(screen.getAllByRole('button', { name: /View items/ })).toHaveLength(1);
    expect(screen.getByText('All on track')).toBeInTheDocument();
    expect(screen.getByText('-$70.00')).toBeInTheDocument();

    await user.click(open);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Dining out')).toBeInTheDocument();
    expect(within(dialog).getByText('Internet')).toBeInTheDocument();
    expect(within(dialog).queryByText('Rent')).toBeNull();
    expect(within(dialog).queryByText('Electric')).toBeNull();
    expect(within(dialog).queryByText('Gas')).toBeNull();
  });

  it('says how much to deposit when the envelope account holds less than the envelopes', async () => {
    api = mockApi(routes());
    renderPage();

    // $250.00 in envelopes − $200.00 in the account.
    expect(await screen.findByText('Deposit $50.00 into Envelope savings')).toBeInTheDocument();
  });

  describe('in whole cents', () => {
    // 600.10 + 250.20 + 0.30 is 850.5999999999999 in floats, and 1,880.91 less that is
    // 1030.3100000000002: shown as $1,030.31, it was sent as it was, and refused.
    const inexact = [
      budgetPeriodItem(october, { id: 21, budget_item_name: 'Car repairs', type: 'Envelope', subtype: 'Flexible', calculated_budget: '600.10', calculated_remaining: '600.10' }),
      budgetPeriodItem(october, { id: 22, budget_item_name: 'Gifts', type: 'Envelope', subtype: 'Flexible', calculated_budget: '250.20', calculated_remaining: '250.20' }),
      budgetPeriodItem(october, { id: 23, budget_item_name: 'Stamps', type: 'Envelope', subtype: 'Flexible', calculated_budget: '0.30', calculated_remaining: '0.30' }),
    ];
    const checking = account({ id: 31, name: 'Family checking' });
    const longTerm = account({
      id: 32, name: 'Reserve savings', account_type: 'savings', is_envelope_account: true,
      calculated_balance: '1880.91', default_pay_from_account_id: checking.id,
    });

    it('shows the variance to the cent, and the envelope transfer sends it with two decimals', async () => {
      api = mockApi(routes({
        'GET /budgets/periods/:uuid/items': { success: true, data: inexact },
        'GET /accounts': accountsResponse([checking, longTerm]),
        'POST /transfer': { success: true, source_transaction_uuid: uuidFor(5, 1), destination_transaction_uuid: uuidFor(5, 2) },
      }));
      const user = userEvent.setup();
      renderPage();

      expect(await screen.findByText('Record unbudgeted income (e.g. interest), or withdraw the excess from Reserve savings')).toBeInTheDocument();
      expect(line('Actual Envelope Balance')).toBe('Actual Envelope Balance$1,880.91Reserve savings');
      expect(line('Expected Budget Balance')).toBe('Expected Budget Balance$850.603 envelope items');
      expect(line('Variance')).toBe('Variance$1,030.31');
      // What the page worked out, exactly: in floats it was 850.5999999999999 and
      // 1030.3100000000002, which the section's rounding hid in what it shows and sends.
      expect(reconciliations[reconciliations.length - 1]).toMatchObject({
        envelope_account: { actual_balance: 1880.91 },
        budget_summary: { expected_balance: 850.6, total_budgeted: 850.6 },
        variance: { amount: 1030.31, status: 'overfunded' },
      });

      await user.click(screen.getByRole('button', { name: 'Submit Transfer' }));
      const dialog = await screen.findByRole('dialog', { name: /Transfer Money/ });
      expect(within(dialog).getByRole('textbox', { name: /Amount/ })).toHaveValue('1,030.31');
      // Overfunded: the excess goes out of the envelope account, to its transfer account.
      expect(within(dialog).getByRole('combobox', { name: /From Account/ })).toHaveTextContent('Reserve savings');
      expect(within(dialog).getByRole('combobox', { name: /To Account/ })).toHaveTextContent('Family checking');
      await user.click(within(dialog).getByRole('button', { name: 'Create Transfer' }));
      const confirm = await screen.findByRole('alertdialog');
      expect(confirm).toHaveTextContent('Transfer $1,030.31 from Reserve savings to Family checking?');
      await user.click(within(confirm).getByRole('button', { name: 'Transfer' }));

      await waitFor(() => expect(api.calls('POST /transfer')).toHaveLength(1));
      const body = api.calls('POST /transfer')[0].body as Record<string, unknown>;
      // At most two decimals, as the API's toCents reads it: 1030.31, not 1030.3100000000002.
      expect(body.amount).toBe(1030.31);
      expect(String(body.amount)).toMatch(/^\d+(\.\d{1,2})?$/);
      expect(body).toMatchObject({ source_account_id: longTerm.id, destination_account_id: checking.id, type: 'transfer' });
      expect(transferCreateSchema.safeParse(body).success).toBe(true);
    });

    it('takes a one-cent variance as one, not as balanced', async () => {
      // 0.10 + 0.20 is 0.30000000000000004, and 0.31 less that 0.00999…, which a 0.01 test
      // called balanced, beside a variance of $0.01.
      api = mockApi(routes({
        'GET /budgets/periods/:uuid/items': { success: true, data: [
          budgetPeriodItem(october, { id: 24, budget_item_name: 'Coffee', type: 'Envelope', subtype: 'Flexible', calculated_budget: '0.10', calculated_remaining: '0.10' }),
          budgetPeriodItem(october, { id: 25, budget_item_name: 'Tea', type: 'Envelope', subtype: 'Flexible', calculated_budget: '0.20', calculated_remaining: '0.20' }),
        ] },
        'GET /accounts': accountsResponse([checking, { ...longTerm, calculated_balance: '0.31' }]),
      }));
      renderPage();

      expect(await screen.findByText('Record unbudgeted income (e.g. interest), or withdraw the excess from Reserve savings')).toBeInTheDocument();
      expect(screen.queryByText('Perfectly balanced!')).toBeNull();
      expect(screen.getByRole('button', { name: 'Submit Transfer' })).toBeInTheDocument();
    });

    it("adds the month's figures to the cent, so a remaining of nothing is $0.00, not -$0.00", async () => {
      // Income of 0.30 less envelopes of 0.10 and 0.20 was -5.55e-17, shown as -$0.00 in red.
      api = mockApi(routes({
        'GET /budgets/periods/:uuid/items': { success: true, data: [
          budgetPeriodItem(october, { id: 26, budget_item_name: 'Interest', expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck', calculated_budget: '0.30', calculated_actual: '0.30' }),
          budgetPeriodItem(october, { id: 24, budget_item_name: 'Coffee', type: 'Envelope', subtype: 'Flexible', calculated_budget: '0.10', calculated_remaining: '0.10' }),
          budgetPeriodItem(october, { id: 25, budget_item_name: 'Tea', type: 'Envelope', subtype: 'Flexible', calculated_budget: '0.20', calculated_remaining: '0.20' }),
        ] },
      }));
      renderPage();

      expect(await screen.findByText('Actual Remaining:')).toBeInTheDocument();
      expect(line('Actual Remaining:')).toBe('Actual Remaining:$0.00');
      expect(line('Estimated Remaining:')).toBe('Estimated Remaining:$0.00');
    });

    it('counts an item a cent over as overspent', async () => {
      api = mockApi(routes({
        'GET /budgets/periods/:uuid/items': { success: true, data: [
          budgetPeriodItem(october, { id: 27, budget_item_name: 'Water', type: 'Monthly', subtype: 'Fixed', calculated_budget: '40.00', calculated_actual: '-40.01', calculated_remaining: '-0.01' }),
        ] },
      }));
      renderPage();

      expect(await screen.findByRole('button', { name: /View items/, description: 'Overspent Monthly Expenses 1' })).toBeInTheDocument();
      expect(screen.getByText('-$0.01')).toBeInTheDocument();
    });
  });

  describe("a zero-balance account's Submit Transfer", () => {
    const checking = account({ id: 41, name: 'Family checking', calculated_balance: '5000.00' });
    const card = account({
      id: 42, name: 'Travel card', type: 'Liability', account_type: 'credit_card', account_group: 'credit cards',
      calculated_balance: '-1998.15', default_pay_from_account_id: checking.id,
    });
    const clearing = account({ id: 43, name: 'Payroll clearing', calculated_balance: '900.00' });

    /** The account's card, as GET /accounts/zero-balance/:uuid works it out (AccountQueries.zeroBalanceAudit). */
    const audited = (row: typeof card, periodBalance: number): ZeroBalanceAccount => ({
      uuid: row.uuid as string,
      name: row.name,
      account_type: row.account_type as string,
      icon: row.icon ?? '',
      color: row.type ?? '',
      period_balance: periodBalance,
      current_balance: Number(row.calculated_balance),
      is_balanced: periodBalance === 0,
      adjustment_needed: Math.abs(periodBalance),
      adjustment_direction: periodBalance < 0 ? 'credit' : periodBalance > 0 ? 'debit' : 'balanced',
    });

    const openTransfer = async (row: typeof card, periodBalance: number) => {
      api = mockApi(routes({
        'GET /accounts': accountsResponse([checking, row]),
        'GET /accounts/zero-balance/:uuid': {
          accounts: [audited(row, periodBalance)],
          summary: { total_accounts: 1, balanced_count: periodBalance === 0 ? 1 : 0, needs_adjustment_count: periodBalance === 0 ? 0 : 1, total_adjustment_amount: Math.abs(periodBalance) },
        },
        'POST /transfer': { success: true, source_transaction_uuid: uuidFor(5, 1), destination_transaction_uuid: uuidFor(5, 2) },
      }));
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Submit Transfer' }));
      const dialog = await screen.findByRole('dialog', { name: /Transfer Money/ });
      const field = (name: RegExp) => within(dialog).getByRole('combobox', { name });
      return { user, dialog, field, amount: within(dialog).getByRole('textbox', { name: /Amount/ }) };
    };

    it("pays a card what the period charged to it, not the card's whole balance", async () => {
      const { user, dialog, field, amount } = await openTransfer(card, -120);
      expect(screen.getByText('Needs credit of $120.00')).toBeInTheDocument();

      expect(amount).toHaveValue('120.00');
      expect(field(/From Account/)).toHaveTextContent('Family checking');
      expect(field(/To Account/)).toHaveTextContent('Travel card');
      expect(field(/Type/)).toHaveTextContent('Payment');

      await user.click(within(dialog).getByRole('button', { name: 'Create Transfer' }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Transfer' }));
      await waitFor(() => expect(api.calls('POST /transfer')).toHaveLength(1));
      expect(api.calls('POST /transfer')[0].body).toMatchObject({
        source_account_id: checking.id, destination_account_id: card.id, amount: 120, type: 'payment', budget_period_id: october.id,
      });
    });

    it("sweeps out what the period left in an asset account, not the account's balance", async () => {
      const { field, amount } = await openTransfer(clearing, 250.4);
      expect(screen.getByText('Needs debit of $250.40')).toBeInTheDocument();

      expect(amount).toHaveValue('250.40');
      expect(field(/From Account/)).toHaveTextContent('Payroll clearing');
      expect(field(/To Account/)).toHaveTextContent('Select destination account...');
      expect(field(/Type/)).toHaveTextContent('Transfer');
    });

    it('tops up an asset account the period left short, into it', async () => {
      const { field, amount } = await openTransfer(clearing, -75.25);
      expect(screen.getByText('Needs credit of $75.25')).toBeInTheDocument();

      expect(amount).toHaveValue('75.25');
      expect(field(/To Account/)).toHaveTextContent('Payroll clearing');
      expect(field(/From Account/)).toHaveTextContent('Select source account...');
      expect(field(/Type/)).toHaveTextContent('Transfer');
    });

    it('pre-fills no amount for a balanced period, and still opens the transfer', async () => {
      const { field, amount } = await openTransfer(card, 0);
      expect(screen.getByText('Balanced')).toBeInTheDocument();

      expect(amount).toHaveValue('');
      expect(field(/From Account/)).toHaveTextContent('Family checking');
      expect(field(/To Account/)).toHaveTextContent('Travel card');
    });
  });

  it('skips the reconciliation, and says why, when the envelope balance is unavailable', async () => {
    api = mockApi(routes({
      'GET /accounts': accountsResponse([{ ...envelopeAccount, calculated_balance: null, balance_unavailable: true }]),
    }));
    renderPage();

    expect(await screen.findByText('Envelope account balance unavailable; envelope reconciliation skipped')).toBeInTheDocument();
    // The banner needs only the accounts; wait for everything the reconciliation reads
    // (the status lines show once the items and the zero-balance answer are in).
    await screen.findByText('Actual Income:');
    expect(api.calls('GET /accounts/zero-balance/:uuid')).toHaveLength(1);
    // Never compared against $0.
    expect(screen.queryByText(/^Deposit .* into Envelope savings$/)).toBeNull();
    // The section says the same, not that no envelope account is configured.
    expect(screen.getByText('Envelope account balance unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Envelope savings's balance can't be worked out right now/)).toBeInTheDocument();
    expect(screen.queryByText('No envelope account configured')).toBeNull();
  });

  it("says the close-out data didn't load when the API fails", async () => {
    api = mockApi(routes({ 'GET /accounts/zero-balance/:uuid': apiError(500, 'Internal error', 'INTERNAL') }));
    renderPage();

    expect(await screen.findByText('Failed to load close-out data')).toBeInTheDocument();
    expect(await screen.findByText('Envelope reconciliation unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No envelope account configured')).toBeNull();
  });

  it('says there is nothing to reconcile in a period without budget items', async () => {
    api = mockApi(routes({ 'GET /budgets/periods/:uuid/items': { success: true, data: [] } }));
    renderPage();

    expect(await screen.findByText('Nothing to reconcile yet')).toBeInTheDocument();
    expect(screen.getByText('This period has no budget items to reconcile Envelope savings against.')).toBeInTheDocument();
    expect(screen.queryByText('No envelope account configured')).toBeNull();
  });

  it('offers to configure an envelope account when there is none', async () => {
    api = mockApi(routes({ 'GET /accounts': accountsResponse([{ ...envelopeAccount, is_envelope_account: false }]) }));
    renderPage();

    expect(await screen.findByText('No envelope account configured')).toBeInTheDocument();
  });

  // The accounts query wasn't counted. Failed, the page had no banner and the section
  // said no envelope account was configured; loading, it said the same until they came.
  it("says the accounts didn't load, not that no envelope account is configured", async () => {
    api = mockApi(routes({ 'GET /accounts': apiError(500, 'Internal error', 'INTERNAL') }));
    renderPage();

    expect(await screen.findByText('Failed to load close-out data')).toBeInTheDocument();
    expect(await screen.findByText('Envelope reconciliation unavailable')).toBeInTheDocument();
    expect(screen.getByText("The close-out data didn't load, so the envelope account isn't reconciled.")).toBeInTheDocument();
    expect(screen.queryByText('No envelope account configured')).toBeNull();
  });

  it('waits for the accounts before saying anything about the envelope account', async () => {
    let release: () => void = () => {};
    const accountsLoaded = new Promise<void>((resolve) => { release = resolve; });
    api = mockApi(routes({
      'GET /accounts': async () => {
        await accountsLoaded;
        return accountsResponse([envelopeAccount]);
      },
    }));
    renderPage();

    // The items and the zero-balance answer are in; the accounts aren't.
    await waitFor(() => expect(api.calls('GET /accounts/zero-balance/:uuid')).toHaveLength(1));
    await waitFor(() => expect(api.calls('GET /budgets/periods/:uuid/items')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('No envelope account configured')).toBeNull();
    expect(screen.queryByText('Actual Income:')).toBeNull();

    release();
    expect(await screen.findByText('Deposit $50.00 into Envelope savings')).toBeInTheDocument();
  });

  // Each was a literal "-" before the amount: nothing showed as -$0.00, and an amount
  // below zero as --$5.00.
  it('shows a figure taken off the remaining as the signed amount it adds', async () => {
    api = mockApi(routes({
      'GET /budgets/periods/:uuid/items': { success: true, data: [
        budgetPeriodItem(october, { id: 1, budget_item_name: 'Paycheck', expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck', calculated_budget: '100.00', calculated_actual: '100.00' }),
        // A goal budgeted below zero (money taken back out of it).
        budgetPeriodItem(october, { id: 7, budget_item_name: 'Emergency fund', expense_type: 'Savings', type: 'Goal', subtype: 'Goal', calculated_budget: '-5.00' }),
      ] },
    }));
    renderPage();

    expect(await screen.findByText('Actual Income:')).toBeInTheDocument();
    expect(line('Planned (Envelopes):')).toBe('Planned (Envelopes):$0.00');
    expect(line('Saved (Goals):')).toBe('Saved (Goals):$5.00');
    expect(line('Unpaid Bills (Remaining Fixed):')).toBe('Unpaid Bills (Remaining Fixed):$0.00');
    // 100 − 0 − (−5)
    expect(line('Actual Remaining:')).toBe('Actual Remaining:$105.00');
  });
});
