import type { Account, EnvelopeBalanceData } from '../services/api';

/**
 * The accounts with each envelope account's balance replaced by its money through the chosen
 * period (`balances`, GET /budgets/periods/:uuid/envelope-balance), which is what its envelopes
 * are reconciled against: they count by the period a transaction is filed under, and the
 * account's balance today counts by date, up to today. An envelope account the answer lacks, or
 * every one while it hasn't loaded, is unavailable (null), never today's balance.
 */
export function withEnvelopeBalances(accounts: Account[], balances: EnvelopeBalanceData | undefined): Account[] {
  const byUuid = new Map((balances?.accounts ?? []).map((account) => [account.uuid, account.balance]));
  return accounts.map((account) =>
    account.is_envelope_account ? { ...account, calculated_balance: byUuid.get(account.uuid) ?? null } : account,
  );
}
