/**
 * API Backup Module - Database Backup Operations
 * 
 * Handles all backup-related API operations:
 * - List available backups
 * - Create new backups
 * - Restore from backups
 * - Download backups
 * - Delete backups
 */

import {
  backupCreateStatusResponseSchema,
  backupKeyGeneratedResponseSchema,
  backupKeyStatusResponseSchema,
  backupListResponseSchema,
  backupOneDriveStatusResponseSchema,
  backupStartedResponseSchema,
  oneDriveAuthResponseSchema,
  oneDriveConfigResponseSchema,
  oneDriveStatusResponseSchema,
  restoreStatusResponseSchema,
  settingsActionResponseSchema,
  type BackupCreateStatus,
  type BackupFile,
  type BackupKeyStatus,
  type BackupStarted,
  type OneDriveConfig,
  type OneDriveStatus,
  type RestoreStatus,
  type SettingsActionResponse,
} from '@nuggets/shared';
import { API_BASE_URL, assertOk, getAuthHeaders, handleResponse, apiGet, apiPost, apiPostFormData } from './base';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

export type { BackupCreateStatus, BackupFile, BackupKeyStatus, OneDriveConfig, OneDriveStatus, RestoreStatus };
/** What the server answers when it starts a restore (202): the restore runs in the background. */
export type RestoreStarted = BackupStarted;

/**
 * Get list of all available backups
 */
export const getBackups = async (): Promise<{ backups: BackupFile[] }> => {
  try {
    const response = await fetch(`${API_BASE_URL}/backup/list`, {
      method: 'GET',
      headers: getAuthHeaders(),
    });
    return parseAnswer(backupListResponseSchema, await handleResponse<unknown>(response), 'backups');
  } catch (error) {
    logger.error({ err: error, endpoint: '/backup' }, 'Failed to get backups');
    throw error;
  }
};

/**
 * Create a new backup
 */
export const createBackup = async (): Promise<BackupStarted> => {
  try {
    // Returns 202 immediately; the backup runs server-side. Poll
    // getBackupCreateStatus() for completion.
    const response = await fetch(`${API_BASE_URL}/backup/create`, {
      method: 'POST',
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseAnswer(backupStartedResponseSchema, await handleResponse<unknown>(response), 'backup started');
  } catch (error) {
    logger.error({ err: error, endpoint: '/backup/create' }, 'Failed to start backup');
    throw error;
  }
};

/**
 * Poll the status of the most recent manual backup (after createBackup()).
 */
export const getBackupCreateStatus = async (): Promise<BackupCreateStatus> => {
  try {
    const response = await fetch(`${API_BASE_URL}/backup/create-status`, {
      method: 'GET',
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseAnswer(backupCreateStatusResponseSchema, await handleResponse<unknown>(response), 'backup status');
  } catch (error) {
    logger.error({ err: error, endpoint: '/backup/create-status' }, 'Failed to fetch backup status');
    throw error;
  }
};

/**
 * Start restoring an uploaded backup file (form fields: backup, and optionally
 * encryptionKey). Poll getRestoreStatus() for the outcome.
 */
export const restoreBackup = async (formData: FormData): Promise<RestoreStarted> => {
  // Shared FormData helper attaches the X-CSRF-Token header (and omits Content-Type).
  return parseAnswer(backupStartedResponseSchema, await apiPostFormData<unknown>('/backup/restore', formData), 'restore started');
};

/** Start restoring one of the backups on the server; without a key, with the server's own. */
export const restoreBackupFromServer = async (fileName: string, encryptionKey?: string): Promise<RestoreStarted> =>
  parseAnswer(
    backupStartedResponseSchema,
    await apiPost<unknown>(`/backup/restore/${encodeURIComponent(fileName)}`, encryptionKey ? { encryptionKey } : {}),
    'restore started'
  );

/** How the restore that is running, or ran last, is going. */
export const getRestoreStatus = async (): Promise<RestoreStatus> =>
  parseAnswer(restoreStatusResponseSchema, await apiGet<unknown>('/backup/restore-status'), 'restore status');

/**
 * Download a backup file. Its name is one path segment, encoded: any .enc file in
 * the backup directory is listed, whatever its name.
 */
export const downloadBackup = async (fileName: string): Promise<Blob> => {
  try {
    const response = await fetch(`${API_BASE_URL}/backup/download/${encodeURIComponent(fileName)}`, {
      method: 'GET',
      headers: getAuthHeaders(),
    });
    await assertOk(response);
    return response.blob();
  } catch (error) {
    logger.error({ err: error, endpoint: '/backup/download' }, 'Failed to download backup');
    throw error;
  }
};

/**
 * Delete a backup file (its name encoded, as for a download).
 */
export const deleteBackup = async (fileName: string): Promise<SettingsActionResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/backup/${encodeURIComponent(fileName)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseAnswer(settingsActionResponseSchema, await handleResponse<unknown>(response), 'backup deleted');
  } catch (error) {
    logger.error({ err: error, endpoint: '/backup' }, 'Failed to delete backup');
    throw error;
  }
};

// ============================================================================
// BACKUP ENCRYPTION KEY
// ============================================================================

/** Whether a backup key exists and whether it has been downloaded. */
export const getBackupKeyStatus = async (): Promise<BackupKeyStatus> => {
  try {
    const response = await fetch(`${API_BASE_URL}/backup/key/status`, {
      method: 'GET',
      headers: getAuthHeaders(),
    });
    return parseAnswer(backupKeyStatusResponseSchema, await handleResponse<unknown>(response), 'backup key status');
  } catch (error) {
    logger.error({ err: error, endpoint: '/backup/key/status' }, 'Failed to get backup key status');
    throw error;
  }
};

/** Generate (or rotate) the backup encryption key. The key itself is fetched separately via downloadBackupKey(). */
export const generateBackupKey = async (): Promise<{ success: boolean }> => {
  try {
    const response = await fetch(`${API_BASE_URL}/backup/key/generate`, {
      method: 'POST',
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseAnswer(backupKeyGeneratedResponseSchema, await handleResponse<unknown>(response), 'backup key generated');
  } catch (error) {
    logger.error({ err: error, endpoint: '/backup/key/generate' }, 'Failed to generate backup key');
    throw error;
  }
};

/** Download the current backup key as a text blob (marks it downloaded server-side). */
export const downloadBackupKey = async (): Promise<Blob> => {
  try {
    const response = await fetch(`${API_BASE_URL}/backup/key/download`, {
      method: 'GET',
      headers: getAuthHeaders(),
    });
    await assertOk(response);
    return response.blob();
  } catch (error) {
    logger.error({ err: error, endpoint: '/backup/key/download' }, 'Failed to download backup key');
    throw error;
  }
};

// ============================================================================
// ONEDRIVE BACKUP SYNC
// ============================================================================

/**
 * Get the OneDrive app registration (client id + redirect uri; the secret is
 * never returned, only whether one is set).
 */
export const getOneDriveConfig = async (): Promise<OneDriveConfig> => {
  try {
    const response = await fetch(`${API_BASE_URL}/onedrive/config`, {
      method: 'GET',
      headers: getAuthHeaders(),
    });
    return parseAnswer(oneDriveConfigResponseSchema, await handleResponse<unknown>(response), 'OneDrive config');
  } catch (error) {
    logger.error({ err: error, endpoint: '/onedrive/config' }, 'Failed to get OneDrive config');
    throw error;
  }
};

/**
 * Save the OneDrive app registration. Omit `clientSecret` to leave the stored
 * secret unchanged. The backend encrypts the client id + secret at rest.
 */
export const saveOneDriveConfig = async (input: {
  clientId: string;
  redirectUri: string;
  clientSecret?: string | undefined;
}): Promise<SettingsActionResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/onedrive/config`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(input),
    });
    return parseAnswer(settingsActionResponseSchema, await handleResponse<unknown>(response), 'OneDrive');
  } catch (error) {
    logger.error({ err: error, endpoint: '/onedrive/config' }, 'Failed to save OneDrive config');
    throw error;
  }
};

/**
 * Get OneDrive connection status
 */
export const getOneDriveStatus = async (): Promise<OneDriveStatus> => {
  try {
    const response = await fetch(`${API_BASE_URL}/onedrive/status`, {
      method: 'GET',
      headers: getAuthHeaders(),
    });
    return parseAnswer(oneDriveStatusResponseSchema, await handleResponse<unknown>(response), 'OneDrive status');
  } catch (error) {
    logger.error({ err: error, endpoint: '/onedrive/status' }, 'Failed to get OneDrive status');
    throw error;
  }
};

/**
 * Start OneDrive OAuth authorization flow
 * Returns authorization URL to open in new window
 */
export const startOneDriveAuth = async (): Promise<{ success: boolean; authUrl: string }> => {
  try {
    const response = await fetch(`${API_BASE_URL}/onedrive/auth`, {
      method: 'GET',
      headers: getAuthHeaders(),
    });
    return parseAnswer(oneDriveAuthResponseSchema, await handleResponse<unknown>(response), 'OneDrive sign-in');
  } catch (error) {
    logger.error({ err: error, endpoint: '/onedrive/auth' }, 'Failed to start OneDrive auth');
    throw error;
  }
};

/**
 * Update OneDrive settings (auto-sync enable/disable)
 */
export const updateOneDriveSettings = async (autoSyncEnabled: boolean): Promise<SettingsActionResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/onedrive/settings`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ autoSyncEnabled }),
    });
    return parseAnswer(settingsActionResponseSchema, await handleResponse<unknown>(response), 'OneDrive');
  } catch (error) {
    logger.error({ err: error, endpoint: '/onedrive/settings' }, 'Failed to update OneDrive settings');
    throw error;
  }
};

/**
 * Check OneDrive status for specific backup files
 */
export const checkBackupOneDriveStatus = async (fileNames: string[]): Promise<{ status: Record<string, boolean> }> => {
  try {
    const response = await fetch(`${API_BASE_URL}/backup/check-onedrive-status`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ fileNames }),
    });
    return parseAnswer(backupOneDriveStatusResponseSchema, await handleResponse<unknown>(response), 'backups in OneDrive');
  } catch (error) {
    logger.error({ err: error, endpoint: '/backup/check-onedrive-status', fileNames }, 'Failed to check OneDrive status');
    throw error;
  }
};

/**
 * Manually upload a specific backup file to OneDrive
 */
export const uploadBackupToOneDrive = async (fileName: string): Promise<SettingsActionResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/onedrive/upload`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ fileName }),
    });
    return parseAnswer(settingsActionResponseSchema, await handleResponse<unknown>(response), 'OneDrive');
  } catch (error) {
    logger.error({ err: error, endpoint: '/onedrive/upload', fileName }, 'Failed to upload backup to OneDrive');
    throw error;
  }
};

/**
 * Disconnect OneDrive (revoke access)
 */
export const disconnectOneDrive = async (): Promise<SettingsActionResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/onedrive/disconnect`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseAnswer(settingsActionResponseSchema, await handleResponse<unknown>(response), 'OneDrive');
  } catch (error) {
    logger.error({ err: error, endpoint: '/onedrive/disconnect' }, 'Failed to disconnect OneDrive');
    throw error;
  }
};

/**
 * Test OneDrive connection by uploading a test file
 */
export const testOneDriveConnection = async (): Promise<SettingsActionResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/onedrive/test-upload`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseAnswer(settingsActionResponseSchema, await handleResponse<unknown>(response), 'OneDrive');
  } catch (error) {
    logger.error({ err: error, endpoint: '/onedrive/test-upload' }, 'Failed to test OneDrive connection');
    throw error;
  }
};
