import { describe, it, expect } from 'vitest';
import type { FieldValues, Resolver, ResolverOptions } from 'react-hook-form';
import { UNREADABLE_AMOUNT_MESSAGE, UNREADABLE_REQUIRED_AMOUNT_MESSAGE, nullableAmountInput, withUnreadableAmounts } from '../optionalAmount';

/** A resolver that accepts everything, as a loose schema does. */
const accepting: Resolver<FieldValues> = async (values) => ({ values, errors: {} });

const options = (mounted: Record<string, boolean>): ResolverOptions<FieldValues> => ({
  names: undefined,
  shouldUseNativeValidation: undefined,
  criteriaMode: 'firstError',
  fields: Object.fromEntries(Object.entries(mounted).map(([name, mount]) => [name, { name, ref: { name }, mount }])),
});

describe('withUnreadableAmounts', () => {
  it('refuses an unreadable amount on screen, with its message', async () => {
    const result = await withUnreadableAmounts(accepting)({ budget: Number.NaN, name: 'x' }, undefined, options({ budget: true, name: true }));
    expect(result.values).toEqual({});
    expect(result.errors).toEqual({ budget: { type: 'unreadable', message: UNREADABLE_AMOUNT_MESSAGE } });
  });

  // A section a choice hid kept its NaN, and the save stopped with nothing on screen to say why.
  it("doesn't refuse one the form has unmounted, or never mounted, and passes it on as undefined", async () => {
    const values = { hidden: Number.NaN, never: Number.NaN, budget: 12 };
    const result = await withUnreadableAmounts(accepting)(values, undefined, options({ hidden: false, budget: true }));
    // Sent as NaN, JSON would carry null and empty the stored amount.
    expect(result).toEqual({ values: { hidden: undefined, never: undefined, budget: 12 }, errors: {} });
    expect(JSON.parse(JSON.stringify(result.values))).toEqual({ budget: 12 });
    // The form's own values are left as they are (the section keeps them for when it comes back).
    expect(Number.isNaN(values.hidden)).toBe(true);
  });
});

describe('a required amount', () => {
  it('holds text the box cannot read as NaN, and the rest as they came', () => {
    const held: Array<number | null> = [];
    const input = nullableAmountInput(undefined, (amount) => held.push(amount));
    expect(input.value).toBeNull();
    input.onChange(null, true);
    input.onChange(null, false);
    input.onChange(12.5, false);
    expect(held).toEqual([Number.NaN, null, 12.5]);
  });

  it("refuses one in the field's own words when it has some", async () => {
    const resolver = withUnreadableAmounts(accepting, { target: UNREADABLE_REQUIRED_AMOUNT_MESSAGE });
    const result = await resolver({ target: Number.NaN, fee: Number.NaN }, undefined, options({ target: true, fee: true }));
    expect(result.errors).toEqual({
      target: { type: 'unreadable', message: 'Not an amount: enter it like 1,234.56.' },
      fee: { type: 'unreadable', message: UNREADABLE_AMOUNT_MESSAGE },
    });
  });
});
