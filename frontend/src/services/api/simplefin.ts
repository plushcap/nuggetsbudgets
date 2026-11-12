/**
 * API SimpleFin Module - SimpleFin Bank Integration Operations
 *
 * Handles SimpleFin integration API operations:
 * - Account connection/disconnection
 * - Import settings for accounts
 * - The bank accounts and transactions SimpleFin reports
 *
 * The org-level connection (saving a setup token, reading and removing the
 * connection) lives in `./organizations`. Each answer is parsed with its
 * `@nuggets/shared` schema.
 */

import {
  bankLinkChangedResponseSchema,
  queryString,
  simpleFinAccountDetailResponseSchema,
  simpleFinAccountTransactionsQuery,
  simpleFinAccountsResponseSchema,
  type SimpleFinAccountDetailResponse,
  type SimpleFinRawTransaction,
} from '@nuggets/shared';
import { API_BASE_URL, getAuthHeaders, handleResponse } from './base';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';
import type { SimpleFinAccountsResponse } from './types';

export type { SimpleFinAccountDetailResponse, SimpleFinRawTransaction };

/**
 * Connect a Nuggets account to a SimpleFin bank account
 */
export const connectAccountToBank = async (accountUuid: string, importAccountId: string): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/accounts/${accountUuid}/connect-bank`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        import_account_id: importAccountId
      }),
    });
    parseAnswer(bankLinkChangedResponseSchema, await handleResponse<unknown>(response), 'bank account linked');
  } catch (error) {
    logger.error({ err: error, endpoint: '/simplefin/connect' }, 'Failed to connect account to bank');
    throw error;
  }
};

/**
 * Disconnect a bank account from SimpleFin
 */
export const disconnectBankAccount = async (accountUuid: string): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/accounts/${accountUuid}/disconnect-bank`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    parseAnswer(bankLinkChangedResponseSchema, await handleResponse<unknown>(response), 'bank account unlinked');
  } catch (error) {
    logger.error({ err: error, endpoint: '/simplefin/disconnect' }, 'Failed to disconnect bank account');
    throw error;
  }
};

/**
 * Update account import settings
 */
export const updateAccountImportSettings = async (accountUuid: string, settings: {
  import_enabled?: boolean;
  import_account_rebalance?: boolean;
  import_auto_match_merchants?: boolean;
  import_auto_assign_budget_period?: boolean;
  import_auto_assign_budget_item?: boolean;
  import_auto_review?: boolean;
  import_default_assigned_to?: number | null;
}): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/accounts/${accountUuid}/import-settings`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify(settings),
    });
    parseAnswer(bankLinkChangedResponseSchema, await handleResponse<unknown>(response), 'account import settings');
  } catch (error) {
    logger.error({ err: error, endpoint: '/accounts/import-settings' }, 'Failed to update account import settings');
    throw error;
  }
};

/**
 * Get all SimpleFin accounts with mapping and status info
 */
export const getSimpleFinAccounts = async (): Promise<SimpleFinAccountsResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/import/simplefin-accounts`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(simpleFinAccountsResponseSchema, await handleResponse<unknown>(response), 'SimpleFin accounts');
  } catch (error) {
    logger.error({ err: error, endpoint: '/import/simplefin-accounts' }, 'Failed to fetch SimpleFin accounts');
    throw error;
  }
};

/**
 * Live, read-only drill-down: pull the last `days` (default 60) of raw SimpleFin
 * data for ONE account. Nothing is stored server-side — research use only.
 */
export const getSimpleFinAccountTransactions = async (
  accountId: string,
  days = 60,
): Promise<SimpleFinAccountDetailResponse> => {
  try {
    const qs = queryString(simpleFinAccountTransactionsQuery, { account_id: accountId, days });
    const response = await fetch(`${API_BASE_URL}/import/simplefin-account-transactions${qs}`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(simpleFinAccountDetailResponseSchema, await handleResponse<unknown>(response), 'SimpleFin account detail');
  } catch (error) {
    logger.error({ err: error, endpoint: '/import/simplefin-account-transactions' }, 'Failed to fetch SimpleFin account detail');
    throw error;
  }
};
