import { DomainError } from '../domainErrors.js';

/**
 * A request about the deployment's backups that can't be carried out, for a reason the
 * deployment admin can act on: answered by the route wrapper with its status. The backup
 * service's own refusals (BackupInProgressError, ShuttingDownError, BackupKeyMissingError,
 * RestoreRefusedError) are in BackupService.ts.
 */
export class BackupError extends DomainError {}

/** No backup in the backup directory has that name (only listed files, never a path). */
export const backupNotFound = (): BackupError => new BackupError(404, 'NOT_FOUND', 'Backup file not found');

/** A restore from an upload that sent no file. */
export const noBackupFile = (): BackupError => new BackupError(400, 'BAD_REQUEST', 'No backup file provided');

/** The backup key's download, before any key was generated. */
export const noBackupKey = (): BackupError => new BackupError(404, 'NOT_FOUND', 'No backup key has been generated yet');

/** OneDrive, where backups are copied, has no app registration (client id and secret) yet. */
export const oneDriveNotConfigured = (): BackupError =>
  new BackupError(503, 'ONEDRIVE_NOT_CONFIGURED', 'OneDrive integration not configured');
