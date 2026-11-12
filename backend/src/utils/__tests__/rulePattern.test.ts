import { describe, it, expect } from 'vitest';
import {
  regexRuleProblem,
  budgetItemMatchingRuleCreateSchema,
  merchantRuleCreateSchema,
  MAX_REGEX_RULE_LENGTH,
} from '@nuggets/shared';

/** What a regex rule may be saved as. */
describe('regexRuleProblem', () => {
  it.each([
    '^SAMPLEMART',
    'SMPLMART\\s*MKTP',
    '(SAMPLERIDE|ACMECAB)\\s*\\*?TRIP',
    '\\d{4,6}',
    '^(?:SQ|TST)\\* ?[A-Z]+',
    '[\\w\\s]+ PAYROLL',
    '(?<store>SAMPLE WHSE) #\\d+',
    'ab?c{2}',
    'a{0,1}(b)?',
    '(?=.*GAS)(?!.*REFUND)',
  ])('accepts %s', (pattern) => {
    expect(regexRuleProblem(pattern)).toBeNull();
  });

  it.each([
    '(a+)+$',
    '(a*)*b',
    '(\\w+\\s?)*$',
    '^(([a-z])+.)+[A-Z]([a-z])+$',
    '(.*){1,255}b',
    '((ab)*)+',
    '(?:x+)+',
    '(a{2,})*',
    '([abc]+)+$',
  ])('refuses the nested repeat %s', (pattern) => {
    expect(regexRuleProblem(pattern)).toMatch(/repeated part can’t contain another repeat/);
  });

  it('refuses an invalid pattern, a long one, too many repeats and a large count', () => {
    expect(regexRuleProblem('(')).toBe('This isn’t a valid regular expression.');
    expect(regexRuleProblem('a'.repeat(MAX_REGEX_RULE_LENGTH + 1))).toMatch(/up to 200 characters/);
    expect(regexRuleProblem('a'.repeat(MAX_REGEX_RULE_LENGTH))).toBeNull();
    expect(regexRuleProblem('a*'.repeat(26))).toMatch(/up to 25 repeats/);
    expect(regexRuleProblem('a{1,1000}')).toMatch(/up to 255/);
  });

  it('is not fooled by brackets, escapes or braces that are literal', () => {
    expect(regexRuleProblem('[(a+)]+')).toBeNull();
    expect(regexRuleProblem('\\(a+\\)+')).toBeNull();
    expect(regexRuleProblem('a{x}+')).toBeNull();
    expect(regexRuleProblem('[\\]+]+x')).toBeNull();
  });

  it('is what the shared rule schemas check, for regex rules only', () => {
    const budget = budgetItemMatchingRuleCreateSchema.safeParse({ budget_item_id: 1, method: 'regex', matching_text: '(a+)+$' });
    expect(budget.success).toBe(false);
    expect(budget.error?.issues[0].path).toEqual(['matching_text']);
    expect(budgetItemMatchingRuleCreateSchema.safeParse({ budget_item_id: 1, method: 'contains', matching_text: '(a+)+$' }).success).toBe(true);
    expect(merchantRuleCreateSchema.safeParse({ method: 'regex', matching_text: '(a*)*b' }).success).toBe(false);
    expect(merchantRuleCreateSchema.safeParse({ method: 'regex', matching_text: '^FUELCO' }).success).toBe(true);
  });
});
