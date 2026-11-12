import { describe, it, expect } from 'vitest';
import type { BudgetPeriodItem } from '../../services/api';
import {
  deriveBudgetSections,
  computeAllSubtotals,
  getCurrentBudgetValue,
} from '../budgetPageCalcs';

// Minimal BudgetPeriodItem factory — only the fields the calc functions read.
const item = (over: Partial<BudgetPeriodItem> & { uuid: string }): BudgetPeriodItem =>
  ({
    expense_type: 'Expense',
    type: 'Monthly',
    subtype: 'Fixed',
    budget_item_name: 'Item',
    calculated_budget: 0,
    calculated_actual: 0,
    calculated_transfers: 0,
    calculated_remaining: 0,
    ...over,
  } as BudgetPeriodItem);

// Shared fixture covering all three sections + an excluded Transfer item.
const fixture = (): BudgetPeriodItem[] => [
  item({ uuid: 'i1', expense_type: 'Income', budget_item_name: 'Zebra', calculated_budget: 5000, calculated_actual: 5000 }),
  item({ uuid: 'i2', expense_type: 'Income', budget_item_name: 'Alpha', calculated_budget: 1000, calculated_actual: 1000 }),
  item({ uuid: 's1', expense_type: 'Savings', budget_item_name: 'S1', goal_target_date: '2026-12-01', calculated_budget: 100, calculated_remaining: 100 }),
  item({ uuid: 's2', expense_type: 'Savings', budget_item_name: 'S2', goal_target_date: '2026-06-01', calculated_budget: 50, calculated_remaining: 50 }),
  item({ uuid: 's3', expense_type: 'Savings', budget_item_name: 'S3', goal_target_date: undefined, calculated_budget: 25, calculated_remaining: 25 }),
  item({ uuid: 'rent', expense_type: 'Expense', type: 'Monthly', subtype: 'Fixed', budget_item_name: 'Rent', calculated_budget: 1000, calculated_actual: 1000, calculated_remaining: 0 }),
  item({ uuid: 'food', expense_type: 'Expense', type: 'Monthly', subtype: 'Flexible', budget_item_name: 'Food', calculated_budget: 400, calculated_actual: 350, calculated_transfers: 50, calculated_remaining: 100 }),
  item({ uuid: 'car', expense_type: 'Expense', type: 'Envelope', subtype: 'Fixed', budget_item_name: 'Car', calculated_budget: 200, calculated_actual: 0, calculated_remaining: 200 }),
  // Excluded from all three sections (not Income/Savings/Expense):
  item({ uuid: 't1', expense_type: 'Transfer', budget_item_name: 'Xfer', calculated_budget: 999 }),
];

describe('deriveBudgetSections', () => {
  it('partitions by expense_type and excludes non Income/Savings/Expense items', () => {
    const s = deriveBudgetSections(fixture());
    expect(s.income.map(i => i.uuid).sort()).toEqual(['i1', 'i2']);
    expect(s.savings.map(i => i.uuid).sort()).toEqual(['s1', 's2', 's3']);
    expect(s.expenseItems.map(i => i.uuid).sort()).toEqual(['car', 'food', 'rent']);
    // The Transfer item appears nowhere.
    const allUuids = [
      ...s.income, ...s.savings, ...s.expenseItems,
    ].map(i => i.uuid);
    expect(allUuids).not.toContain('t1');
  });

  it('sorts income by name and savings by goal_target_date (missing last)', () => {
    const s = deriveBudgetSections(fixture());
    expect(s.income.map(i => i.budget_item_name)).toEqual(['Alpha', 'Zebra']);
    // June before December, undated last.
    expect(s.savings.map(i => i.uuid)).toEqual(['s2', 's1', 's3']);
  });

  it('groups expenses by type/subtype, items sorted by name, each item once', () => {
    const s = deriveBudgetSections(fixture());
    // Both types present.
    expect(Object.keys(s.expenseGrouped).sort()).toEqual(['Envelope', 'Monthly']);

    // Monthly has Fixed (Rent) and Flexible (Food); Envelope has Fixed (Car).
    expect(Object.keys(s.expenseGrouped.Monthly).sort()).toEqual(['Fixed', 'Flexible']);
    expect(s.expenseGrouped.Monthly.Flexible.map(i => i.uuid)).toEqual(['food']);
    expect(s.expenseGrouped.Monthly.Fixed.map(i => i.uuid)).toEqual(['rent']);
    expect(s.expenseGrouped.Envelope.Fixed.map(i => i.uuid)).toEqual(['car']);

    // Every expense item appears exactly once across the grouping.
    const flat = Object.values(s.expenseGrouped)
      .flatMap(subs => Object.values(subs).flat())
      .map(i => i.uuid);
    expect(flat.sort()).toEqual(['car', 'food', 'rent']);
  });

  it('sorts items within a subtype by name', () => {
    const s = deriveBudgetSections([
      item({ uuid: 'b', expense_type: 'Expense', type: 'Monthly', subtype: 'Fixed', budget_item_name: 'Bravo' }),
      item({ uuid: 'a', expense_type: 'Expense', type: 'Monthly', subtype: 'Fixed', budget_item_name: 'Alpha' }),
    ]);
    expect(s.expenseGrouped.Monthly.Fixed.map(i => i.budget_item_name)).toEqual(['Alpha', 'Bravo']);
  });

  it('handles empty input', () => {
    const empty = deriveBudgetSections([]);
    expect(empty.income).toEqual([]);
    expect(empty.savings).toEqual([]);
    expect(empty.expenseItems).toEqual([]);
    expect(empty.expenseGrouped).toEqual({});
  });

  it('does not mutate the input array', () => {
    const items = fixture();
    const before = items.map(i => i.uuid);
    deriveBudgetSections(items);
    expect(items.map(i => i.uuid)).toEqual(before);
  });
});

describe('computeAllSubtotals', () => {
  it('matches hand-computed totals at every level', () => {
    const s = deriveBudgetSections(fixture());
    const t = computeAllSubtotals(s, {});

    expect(t.income).toEqual({ budget: 6000, actual: 6000, transfers: 0, remaining: 0 });
    expect(t.savings).toEqual({ budget: 175, actual: 0, transfers: 0, remaining: 175 });
    expect(t.expense).toEqual({ budget: 1600, actual: 1350, transfers: 50, remaining: 300 });

    expect(t.byType.Monthly).toEqual({ budget: 1400, actual: 1350, transfers: 50, remaining: 100 });
    expect(t.byType.Envelope).toEqual({ budget: 200, actual: 0, transfers: 0, remaining: 200 });

    expect(t.bySubtype['Monthly::Flexible']).toEqual({ budget: 400, actual: 350, transfers: 50, remaining: 100 });
    expect(t.bySubtype['Monthly::Fixed']).toEqual({ budget: 1000, actual: 1000, transfers: 0, remaining: 0 });
    expect(t.bySubtype['Envelope::Fixed']).toEqual({ budget: 200, actual: 0, transfers: 0, remaining: 200 });
  });

  it('applies a pending budget edit to budget totals only (not actual/transfers/remaining)', () => {
    const s = deriveBudgetSections(fixture());
    const t = computeAllSubtotals(s, { food: 999 });

    // Food budget 400 -> 999 shifts expense + Monthly + Flexible budgets by +599.
    expect(t.expense.budget).toBe(2199);
    expect(t.byType.Monthly.budget).toBe(1999);
    expect(t.bySubtype['Monthly::Flexible'].budget).toBe(999);

    // Non-budget figures are unaffected by the pending edit.
    expect(t.expense.actual).toBe(1350);
    expect(t.expense.transfers).toBe(50);
    expect(t.expense.remaining).toBe(300);
  });

  it('adds amounts exactly, in cents', () => {
    // As floats 0.1 + 0.2 - 0.3 is 5.55e-17, which isn't zero, and 0.1 + 0.2 isn't 0.3.
    const s = deriveBudgetSections([
      item({ uuid: 'a', calculated_budget: 0.1, calculated_actual: -0.1, calculated_remaining: 0.1 }),
      item({ uuid: 'b', calculated_budget: 0.2, calculated_actual: -0.2, calculated_remaining: 0.2 }),
      item({ uuid: 'c', calculated_budget: 0, calculated_actual: 0, calculated_remaining: -0.3 }),
    ]);
    const t = computeAllSubtotals(s, {});
    expect(t.expense).toEqual({ budget: 0.3, actual: -0.3, transfers: 0, remaining: 0 });
  });

  it('returns zeros for empty sections', () => {
    const t = computeAllSubtotals(deriveBudgetSections([]), {});
    expect(t.income).toEqual({ budget: 0, actual: 0, transfers: 0, remaining: 0 });
    expect(t.expense).toEqual({ budget: 0, actual: 0, transfers: 0, remaining: 0 });
    expect(t.byType).toEqual({});
    expect(t.bySubtype).toEqual({});
  });
});

describe('getCurrentBudgetValue', () => {
  it('prefers a pending value over calculated_budget, else falls back', () => {
    const it1 = item({ uuid: 'x', calculated_budget: 500 });
    expect(getCurrentBudgetValue(it1, {})).toBe(500);
    expect(getCurrentBudgetValue(it1, { x: 750 })).toBe(750);
    // A pending 0 is a real value (overrides), not ignored.
    expect(getCurrentBudgetValue(it1, { x: 0 })).toBe(0);
  });
});
