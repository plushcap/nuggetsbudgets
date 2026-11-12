import type { NextFunction, Request, Response } from 'express';
import { isRestoreRunning } from '../services/restoreJob.js';
import { sendError } from '../utils/apiError.js';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Maintenance mode while a backup is restored: a request that would change
 * something gets a 503, since the restore replaces the data it would write to. Reads still
 * work (they see the data from before until the restore swaps it in), so the Backup page
 * can follow the restore with GET /api/backup/restore-status.
 */
export function restoreMaintenanceGate(req: Request, res: Response, next: NextFunction): void {
  if (READS.has(req.method) || !isRestoreRunning()) {
    next();
    return;
  }
  res.setHeader('Retry-After', '30');
  sendError(res, 503, 'RESTORE_IN_PROGRESS', 'A backup is being restored. Nothing can be changed until it has finished.', {
    success: false,
  });
}
