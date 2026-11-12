import { describe, it, expect } from 'vitest';
import { BUDGET_STATUS_LABELS, budgetStatus, envelopeTarget, goalFigures, progressPercentage, styledAmount } from '../budgetFigures';
import { budgetPeriod, budgetPeriodItem } from '../../../test/fixtures';
import type { BudgetPeriodItem } from '../../../services/api';

/**
 * The Budget page's per-item figures, in whole cents. As floats, 1.12 / 22.40 * 100 is
 * 5.000000000000001, so an item with exactly 5% of its budget left read as a Warning rather
 * than Critical, and a sub-cent remainder showed as a red $0.00.
 */

const october = budgetPeriod(2026, 10);
const item = (overrides: Partial<Parameters<typeof budgetPeriodItem>[1]>) =>
  budgetPeriodItem(october, { id: 1, budget_item_name: 'Groceries', ...overrides }) as unknown as BudgetPeriodItem;

describe('budgetStatus', () => {
  it('takes exactly 5%, 25% and 50% left as on the threshold, whatever the floats say', () => {
    // Each of these is 5.000000000000001% (or more) as floats.
    expect(budgetStatus('-21.28', '22.40', '1.12')).toBe('critical');
    expect(budgetStatus('-1.33', '1.40', '0.07')).toBe('critical');
    expect(budgetStatus('-75.00', '100.00', '25.00')).toBe('warning');
    expect(budgetStatus('-50.00', '100.00', '50.00')).toBe('near-limit');
    expect(budgetStatus('-49.99', '100.00', '50.01')).toBe('on-track');
  });

  it('is over budget only below zero, and spent at exactly zero', () => {
    expect(budgetStatus(0, 100, -0.01)).toBe('over-budget');
    // Less than half a cent below zero is zero.
    expect(budgetStatus(100, 100, -0.004)).toBe('spent');
    expect(budgetStatus(100, 100, 0)).toBe('spent');
    expect(budgetStatus(0, 0, 0)).toBe('on-track');
  });

  // An actual is pre-signed, an expense's spending negative, so "spent" took `actual > 0`,
  // which no expense ever had: one spent to the cent showed Critical.
  it('is spent at exactly zero once something was spent, whatever the sign of the actual', () => {
    // An expense: the server's remaining is budget + actual.
    expect(budgetStatus('-100.00', '100.00', '0.00')).toBe('spent');
    expect(budgetStatus('-1500.10', '1500.10', '0.00')).toBe('spent');
    // An income item: its remaining is actual − budget, so zero is the income in full, as before.
    expect(budgetStatus('5000.00', '5000.00', '0.00')).toBe('spent');
    // Nothing spent this period (an envelope at zero, its money moved out) isn't spent.
    expect(budgetStatus('0.00', '100.00', '0.00')).toBe('critical');
    expect(budgetStatus('0.00', '0.00', '0.00')).toBe('on-track');
    // A refund: an expense whose actual went back to zero is no longer spent.
    expect(budgetStatus('0.00', '100.00', '100.00')).toBe('on-track');
    // An envelope at zero after spending this period.
    expect(budgetStatus('-50.00', '100.00', '0.00')).toBe('spent');
  });

  // By design, an income item has its own words, from what came
  // in against its budget, in cents. It read Over Budget (nothing received yet), Critical and
  // Spent (all of it received), in red.
  it("gives an income item its own statuses: expected, partly received, received, above plan", () => {
    expect(budgetStatus('0.00', '5000.00', '-5000.00', 'income')).toBe('expected');
    // A reversal this period (a negative actual) is nothing received yet.
    expect(budgetStatus('-50.00', '100.00', '0.00', 'income')).toBe('expected');
    expect(budgetStatus('0.01', '5000.00', '-4999.99', 'income')).toBe('partly-received');
    expect(budgetStatus('4999.99', '5000.00', '-0.01', 'income')).toBe('partly-received');
    expect(budgetStatus('5000.00', '5000.00', '0.00', 'income')).toBe('received');
    // 600.10 + 250.20 + 0.30 received of 850.60: received, not a float's sliver short of it.
    expect(budgetStatus(600.1 + 250.2 + 0.3, '850.60', 0, 'income')).toBe('received');
    expect(budgetStatus('5000.01', '5000.00', '0.01', 'income')).toBe('above-plan');
    // Nothing planned and money received is above plan; nothing planned or received is expected.
    expect(budgetStatus('25.00', '0.00', '25.00', 'income')).toBe('above-plan');
    expect(budgetStatus('0.00', '0.00', '0.00', 'income')).toBe('expected');
    // The same figures as an expense's keep an expense's words.
    expect(budgetStatus('-50.00', '100.00', '0.00', 'expense')).toBe('spent');
  });

  it('labels the income and goal statuses in their own words', () => {
    expect([BUDGET_STATUS_LABELS.expected, BUDGET_STATUS_LABELS['partly-received'], BUDGET_STATUS_LABELS.received, BUDGET_STATUS_LABELS['above-plan'], BUDGET_STATUS_LABELS.funded])
      .toEqual(['Expected', 'Partly received', 'Received', 'Above plan', 'Funded']);
  });
});

describe('progressPercentage', () => {
  it("shows an expense's budget left, an envelope's savings against its target or budget", () => {
    expect(progressPercentage(item({ calculated_remaining: '1.12' }), 22.4)).toBeCloseTo(5);
    expect(progressPercentage(item({ calculated_remaining: '-5.00' }), 22.4)).toBe(0);
    expect(progressPercentage(item({ calculated_remaining: '10.00' }), 0)).toBe(0);
    const envelope = { type: 'Envelope' as const, subtype: 'Flexible' as const };
    expect(progressPercentage(item({ ...envelope, calculated_remaining: '40.00', rollover_target_amount: '100.00' }), 10)).toBe(40);
    expect(progressPercentage(item({ ...envelope, calculated_remaining: '400.00', rollover_target_amount: '100.00' }), 10)).toBe(100);
    expect(progressPercentage(item({ ...envelope, calculated_remaining: '5.00' }), 20)).toBe(25);
    expect(progressPercentage(item({ ...envelope, calculated_remaining: '5.00' }), 0)).toBe(100);
    expect(progressPercentage(item({ ...envelope, calculated_remaining: '0.00' }), 0)).toBe(0);
  });
});

describe('styledAmount', () => {
  it('colours an amount by its cents: a sub-cent negative is a gray $0.00, not a red one', () => {
    expect(styledAmount(-0.004)).toEqual({ text: '$0.00', className: 'text-[var(--gray-11)]' });
    expect(styledAmount('-0.01')).toEqual({ text: '($0.01)', className: 'text-[var(--red-11)]' });
    expect(styledAmount(12.5)).toEqual({ text: '$12.50', className: 'text-[var(--gray-12)]' });
    expect(styledAmount(12.5, 'remaining')).toEqual({ text: '$12.50', className: 'text-[var(--green-12)]' });
    // 0.1 + 0.2 - 0.3 is 5.6e-17 as floats.
    expect(styledAmount(0.1 + 0.2 - 0.3, 'remaining').className).toBe('text-[var(--gray-11)]');
  });
});

describe('envelopeTarget and goalFigures', () => {
  it("states an envelope's savings against its target, in cents", () => {
    const envelope = item({ type: 'Envelope', subtype: 'Flexible', calculated_remaining: '33.33', rollover_target_amount: '100.00' });
    expect(envelopeTarget(envelope)).toEqual({ saved: '$33.33', target: '$100.00', percent: 33 });
    expect(envelopeTarget(item({ type: 'Envelope', subtype: 'Flexible', rollover_target_amount: '0.00' }))).toBeNull();
    expect(envelopeTarget(item({ rollover_target_amount: '100.00' }))).toBeNull();
  });

  it("shows a goal's saving as its size, and its status from it", () => {
    const goal = item({ expense_type: 'Savings', type: 'Goal', subtype: 'Goal', calculated_actual: '-1.33', calculated_remaining: '0.07' });
    const figures = goalFigures(goal, 1.4);
    expect(figures.actual.text).toBe('$1.33');
    expect(figures.status).toBe('critical');
  });

  // A goal funded in full read Spent (all of it set aside) or Over Budget (more), in red.
  it('calls a goal that has set aside its budget, or more, Funded', () => {
    const goal = (actual: string, remaining: string) =>
      item({ expense_type: 'Savings', type: 'Goal', subtype: 'Goal', calculated_actual: actual, calculated_remaining: remaining });
    expect(goalFigures(goal('-1.40', '0.00'), 1.4).status).toBe('funded');
    expect(goalFigures(goal('-2.00', '-0.60'), 1.4).status).toBe('funded');
    // Set aside with nothing planned is funded too; nothing set aside with nothing planned is on track.
    expect(goalFigures(goal('-5.00', '-5.00'), 0).status).toBe('funded');
    expect(goalFigures(goal('0.00', '0.00'), 0).status).toBe('on-track');
    // A cent short keeps an expense's status.
    expect(goalFigures(goal('-1.39', '0.01'), 1.4).status).toBe('critical');
    // Money taken back out of it (a positive actual) isn't saving.
    expect(goalFigures(goal('1.40', '0.00'), 1.4).status).toBe('spent');
  });
});
