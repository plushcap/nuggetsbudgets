import { z } from 'zod';
import { moneyInput } from './primitives.js';

/**
 * POST /api/transfer body. Validates amount (> 0), transaction_date, and type
 * up front; the source/destination account presence + same-account check stay
 * in the handler because accounts may be supplied by id OR uuid (resolved
 * there). Loose so the other fields pass through.
 */
export const transferCreateSchema = z.looseObject({
  // A number or decimal text, as sent, which createTransfer reads in whole cents:
  // coerced, "1e2" was 100, "" was 0 and "12.3400000000000001" was 12.34.
  amount: moneyInput('Amount must be greater than zero').refine((v) => Number(v) > 0, 'Amount must be greater than zero'),
  transaction_date: z.string({ error: 'Transaction date is required' }).min(1, 'Transaction date is required'),
  type: z.enum(['payment', 'transfer'], { error: 'Type must be payment or transfer' }),
});
export type TransferCreateInput = z.infer<typeof transferCreateSchema>;

/**
 * POST /api/transfer/period body ("move balance to next period"): a same-account transfer
 * from one budget period to the next (unlike the account-to-account transfer above, which
 * moves money between two accounts in one period). movePeriodBalance looks the account and
 * the period up, and finds the next period.
 */
export const budgetPeriodTransferSchema = z.object({
  account_uuid: z.string().min(1, 'Account is required'),
  source_period_uuid: z.string().min(1, 'Source period is required'),
  // Signed balance to move forward (defaults to the period balance in the UI): a number or
  // decimal text, as sent, which movePeriodBalance reads in whole cents. Coerced, '1e2'
  // was 100 and 0.004 got past the zero check, to be rounded to a 0.00 pair.
  amount: moneyInput('amount must be a non-zero number').refine((v) => Number(v) !== 0, 'Amount cannot be zero'),
  description: z.string().optional(),
});
export type BudgetPeriodTransferInput = z.infer<typeof budgetPeriodTransferSchema>;

/** POST /api/transfer: the two sides written, by uuid. */
export const transferResponseSchema = z.object({
  success: z.literal(true),
  source_transaction_uuid: z.uuid(),
  destination_transaction_uuid: z.uuid(),
});
export type TransferResponse = z.infer<typeof transferResponseSchema>;

/** POST /api/transfer/period: the two sides written, and the period the balance moved to. */
export const budgetPeriodTransferResponseSchema = transferResponseSchema.extend({ next_period_name: z.string() });
export type BudgetPeriodTransferResponse = z.infer<typeof budgetPeriodTransferResponseSchema>;
