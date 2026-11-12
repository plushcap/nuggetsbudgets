import { describe, it, expect } from 'vitest';
import { budgetPeriodTransferSchema } from '@nuggets/shared';

/**
 * POST /api/transfer/period's body, checked by the shared schema as the
 * other transaction bodies are. The route's answers to it are in
 * transactionRoutesCharacterization.test.ts; this is the schema on its own.
 */
describe('budgetPeriodTransferSchema', () => {
  const body = { account_uuid: 'acct-uuid', source_period_uuid: 'period-uuid' };
  const messages = (input: unknown) => {
    const parsed = budgetPeriodTransferSchema.safeParse(input);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  };

  it('takes a signed amount as a number or as decimal text, as sent, with an optional note', () => {
    expect(budgetPeriodTransferSchema.parse({ ...body, amount: -125.5 })).toEqual({ ...body, amount: -125.5 });
    expect(budgetPeriodTransferSchema.parse({ ...body, amount: ' 40.25 ', description: 'Carry forward' })).toEqual({
      ...body,
      amount: '40.25',
      description: 'Carry forward',
    });
  });

  it('refuses a zero amount, and text that is not a decimal amount', () => {
    for (const amount of [0, '0', '0.00']) expect(messages({ ...body, amount })).toEqual(['Amount cannot be zero']);
    for (const amount of ['1e2', '0x10', 'twelve', '', null]) {
      expect(messages({ ...body, amount }), String(amount)).toContain('amount must be a non-zero number');
    }
  });

  it('needs the account and the source period', () => {
    expect(budgetPeriodTransferSchema.safeParse({ amount: 10 }).error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'account_uuid',
      'source_period_uuid',
    ]);
    expect(messages({ ...body, account_uuid: '', amount: 10 })).toEqual(['Account is required']);
    expect(messages({ ...body, source_period_uuid: '', amount: 10 })).toEqual(['Source period is required']);
  });
});
