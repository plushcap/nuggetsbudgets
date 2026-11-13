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

/** A public key the server can't encrypt backups to: the message never repeats the key. */
export const invalidBackupKey = (message: string): BackupError => new BackupError(400, 'INVALID_BACKUP_KEY', message);

/** Already as many backup keys as a backup is encrypted to. */
export const tooManyBackupKeys = (max: number): BackupError =>
  new BackupError(409, 'TOO_MANY_BACKUP_KEYS', `A backup is encrypted to at most ${max} keys: remove one before adding another.`);

/** A key of the other kind than the server's: age won't encrypt to post-quantum and classic keys together. */
export const backupKeyKindMismatch = (existing: string): BackupError =>
  new BackupError(
    409,
    'BACKUP_KEY_KIND_MISMATCH',
    `This server's backup keys are ${existing}: a key of the other kind can't join them, since a classic key in the same file undoes the post-quantum protection. Use a ${existing} key, or remove the others first.`
  );

/** The same public key twice. */
export const duplicateBackupKey = (): BackupError => new BackupError(409, 'DUPLICATE_BACKUP_KEY', 'That key is already one of the backup keys.');

/** No backup key has that id. */
export const backupKeyNotFound = (): BackupError => new BackupError(404, 'NOT_FOUND', 'Backup key not found');

/** A header asked for a backup that isn't age (an older .enc one opens with the old key instead). */
export const notAnAgeBackup = (): BackupError =>
  new BackupError(409, 'NOT_AN_AGE_BACKUP', "This backup isn't encrypted with age: it opens with the old backup key.");

/** A backup whose age header can't be read: damaged, or not a backup. */
export const damagedBackupHeader = (message: string): BackupError => new BackupError(422, 'BACKUP_DAMAGED', message);
