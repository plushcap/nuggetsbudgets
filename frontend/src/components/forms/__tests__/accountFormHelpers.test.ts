import { describe, it, expect } from 'vitest';
import { ACCOUNT_TYPE_LABELS } from '@nuggets/shared';
import { withCurrentValue } from '../AccountFormFields';

/**
 * Guards against the Account Classification selects rendering blank.
 * A Radix Select with a controlled value that isn't among its items shows an
 * empty trigger, so every classification select must be guaranteed to contain
 * its current value.
 */
describe('withCurrentValue', () => {
  const options = [
    { value: 'cash', label: 'Cash' },
    { value: 'loans', label: 'Loans' },
  ];

  it('returns options unchanged when the current value is present', () => {
    expect(withCurrentValue(options, 'cash')).toBe(options);
  });

  it('appends an unmatched stored value as a visible legacy option', () => {
    const result = withCurrentValue(options, 'checking');
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ value: 'checking', label: 'checking (legacy value)' });
  });

  // A credit card with no category is an asset (as net worth counts it), whose Account
  // Type list has no credit card: it showed as "credit_card (legacy value)".
  it('shows a known value outside the options by its label, not as a legacy value', () => {
    const result = withCurrentValue(options, 'credit_card', ACCOUNT_TYPE_LABELS);
    expect(result[2]).toEqual({ value: 'credit_card', label: 'Credit Card' });
    expect(withCurrentValue(options, 'Checking', ACCOUNT_TYPE_LABELS)[2]).toEqual({ value: 'Checking', label: 'Checking (legacy value)' });
    expect(withCurrentValue(options, 'constructor', ACCOUNT_TYPE_LABELS)[2]).toEqual({ value: 'constructor', label: 'constructor (legacy value)' });
  });

  it('ignores empty/null current values', () => {
    expect(withCurrentValue(options, '')).toBe(options);
    expect(withCurrentValue(options, null)).toBe(options);
    expect(withCurrentValue(options, undefined)).toBe(options);
  });
});
