import { describe, it, expect, vi, afterEach } from 'vitest';
import { accountListResponseSchema, sankeyResponseSchema } from '@nuggets/shared';
import { AnswerContractError, answersFailLoudly, parseAnswer, salvage } from '../parseAnswer';
import { getAccounts } from '../accounts';
import { account, accountsResponse } from '../../../test/fixtures';
import { logger } from '../../../utils/logger';

/**
 * An answer that doesn't match its shared schema fails loudly in development and tests, naming
 * the answer and the field, and is logged and kept in a production build.
 */
describe('parseAnswer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const good = accountsResponse([account({ id: 1, name: 'Checking', calculated_balance: '12.50' })]);

  it('reads an answer that matches: amounts as numbers', () => {
    expect(parseAnswer(accountListResponseSchema, good, 'accounts').accounts[0]?.calculated_balance).toBe(12.5);
  });

  it('throws in development and tests on a field the schema refuses, naming it', () => {
    const bad = { accounts: [{ ...good.accounts[0], calculated_balance: '12.345' }] };
    expect(() => parseAnswer(accountListResponseSchema, bad, 'accounts', true)).toThrow(AnswerContractError);
    expect(() => parseAnswer(accountListResponseSchema, bad, 'accounts', true)).toThrow(/accounts answer.*accounts\.0\.calculated_balance/);
  });

  it('throws on a field the schema does not name, rather than dropping it unseen', () => {
    const extra = { accounts: [{ ...good.accounts[0], nickname: 'Main' }] };
    expect(() => parseAnswer(accountListResponseSchema, extra, 'accounts', true)).toThrow(/accounts\[0\]\.nickname is not in the schema/);
  });

  it('in a production build logs the problem without its values and carries on with the answer', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const bad = { accounts: [{ ...good.accounts[0], calculated_balance: 'lots' }] };
    expect(parseAnswer(accountListResponseSchema, bad, 'accounts', false).accounts[0]?.calculated_balance).toBe('lots');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('lots');
  });

  it('in a production build reads every row and field that matches, keeping only the odd one as it came', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const rows = accountsResponse([
      account({ id: 1, name: 'Checking', calculated_balance: '12.50' }),
      account({ id: 2, name: 'Odd', calculated_balance: '7.25' }),
    ]);
    const odd = { accounts: [rows.accounts[0], { ...rows.accounts[1], institution_current_balance: '1.005' }] };
    const read = parseAnswer(accountListResponseSchema, odd, 'accounts', false).accounts;
    expect(read[0]?.calculated_balance).toBe(12.5);
    // The odd row's other amounts are still numbers; only the field the schema refuses is as sent.
    expect(read[1]?.calculated_balance).toBe(7.25);
    expect(read[1]?.institution_current_balance).toBe('1.005');
  });

  it('in a production build reads each entry of a record on its own', () => {
    const item = (contribution: string) => ({
      budget_item_uuid: '019a3b2c-1d2e-7f00-8a00-0000000000aa',
      budget_item_name: 'Groceries',
      contribution,
      rule_applied: 'expense_transactions',
    });
    const raw = { good: [item('12.50')], odd: [item('1.005'), item('3.00')] };
    // One odd Sankey drilldown entry left every entry as it came, amounts as text.
    const read = salvage(sankeyResponseSchema.shape._drilldown, raw) as Record<string, Array<{ contribution: unknown }>>;
    expect(read.good?.[0]?.contribution).toBe(12.5);
    expect(read.odd?.map((row) => row.contribution)).toEqual(['1.005', 3]);
  });

  it("reads a legacy account saved with type '' as one with no class", async () => {
    // The strict schema refused '', so the accounts answer failed in development; and the page
    // took '' as a class and listed the account under "Liabilities". Read as null, the page
    // lists it under its kind's class, as it does an account saved without one.
    const legacy = accountsResponse([account({ id: 3, name: 'Old card', type: '', account_type: 'savings', account_group: 'cash' })]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(legacy), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const [read] = await getAccounts();
    expect(read?.type).toBeNull();
  });

  it('fails loudly under vite dev and the tests, not in a production build', () => {
    expect(answersFailLoudly()).toBe(true);
    expect(answersFailLoudly({ DEV: true, MODE: 'development' })).toBe(true);
    expect(answersFailLoudly({ DEV: false, MODE: 'production' })).toBe(false);
  });

  it('is what the api modules read their answers with', async () => {
    const bad = { accounts: [{ ...good.accounts[0], account_type: '' }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(bad), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await expect(getAccounts()).rejects.toThrow(/accounts\.0\.account_type/);
  });
});
