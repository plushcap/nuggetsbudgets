import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { apiError, labelledLine, mockApi } from '../../test/apiServer';
import { account, accountsResponse, budgetPeriod, budgetPeriodItem, envelopeBalanceFrom, uuidFor, type BudgetPeriodItemWire } from '../../test/fixtures';
import BudgetPage from '../BudgetPage';

/**
 * The Budget page against the API: what it adds up from the period's items,
 * and what an inline budget edit sends. Only `fetch` is stubbed; the page's hooks and
 * API module run as they do in the app.
 */

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});

// jsdom applies no CSS, so the mobile and the desktop layout are both in the page, and
// each one's edit field takes focus as it mounts: the other one's blur then saves and
// closes both. In a browser only one layout shows. Leave focus to the test.
vi.mock('../../utils/focusOnMount', () => ({ focusOnMount: () => {} }));

const october = budgetPeriod(2026, 10);

// Amounts as pg sends NUMERIC: strings, pre-signed (an actual is SUM(amount), so spending is negative). Each budget is distinct so a row's button is findable by it.
const seed = (): BudgetPeriodItemWire[] => [
  budgetPeriodItem(october, {
    id: 1, budget_item_name: 'Paycheck', expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck',
    calculated_budget: '5000.00', calculated_actual: '5000.00', calculated_remaining: '0.00',
  }),
  budgetPeriodItem(october, {
    id: 2, budget_item_name: 'Rent', expense_type: 'Expense', type: 'Monthly', subtype: 'Fixed',
    calculated_budget: '1500.10', calculated_actual: '-1500.10', calculated_remaining: '0.00',
  }),
  budgetPeriodItem(october, {
    id: 3, budget_item_name: 'Groceries', expense_type: 'Expense', type: 'Monthly', subtype: 'Flexible',
    calculated_budget: '600.25', calculated_actual: '-410.05', calculated_remaining: '190.20',
  }),
  budgetPeriodItem(october, {
    id: 4, budget_item_name: 'Emergency fund', expense_type: 'Savings', type: 'Goal', subtype: 'Goal',
    calculated_budget: '400.00', calculated_actual: '-400.00', calculated_remaining: '0.00',
  }),
];

let items: BudgetPeriodItemWire[];
let api: ReturnType<typeof mockApi>;

const routes = (overrides: Parameters<typeof mockApi>[0] = {}) => {
  const answers = {
    'GET /budgets/periods': [october],
    'GET /budgets/items': [],
    // The household's time zone, for which month is today's (useBudgetPeriodSelection).
    'GET /settings/general': [],
    'GET /accounts': accountsResponse([]),
    'GET /budgets/periods/:uuid/items': () => ({ success: true, data: items }),
    'PUT /budgets/period-items/:uuid/budget': ({ params, body }: { params: Record<string, string>; body: unknown }) => {
      const amount = (body as { amount: number }).amount;
      items = items.map((item) => (item.uuid === params.uuid ? { ...item, calculated_budget: amount.toFixed(2) } : item));
      return { success: true, eventUuid: uuidFor(15, 1) };
    },
    ...overrides,
  };
  // The envelope accounts' money through the period: their balances in the accounts answer,
  // unless a test answers this itself.
  return { 'GET /budgets/periods/:uuid/envelope-balance': envelopeBalanceFrom(answers['GET /accounts']), ...answers };
};

const renderPage = () =>
  renderWithProviders(<Theme><BudgetPage /></Theme>, { route: '/budgets?period=2026-10' });

/** The text of the sidebar line a label starts (label and figure share one row). */
const summaryLine = (label: string) => labelledLine(screen.getByText(label));

/** The Expenses section header: its toggle and its budget/actual/remaining figures. */
const sectionHeader = (name: string) => labelledLine(screen.getAllByRole('button', { name })[0]);

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  items = seed();
});
afterEach(() => vi.unstubAllGlobals());

describe('BudgetPage', () => {
  it('adds up each section and the plan from the figures the API sends', async () => {
    api = mockApi(routes());
    renderPage();

    expect(await screen.findAllByText('Paycheck')).not.toHaveLength(0);
    expect(summaryLine('Total Income:')).toBe('Total Income:$5,000.00');
    expect(summaryLine('Total Expenses:')).toBe('Total Expenses:-$2,100.35');
    expect(summaryLine('Total Savings:')).toBe('Total Savings:-$400.00');
    // 5,000.00 − 2,100.35 − 400.00
    expect(summaryLine('Calculation:')).toBe('Calculation:$2,499.65');

    // The Expenses header's budget, actual and remaining are its items' sums.
    // Actuals are pre-signed: spending shows negative.
    expect(sectionHeader('Expenses')).toBe('Expenses$2,100.35-$1,910.15$190.20');
    expect(api.unhandled).toEqual([]);
  });

  // "Spent" took an actual above zero, which an expense's pre-signed actual (its spending,
  // negative) never is: Rent, spent to the cent, showed Critical in its row and its card.
  it("shows each item's status in its row and its card: an expense spent to the cent is Spent", async () => {
    api = mockApi(routes());
    renderPage();
    expect(await screen.findAllByText('Paycheck')).not.toHaveLength(0);

    const statuses = (name: string) =>
      screen.getAllByRole('link', { name }).map((link) => {
        const card = link.closest('.rt-Card') as HTMLElement;
        return within(card).queryByText(/^(On Track|Near Limit|Warning|Critical|Over Budget|Spent|Expected|Partly received|Received|Above plan|Funded)$/)?.textContent ?? '';
      });
    // The mobile card, then the desktop row (jsdom shows both layouts).
    expect(statuses('Rent')).toEqual(['Spent', 'Spent']);
    expect(statuses('Groceries')).toEqual(['Near Limit', 'Near Limit']);
    // An income item received in full is Received (it read Spent).
    expect(statuses('Paycheck')).toEqual(['Received', 'Received']);
    // A goal's card shows what it set aside, as a size, and Funded once that is its budget
    // (it read Spent); its desktop row has no status.
    expect(statuses('Emergency fund')).toEqual(['Funded', '']);
  });

  // The desktop grid listed and totalled the active goals only, while the mobile
  // list and the Plan card counted every goal: a paused goal's budget this month was in one and
  // not the other. Both list the period's goals now: active, or with money in the period.
  it("lists the period's goals in both layouts: a paused one with money this month, not a finished one with none", async () => {
    items = [
      ...seed(),
      budgetPeriodItem(october, {
        id: 5, budget_item_name: 'Car', expense_type: 'Savings', type: 'Goal', subtype: 'Goal', status: 'paused',
        calculated_budget: '25.00', calculated_actual: '0.00', calculated_remaining: '25.00',
      }),
      budgetPeriodItem(october, {
        id: 6, budget_item_name: 'Old trip', expense_type: 'Savings', type: 'Goal', subtype: 'Goal', status: 'completed',
        calculated_budget: '0.00', calculated_actual: '0.00', calculated_remaining: '0.00',
      }),
    ];
    api = mockApi(routes());
    renderPage();
    expect(await screen.findAllByText('Paycheck')).not.toHaveLength(0);
    // The mobile card, then the desktop row.
    expect(screen.getAllByRole('link', { name: 'Car' })).toHaveLength(2);
    expect(screen.queryAllByRole('link', { name: 'Old trip' })).toHaveLength(0);
  });

  // A screen reader heard "$600.25, button", with no item.
  it('names each inline budget-edit button for its item, not by its amount alone', async () => {
    api = mockApi(routes());
    renderPage();
    expect(await screen.findAllByText('Paycheck')).not.toHaveLength(0);

    const named = (name: string, amount: string) => screen.queryAllByRole('button', { name: `Edit budget for ${name}, ${amount}` }).length;
    // The desktop row and the mobile card: jsdom shows both layouts.
    expect([named('Paycheck', '$5,000.00'), named('Rent', '$1,500.10'), named('Groceries', '$600.25'), named('Emergency fund', '$400.00')])
      .toEqual([2, 2, 2, 2]);
    expect(screen.queryAllByRole('button', { name: /^-?\$[\d,.]+$/ }).map((b) => b.textContent)).toEqual([]);
  });

  it('saves an inline budget edit as that period item’s amount, and the totals follow it', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await user.click((await screen.findAllByRole('button', { name: 'Edit budget for Groceries, $600.25' }))[0]);
    const [field] = screen.getAllByRole('textbox', { name: 'Budget for Groceries' });
    expect(field).toHaveValue('600.25');
    await user.clear(field);
    await user.type(field, '650.40{Enter}');

    // The edit shows at once, before the (debounced) save.
    expect(summaryLine('Total Expenses:')).toBe('Total Expenses:-$2,150.50');

    await waitFor(() => expect(api.calls('PUT /budgets/period-items/:uuid/budget')).toHaveLength(1));
    const [put] = api.calls('PUT /budgets/period-items/:uuid/budget');
    expect(put.params.uuid).toBe(items[2].uuid);
    // The cents too.
    expect(put.body).toMatchObject({ amount: 650.4 });
    // A write carries the session's CSRF token (the stand-in refuses one without it).
    expect(put.headers.get('X-CSRF-Token')).toBeTruthy();
    // Only that item was changed.
    expect(api.calls('PUT /budgets/period-items/:uuid/budget').map((c) => c.params.uuid)).toEqual([items[2].uuid]);

    // After the save the page shows what the API now holds.
    expect((await screen.findAllByRole('button', { name: 'Edit budget for Groceries, $650.40' })).length).toBeGreaterThan(0);
    expect(summaryLine('Total Expenses:')).toBe('Total Expenses:-$2,150.50');
  });

  it("shows the server's reason when a budget edit is refused, and the totals go back", async () => {
    api = mockApi(routes({ 'PUT /budgets/period-items/:uuid/budget': apiError(409, 'Budget period is closed', 'PERIOD_CLOSED') }));
    const user = userEvent.setup();
    renderPage();

    await user.click((await screen.findAllByRole('button', { name: 'Edit budget for Groceries, $600.25' }))[0]);
    const [field] = screen.getAllByRole('textbox', { name: 'Budget for Groceries' });
    await user.clear(field);
    await user.type(field, '650{Enter}');

    const { default: toast } = await import('react-hot-toast');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Budget period is closed'));
    // The page stays, and shows what the server still holds, not the refused amount.
    await waitFor(() => expect(summaryLine('Total Expenses:')).toBe('Total Expenses:-$2,100.35'));
    expect(screen.getAllByRole('button', { name: 'Edit budget for Groceries, $600.25' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Edit budget for Groceries, $650.00' })).toBeNull();
  });

  // As floats, 600.10 + 250.20 + 0.30 is 850.5999999999999 and 0.10 + 0.20 is
  // 0.30000000000000004, so figures that matched to the cent came to -1.1e-13 or -5.6e-17,
  // which showed as "-$0.00" in red. In whole cents they are $0.00.
  it('adds up the plan, the Actual box and the envelope comparison in whole cents', async () => {
    items = [
      budgetPeriodItem(october, {
        id: 11, budget_item_name: 'Paycheck', expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck',
        calculated_budget: '600.10', calculated_actual: '600.10',
      }),
      budgetPeriodItem(october, {
        id: 12, budget_item_name: 'Bonus', expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck',
        calculated_budget: '250.20', calculated_actual: '250.20',
      }),
      budgetPeriodItem(october, {
        id: 13, budget_item_name: 'Interest', expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck',
        calculated_budget: '0.30', calculated_actual: '0.30',
      }),
      budgetPeriodItem(october, {
        id: 14, budget_item_name: 'Vacation', expense_type: 'Expense', type: 'Envelope', subtype: 'Flexible',
        calculated_budget: '850.60', calculated_actual: '-850.30', calculated_remaining: '0.30',
      }),
    ];
    api = mockApi(routes({
      'GET /accounts': accountsResponse([
        account({ id: 21, name: 'Envelope savings', account_type: 'savings', is_envelope_account: true, calculated_balance: '0.10' }),
        account({ id: 22, name: 'Holiday fund', account_type: 'savings', is_envelope_account: true, calculated_balance: '0.20' }),
      ]),
    }));
    renderPage();

    expect(await screen.findByText('Envelope Comparison')).toBeInTheDocument();
    // The plan: 850.60 of income less 850.60 of expenses.
    expect(summaryLine('Total Income:')).toBe('Total Income:$850.60');
    expect(summaryLine('Calculation:')).toBe('Calculation:$0.00');
    // Actual: 850.60 that came in less 850.60 the envelope plans.
    expect(summaryLine('Planned (Envelopes):')).toBe('Planned (Envelopes):-$850.60');
    expect(summaryLine('Remaining:')).toBe('Remaining:$0.00');
    // The two boxes' titles are coloured by their sign (the table's column headers aren't).
    const title = (text: string) => screen.getAllByText(text).find((el) => /--(green-12|red-11)/.test(el.className));
    expect(title('Budget')).toHaveClass('text-[var(--green-12)]');
    expect(title('Actual')).toHaveClass('text-[var(--green-12)]');
    // The envelopes hold 0.30, and the two accounts 0.10 + 0.20.
    expect(summaryLine('Difference:')).toBe('Difference:$0.00');
    expect(api.unhandled).toEqual([]);
  });

  // Each was a literal "-" before the amount, so nothing showed as -$0.00 and an amount
  // below zero as --$5.00. Each now shows the signed amount it adds to the total.
  it('shows a figure taken off the total as the signed amount it adds, never -$0.00 or --$5.00', async () => {
    items = [
      budgetPeriodItem(october, {
        id: 1, budget_item_name: 'Paycheck', expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck',
        calculated_budget: '100.00', calculated_actual: '100.00',
      }),
      // A goal budgeted below zero (money taken back out of it).
      budgetPeriodItem(october, {
        id: 4, budget_item_name: 'Emergency fund', expense_type: 'Savings', type: 'Goal', subtype: 'Goal',
        calculated_budget: '-5.00', calculated_actual: '0.00', calculated_remaining: '-5.00',
      }),
    ];
    api = mockApi(routes({
      'GET /accounts': accountsResponse([
        account({ id: 21, name: 'Envelope savings', account_type: 'savings', is_envelope_account: true, calculated_balance: '0.00' }),
      ]),
    }));
    renderPage();

    expect(await screen.findByText('Envelope Comparison')).toBeInTheDocument();
    expect(summaryLine('Total Expenses:')).toBe('Total Expenses:$0.00');
    expect(summaryLine('Total Savings:')).toBe('Total Savings:$5.00');
    // 100 − 0 − (−5)
    expect(summaryLine('Calculation:')).toBe('Calculation:$105.00');
    expect(summaryLine('Planned (Envelopes):')).toBe('Planned (Envelopes):$0.00');
    expect(summaryLine('Saved (Goals):')).toBe('Saved (Goals):$5.00');
    expect(summaryLine('Actual Envelope Account Total:')).toBe('Actual Envelope Account Total:$0.00');
  });

  it("says the items didn't load rather than showing an empty budget, and Try again reloads them", async () => {
    let failing = true;
    api = mockApi(routes({
      'GET /budgets/periods/:uuid/items': () => (failing ? apiError(500, 'Internal error', 'INTERNAL') : { success: true, data: items }),
    }));
    const user = userEvent.setup();
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading', { name: "Couldn't load the budget" })).toBeInTheDocument();
    expect(screen.queryByText('Total Income:')).toBeNull();

    failing = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Total Income:')).toBeInTheDocument();
    expect(summaryLine('Total Income:')).toBe('Total Income:$5,000.00');
  });
});
