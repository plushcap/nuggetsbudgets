/**
 * API Import Module - Data Import Operations
 *
 * Handles the SimpleFin bank-import API operations:
 * - Import settings, status, and sync (manual + per-account)
 * - SimpleFin account discovery and sync log
 * - Fix budget period items
 *
 * Each answer is parsed with its `@nuggets/shared` schema.
 */

import {
  importAccountSyncResponseSchema,
  importAccountsResponseSchema,
  importSettingsResponseSchema,
  importStatusResponseSchema,
  importSyncLogQuery,
  importSyncResponseSchema,
  importTestSyncResponseSchema,
  importUsersResponseSchema,
  queryString,
  settingsActionResponseSchema,
  syncLogPageResponseSchema,
  type ImportAccountSyncResponse,
  type ImportSyncResponse,
  type SettingsActionResponse,
  type SyncLogPage,
} from '@nuggets/shared';
import { API_BASE_URL, getAuthHeaders, handleResponse, toLedgerWording } from './base';
import { parseAnswer } from './parseAnswer';
import type {
  ImportStatus,
  ImportSettingsResponse,
  ImportUsersResponse,
  TestImportConnectionResponse,
  ImportAccountsResponse,
} from './types';
import { logger } from '../../utils/logger';

// ====================================================================
// IMPORT STATUS AND SETTINGS
// ====================================================================

/**
 * Get import status
 */
export const getImportStatus = async (): Promise<ImportStatus> => {
  try {
    const response = await fetch(`${API_BASE_URL}/import/status`, {
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseAnswer(importStatusResponseSchema, await handleResponse<unknown>(response), 'import status');
  } catch (error) {
    logger.error({ err: error, endpoint: '/import/status' }, 'Failed to get import status');
    throw error;
  }
};

/**
 * Get import settings. Their descriptions come from the server, which calls a ledger a
 * tenant, so they are shown in Ledger wording, as its errors are.
 */
export const getImportSettings = async (): Promise<ImportSettingsResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/import/settings`, {
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    const result = parseAnswer(importSettingsResponseSchema, await handleResponse<unknown>(response), 'import settings');
    // `?? ''`: a production build reads a mismatched answer as it came (parseAnswer), maybe without one.
    const settings = Object.fromEntries(
      Object.entries(result.settings).map(([key, setting]) => [key, { ...setting, description: toLedgerWording(setting.description ?? '') }])
    ) as ImportSettingsResponse['settings'];
    return { ...result, settings };
  } catch (error) {
    logger.error({ err: error, endpoint: '/import/settings' }, 'Failed to get import settings');
    throw error;
  }
};

/**
 * Update import settings
 */
export const updateImportSettings = async (settings: Record<string, string>): Promise<SettingsActionResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/import/settings`, {
      method: 'POST',
      headers: getAuthHeaders(),
      credentials: 'include',
      body: JSON.stringify({ settings }),
    });
    return parseAnswer(settingsActionResponseSchema, await handleResponse<unknown>(response), 'import settings saved');
  } catch (error) {
    logger.error({ err: error, endpoint: '/import/settings' }, 'Failed to update import settings');
    throw error;
  }
};

/**
 * Get import users
 */
export const getImportUsers = async (): Promise<ImportUsersResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/import/users`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(importUsersResponseSchema, await handleResponse<unknown>(response), 'import users');
  } catch (error) {
    logger.error({ err: error, endpoint: '/import/users' }, 'Failed to get import users');
    throw error;
  }
};

// ====================================================================
// SYNC OPERATIONS
// ====================================================================

/**
 * How a manual sync ended. `status` is what its bank-sync-history row says: 'partial'
 * when accounts or transactions couldn't be saved, and `message` then says what. A sync
 * of the Ledger that is already running answers 409 instead (the rejection's message
 * says so).
 */
export type SyncAnswer = Pick<ImportAccountSyncResponse, 'success' | 'status' | 'message' | 'error'>;

/**
 * Run manual sync for all accounts
 */
export const runManualSync = async (): Promise<ImportSyncResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/import/sync`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseAnswer(importSyncResponseSchema, await handleResponse<unknown>(response), 'sync');
  } catch (error) {
    logger.error({ err: error, endpoint: '/import/sync' }, 'Failed to run manual sync');
    throw error;
  }
};

/**
 * Sync a specific account: how it ended, and what it did (`result`).
 */
export const syncAccount = async (accountUuid: string): Promise<ImportAccountSyncResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/import/sync/${accountUuid}`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseAnswer(importAccountSyncResponseSchema, await handleResponse<unknown>(response), 'account sync');
  } catch (error) {
    logger.error({ err: error, endpoint: '/import/sync/account' }, 'Failed to sync account');
    throw error;
  }
};

/**
 * Test import connection
 */
export const testImportConnection = async (): Promise<TestImportConnectionResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/import/test-sync`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseAnswer(importTestSyncResponseSchema, await handleResponse<unknown>(response), 'test sync');
  } catch (error) {
    logger.error({ err: error, endpoint: '/import/test' }, 'Failed to test import connection');
    throw error;
  }
};

/**
 * Get import accounts
 */
export const getImportAccounts = async (): Promise<ImportAccountsResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/import/accounts`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(importAccountsResponseSchema, await handleResponse<unknown>(response), 'import accounts');
  } catch (error) {
    logger.error({ err: error, endpoint: '/import/accounts' }, 'Failed to get import accounts');
    throw error;
  }
};

/**
 * Get import sync log
 */
export const getImportSyncLog = async (limit = 50, offset = 0): Promise<SyncLogPage> => {
  try {
    const response = await fetch(`${API_BASE_URL}/import/sync-log${queryString(importSyncLogQuery, { limit, offset })}`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(syncLogPageResponseSchema, await handleResponse<unknown>(response), 'sync log');
  } catch (error) {
    logger.error({ err: error, endpoint: '/import/sync-log' }, 'Failed to get import sync log');
    throw error;
  }
};
