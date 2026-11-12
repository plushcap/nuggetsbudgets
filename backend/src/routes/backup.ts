import { Router, Response, type RequestHandler } from 'express';
import multer from 'multer';
import {
  BACKUP_SETTING_KEYS,
  backupListQuery,
  backupOneDriveStatusRequestSchema,
  backupRestoreRequestSchema,
  backupSettingsUpdateSchema,
  type BackupRestoreRequest,
  type BackupSettingsUpdate,
} from '@nuggets/shared';
import { BackupService, BackupInProgressError, ShuttingDownError } from '../services/BackupService.js';
import { backupNotFound, noBackupFile, noBackupKey } from '../services/backup/errors.js';
import { getRestoreStatus, startRestoreJob } from '../services/restoreJob.js';
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
 * requireDeploymentAdmin: making, listing, downloading, deleting and restoring them, their
 * schedule and key, and copying them to OneDrive. A refusal (no such backup, one already
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
      if (file.originalname.endsWith('.enc')) {
        cb(null, true);
      } else {
        cb(new UploadRejectedError('Only .enc backup files are allowed'));
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

  /**
   * Backup-encryption-key management (admin-only via the router mount).
   *
   * K is the key backups are encrypted with — separate from the Docker secret,
   * stored in system_settings encrypted with that secret. The user downloads a
   * copy to keep for disaster recovery / cross-server restore.
   */

  // Whether a backup key exists and whether it has been downloaded yet.
  router.get('/key/status', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await backupService.getBackupKeyStatus());
  }));

  // Generate (or rotate) the backup key. The plaintext never comes back here — it
  // only leaves via GET /key/download. Rotating does not re-encrypt old backups.
  router.post('/key/generate', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    await backupService.generateBackupKey();
    logger.warn({ userId: req.user.userId }, 'Backup encryption key generated/rotated');
    // Automatic backups wait for a key; with one now, the scheduler can arm. One already
    // armed keeps its schedule: restarting it mid-backup would queue another.
    try {
      if ((await lifecycleService.getBackupSchedulerStatus()).waitingForBackupKey) {
        await lifecycleService.updateBackupSchedulerConfiguration();
      }
    } catch (error) {
      logger.error({ err: error, userId: req.user.userId }, 'Error restarting the backup scheduler after generating a key');
    }
    res.json({ success: true });
  }));

  // Download the current backup key as a .txt file (and mark it downloaded).
  router.get('/key/download', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const key = await backupService.getBackupKeyForDownload();
    if (!key) throw noBackupKey();
    logger.info({ userId: req.user.userId }, 'Backup encryption key downloaded');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', contentDisposition('attachment', 'nuggets-backup-key.txt'));
    res.setHeader('Cache-Control', 'no-store');
    res.send(key);
  }));

  /**
   * Start a restore in the background and answer 202. Another backup or restore running
   * (409) or a shutdown begun (503) throws, answered by the route wrapper.
   */
  function startRestore(
    req: AuthenticatedRequest,
    res: Response,
    input: { filePath: string; fileName: string; key: string | null; deleteAfter: boolean }
  ): void {
    startRestoreJob({ backupService, schedulers: lifecycleService }, { ...input, userId: req.user.userId });
    res.locals.restoreStarted = true;
    logger.info({ userId: req.user.userId, fileName: input.fileName, usingCustomKey: input.key !== null }, 'Restore started');
    res.status(202).json({ success: true, started: true, message: 'Restore started' });
  }

  /**
   * Restore an uploaded backup, in the background: 202, then poll
   * GET /api/backup/restore-status. The restore takes minutes, longer than a reverse proxy
   * waits, and the server is in maintenance mode while it runs.
   * POST /api/backup/restore (multipart: backup, and optionally encryptionKey: without it,
   * this server's backup key)
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
      const { encryptionKey } = req.body as BackupRestoreRequest;
      startRestore(req, res, {
        filePath: req.file.path,
        fileName: req.file.originalname,
        key: encryptionKey?.trim() || null,
        deleteAfter: true,
      });
    })
  );

  /**
   * Restore one of the backups in the server's backup directory, by its listed name: no
   * upload, so no size limit. In the background, like POST /restore.
   * POST /api/backup/restore/:fileName  Body: { encryptionKey?: string }
   */
  router.post('/restore/:fileName', refuseWhileShuttingDown, validateBody(backupRestoreRequestSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { encryptionKey } = req.body as BackupRestoreRequest;
    const backup = await backupService.findBackup(String(req.params.fileName));
    if (!backup) throw backupNotFound();
    startRestore(req, res, {
      filePath: backup.filePath,
      fileName: backup.fileName,
      key: encryptionKey?.trim() || null,
      deleteAfter: false,
    });
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
        onedriveUploaded: onedriveStatus[backup.fileName] || false
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

    // Any .enc file in the directory is listed, whatever its name.
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
