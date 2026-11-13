import { Router, Response, type RequestHandler } from 'express';
import multer from 'multer';
import {
  BACKUP_SETTING_KEYS,
  MAX_BACKUP_RECIPIENTS,
  backupListQuery,
  backupOneDriveStatusRequestSchema,
  backupRecipientCreateSchema,
  backupRestoreRequestSchema,
  backupSettingsUpdateSchema,
  type BackupRecipientCreate,
  type BackupRestoreRequest,
  type BackupSettingsUpdate,
} from '@nuggets/shared';
import { BackupService, BackupInProgressError, ShuttingDownError } from '../services/BackupService.js';
import { backupKeyNotFound, backupNotFound, noBackupFile, noBackupKey } from '../services/backup/errors.js';
import { getRestoreStatus, getVerifyStatus, startRestoreJob, startVerifyJob, type StartRestoreInput } from '../services/restoreJob.js';
import { requireRecentReauth } from '../middleware/auth.js';
import { isUuid } from '../middleware/routeParams.js';
import { isBackupFileName } from '../utils/backupFormat.js';
import { parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import { authHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { createLogger } from '../utils/logger.js';
import * as path from 'path';
import { UploadRejectedError } from '../utils/imageUpload.js';
import { contentDisposition } from '../utils/uploadSafety.js';
import { answerError, publicErrorMessage } from '../utils/apiError.js';
import { unlink } from 'fs/promises';
import { createReadStream } from 'fs';
import type { RouteDependencies } from './dependencies.js';
import { refuseNulFields } from '../middleware/nulText.js';

const logger = createLogger({ service: 'BackupRoute' });

/**
 * The largest backup the Backup page uploads for a restore, in MB. Backups stream through
 * encryption now, so this only keeps a client from filling the disk; a backup larger
 * than this, or than the reverse proxy lets through, is restored from the server's backup
 * directory instead (POST /restore/:fileName) or with the restore command.
 */
const DEFAULT_MAX_UPLOAD_MB = 4096;

/**
 * The deployment's backups (/api/backup), mounted behind authenticateToken and
 * requireDeploymentAdmin: making, listing, downloading, deleting, verifying and restoring
 * them, their schedule and keys, and copying them to OneDrive. A refusal (no such backup, one already
 * running, a shutdown begun) is a DomainError the route wrapper answers; any other failure
 * is its 500.
 */
export function createBackupRoutes({
  lifecycleService,
  backupService,
  oneDriveService,
  config,
}: Pick<RouteDependencies, 'lifecycleService' | 'backupService' | 'oneDriveService' | 'config'>): Router {
  const router = Router();

  // Tracks the most recent manual backup so POST /create can return immediately
  // and the client polls GET /create-status. The dump + zip + encrypt can take
  // minutes — longer than typical reverse-proxy idle timeouts — so we must not
  // hold the HTTP connection open for the whole operation.
  type ManualBackupState = {
    status: 'idle' | 'running' | 'completed' | 'failed';
    fileName?: string;
    fileSize?: number;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
  };
  let manualBackup: ManualBackupState = { status: 'idle' };

  // Backups uploaded for a restore go to the temp directory, which a start after a crash sweeps.
  const upload = multer({
    dest: path.join(backupService.getTempDir(), 'uploads'),
    limits: {
      fileSize: (parseInt(config.BACKUP_MAX_FILE_SIZE_MB || '', 10) || DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
      // By name here; what the file is comes from its bytes when it is opened.
      if (isBackupFileName(file.originalname)) {
        cb(null, true);
      } else {
        cb(new UploadRejectedError('Only backup files (.tar.age, or an older .enc) are allowed'));
      }
    }
  });

  /**
   * Once a shutdown has begun no backup or restore starts (BackupService.refuseNewOperations):
   * 503 SHUTTING_DOWN, before an uploaded backup is received.
   */
  const refuseWhileShuttingDown: RequestHandler = (_req, res, next) => {
    if (!BackupService.isRefusingNewOperations()) {
      next();
      return;
    }
    answerError(new ShuttingDownError(), res);
  };

  /**
   * An uploaded backup is deleted once the request is answered, unless a restore started
   * with it (the restore job deletes it when it is done): a refused body, a refused start
   * (another backup or restore running) or a failure leaves nothing in the temp directory.
   */
  const discardUploadUnlessRestoring: RequestHandler = (req, res, next) => {
    const discard = () => {
      if (req.file && res.locals.restoreStarted !== true) void unlink(req.file.path).catch(() => {});
    };
    res.once('finish', discard);
    res.once('close', discard);
    next();
  };

  /**
   * Create a new backup (manual)
   * POST /api/backup/create
   */
  router.post('/create', refuseWhileShuttingDown, authHandler(async (req: AuthenticatedRequest, res: Response) => {
    // Any backup in this process, scheduled ones included: they share BackupService's lock.
    if (manualBackup.status === 'running' || BackupService.isBackupInProgress()) {
      throw new BackupInProgressError();
    }

    const userId = req.user.userId;
    const startedAt = new Date().toISOString();
    manualBackup = { status: 'running', startedAt };
    logger.info({ userId }, 'Starting manual backup creation (async)');

    // Started here, not after an await, so it holds the lock before anything else can ask.
    const creating = backupService.createBackup();

    // Run the backup in the background and report progress via /create-status,
    // so the HTTP request returns immediately instead of blocking for minutes.
    void (async () => {
      try {
        const result = await creating;
        manualBackup = {
          status: 'completed',
          fileName: result.fileName,
          fileSize: result.fileSize,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
        logger.info({ userId, fileName: result.fileName, fileSize: result.fileSize }, 'Manual backup created successfully');

        // Auto-upload to OneDrive if enabled (best-effort; does not affect status).
        if (await oneDriveService.isConfigured()) {
          try {
            if (await oneDriveService.isAutoSyncEnabled(userId)) {
              await oneDriveService.uploadFile(userId, result.filePath, result.fileName);
              logger.info({ userId, fileName: result.fileName }, 'Backup auto-uploaded to OneDrive');
            }
          } catch (error) {
            logger.warn({ err: error, userId }, 'OneDrive auto-upload failed');
          }
        }
      } catch (error) {
        manualBackup = {
          status: 'failed',
          // A refusal written for people (no key yet, another backup running), else generic:
          // a failed pg_dump's text names the database host and role.
          error: publicErrorMessage(error, 'Backup failed; the server log has the details'),
          startedAt,
          finishedAt: new Date().toISOString(),
        };
        if (error instanceof BackupInProgressError) {
          logger.warn({ err: error, userId }, 'Manual backup refused: another backup is in progress');
        } else {
          logger.error({ err: error, userId }, 'Backup creation failed');
        }
      }
    })();

    res.status(202).json({ success: true, started: true, message: 'Backup started' });
  }));

  /**
   * Status of the most recent manual backup (for polling after POST /create).
   * GET /api/backup/create-status
   */
  router.get('/create-status', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(manualBackup);
  }));

  /** Automatic backups wait for a backup key: with one now, the scheduler can arm. One already armed keeps its schedule. */
  async function armSchedulerIfWaiting(userId: number): Promise<void> {
    try {
      const scheduler = await lifecycleService.getBackupSchedulerStatus();
      if (scheduler.waitingForBackupKey || scheduler.usingOldBackupKey) await lifecycleService.updateBackupSchedulerConfiguration();
    } catch (error) {
      logger.error({ err: error, userId }, 'Error restarting the backup scheduler after a backup key changed');
    }
  }

  /**
   * The backup keys (admin-only via the router mount): the owner's age public keys, which
   * every backup is encrypted to. The private keys never reach the server. Adding or removing
   * one takes step-up: a key of their own would make the backups after it readable to whoever
   * holds its private key.
   */
  router.get('/recipients', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const [recipients, signer, encryption, legacyKey] = await Promise.all([
      backupService.listRecipients(),
      backupService.signerPublicId(),
      backupService.encryptionState(),
      backupService.getBackupKeyStatus(),
    ]);
    res.json({ recipients, signer, mode: encryption.mode, maxRecipients: MAX_BACKUP_RECIPIENTS, legacyKey });
  }));

  // Add a backup key: checked (prefix, length, checksum), at most five, all of one kind.
  router.post('/recipients', requireRecentReauth, validateBody(backupRecipientCreateSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const body = req.body as BackupRecipientCreate;
    const recipient = await backupService.addRecipient({
      recipient: body.recipient,
      label: body.label,
      checked: body.checked === true,
      createdBy: req.user.userId,
    });
    logger.warn({ userId: req.user.userId, fingerprint: recipient.fingerprint, kind: recipient.kind }, 'Backup key added: backups from now on are encrypted to it');
    await armSchedulerIfWaiting(req.user.userId);
    res.status(201).json({ success: true, recipient });
  }));

  // Remove a backup key: backups made to it still open with its private key.
  router.delete('/recipients/:uuid', requireRecentReauth, authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const uuid = String(req.params.uuid);
    if (!isUuid(uuid)) throw backupKeyNotFound();
    await backupService.removeRecipient(uuid);
    logger.warn({ userId: req.user.userId, uuid }, 'Backup key removed');
    // The last one gone: automatic backups wait for a key again (or go back to the old key).
    if ((await backupService.encryptionState()).recipients === 0) {
      try {
        await lifecycleService.updateBackupSchedulerConfiguration();
      } catch (error) {
        logger.error({ err: error, userId: req.user.userId }, 'Error restarting the backup scheduler after the last backup key was removed');
      }
    }
    res.json({ success: true, message: 'Backup key removed' });
  }));

  // "Check a key": the browser matched a private key file to this public key. A mark for the
  // list, so no step-up: it adds no key and opens nothing.
  router.post('/recipients/:uuid/checked', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const uuid = String(req.params.uuid);
    if (!isUuid(uuid)) throw backupKeyNotFound();
    const recipient = await backupService.markRecipientChecked(uuid);
    logger.info({ userId: req.user.userId, uuid }, 'Backup key checked against its private key');
    res.json({ success: true, recipient });
  }));

  // Whether the old backup key K exists and whether it has been downloaded.
  router.get('/key/status', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await backupService.getBackupKeyStatus());
  }));

  // Download the old backup key K as a .txt file (and mark it downloaded): the one way to it,
  // so it takes step-up. It opens every .enc backup made with it, wherever its copies are.
  router.get('/key/download', requireRecentReauth, authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const key = await backupService.getBackupKeyForDownload();
    if (!key) throw noBackupKey();
    logger.info({ userId: req.user.userId }, 'Old backup key downloaded');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', contentDisposition('attachment', 'nuggets-backup-key.txt'));
    res.setHeader('Cache-Control', 'no-store');
    res.send(key);
  }));

  /** What a restore or verify request carries, from its body: the file key, or the old key. */
  function keysFrom(body: BackupRestoreRequest): Pick<StartRestoreInput, 'key' | 'fileKey'> {
    return {
      key: body.encryptionKey?.trim() || null,
      fileKey: body.fileKey ? Buffer.from(body.fileKey, 'base64') : null,
    };
  }

  /**
   * Start a restore in the background and answer 202. Another backup or restore running
   * (409) or a shutdown begun (503) throws, answered by the route wrapper.
   */
  function startRestore(
    req: AuthenticatedRequest,
    res: Response,
    input: Omit<StartRestoreInput, 'userId'>
  ): void {
    startRestoreJob({ backupService, schedulers: lifecycleService }, { ...input, userId: req.user.userId });
    res.locals.restoreStarted = true;
    logger.info({ userId: req.user.userId, fileName: input.fileName, usingCustomKey: input.key !== null, usingFileKey: input.fileKey !== null }, 'Restore started');
    res.status(202).json({ success: true, started: true, message: 'Restore started' });
  }

  /** Start a verify in the background and answer 202; refusals as for a restore. */
  function startVerify(req: AuthenticatedRequest, res: Response, input: Omit<StartRestoreInput, 'userId'>): void {
    startVerifyJob({ backupService }, { ...input, userId: req.user.userId });
    res.locals.restoreStarted = true;
    logger.info({ userId: req.user.userId, fileName: input.fileName, usingFileKey: input.fileKey !== null }, 'Verify started');
    res.status(202).json({ success: true, started: true, message: 'Verify started' });
  }

  /**
   * Restore an uploaded backup, in the background: 202, then poll
   * GET /api/backup/restore-status. The restore takes minutes, longer than a reverse proxy
   * waits, and the server is in maintenance mode while it runs.
   * POST /api/backup/restore (multipart: backup, and fileKey for an age backup, or optionally
   * encryptionKey for an older .enc one: without it, this server's old key)
   */
  router.post(
    '/restore',
    refuseWhileShuttingDown,
    upload.single('backup'),
    discardUploadUnlessRestoring,
    // Its key's text, as every multipart body's: a NUL in it started the restore.
    refuseNulFields,
    validateBody(backupRestoreRequestSchema),
    authHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!req.file) throw noBackupFile();
      startRestore(req, res, {
        filePath: req.file.path,
        fileName: req.file.originalname,
        ...keysFrom(req.body as BackupRestoreRequest),
        deleteAfter: true,
      });
    })
  );

  /**
   * Restore one of the backups in the server's backup directory, by its listed name: no
   * upload, so no size limit. In the background, like POST /restore.
   * POST /api/backup/restore/:fileName  Body: { fileKey?: string, encryptionKey?: string }
   */
  router.post('/restore/:fileName', refuseWhileShuttingDown, validateBody(backupRestoreRequestSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const backup = await backupService.findBackup(String(req.params.fileName));
    if (!backup) throw backupNotFound();
    startRestore(req, res, {
      filePath: backup.filePath,
      fileName: backup.fileName,
      ...keysFrom(req.body as BackupRestoreRequest),
      deleteAfter: false,
    });
  }));

  /**
   * Verify an uploaded backup: restore it into a scratch database, check it and drop it, in
   * the background, while the app keeps serving. 202, then poll GET /api/backup/verify-status.
   * POST /api/backup/verify (multipart, as POST /restore)
   */
  router.post(
    '/verify',
    refuseWhileShuttingDown,
    upload.single('backup'),
    discardUploadUnlessRestoring,
    refuseNulFields,
    validateBody(backupRestoreRequestSchema),
    authHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!req.file) throw noBackupFile();
      startVerify(req, res, {
        filePath: req.file.path,
        fileName: req.file.originalname,
        ...keysFrom(req.body as BackupRestoreRequest),
        deleteAfter: true,
      });
    })
  );

  /** Verify one of the backups on the server. POST /api/backup/verify/:fileName  Body: as /restore/:fileName */
  router.post('/verify/:fileName', refuseWhileShuttingDown, validateBody(backupRestoreRequestSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const backup = await backupService.findBackup(String(req.params.fileName));
    if (!backup) throw backupNotFound();
    startVerify(req, res, { filePath: backup.filePath, fileName: backup.fileName, ...keysFrom(req.body as BackupRestoreRequest), deleteAfter: false });
  }));

  /** How the last verify went. GET /api/backup/verify-status */
  router.get('/verify-status', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(getVerifyStatus());
  }));

  /**
   * The age header of a backup on the server (at most 16 KiB), for the browser to open with
   * the owner's private key, which stays in the browser: it sends back only the file key.
   * GET /api/backup/:fileName/header
   */
  router.get('/:fileName/header', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const header = await backupService.readBackupHeader(String(req.params.fileName));
    if (!header) throw backupNotFound();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.send(header);
  }));

  /**
   * How the last restore went (for polling after POST /restore). After a successful one the
   * session that started it may be gone: sessions are part of the restored data.
   * GET /api/backup/restore-status
   */
  router.get('/restore-status', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(getRestoreStatus());
  }));

  /**
   * List available backups
   * GET /api/backup/list (?checkOneDrive=true also asks OneDrive which it has, slower)
   */
  router.get('/list', validateQuery(backupListQuery), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { checkOneDrive } = parsedQuery(req, backupListQuery);
    const backups = await backupService.listBackups();

    // OneDrive only when asked (it would hold up the page), and best-effort.
    let onedriveStatus: Record<string, boolean> = {};
    if (checkOneDrive && await oneDriveService.isConfigured()) {
      try {
        onedriveStatus = await oneDriveService.checkFilesExistence(req.user.userId, backups.map((b) => b.fileName));
      } catch (error) {
        logger.warn({ err: error, userId: req.user.userId }, 'Failed to check OneDrive status for backups');
      }
    }

    res.json({
      success: true,
      backups: backups.map(backup => ({
        fileName: backup.fileName,
        size: backup.size,
        created: backup.created,
        sizeFormatted: formatFileSize(backup.size),
        onedriveUploaded: onedriveStatus[backup.fileName] || false,
        format: backup.format,
      }))
    });
  }));

  /**
   * Check OneDrive upload status for backups
   * POST /api/backup/check-onedrive-status
   * Body: { fileNames: string[] }
   */
  router.post('/check-onedrive-status', validateBody(backupOneDriveStatusRequestSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { fileNames } = req.body as { fileNames: string[] };
    if (!(await oneDriveService.isConfigured())) {
      res.json({ success: true, status: {} });
      return;
    }
    res.json({ success: true, status: await oneDriveService.checkFilesExistence(req.user.userId, fileNames) });
  }));

  /**
   * Download a backup file
   * GET /api/backup/download/:fileName
   */
  router.get('/download/:fileName', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const backup = await backupService.findBackup(String(req.params.fileName));
    if (!backup) throw backupNotFound();

    // Opened before the headers are set: a backup deleted since it was listed (retention,
    // another admin) is a 404, not an 'error' on a stream nobody listens to.
    const fileStream = createReadStream(backup.filePath);
    await new Promise<void>((resolve, reject) => {
      fileStream.once('open', () => resolve());
      fileStream.once('error', reject);
    }).catch((err: unknown) => {
      logger.warn({ err, userId: req.user.userId, fileName: backup.fileName }, 'Backup file could not be opened for download');
      throw backupNotFound();
    });
    fileStream.on('error', (err) => {
      logger.error({ err, userId: req.user.userId, fileName: backup.fileName }, 'Backup download failed');
      res.destroy(err);
    });

    // Any backup file in the directory is listed, whatever its name.
    res.setHeader('Content-Disposition', contentDisposition('attachment', backup.fileName));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', backup.size.toString());
    fileStream.pipe(res);
  }));

  /**
   * Delete a backup file
   * DELETE /api/backup/:fileName
   */
  router.delete('/:fileName', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const fileName = String(req.params.fileName);
    // Only a file the backup listing has: mirrors the download route and blocks path
    // traversal (e.g. `../../etc/..`) reaching fs.unlink on an arbitrary path.
    if (!(await backupService.findBackup(fileName))) throw backupNotFound();
    await backupService.deleteBackup(fileName);
    logger.info({ userId: req.user.userId, fileName }, 'Backup deleted successfully');
    res.json({ success: true, message: 'Backup deleted successfully' });
  }));

  /**
   * Get backup scheduler status
   * GET /api/backup/status
   */
  router.get('/status', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const settings = await backupService.readSettings(['backup_enabled', 'backup_time']);
    res.json({
      configured: !!settings.backup_time,
      enabled: settings.backup_enabled === 'true',
      scheduler: await lifecycleService.getBackupSchedulerStatus(),
    });
  }));

  /**
   * Get backup settings
   * GET /api/backup/settings
   */
  router.get('/settings', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    // Only the editable settings: not the encrypted backup key or its download flag.
    const rows = await backupService.readEditableSettings(BACKUP_SETTING_KEYS);
    const settings: Record<string, { value: string | null; type: string | null; description: string | null }> = {};
    for (const row of rows) {
      settings[row.setting_key] = { value: row.setting_value, type: row.setting_type, description: row.description };
    }
    res.json({ settings });
  }));

  /**
   * Update backup settings: only BACKUP_SETTING_KEYS (backupSettingsUpdateSchema).
   * POST /api/backup/settings  Body: { settings }
   */
  router.post('/settings', validateBody(backupSettingsUpdateSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { settings } = req.body as { settings: BackupSettingsUpdate };
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) await backupService.saveBackupSetting(key, value);
    }

    // If scheduler settings were updated, restart the scheduler to pick up new configuration
    if ('backup_time' in settings || 'backup_enabled' in settings || 'backup_frequency_days' in settings) {
      try {
        logger.info({ userId: req.user.userId, updatedSettings: Object.keys(settings) }, 'Backup scheduler settings updated, restarting scheduler');
        await lifecycleService.updateBackupSchedulerConfiguration();
      } catch (error) {
        logger.error({ err: error, userId: req.user.userId }, 'Error updating backup scheduler configuration');
      }
    }

    res.json({ success: true, message: 'Settings updated successfully' });
  }));

  /**
   * Start backup scheduler
   * POST /api/backup/scheduler/start
   *
   * Start and stop save `backup_enabled` too, as the import scheduler's do. The scheduler
   * reads it when it starts and arms nothing when it is false; the page's switch used to
   * only stage it until a separate Save, so a restart could silently undo the switch.
   */
  router.post('/scheduler/start', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    await backupService.saveBackupSetting('backup_enabled', 'true');
    await lifecycleService.startBackupScheduler();
    logger.info({ userId: req.user.userId }, 'Backup scheduler started successfully');
    res.json({ success: true, message: 'Backup scheduler started successfully' });
  }));

  /**
   * Stop backup scheduler
   * POST /api/backup/scheduler/stop
   */
  router.post('/scheduler/stop', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    await backupService.saveBackupSetting('backup_enabled', 'false');
    await lifecycleService.stopBackupScheduler();
    logger.info({ userId: req.user.userId }, 'Backup scheduler stopped successfully');
    res.json({ success: true, message: 'Backup scheduler stopped successfully' });
  }));

  return router;
}

// Helper function to format file sizes
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
