import { Router, Response } from 'express';
import { escapeCsvValue, exportDateRangeQuery } from '@nuggets/shared';
import { tenantNetworkHandler, type AuthenticatedRequest } from '../utils/routeHandler.js';
import { createLogger } from '../utils/logger.js';
import { parsedQuery, validateQuery } from '../middleware/validate.js';
import { contentDisposition } from '../utils/uploadSafety.js';
import { ExportService, type CsvExport, type DayRange } from '../services/export/ExportService.js';

/**
 * CSV exports of the active ledger's data (the Data Export page, and the merchants export
 * on the merchant page). What each reads is ExportService's; this writes it.
 *
 * Mounted in routes.ts behind authenticateToken, resolveTenant and requireTenantMember.
 * Each route is a tenantNetworkHandler: the service reads in short transactions of the
 * ledger's, and none is open while the client takes what was read. An error before
 * the download starts is answered (a 404, a 500); one after it cuts the connection.
 *
 * Each export streams: see {@link streamCsv}.
 */

const logger = createLogger({ service: 'ExportRoute' });

/** Wait until the client has taken what was written so far, or has gone. */
function drained(res: Response): Promise<void> {
  // Gone already: 'close' has been and won't come again, nor will 'drain'.
  if (res.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * Stream an export as a CSV download with exactly its columns, in their order.
 *
 * Each batch of rows is written before the next is read, waiting while the client catches
 * up. So an export of any size holds one batch in memory. Each batch is read in a
 * transaction of its own (ExportService), so no transaction, nor its pool connection, waits
 * on the client. The status and headers go out with the first batch; a failure after
 * that cuts the connection, so a client never takes a truncated file for a whole one.
 */
async function streamCsv(res: Response, { filename, headers, batches }: CsvExport): Promise<void> {
  try {
    await writeCsv(res, filename, headers, batches);
  } catch (err) {
    // A download already under way: its status has gone, so cut it (the wrapper logs it).
    if (res.headersSent) res.destroy();
    throw err;
  }
}

async function writeCsv(res: Response, filename: string, headers: CsvExport['headers'], batches: CsvExport['batches']): Promise<void> {
  const csvLine = (row: Record<string, unknown>) => headers.map((h) => escapeCsvValue(row[h])).join(',');
  let rowCount = 0;
  let first = true;
  for await (const rows of batches) {
    if (first) {
      first = false;
      // A header the query doesn't select would export as an empty column; fail instead.
      const missing = rows.length > 0 ? headers.filter((h) => !(h in rows[0]!)) : [];
      if (missing.length > 0) throw new Error(`Export columns not selected by the query: ${missing.join(', ')}`);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', contentDisposition('attachment', filename));
      res.write(`${headers.join(',')}\n`);
    }
    if (rows.length === 0) continue;
    // Lines are separated, not terminated, by a newline, as rowsToCsv writes them.
    const chunk = `${rowCount > 0 ? '\n' : ''}${rows.map(csvLine).join('\n')}`;
    rowCount += rows.length;
    if (!res.write(chunk)) await drained(res);
    if (res.destroyed) {
      logger.info({ rowCount, filename }, 'Export stopped: the client went away');
      return;
    }
  }
  res.end();
  logger.info({ rowCount, filename }, 'Export completed');
}

/** The range the query asked for (exportDateRangeQuery): either end may be open. */
function dayRange(req: AuthenticatedRequest): DayRange {
  const { start_date: start, end_date: end } = parsedQuery(req, exportDateRangeQuery);
  return { ...(start !== undefined && { start }), ...(end !== undefined && { end }) };
}

/**
 * The active ledger's data as CSV (/api/export): transactions, an account's transactions,
 * budget items, accounts and merchants, streamed. Mounted behind authenticateToken,
 * resolveTenant and requireTenantMember.
 */
export function createExportRoutes(): Router {
  const router = Router();
  const service = new ExportService();

  // GET /api/export/transactions?start_date&end_date - every transaction, newest first
  router.get('/transactions', validateQuery(exportDateRangeQuery), tenantNetworkHandler(async (req: AuthenticatedRequest, res: Response, tenantId) => {
    await streamCsv(res, await service.transactions(tenantId, dayRange(req)));
  }));

  // GET /api/export/account-transactions/:accountUuid?start_date&end_date - one account's
  // transactions, newest first, with the balance after each
  router.get('/account-transactions/:accountUuid', validateQuery(exportDateRangeQuery), tenantNetworkHandler(async (req: AuthenticatedRequest, res: Response, tenantId) => {
    const accountUuid = typeof req.params.accountUuid === 'string' ? req.params.accountUuid : '';
    await streamCsv(res, await service.accountTransactions(tenantId, accountUuid, dayRange(req)));
  }));

  // GET /api/export/budget-items - every budget item, with its uuid for import mapping
  router.get('/budget-items', tenantNetworkHandler(async (_req: AuthenticatedRequest, res: Response, tenantId) => {
    await streamCsv(res, await service.budgetItems(tenantId));
  }));

  // GET /api/export/accounts - every account (hidden and closed too), with its ledger and bank balances
  router.get('/accounts', tenantNetworkHandler(async (_req: AuthenticatedRequest, res: Response, tenantId) => {
    await streamCsv(res, await service.accounts(tenantId));
  }));

  // GET /api/export/merchants - every merchant with its transaction totals and matching rules
  router.get('/merchants', tenantNetworkHandler(async (_req: AuthenticatedRequest, res: Response, tenantId) => {
    await streamCsv(res, await service.merchants(tenantId));
  }));

  return router;
}
