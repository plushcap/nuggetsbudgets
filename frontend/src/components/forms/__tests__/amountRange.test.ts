import { describe, it, expect } from 'vitest';
import { zodResolver } from '@hookform/resolvers/zod';
import type { FieldValues, Resolver, ResolverOptions } from 'react-hook-form';
import type { z } from 'zod';
import { accountCreateSchema, budgetItemCreateSchema, goalCreateSchema } from '@nuggets/shared';
import { amountRangeProblem, withUnreadableAmounts } from '../optionalAmount';
import { transferFormSchema } from '../../transfer/TransferForm';
import { addTransactionFormSchema } from '../../../pages/AddTransactionPage';
import { adjustBalanceSchema } from '../../AdjustBalanceModal';
import { moveBalanceSchema } from '../../closeout/MoveBalanceToNextPeriodModal';

/**
 * An amount past DECIMAL(12,2) was refused beside its box in the API's words
 * ("default_budget_amount must be between -9,999,999,999.99 and 9,999,999,999.99", a minus
 * bound in a box that takes no negatives), or, where the form had its own schema, sent and
 * refused by the server in a toast. Every form says it for people now, once.
 */

const UP_TO = 'Enter an amount up to 9,999,999,999.99.';
const BETWEEN = 'Enter an amount between -9,999,999,999.99 and 9,999,999,999.99.';

const options = (names: string[]): ResolverOptions<FieldValues> => ({
  names: undefined,
  shouldUseNativeValidation: undefined,
  criteriaMode: 'firstError',
  fields: Object.fromEntries(names.map((name) => [name, { name, ref: { name }, mount: true }])),
});

/** What the form shows beside each of `fields` for these values. */
async function shownBeside(schema: z.ZodType, values: FieldValues, fields: string[]) {
  const resolver = withUnreadableAmounts(zodResolver(schema as never) as Resolver<FieldValues>);
  const { errors } = await resolver(values, undefined, options(Object.keys(values)));
  return Object.fromEntries(fields.map((field) => [field, (errors as Record<string, { message?: string } | undefined>)[field]?.message]));
}

/** The messages a form's own schema gives `field`, in order. */
const messagesOf = (schema: z.ZodType, values: object, field: string) =>
  schema.safeParse(values).error?.issues.filter((issue) => issue.path[0] === field).map((issue) => issue.message) ?? [];

describe('an amount past the column', () => {
  it('is said by its sign: a positive one has no minus bound', () => {
    expect([1e10, '10000000000', 99999999999, -1e10, '-10000000000.00'].map(amountRangeProblem)).toEqual([UP_TO, UP_TO, UP_TO, BETWEEN, BETWEEN]);
    expect([9999999999.99, -9999999999.99, 0, null, undefined, Number.NaN, 'abc'].map(amountRangeProblem)).toEqual([null, null, null, null, null, null, null]);
  });

  it('beside a box a request schema checks, in those words instead of the API key', async () => {
    expect(await shownBeside(budgetItemCreateSchema, { name: 'Gas', default_budget_amount: 99999999999 }, ['default_budget_amount']))
      .toEqual({ default_budget_amount: UP_TO });
    expect(await shownBeside(accountCreateSchema, { name: 'Card', initial_balance: -1e10 }, ['initial_balance'])).toEqual({ initial_balance: BETWEEN });
    expect(await shownBeside(goalCreateSchema, { name: 'Trip', target_amount: 500, estimated_monthly_contribution: 1e10 }, ['target_amount', 'estimated_monthly_contribution']))
      .toEqual({ target_amount: undefined, estimated_monthly_contribution: UP_TO });
    // The largest the column holds is no problem.
    expect(await shownBeside(budgetItemCreateSchema, { name: 'Gas', default_budget_amount: 9999999999.99 }, ['default_budget_amount']))
      .toEqual({ default_budget_amount: undefined });
  });

  it("in a form's own schema, once, so the form doesn't send it", () => {
    const transfer = { source_account_id: 1, destination_account_id: 2, transaction_date: '2026-06-01', type: 'transfer', description: '', budget_period_id: null };
    expect(messagesOf(transferFormSchema, { ...transfer, amount: 1e10 }, 'amount')).toEqual([UP_TO]);
    expect(messagesOf(transferFormSchema, { ...transfer, amount: 9999999999.99 }, 'amount')).toEqual([]);
    const transaction = { merchant_name: 'Shop', merchant_id: null, transaction_date: '2026-06-01', type: 'expense', status: 'cleared', review_status: 'reviewed', description: '', budget_item_id: null, budget_period_id: null };
    expect(messagesOf(addTransactionFormSchema, { ...transaction, amount: -1e10 }, 'amount')).toEqual([BETWEEN]);
    expect(messagesOf(addTransactionFormSchema, { ...transaction, amount: 1e10 }, 'amount')).toEqual([UP_TO]);
    expect(messagesOf(adjustBalanceSchema(0), { targetBalance: 1e10 }, 'targetBalance')).toEqual([UP_TO]);
    expect(messagesOf(adjustBalanceSchema(0), { targetBalance: -9999999999.99 }, 'targetBalance')).toEqual([]);
    expect(messagesOf(moveBalanceSchema, { amount: -1e10 }, 'amount')).toEqual([BETWEEN]);
  });
});
