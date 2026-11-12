import { describe, it, expect } from 'vitest';
import {
  amountCents,
  calculateActualRemaining,
  calculateSubtotals,
  centsAmount,
  computeAllSubtotals,
  currentBudgetValue,
  deriveBudgetSections,
  envelopeReconciliation,
  type ReconciledAccount,
  type SubtotalItem,
} from '@nuggets/shared';

/**
 * The budget's totals in `@nuggets/shared`: the Budget page, Close-Out, the
 * Dashboard card and the MCP server's list_budget_period_items all work them out with this
 * code, in whole cents. The cases are the float sums that went wrong before.
 */

let n = 0;
const item = (over: Partial<SubtotalItem>): SubtotalItem => ({
  uuid: `0190a000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
  budget_item_name: `Item ${n}`,
  goal_target_date: null,
  status: 'active',
  expense_type: 'Expense',
  type: 'Monthly',
  subtype: 'Flexible',
  calculated_budget: 0,
  calculated_actual: 0,
  calculated_transfers: 0,
  calculated_remaining: 0,
  ...over,
});
const envelope = (balance: number | string | null, over: Partial<ReconciledAccount> = {}): ReconciledAccount => ({
  uuid: '0190a000-0001-7000-8000-000000000001', name: 'Envelope savings', icon: null, is_envelope_account: true, calculated_balance: balance, ...over,
});

describe('amountCents and centsAmount', () => {
  it('read an amount as the API sends it, text or number, in whole cents, and give back no -0', () => {
    expect(amountCents('-30.27')).toBe(-3027);
    expect(amountCents(1030.31)).toBe(103031);
    expect(amountCents('not a number')).toBe(0);
    expect(amountCents(null)).toBe(0);
    expect(centsAmount(103031)).toBe(1030.31);
    expect(Object.is(centsAmount(-0), 0)).toBe(true);
  });
});

describe('calculateActualRemaining', () => {
  // 600.10 + 250.20 + 0.30 of income against 850.60 of envelope plans was -1.1e-13 as floats.
  it('comes to exactly 0 where floats left -1.1e-13', () => {
    const totals = calculateActualRemaining([
      item({ expense_type: 'Income', calculated_actual: 600.1 }),
      item({ expense_type: 'Income', calculated_actual: 250.2 }),
      item({ expense_type: 'Income', calculated_actual: 0.3 }),
      item({ type: 'Envelope', calculated_budget: 850.6 }),
    ]);
    expect(totals.remaining).toBe(0);
    expect(Object.is(totals.remaining, -0)).toBe(false);
  });

  it("counts a fixed bill's unpaid remaining only, and an overpaid one as nothing", () => {
    const totals = calculateActualRemaining([
      item({ expense_type: 'Income', calculated_actual: 1000 }),
      item({ subtype: 'Fixed', calculated_actual: -0.1, calculated_remaining: 0.2 }),
      item({ subtype: 'Fixed', calculated_actual: -50, calculated_remaining: -5 }),
    ]);
    expect(totals).toMatchObject({ monthlyActual: -50.1, remaining: 949.9, fixedRemaining: 0.2, estimatedRemaining: 949.7 });
  });
});

describe('the Budget page subtotals', () => {
  it('add in cents, counting a pending budget instead of the saved one', () => {
    const a = item({ calculated_budget: 0.1, calculated_actual: -0.1, calculated_remaining: 0 });
    const b = item({ calculated_budget: 0.2, calculated_transfers: 0.2, calculated_remaining: 0.4 });
    expect(calculateSubtotals([a, b])).toEqual({ budget: 0.3, actual: -0.1, transfers: 0.2, remaining: 0.4 });
    expect(calculateSubtotals([a, b], { [b.uuid]: 1.05 })).toEqual({ budget: 1.15, actual: -0.1, transfers: 0.2, remaining: 0.4 });
    // A pending budget that can't be read yet (NaN while typing) counts as 0, as before.
    expect(currentBudgetValue(b, { [b.uuid]: Number.NaN })).toBe(0);
  });

  it('group expenses by type and subtype, each sorted by name, and goals by target date (none last)', () => {
    const sections = deriveBudgetSections([
      item({ budget_item_name: 'Water', subtype: 'Fixed', calculated_budget: 0.1 }),
      item({ budget_item_name: 'Rent', subtype: 'Fixed', calculated_budget: 0.2 }),
      item({ budget_item_name: 'Car', type: 'Envelope', calculated_budget: 5 }),
      item({ budget_item_name: 'Later', expense_type: 'Savings', type: 'Goal', goal_target_date: '2027-06-30' }),
      item({ budget_item_name: 'Someday', expense_type: 'Savings', type: 'Goal' }),
      item({ budget_item_name: 'Sooner', expense_type: 'Savings', type: 'Goal', goal_target_date: '2027-01-31' }),
    ]);
    expect(sections.expenseGrouped.Monthly?.Fixed?.map((i) => i.budget_item_name)).toEqual(['Rent', 'Water']);
    expect(sections.savings.map((i) => i.budget_item_name)).toEqual(['Sooner', 'Later', 'Someday']);
    const subtotals = computeAllSubtotals(sections);
    expect(subtotals.bySubtype['Monthly::Fixed']?.budget).toBe(0.3);
    expect(subtotals.byType.Envelope?.budget).toBe(5);
    expect(subtotals.expense.budget).toBe(5.3);
  });
});

// The desktop grid totalled the active goals only, the mobile list, the Plan card and
// the MCP every goal. One definition now: the period's goals, totalled the same way.
describe("the period's goals", () => {
  it('are the active ones and any other with money in the period, so their totals are every goal’s', () => {
    const goals = [
      item({ budget_item_name: 'House', expense_type: 'Savings', type: 'Goal', calculated_budget: 100 }),
      item({ budget_item_name: 'Car', expense_type: 'Savings', type: 'Goal', status: 'paused', calculated_budget: 40.1, calculated_remaining: 40.1 }),
      item({ budget_item_name: 'Old trip', expense_type: 'Savings', type: 'Goal', status: 'completed' }),
      item({ budget_item_name: 'Archived fund', expense_type: 'Savings', type: 'Goal', status: 'archived', calculated_remaining: -0.01 }),
      item({ budget_item_name: 'Legacy', expense_type: 'Savings', type: 'Goal', status: null }),
    ];
    const sections = deriveBudgetSections(goals);
    expect(sections.savings.map((g) => g.budget_item_name).sort()).toEqual(['Archived fund', 'Car', 'House', 'Legacy']);
    const shown = computeAllSubtotals(sections).savings;
    expect(shown).toEqual(calculateSubtotals(goals));
    expect(shown).toEqual({ budget: 140.1, actual: 0, transfers: 0, remaining: 40.09 });
    // The Plan card's and the Actual remaining's savings: the same budget.
    expect(calculateActualRemaining(goals).savingsBudgetAmount).toBe(shown.budget);
  });
});

describe('envelopeReconciliation', () => {
  // A variance of $1,030.31 was 1030.3100000000002, which the transfer sent and the API refused.
  it('works the variance out in cents, and calls exactly 0 balanced', () => {
    const items = [
      item({ type: 'Envelope', calculated_budget: 600.1, calculated_actual: -0.2, calculated_remaining: 600.1 }),
      item({ type: 'Envelope', calculated_budget: 250.2, calculated_remaining: 250.2 }),
      item({ type: 'Monthly', calculated_remaining: 999 }),
    ];
    const under = envelopeReconciliation(items, [envelope('-180.01')]);
    expect(under).toEqual({
      envelope_account: { uuid: envelope(0).uuid, name: 'Envelope savings', icon: null, actual_balance: -180.01 },
      budget_summary: { expected_balance: 850.3, envelope_items_count: 2, total_budgeted: 850.3, total_spent: -0.2 },
      variance: { amount: -1030.31, status: 'underfunded', percentage: -121 },
    });
    expect(envelopeReconciliation(items, [envelope(800.1), envelope('50.20', { uuid: '0190a000-0001-7000-8000-000000000002' })])?.variance)
      .toEqual({ amount: 0, status: 'balanced', percentage: 0 });
    expect(envelopeReconciliation(items, [envelope('850.31')])?.variance?.status).toBe('overfunded');
  });

  // A small shortfall's percentage rounded to -0.
  it('gives a percentage of 0, never -0, for a variance under half a percent', () => {
    const items = [item({ type: 'Envelope', calculated_remaining: 1000 })];
    const short = envelopeReconciliation(items, [envelope('999.99')])!;
    expect(short.variance?.status).toBe('underfunded');
    expect(Object.is(short.variance?.percentage, 0)).toBe(true);
    const overspent = envelopeReconciliation([item({ type: 'Envelope', calculated_remaining: -1000 })], [envelope('-999.99')])!;
    expect(Object.is(overspent.variance?.percentage, 0)).toBe(true);
  });

  it('is null without an envelope account or items, or when an envelope balance is unavailable (never compared to $0)', () => {
    const items = [item({ type: 'Envelope', calculated_remaining: 10 })];
    expect(envelopeReconciliation(items, [envelope(10, { is_envelope_account: false })])).toBeNull();
    expect(envelopeReconciliation([], [envelope(10)])).toBeNull();
    expect(envelopeReconciliation(items, [envelope(10), envelope(null, { uuid: '0190a000-0001-7000-8000-000000000003' })])).toBeNull();
  });
});
