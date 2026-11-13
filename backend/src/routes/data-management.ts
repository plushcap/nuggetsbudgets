import { Router, Response, type NextFunction } from 'express';
import { tenantHandler, tenantNetworkHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { createLogger } from '../utils/logger.js';
import { validateBody } from '../middleware/validate.js';
import {
  transactionRangeDeleteSchema,
  transactionRangePreviewSchema,
  type TransactionRangeDeleteInput,
  type TransactionRangePreviewInput,
} from '@nuggets/shared';
import { DomainError } from '../services/domainErrors.js';
import { BackupInProgressError, ShuttingDownError, type BackupService } from '../services/BackupService.js';
import { checkRangeUnchanged, deleteRange, previewRangeDeletion } from '../services/transactions/rangeDeletion.js';
import type { RouteDependencies } from './dependencies.js';
import { isDeploymentAdminRequest, type TenantRequest } from '../middleware/tenant.js';

const logger = createLogger({ service: 'DataManagementRoutes' });

/**
 * "Back up first" (createBackup) runs BackupService.createBackup(): a pg_dump of every
 * tenant on the server, added to the deployment's backup list. Only a deployment admin may
 * make one, as the backup routes do (requireDeploymentAdmin), so a request for one from
 * anyone else is refused here, before the body is checked or anything runs. Without
 * it, a tenant admin still deletes.
 */
async function requireDeploymentAdminForBackup(req: TenantRequest, res: Response, next: NextFunction) {
  if (!(req.body as { createBackup?: unknown } | undefined)?.createBackup) return next();
  // A failed check is the global error handler's (logged, 500 INTERNAL_ERROR), as any other.
  let isDeploymentAdmin: boolean;
  try {
    isDeploymentAdmin = await isDeploymentAdminRequest(req);
  } catch (err) {
    next(err);
    return;
  }
  if (isDeploymentAdmin) return next();
  logger.warn({ userId: req.user?.userId }, 'Backup before deletion refused: not a deployment admin');
  res.status(403).json({
    error: 'Only a deployment admin can create a backup: it holds every tenant on this server. Delete without one, or ask a deployment admin to back up first.',
    code: 'BACKUP_REQUIRES_DEPLOYMENT_ADMIN',
  });
}

/** The backup a deletion asked for failed: no deletion without it. Answered 500, saying so. */
class BackupBeforeDeletionFailed extends Error {}

/**
 * The backup before a deletion; its file's name. No backup can start when the server is
 * shutting down (503 SHUTTING_DOWN) or another backup or restore is running (409
 * BACKUP_IN_PROGRESS): refused as the backup routes refuse them, so a client can tell "try
 * again later" from a failure. Any other failure is a {@link BackupBeforeDeletionFailed}.
 */
async function backupBeforeDeletion(backupService: BackupService, userId: number): Promise<string> {
  try {
    logger.info('Creating backup before deletion');
    const { fileName } = await backupService.createBackup({ trigger: 'before-deletion', startedBy: userId });
    logger.info({ backupFileName: fileName }, 'Backup created successfully');
    return fileName;
  } catch (backupError) {
    if (backupError instanceof ShuttingDownError || backupError instanceof BackupInProgressError) {
      logger.warn({ code: backupError.code }, 'No backup could start - blocking deletion');
      throw new DomainError(backupError.status, backupError.code, `${backupError.message.replace(/\.$/, '')}. Deletion has been blocked for safety.`);
    }
    logger.error({ err: backupError }, 'Backup creation failed - blocking deletion');
    throw new BackupBeforeDeletionFailed('Backup creation failed', { cause: backupError });
  }
}

export function createDataManagementRoutes({ backupService }: Pick<RouteDependencies, 'backupService'>): Router {
  const router = Router();

  /**
   * Preview transaction deletion: what would be deleted, without making changes, and the
   * selectionKey the deletion sends back.
   */
  router.post('/preview-delete-transactions', validateBody(transactionRangePreviewSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const range = req.body as TransactionRangePreviewInput;
    logger.info({ dateFrom: range.dateFrom, dateTo: range.dateTo, excludeBudgetPeriod: range.excludeBudgetPeriod }, 'Previewing transaction deletion');
    res.json({ success: true, ...(await previewRangeDeletion(range)) });
  }));

  /**
   * Delete transactions by date range: exactly the ones the preview found (its
   * selectionKey), or none. Creates a backup first if requested (a deployment admin only:
   * requireDeploymentAdminForBackup).
   *
   * No transaction is open while the backup runs (tenantNetworkHandler): it takes as long
   * as pg_dump does, and the range's rows locked meanwhile made an edit, a bank sync or an
   * import that touched one wait for it, then fail at lock_timeout. The check, and then the
   * locks and the deletion, each run in a short withTenant transaction of their own
   * (services/transactions/rangeDeletion.ts).
   */
  router.post(
    '/delete-transactions',
    requireDeploymentAdminForBackup,
    validateBody(transactionRangeDeleteSchema),
    tenantNetworkHandler(async (req: AuthenticatedRequest, res: Response, tenantId: number) => {
      const { selectionKey, createBackup, ...range } = req.body as TransactionRangeDeleteInput;
      logger.info({ dateFrom: range.dateFrom, dateTo: range.dateTo, excludeBudgetPeriod: range.excludeBudgetPeriod, createBackup }, 'Starting transaction deletion');

      // Step 1: the set must be the one the preview found, as it was then, before any backup.
      const candidates = await checkRangeUnchanged(tenantId, range, selectionKey);

      // Step 2: the backup, if asked for.
      let backupFileName: string | undefined;
      if (createBackup) {
        try {
          backupFileName = await backupBeforeDeletion(backupService, req.user.userId);
        } catch (err) {
          if (!(err instanceof BackupBeforeDeletionFailed)) throw err;
          // A refusal written for people (no backup key yet) says so; anything else is in the log.
          const cause = err.cause;
          res.status(500).json({
            error: 'Backup creation failed. Deletion has been blocked for safety.',
            ...(cause instanceof DomainError ? { message: `Backup creation failed: ${cause.message.replace(/\.$/, '')}. Deletion has been blocked for safety.` } : {}),
          });
          return;
        }
      }

      // Steps 3-5: lock, check again, delete; answered once the deletion has committed.
      const deleted = await deleteRange(tenantId, range, selectionKey, candidates);
      res.json({ success: true, ...deleted, backupCreated: !!backupFileName, backupFileName });
    })
  );

  return router;
}
