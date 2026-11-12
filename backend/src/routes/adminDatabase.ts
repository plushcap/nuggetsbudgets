import { Router, type Response } from 'express';
import { authHandler, type AuthenticatedRequest } from '../utils/routeHandler.js';
import { createLogger } from '../utils/logger.js';
import { sendError } from '../utils/apiError.js';
import {
  appliedMigrations,
  downloadFileName,
  migrationsListing,
  SchemaDumpError,
  streamSchemaDump,
} from '../services/databaseDiagnostics.js';
import { contentDisposition } from '../utils/uploadSafety.js';
import { runningPgTools } from '../utils/pgTools.js';

const logger = createLogger({ service: 'AdminDatabaseRoute' });

/**
 * Settings → Utilities: the database's schema and the migrations it has applied,
 * as downloads, for a report when a migration fails on upgrade. Mounted at
 * /api/admin/database behind authenticateToken, requireDeploymentAdmin and
 * requireInteractiveSession (routes.ts), so only a deployment admin in a signed-in browser
 * reaches them, never a personal access token. Neither file holds a ledger's rows; the
 * log gets the request's ids and sizes, never the files.
 */
export function createAdminDatabaseRoutes(): Router {
  const router = Router();
  // One schema dump at a time in this process, from the request until its pg_dump has
  // exited (a stopped one can take a few seconds to): each holds a database connection
  // and a lock on every table while it reads the catalog.
  let dumping = false;

  /** GET /api/admin/database/schema: `pg_dump --schema-only`, streamed. */
  router.get('/schema', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    // Express answers HEAD with the GET route; a link checker's HEAD shouldn't run pg_dump.
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Download the schema with GET');
      return;
    }
    if (dumping || runningPgTools('download') > 0) {
      sendError(res, 409, 'SCHEMA_EXPORT_IN_PROGRESS', 'A schema download is already running. Try again when it has finished.');
      return;
    }
    dumping = true;
    try {
      const fileName = await downloadFileName('schema');
      const { bytes } = await streamSchemaDump(res, fileName);
      logger.info({ bytes }, 'Database schema downloaded');
    } catch (err) {
      if (err instanceof SchemaDumpError && err.reason === 'aborted') {
        logger.warn({ err }, 'Database schema download cancelled by the client');
        return;
      }
      const shuttingDown = err instanceof SchemaDumpError && err.reason === 'shutdown';
      if (shuttingDown) logger.warn({ err }, 'Database schema download stopped: the server is shutting down');
      else logger.error({ err }, 'Database schema download failed');
      // Part of the file went out: streamSchemaDump has cut the connection, so the
      // browser's download fails instead of saving a cut-off file.
      if (res.headersSent) return;
      if (shuttingDown) {
        sendError(res, 503, 'SHUTTING_DOWN', 'The server is shutting down. Download the schema again once it has restarted.');
      } else {
        sendError(res, 500, 'SCHEMA_EXPORT_FAILED', "The database schema couldn't be exported. The server log has the details.");
      }
    } finally {
      dumping = false;
    }
  }));

  /** GET /api/admin/database/migrations: the rows of schema_migrations, as SQL. */
  router.get('/migrations', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const [fileName, migrations] = await Promise.all([downloadFileName('migrations'), appliedMigrations()]);
    const listing = migrationsListing(migrations);
    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', contentDisposition('attachment', fileName));
    res.setHeader('Cache-Control', 'no-store');
    res.send(listing);
    logger.info({ migrations: migrations?.length ?? null }, 'Applied migrations downloaded');
  }));

  return router;
}
