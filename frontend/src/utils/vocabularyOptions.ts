/**
 * Helpers for the options of a fixed list (@nuggets/shared's vocabulary.ts). A page builds a
 * list's options from its shared constant and shows its label map, so what it sends is the
 * list's own value (src/__tests__/vocabularyValues.test.ts checks).
 */
import { TRANSACTION_TYPES, type TransactionType, transactionType } from '@nuggets/shared';

/** The transaction types in the order the pickers show them: the commonest, expense, first. */
export const TRANSACTION_TYPE_OPTIONS: readonly TransactionType[] = [
  'expense',
  ...TRANSACTION_TYPES.filter((type) => type !== transactionType.enum.expense),
];

/**
 * `value` when it is one of `list`'s values, else undefined: for a value read from outside the
 * code (a URL's query), which a cast would let through in any spelling.
 */
export function oneOf<Value extends string>(list: readonly Value[], value: string | null | undefined): Value | undefined {
  return value !== null && value !== undefined && (list as readonly string[]).includes(value) ? (value as Value) : undefined;
}
