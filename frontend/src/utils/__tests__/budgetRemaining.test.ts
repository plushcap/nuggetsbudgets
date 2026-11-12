import { describe, it, expect } from 'vitest';
import { amountSpent, calculateActualRemaining } from '../budgetRemaining';

type Item = Parameters<typeof calculateActualRemaining>[0][number];

const item = (
  expense_type: Item['expense_type'],
  type: Item['type'],
  calculated_budget: number | string,
  calculated_actual: number | string,
  more: { subtype?: Item['subtype']; calculated_remaining?: number | string } = {},
): Item => ({ expense_type, type, subtype: 'Flexible', calculated_budget, calculated_actual, calculated_remaining: 0, ...more } as Item);

describe('calculateActualRemaining', () => {
  it('takes monthly spending, envelope plans and goal savings out of actual income', () => {
    const result = calculateActualRemaining([
      item('Income', 'Monthly', 4812.37, 6347.19),
      item('Expense', 'Monthly', -3150.45, -2987.62),
      item('Expense', 'Envelope', 1642.83, -415.27),
      item('Savings', 'Goal', 2263.91, 0),
    ]);
    expect(result.actualIncome).toBeCloseTo(6347.19);
    expect(result.monthlyActual).toBeCloseTo(-2987.62);
    expect(result.envelopeBudgetAmount).toBeCloseTo(1642.83);
    expect(result.savingsBudgetAmount).toBeCloseTo(2263.91);
    expect(result.remaining).toBeCloseTo(-547.17);
  });

  it('coerces NUMERIC strings and ignores transfers and other item types', () => {
    const result = calculateActualRemaining([
      item('Income', 'Fixed', '0', '100.50'),
      item('Expense', 'Fixed', '-40', '-40'),
      item('Transfer', 'Monthly', '0', '-500'),
      item('Expense', 'Monthly', '0', 'not a number'),
    ]);
    expect(result.remaining).toBeCloseTo(100.5);
  });

  it('is zero with no items', () => {
    expect(calculateActualRemaining([]).remaining).toBe(0);
  });

  // As floats, 600.10 + 250.20 + 0.30 is 850.5999999999999, so income that matched the
  // envelope plans to the cent left -1.1e-13, shown as "-$0.00" in red.
  it('adds and takes off in whole cents, so money that comes to nothing is 0, not -0.00', () => {
    const result = calculateActualRemaining([
      item('Income', 'Monthly', '600.10', '600.10'),
      item('Income', 'Monthly', '250.20', '250.20'),
      item('Income', 'Monthly', '0.30', '0.30'),
      item('Expense', 'Envelope', '850.60', '0.00'),
    ]);
    expect(result.actualIncome).toBe(850.6);
    expect(result.envelopeBudgetAmount).toBe(850.6);
    expect(Object.is(result.remaining, 0)).toBe(true);
    expect(Object.is(result.estimatedRemaining, 0)).toBe(true);

    // And a cent short is a cent, not a float near it.
    const short = calculateActualRemaining([
      item('Income', 'Monthly', '0', '600.10'),
      item('Income', 'Monthly', '0', '250.20'),
      item('Income', 'Monthly', '0', '0.30'),
      item('Expense', 'Envelope', '850.61', '0.00'),
    ]);
    expect(short.remaining).toBe(-0.01);
  });

  // Close-Out had its own copy, which took every Envelope item's budget as a plan: an
  // Envelope Savings item came off twice, and a Transfer one the Budget page doesn't list came off.
  it('takes an envelope plan from Expense items only, as the Budget page lists them', () => {
    const result = calculateActualRemaining([
      item('Income', 'Monthly', '0', '1000.00'),
      item('Expense', 'Envelope', '100.00', '0'),
      item('Savings', 'Envelope', '200.00', '0'),
      item('Transfer', 'Envelope', '300.00', '0'),
    ]);
    expect(result.envelopeBudgetAmount).toBe(100);
    expect(result.savingsBudgetAmount).toBe(200);
    expect(result.remaining).toBe(700);
  });

  it("counts the fixed monthly bills still to pay, and what's left after them", () => {
    const result = calculateActualRemaining([
      item('Income', 'Monthly', '0', '1000.00'),
      // Paid: nothing left to pay.
      item('Expense', 'Monthly', '500.00', '-500.00', { subtype: 'Fixed', calculated_remaining: '0.00' }),
      // Not paid yet.
      item('Expense', 'Monthly', '120.10', '0.00', { subtype: 'Fixed', calculated_remaining: '120.10' }),
      item('Expense', 'Monthly', '0.20', '0.00', { subtype: 'Fixed', calculated_remaining: '0.20' }),
      // Paid over: owes nothing more.
      item('Expense', 'Monthly', '60.00', '-80.00', { subtype: 'Fixed', calculated_remaining: '-20.00' }),
      // Flexible money left, and an envelope's: not bills.
      item('Expense', 'Monthly', '100.00', '-60.00', { subtype: 'Flexible', calculated_remaining: '40.00' }),
      item('Expense', 'Envelope', '0', '0', { subtype: 'Fixed', calculated_remaining: '75.00' }),
    ]);
    expect(result.monthlyActual).toBe(-640);
    expect(result.remaining).toBe(360);
    expect(result.fixedRemaining).toBe(120.3);
    expect(result.estimatedRemaining).toBe(239.7);
  });
});

// Actuals are pre-signed, so an expense that spent has a negative one.
describe('amountSpent', () => {
  it('is the size of what an expense spent', () => {
    expect(amountSpent(-20.5)).toBe(20.5);
  });

  it('is nothing for a period that spent nothing or was refunded on balance', () => {
    expect(amountSpent(0)).toBeUndefined();
    expect(amountSpent(15)).toBeUndefined();
  });
});
