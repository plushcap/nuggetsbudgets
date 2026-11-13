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
  backupKeysResponseSchema,
  backupKeyStatusResponseSchema,
  backupListResponseSchema,
  backupRunsResponseSchema,
  backupOneDriveStatusResponseSchema,
  backupRecipientSavedResponseSchema,
  backupStartedResponseSchema,
  oneDriveAuthResponseSchema,
  oneDriveConfigResponseSchema,
  oneDriveStatusResponseSchema,
  restoreStatusResponseSchema,
  settingsActionResponseSchema,
  verifyStatusResponseSchema,
  type BackupCreateStatus,
  type BackupFile,
  type BackupKeys,
  type BackupKeyStatus,
  type BackupRecipient,
  type BackupRecipientCreate,
  type BackupRun,
  type BackupRuns,
  type BackupStarted,
  type OneDriveConfig,
  type OneDriveStatus,
  type RestoreStatus,
  type SettingsActionResponse,
  type VerifyStatus,
} from '@nuggets/shared';
import { API_BASE_URL, assertOk, getAuthHeaders, handleResponse, apiDelete, apiGet, apiPost, apiPostFormData } from './base';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

export type {
  BackupCreateStatus,
  BackupFile,
  BackupKeys,
  BackupKeyStatus,
  BackupRecipient,
  OneDriveConfig,
  OneDriveStatus,
  RestoreStatus,
  VerifyStatus,
};

/**
 * What a restore or verify sends with the backup: for an age backup the file key (base64) the
 * browser got from its header with the private key, which itself never leaves the browser;
 * for an older .enc one, the old backup key, if typed.
 */
export interface BackupKeyAnswer {
  fileKey?: string;
  encryptionKey?: string;
}
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
 * Start restoring an uploaded backup file (form fields: backup, and fileKey for an age
 * backup or optionally encryptionKey for an .enc one). Poll getRestoreStatus() for the outcome.
 */
export const restoreBackup = async (formData: FormData): Promise<RestoreStarted> => {
  // Shared FormData helper attaches the X-CSRF-Token header (and omits Content-Type).
  return parseAnswer(backupStartedResponseSchema, await apiPostFormData<unknown>('/backup/restore', formData), 'restore started');
};

/** Start restoring one of the backups on the server, with its file key (age) or the old key (.enc). */
export const restoreBackupFromServer = async (fileName: string, keys: BackupKeyAnswer): Promise<RestoreStarted> =>
  parseAnswer(backupStartedResponseSchema, await apiPost<unknown>(`/backup/restore/${encodeURIComponent(fileName)}`, keys), 'restore started');

/** How the restore that is running, or ran last, is going. */
/** The record of backups: the newest runs, failures too, each with its last verify; and whether none has passed one for 90 days. */
export const getBackupRuns = async (): Promise<BackupRuns> =>
  parseAnswer(backupRunsResponseSchema, await apiGet<unknown>('/backup/runs'), 'backup runs');

export type { BackupRun, BackupRuns };

export const getRestoreStatus = async (): Promise<RestoreStatus> =>
  parseAnswer(restoreStatusResponseSchema, await apiGet<unknown>('/backup/restore-status'), 'restore status');

/**
 * Start verifying an uploaded backup (form fields as for a restore): it is restored into a
 * scratch database, checked and dropped, while the app keeps serving. Poll getVerifyStatus().
 */
export const verifyBackup = async (formData: FormData): Promise<BackupStarted> =>
  parseAnswer(backupStartedResponseSchema, await apiPostFormData<unknown>('/backup/verify', formData), 'verify started');

/** Start verifying one of the backups on the server. */
export const verifyBackupFromServer = async (fileName: string, keys: BackupKeyAnswer): Promise<BackupStarted> =>
  parseAnswer(backupStartedResponseSchema, await apiPost<unknown>(`/backup/verify/${encodeURIComponent(fileName)}`, keys), 'verify started');

/** How the verify that is running, or ran last, is going. */
export const getVerifyStatus = async (): Promise<VerifyStatus> =>
  parseAnswer(verifyStatusResponseSchema, await apiGet<unknown>('/backup/verify-status'), 'verify status');

/**
 * The age header of a backup on the server (at most 16 KiB): the page opens it with the
 * private key, which stays in the browser.
 */
export const getBackupHeader = async (fileName: string): Promise<Uint8Array> => {
  const response = await fetch(`${API_BASE_URL}/backup/${encodeURIComponent(fileName)}/header`, {
    method: 'GET',
    headers: getAuthHeaders(),
  });
  await assertOk(response);
  return new Uint8Array(await response.arrayBuffer());
};

// ============================================================================
// BACKUP KEYS (the owner's age public keys)
// ============================================================================

/** The backup keys, this server's signer, how backups are encrypted now, and the old key. */
export const getBackupKeys = async (): Promise<BackupKeys> =>
  parseAnswer(backupKeysResponseSchema, await apiGet<unknown>('/backup/recipients'), 'backup keys');

/** Add a backup key (a public key). Takes step-up: wrap the call in useReauth's withReauth. */
export const addBackupKey = async (input: BackupRecipientCreate): Promise<BackupRecipient> =>
  parseAnswer(backupRecipientSavedResponseSchema, await apiPost<unknown>('/backup/recipients', input), 'backup key').recipient;

/** Remove a backup key. Takes step-up. */
export const removeBackupKey = async (uuid: string): Promise<SettingsActionResponse> =>
  parseAnswer(settingsActionResponseSchema, await apiDelete<unknown>(`/backup/recipients/${encodeURIComponent(uuid)}`), 'backup key removed');

/** Mark a backup key checked: its private key file matched it here. */
export const markBackupKeyChecked = async (uuid: string): Promise<BackupRecipient> =>
  parseAnswer(backupRecipientSavedResponseSchema, await apiPost<unknown>(`/backup/recipients/${encodeURIComponent(uuid)}/checked`), 'backup key')
    .recipient;

/**
 * Download a backup file. Its name is one path segment, encoded: any backup file in the
 * backup directory is listed, whatever its name.
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

/** Whether the old backup key exists and whether it has been downloaded. */
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

/**
 * Download the old backup key as a text blob (marks it downloaded server-side). Takes
 * step-up: wrap the call in useReauth's withReauth.
 */
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
