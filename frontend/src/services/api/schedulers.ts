/**
 * API Schedulers Module - Scheduler Control Operations
 *
 * Handles all scheduler-related API operations:
 * - Import scheduler control (start, stop, restart)
 * - Backup scheduler control and settings
 *
 * Each answer is parsed with its `@nuggets/shared` schema.
 */

import {
  backupSettingsResponseSchema,
  backupStatusResponseSchema,
  importSchedulerResponseSchema,
  settingsActionResponseSchema,
  type BackupStatus,
  type ImportSchedulerResponse,
  type SettingsActionResponse,
  type StoredSetting,
} from '@nuggets/shared';
import { API_BASE_URL, apiPost, getAuthHeaders, handleResponse } from './base';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

// ====================================================================
// IMPORT SCHEDULER OPERATIONS
// ====================================================================

/** Turn the ledger's automatic import on. */
export const startImportScheduler = async (): Promise<ImportSchedulerResponse> =>
  parseAnswer(importSchedulerResponseSchema, await apiPost<unknown>('/import/scheduler/start'), 'import scheduler start');

/** Turn the ledger's automatic import off. */
export const stopImportScheduler = async (): Promise<ImportSchedulerResponse> =>
  parseAnswer(importSchedulerResponseSchema, await apiPost<unknown>('/import/scheduler/stop'), 'import scheduler stop');

// ====================================================================
// BACKUP SCHEDULER OPERATIONS
// ====================================================================

/**
 * Get backup scheduler status
 */
export const getBackupSchedulerStatus = async (): Promise<BackupStatus> => {
  try {
    const response = await fetch(`${API_BASE_URL}/backup/status`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(backupStatusResponseSchema, await handleResponse<unknown>(response), 'backup status');
  } catch (error) {
    logger.error({ err: error, endpoint: '/backup/scheduler/status' }, 'Failed to get backup scheduler status');
    throw error;
  }
};

/**
 * Get backup scheduler settings
 */
export const getBackupSettings = async (): Promise<{ settings: Record<string, StoredSetting> }> => {
  try {
    const response = await fetch(`${API_BASE_URL}/backup/settings`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(backupSettingsResponseSchema, await handleResponse<unknown>(response), 'backup settings');
  } catch (error) {
    logger.error({ err: error, endpoint: '/backup/settings' }, 'Failed to get backup settings');
    throw error;
  }
};

/**
 * Update backup scheduler settings
 */
export const updateBackupSettings = async (settings: Record<string, string>): Promise<SettingsActionResponse> =>
  parseAnswer(settingsActionResponseSchema, await apiPost<unknown>('/backup/settings', { settings }), 'backup settings saved');

/**
 * Start the backup scheduler
 */
export const startBackupScheduler = async (): Promise<SettingsActionResponse> =>
  parseAnswer(settingsActionResponseSchema, await apiPost<unknown>('/backup/scheduler/start'), 'backup scheduler start');

/**
 * Stop the backup scheduler
 */
export const stopBackupScheduler = async (): Promise<SettingsActionResponse> =>
  parseAnswer(settingsActionResponseSchema, await apiPost<unknown>('/backup/scheduler/stop'), 'backup scheduler stop');
