import type { Condition, ConditionOperand } from '@nuggets/shared';

/**
 * Judging a notification rule's condition against one subject's facts. Pure.
 *
 * A fact the subject doesn't have is null. null equals only null; an ordered
 * comparison (lt, gt, …) with anything but a number is false, so
 * `{ not: { fact: 'percent_used', gt: 80 } }` holds for an item with no budget.
 */
export type FactValue = string | number | boolean | null;
export type Facts = Readonly<Record<string, FactValue>>;

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Whether any phrase's words appear in `text` as a run of whole words, ignoring
 * case: "Acme Marketplace" has "acme", but "Acmeville" doesn't.
 */
export function hasWords(text: string, phrases: readonly string[]): boolean {
  const haystack = words(text);
  return phrases.some((phrase) => {
    const needle = words(phrase);
    if (needle.length === 0) return false;
    for (let start = 0; start + needle.length <= haystack.length; start++) {
      if (needle.every((word, i) => haystack[start + i] === word)) return true;
    }
    return false;
  });
}

function operand(value: ConditionOperand): number {
  return Number(value);
}

export function evaluate(condition: Condition, facts: Facts): boolean {
  if ('all' in condition) return condition.all.every((part) => evaluate(part, facts));
  if ('any' in condition) return condition.any.some((part) => evaluate(part, facts));
  if ('not' in condition) return !evaluate(condition.not, facts);
  const value = facts[condition.fact] ?? null;
  if ('is' in condition) return value === condition.is;
  if ('in' in condition) return condition.in.includes(value);
  if ('hasWords' in condition) return typeof value === 'string' && hasWords(value, condition.hasWords);
  if (typeof value !== 'number') return false;
  if ('lt' in condition) return value < operand(condition.lt);
  if ('lte' in condition) return value <= operand(condition.lte);
  if ('gt' in condition) return value > operand(condition.gt);
  return value >= operand(condition.gte);
}
