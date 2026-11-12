/**
 * Which shares a recorded figure is in, across a security's splits. Pure.
 *
 * An open lot holds today's shares: each split recorded after it was acquired scaled it. An
 * event's own figures, and a sale's lot consumptions, are in the shares of its day: a split
 * dated on or before it (a split's own day is in the split's shares), not one after. An event
 * recorded with figures already adjusted for the splits after it (`adjusted_for_splits`) is in
 * the shares after those too: the splits dated after it that were recorded when it was, those
 * with an id up to its holding_events.adjusted_through_action_id (a security's corporate actions
 * are recorded one at a time, under its row's lock, so one recorded later has a higher id).
 */

/** A split or reverse split as recorded: its ratio is new shares : old shares, in the ratios' units. */
export interface RecordedSplit {
  id: number;
  actionDate: string;
  numerator: bigint;
  denominator: bigint;
}

/** A ratio of two bigints. */
export interface SplitRatio {
  numerator: bigint;
  denominator: bigint;
}

/**
 * Whether a figure dated `date`, adjusted through `adjustedThrough` (null: as of its date), is
 * in the shares after `split`.
 */
export function inSharesAfter(split: Pick<RecordedSplit, 'id' | 'actionDate'>, date: string, adjustedThrough: number | null): boolean {
  return split.actionDate <= date || (adjustedThrough != null && split.id <= adjustedThrough);
}

/**
 * What one share of a figure dated `date` (adjusted through `adjustedThrough`) is in today's
 * shares: the product of the recorded `splits` it isn't in the shares after.
 */
export function splitsSince(splits: readonly RecordedSplit[], date: string, adjustedThrough: number | null): SplitRatio {
  return splits
    .filter((split) => !inSharesAfter(split, date, adjustedThrough))
    .reduce((ratio, split) => ({ numerator: ratio.numerator * split.numerator, denominator: ratio.denominator * split.denominator }), { numerator: 1n, denominator: 1n });
}
