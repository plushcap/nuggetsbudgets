/**
 * API Close-Out Module - Monthly Close-Out Operations
 *
 * Handles all monthly close-out related API operations:
 * - Zero-balance account verification
 * - Moving an account's period balance to the next period
 *
 * Every answer is read with its `@nuggets/shared` response schema (parseAnswer).
 */

import { budgetPeriodTransferResponseSchema, zeroBalanceAuditResponseSchema, type ZeroBalanceAudit } from '@nuggets/shared';
import { apiGet, apiPost } from './base';
import { parseAnswer } from './parseAnswer';

/**
 * Get zero-balance accounts verification data for a budget period.
 *
 * Computed server-side in a single aggregate query
 * (`GET /accounts/zero-balance/:periodUuid`). This replaced a client-side
 * approach that fetched every transaction (`?limit=10000`) for each
 * require_zero_balance account and summed them in the browser — for N accounts
 * that fired N heavy requests per Close-Out load, a thundering herd that
 * overwhelmed the proxy and surfaced as empty/truncated (200, 0-byte)
 * responses.
 */
export const getZeroBalanceAccounts = async (budgetPeriodUuid: string): Promise<ZeroBalanceAudit> =>
  parseAnswer(zeroBalanceAuditResponseSchema, await apiGet<unknown>(`/accounts/zero-balance/${budgetPeriodUuid}`), 'zero-balance accounts');

/**
 * Move an account's period balance to the NEXT period ("Budget Period Transfer").
 * Same account, source period → next period. The backend resolves the next period
 * and writes the linked pair of transfer transactions.
 */
export const moveBalanceToNextPeriod = async (input: {
  accountUuid: string;
  sourcePeriodUuid: string;
  amount: number;
  description?: string | undefined;
}): Promise<{ success: true; next_period_name: string }> =>
  parseAnswer(
    budgetPeriodTransferResponseSchema,
    await apiPost<unknown>('/transfer/period', {
      account_uuid: input.accountUuid,
      source_period_uuid: input.sourcePeriodUuid,
      amount: input.amount,
      description: input.description,
    }),
    'period balance move',
  );
