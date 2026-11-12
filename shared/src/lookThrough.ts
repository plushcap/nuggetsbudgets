import { z } from 'zod';
import { responseAmount, responseDecimal } from './responses.js';

/**
 * The look-through reports' answers (the backend and the frontend each had their own copy
 * of LookThroughResult). Amounts are dollars rounded to cents, rounded together so that the
 * pieces of a total add up to it exactly. A percentage is of the total, each rounded to 2
 * places on its own, so a list of them adds up to its whole only to within that rounding (a
 * hundredth of a point for each, at most half).
 */

/** One bucket of GET /api/investments/reports/lookthrough: a dimension's value and its share. */
export const lookThroughBucketSchema = z.object({
  dimensionValue: z.string(),
  amount: responseAmount,
  percentage: responseDecimal,
});
export type LookThroughBucket = z.infer<typeof lookThroughBucketSchema>;

/**
 * GET /api/investments/reports/lookthrough: the portfolio along one dimension (a fund through
 * its composition). The buckets add up to the total; a fund with no composition for the
 * dimension is in the 'unknown' bucket, and `unknownValue`.
 */
export const lookThroughResponseSchema = z.object({
  dimension: z.string(),
  totalValue: responseAmount,
  buckets: z.array(lookThroughBucketSchema),
  unknownValue: responseAmount,
});
export type LookThroughResult = z.infer<typeof lookThroughResponseSchema>;
/** The answer as the API sends it (a figure may be exact text), for the backend. */
export type LookThroughAnswer = z.input<typeof lookThroughResponseSchema>;

/** One security of GET /api/investments/reports/underlying-exposure. */
export const underlyingExposureSchema = z.object({
  security_uuid: z.uuid().nullable(),
  ticker: z.string(),
  name: z.string().nullable(),
  amount: responseAmount,
  percentage: responseDecimal,
});
export type UnderlyingExposure = z.infer<typeof underlyingExposureSchema>;

/**
 * GET /api/investments/reports/underlying-exposure: every position resolved to the securities
 * it holds. `exposures` lists each security worth a cent or more; the ones worth less are
 * summed in `below_a_cent` (how many, their amount and percentage), so the listed amounts,
 * `below_a_cent.amount` and `unknown_value` add up to `total_value` exactly, and their
 * percentages to 100 to within each one's rounding (see above). A sliver was dropped
 * while its value stayed in what resolved, so the listed percentages fell short of 100% by the
 * slivers' share, and of identical slivers some were listed, by security id.
 */
export const underlyingExposureResponseSchema = z.object({
  total_value: responseAmount,
  unknown_value: responseAmount,
  below_a_cent: z.object({
    securities: z.number().int().nonnegative(),
    amount: responseAmount,
    percentage: responseDecimal,
  }),
  exposures: z.array(underlyingExposureSchema),
});
export type UnderlyingExposureResult = z.infer<typeof underlyingExposureResponseSchema>;
/** The answer as the API sends it (a figure may be exact text), for the backend. */
export type UnderlyingExposureAnswer = z.input<typeof underlyingExposureResponseSchema>;
