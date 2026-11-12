import { describe, it, expect } from 'vitest';
import {
  conditionProblems,
  defaultNotificationRules,
  notificationRulesSchema,
  setNotificationPreferencesRequestSchema,
  type Condition,
} from '@nuggets/shared';
import { evaluate, hasWords } from '../../../services/notifications/conditions.js';
import { addDays, digestDueOn, localTime, mondayOf, weekdayOf } from '../../../services/notifications/schedule.js';

describe('hasWords', () => {
  it.each([
    ['Acme Marketplace', ['acme'], true],
    ['ACME.COM*2K4', ['acme'], true],
    ['Acmeville Tours', ['acme'], false],
    ['Sample Fresh Market', ['fresh market'], true],
    ['Sample Fresh Market', ['market fresh'], false],
    ['Example Fuel 1234', ['acme gas', 'fuel'], true],
    ['', ['fuel'], false],
  ])('%s has %j -> %s', (text, phrases, expected) => {
    expect(hasWords(text, phrases)).toBe(expected);
  });
});

describe('evaluate', () => {
  const facts = { size: 650, direction: 'out', merchant: 'Sample Wholesale', pending: false, percent_used: null };

  it.each<[string, Condition, boolean]>([
    ['is', { fact: 'direction', is: 'out' }, true],
    ['is (no match)', { fact: 'direction', is: 'in' }, false],
    ['in', { fact: 'direction', in: ['in', 'out'] }, true],
    ['gte', { fact: 'size', gte: 650 }, true],
    ['gt at the boundary', { fact: 'size', gt: 650 }, false],
    ['a numeric-string operand', { fact: 'size', lt: '1000' }, true],
    ['hasWords', { fact: 'merchant', hasWords: ['sample'] }, true],
    ['ordered comparison with no value is false', { fact: 'percent_used', gt: 80 }, false],
    ['not of it is true', { not: { fact: 'percent_used', gt: 80 } }, true],
    ['null equals null', { fact: 'percent_used', is: null }, true],
    ['an unknown fact is null', { fact: 'nope', is: null }, true],
    ['empty all is always', { all: [] }, true],
    ['empty any is never', { any: [] }, false],
    ['nested', { all: [{ fact: 'direction', is: 'out' }, { any: [{ fact: 'size', gte: 500 }, { fact: 'pending', is: true }] }] }, true],
  ])('%s', (_label, condition, expected) => {
    expect(evaluate(condition, facts)).toBe(expected);
  });
});

describe('conditionProblems', () => {
  it('accepts the default rules', () => {
    expect(notificationRulesSchema.safeParse(defaultNotificationRules).success).toBe(true);
  });

  it.each<[string, Condition, string]>([
    ['a fact the kind lacks', { fact: 'spent', gte: 1 }, 'A transaction rule doesn’t know “spent”.'],
    ['ordering a non-number', { fact: 'merchant', gt: 3 }, '“merchant” isn’t a number to compare.'],
    ['a boolean given as text', { fact: 'pending', is: 'true' }, '“pending” is true or false.'],
    ['a choice outside its values', { fact: 'direction', is: 'sideways' }, '“direction” is one of in, out.'],
    ['words on a non-text fact', { fact: 'size', hasWords: ['x'] }, '“size” isn’t text to look for words in.'],
  ])('%s', (_label, condition, message) => {
    expect(conditionProblems(condition, 'transaction')).toEqual([message]);
  });

  it('refuses nesting deeper than eight', () => {
    let condition: Condition = { fact: 'size', gte: 1 };
    for (let i = 0; i < 8; i++) condition = { not: condition };
    expect(conditionProblems(condition, 'transaction')).toEqual(['Nest conditions at most eight deep.']);
  });

  it('puts a rule’s condition problem at its path in the rules list', () => {
    const result = notificationRulesSchema.safeParse({
      rules: [{ key: 'big', label: 'Big', enabled: true, kind: 'transaction', audience: 'everyone', when: { fact: 'pending', is: 'yes' } }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ['rules', 0, 'when'], message: '“pending” is true or false.' });
  });

  it('refuses two rules with one key', () => {
    const rule = defaultNotificationRules.rules[1];
    const result = notificationRulesSchema.safeParse({ rules: [rule, rule] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('Give each rule its own key.');
  });

  it('reads "false" from a model as false', () => {
    const parsed = notificationRulesSchema.parse({ rules: [{ ...defaultNotificationRules.rules[1], enabled: 'false' }] });
    expect(parsed.rules[0].enabled).toBe(false);
    expect(setNotificationPreferencesRequestSchema.parse({ rules: [{ rule: 'x', email: 'false' }] }).rules[0].email).toBe(false);
  });
});

describe('schedule', () => {
  it('reads the local day and time in a time zone', () => {
    // 03:30 UTC on Oct 20 is 23:30 on Oct 19 in New York (EDT, UTC-4).
    expect(localTime(new Date('2026-10-20T03:30:00Z'), 'America/New_York')).toEqual({ day: '2026-10-19', minutes: 23 * 60 + 30 });
  });

  it('knows weekdays and Mondays', () => {
    expect(weekdayOf('2026-10-19')).toBe(1); // a Monday
    expect(weekdayOf('2026-10-25')).toBe(7);
    expect(mondayOf('2026-10-25')).toBe('2026-10-19');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  // A digest due Sunday (7) at 18:00.
  it.each<[string, string, number, string | null]>([
    ['a minute early', '2026-10-25', 17 * 60 + 59, null],
    ['on the hour', '2026-10-25', 18 * 60, '2026-10-25'],
    ['late that night', '2026-10-25', 23 * 60 + 59, '2026-10-25'],
    ['into Monday, still within a day', '2026-10-26', 17 * 60 + 59, '2026-10-25'],
    ['a day late', '2026-10-26', 18 * 60, null],
    ['midweek', '2026-10-21', 18 * 60, null],
  ])('a Sunday 18:00 digest, %s', (_label, day, minutes, expected) => {
    expect(digestDueOn(7, 18, day, minutes)).toBe(expected);
  });
});
