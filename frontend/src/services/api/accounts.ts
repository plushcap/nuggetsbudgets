/**
 * API Accounts Module - Account Operations
 * 
 * Handles all account-related API operations:
 * - CRUD operations for accounts
 * - Account balance queries
 * - Account transactions (with filtering)
 * - Image upload support
 */

import { API_BASE_URL, getAuthHeaders, handleResponse, apiPost, apiPostFormData, apiPutFormData } from './base';
import type { Account, AccountTransactionsResponse } from './types';
import {
  accountBalanceAdjustedResponseSchema,
  accountBalanceResponseSchema,
  accountListQuery,
  accountListResponseSchema,
  accountRegisterQuery,
  accountResponseSchema,
  accountRowResponseSchema,
  queryString,
  transactionPageResponseSchema,
  type AccountBalanceAdjusted,
  type AccountRow,
} from '@nuggets/shared';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';


/**
 * Get all accounts
 * 
 * @param includeHidden - Include hidden accounts in results (default: false)
 * @returns Array of accounts
 */
export const getAccounts = async (includeHidden: boolean = false): Promise<Account[]> => {
  try {
    // include_hidden is false when it isn't sent (accountListQuery).
    const url = `${API_BASE_URL}/accounts${queryString(accountListQuery, { include_hidden: includeHidden || undefined })}`;
    const response = await fetch(url, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(accountListResponseSchema, await handleResponse<unknown>(response), 'accounts').accounts;
  } catch (error) {
    logger.error({ err: error, endpoint: '/accounts' }, 'Failed to fetch accounts');
    throw error;
  }
};

/** Result of a manual balance adjustment (accountBalanceAdjustedResponseSchema). `adjusted: false`
 *  means the entered balance already matched (no transaction created). */
export type AdjustBalanceResult = AccountBalanceAdjusted;

/**
 * Adjust an account's balance to `targetBalance` (same pre-signed convention as
 * the displayed balance). The server inserts one `balance adjustment` transaction
 * for the delta, or no-ops if the balance already matches.
 */
export const adjustAccountBalance = async (uuid: string, targetBalance: number): Promise<AdjustBalanceResult> =>
  parseAnswer(accountBalanceAdjustedResponseSchema, await apiPost<unknown>(`/accounts/${uuid}/adjust-balance`, { targetBalance }), 'balance adjustment');

/**
 * Get a single account by UUID
 *
 * @param uuid - Account UUID
 * @returns Account details
 */
export const getAccount = async (uuid: string): Promise<Account> => {
  try {
    const response = await fetch(`${API_BASE_URL}/accounts/${uuid}`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(accountResponseSchema, await handleResponse<unknown>(response), 'account');
  } catch (error) {
    logger.error({ err: error, accountUuid: uuid, endpoint: `/accounts/${uuid}` }, 'Failed to fetch account');
    throw error;
  }
};

/**
 * Get account balance details
 * 
 * @param uuid - Account UUID
 * @returns Account balance information with snapshot details
 */
export const getAccountBalance = async (uuid: string): Promise<{
  account_id: number;
  balance: {
    /** null when the balance couldn't be computed: render "Unavailable". */
    calculated_balance: number | null;
    balance_unavailable: boolean;
  };
}> => {
  try {
    const response = await fetch(`${API_BASE_URL}/accounts/${uuid}/balance`, {
      headers: getAuthHeaders(),
    });
    const result = parseAnswer(accountBalanceResponseSchema, await handleResponse<unknown>(response), 'account balance');

    const unavailable = result.balance_unavailable || result.balance === null;
    return {
      account_id: result.account_id,
      balance: {
        calculated_balance: unavailable ? null : result.balance,
        balance_unavailable: unavailable,
      },
    };
  } catch (error) {
    logger.error({ err: error, accountUuid: uuid, endpoint: `/accounts/${uuid}/balance` }, 'Failed to fetch account balance');
    throw error;
  }
};

/**
 * Create a new account with image upload
 * 
 * @param formData - FormData containing account fields and optional image file
 * @returns Created account
 */
export const createAccountWithImage = async (formData: FormData): Promise<AccountRow> => {
  // Delegate to the shared FormData helper so the X-CSRF-Token header is attached
  // (multipart requests must not set Content-Type; csrfHeaders handles that).
  return parseAnswer(accountRowResponseSchema, await apiPostFormData<unknown>('/accounts', formData), 'created account');
};

/**
 * Update an existing account with image upload
 * 
 * @param uuid - Account UUID
 * @param formData - FormData containing account fields and optional image file
 * @returns Updated account
 */
export const updateAccountWithImage = async (uuid: string, formData: FormData): Promise<AccountRow> => {
  // Delegate to the shared FormData helper so the X-CSRF-Token header is attached
  // (multipart requests must not set Content-Type; csrfHeaders handles that).
  return parseAnswer(accountRowResponseSchema, await apiPutFormData<unknown>(`/accounts/${uuid}`, formData), 'updated account');
};

/**
 * Get transactions for a specific account with optional filtering
 * 
 * @param accountUuid - Account UUID
 * @param params - Optional filter parameters (page, limit, search, status, type, etc.)
 * @returns Paginated transaction response with account and transaction data
 */
export const getAccountTransactions = async (
  accountUuid: string, 
  params?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    type?: string;
    review_status?: string;
    date_from?: string;
    date_to?: string;
    budget_period_id?: string;
    budget_item_id?: string;
    amount_min?: string;
    amount_max?: string;
  }
): Promise<AccountTransactionsResponse> => {
  try {
    // The route's own query schema writes and checks the query; a page or limit
    // of 0 is left out, as before.
    const query = queryString(accountRegisterQuery, { ...params, page: params?.page || undefined, limit: params?.limit || undefined });
    const url = `${API_BASE_URL}/accounts/${accountUuid}/transactions${query}`;
    
    const response = await fetch(url, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(transactionPageResponseSchema, await handleResponse<unknown>(response), 'account register');
  } catch (error) {
    logger.error({ err: error, accountUuid, endpoint: `/accounts/${accountUuid}/transactions` }, 'Failed to fetch account transactions');
    throw error;
  }
};
