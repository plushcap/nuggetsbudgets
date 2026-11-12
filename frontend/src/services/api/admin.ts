/**
 * API Admin Module - Administrative Operations
 * 
 * Handles all admin-related API operations:
 * - Test data generation
 * - Bulk data operations
 * - System maintenance
 * - The database's schema and applied migrations, for a bug report (Settings → Utilities)
 * - The deployment's own settings: its time zone (Settings → Database Backup)
 */

import type { z } from 'zod';
import {
  deploymentSettingsResponseSchema,
  deploymentSettingsSavedResponseSchema,
  testAccountsResponseSchema,
  testBudgetItemsResponseSchema,
  testBudgetPeriodsResponseSchema,
  testCategoriesResponseSchema,
  testDataClearedResponseSchema,
  testDataGeneratedResponseSchema,
  testInstitutionsResponseSchema,
  testTransactionsResponseSchema,
  type DeploymentSettings,
  type DeploymentSettingsSaved,
} from '@nuggets/shared';
import { API_BASE_URL, apiGet, apiPut, assertOk, getAuthHeaders, handleResponse } from './base';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

export type { DeploymentSettings, DeploymentSettingsSaved };

// ====================================================================
// TEST DATA GENERATION
// ====================================================================

/**
 * Generate test categories
 */
export const generateTestCategories = async (): Promise<z.output<typeof testCategoriesResponseSchema>> => {
  try {
    const response = await fetch(`${API_BASE_URL}/admin/test-data/categories`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseAnswer(testCategoriesResponseSchema, await handleResponse<unknown>(response), 'test categories');
  } catch (error) {
    logger.error({ err: error, endpoint: '/test-data/categories' }, 'Failed to generate test categories');
    throw error;
  }
};

/**
 * Generate test account institutions
 */
export const generateTestAccountInstitutions = async (): Promise<z.output<typeof testInstitutionsResponseSchema>> => {
  try {
    const response = await fetch(`${API_BASE_URL}/admin/test-data/account-institutions`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseAnswer(testInstitutionsResponseSchema, await handleResponse<unknown>(response), 'test institutions');
  } catch (error) {
    logger.error({ err: error, endpoint: '/test-data/institutions' }, 'Failed to generate test institutions');
    throw error;
  }
};

/**
 * Generate test accounts
 */
export const generateTestAccounts = async (): Promise<z.output<typeof testAccountsResponseSchema>> => {
  try {
    const response = await fetch(`${API_BASE_URL}/admin/test-data/accounts`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseAnswer(testAccountsResponseSchema, await handleResponse<unknown>(response), 'test accounts');
  } catch (error) {
    logger.error({ err: error, endpoint: '/test-data/accounts' }, 'Failed to generate test accounts');
    throw error;
  }
};

/**
 * Generate test budget periods
 */
export const generateTestBudgetPeriods = async (months: Array<{year: number, monthNumber: number}>): Promise<z.output<typeof testBudgetPeriodsResponseSchema>> => {
  try {
    const response = await fetch(`${API_BASE_URL}/admin/test-data/budget-periods`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ months }),
    });
    return parseAnswer(testBudgetPeriodsResponseSchema, await handleResponse<unknown>(response), 'test budget periods');
  } catch (error) {
    logger.error({ err: error, endpoint: '/test-data/budget-periods' }, 'Failed to generate test budget periods');
    throw error;
  }
};

/**
 * Generate test budget items
 */
export const generateTestBudgetItems = async (): Promise<z.output<typeof testBudgetItemsResponseSchema>> => {
  try {
    const response = await fetch(`${API_BASE_URL}/admin/test-data/budget-items`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseAnswer(testBudgetItemsResponseSchema, await handleResponse<unknown>(response), 'test budget items');
  } catch (error) {
    logger.error({ err: error, endpoint: '/test-data/budget-items' }, 'Failed to generate test budget items');
    throw error;
  }
};

/**
 * Generate test transactions
 */
export const generateTestTransactions = async (): Promise<z.output<typeof testTransactionsResponseSchema>> => {
  try {
    const response = await fetch(`${API_BASE_URL}/admin/test-data/transactions`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseAnswer(testTransactionsResponseSchema, await handleResponse<unknown>(response), 'test transactions');
  } catch (error) {
    logger.error({ err: error, endpoint: '/test-data/transactions' }, 'Failed to generate test transactions');
    throw error;
  }
};

/**
 * Generate all test data at once
 */
export const generateAllTestData = async (): Promise<z.output<typeof testDataGeneratedResponseSchema>> => {
  try {
    const response = await fetch(`${API_BASE_URL}/admin/test-data/generate-all`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseAnswer(testDataGeneratedResponseSchema, await handleResponse<unknown>(response), 'test data');
  } catch (error) {
    logger.error({ err: error, endpoint: '/test-data/all' }, 'Failed to generate all test data');
    throw error;
  }
};

/**
 * Clear all test data
 */
export const clearAllTestData = async (): Promise<z.output<typeof testDataClearedResponseSchema>> => {
  try {
    const response = await fetch(`${API_BASE_URL}/admin/test-data/clear-all`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseAnswer(testDataClearedResponseSchema, await handleResponse<unknown>(response), 'test data cleared');
  } catch (error) {
    logger.error({ err: error, endpoint: '/test-data/clear' }, 'Failed to clear test data');
    throw error;
  }
};

// ====================================================================
// DATABASE DIAGNOSTICS (Settings → Utilities)
// ====================================================================

/** A file the server sent, with the name it gave it. */
export interface DownloadedFile {
  blob: Blob;
  fileName: string;
}

/**
 * The file name a download's Content-Disposition gives (RFC 6266: `filename*` before
 * `filename`), as a bare name, never a path; `fallback` when it gives none.
 */
export const attachmentFileName = (response: Response, fallback: string): string => {
  const header = response.headers.get('Content-Disposition') ?? '';
  let name: string | undefined;
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (extended) {
    try {
      name = decodeURIComponent(extended.trim());
    } catch {
      name = undefined;
    }
  }
  name ??= /filename="([^"]*)"/i.exec(header)?.[1];
  // eslint-disable-next-line no-control-regex
  const bare = name?.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return bare && bare !== '.' && bare !== '..' ? bare : fallback;
};

/** GET one of the database downloads, with the name the server gave it (else `fallback`). */
const downloadDatabaseFile = async (file: 'schema' | 'migrations', fallback: string): Promise<DownloadedFile> => {
  try {
    const response = await fetch(`${API_BASE_URL}/admin/database/${file}`, {
      method: 'GET',
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    await assertOk(response);
    return { blob: await response.blob(), fileName: attachmentFileName(response, fallback) };
  } catch (error) {
    logger.error({ err: error, endpoint: `/admin/database/${file}` }, 'Failed to download a database file');
    throw error;
  }
};

/** The database's schema (`pg_dump --schema-only`): no rows, so none of a ledger's data. */
export const downloadDatabaseSchema = (): Promise<DownloadedFile> => downloadDatabaseFile('schema', 'nuggets-schema.sql');

/** The migrations the database has applied (the rows of `schema_migrations`), as SQL. */
export const downloadAppliedMigrations = (): Promise<DownloadedFile> =>
  downloadDatabaseFile('migrations', 'nuggets-migrations.sql');

// ====================================================================
// DEPLOYMENT SETTINGS
// ====================================================================

export const getDeploymentSettings = async (): Promise<{ settings: DeploymentSettings }> =>
  parseAnswer(deploymentSettingsResponseSchema, await apiGet<unknown>('/admin/deployment-settings'), 'deployment settings');

/**
 * What saving answers. When the zone is saved, each ledger that follows it has its goal
 * history's ranges moved to the new zone's today; `notice` (and `tenants_not_clamped`, how many
 * ledgers) says some couldn't be, and saving the zone again retries them.
 */
export const updateDeploymentSettings = async (settings: Partial<DeploymentSettings>): Promise<DeploymentSettingsSaved> =>
  parseAnswer(deploymentSettingsSavedResponseSchema, await apiPut<unknown>('/admin/deployment-settings', { settings }), 'deployment settings saved');
