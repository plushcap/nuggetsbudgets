import { Router, Response } from 'express';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import {
  transactionCreateSchema,
  bulkTransactionsCreateSchema,
  transactionBulkUpdateSchema,
  transactionListQuerySchema,
  transactionPageQuerySchema,
  transactionSplitSchema,
  transactionUpdateSchema,
  type BulkTransactionsCreateInput,
  type TransactionBulkUpdateInput,
  type TransactionCreateInput,
  type TransactionSplitInput,
  type TransactionUpdateInput,
} from '@nuggets/shared';
import { bodyKeys, createLogger } from '../utils/logger.js';
import { toCents } from '../utils/money.js';
import {
  addTransactionTag,
  bulkCreateTransactions,
  bulkUpdateTransactions,
  createTransaction,
  deleteTransaction,
  getTransactionDetail,
  listTransactionAttachments,
  listTransactions,
  listTransactionsPage,
  removeTransactionTag,
  splitTransaction,
  unsplitTransaction,
  updateTransaction,
  type SplitInput,
} from '../services/transactions/index.js';

/**
 * /api/transactions. Each handler reads and checks its input, calls the transactions
 * service (services/transactions/), and shapes the answer; a refusal the service
 * throws (a TransactionRefusal, a 409 TRANSACTION_BUSY) and any other error propagate
 * to the route wrapper, which answers them. The handler runs in the request's tenant
 * transaction, which an answer of 400 or more, or an error, rolls back.
 */

const logger = createLogger({ service: 'TransactionsRoute' });

export function createTransactionsRoutes(): Router {
  const router = Router();

  // Get all transactions with optional filtering (at most TRANSACTION_LIST_MAX of them).
  // Number and date filters are checked first: a value that isn't one is 400.
  router.get('/', validateQuery(transactionListQuerySchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { limit, ...filters } = parsedQuery(req, transactionListQuerySchema);
    const { rows, truncated } = await listTransactions(filters, limit);

    // The body stays a plain array, so a truncated list says so in a header,
    // and the log shows a caller that needs filters or pagination.
    if (truncated) {
      res.setHeader('X-Result-Truncated', 'true');
      logger.warn(
        { limit, filters: bodyKeys(req.query) },
        'GET /transactions hit the row cap; result may be truncated — caller should add filters or use /paginated',
      );
    }
    res.json(rows);
  }));

  // One page of transactions (the transactions and tasks pages)
  router.get('/paginated', validateQuery(transactionPageQuerySchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { page, limit, ...filters } = parsedQuery(req, transactionPageQuerySchema);
    const { transactions, total } = await listTransactionsPage(filters, limit, (page - 1) * limit);
    res.json({
      transactions,
      pagination: { total, totalPages: Math.ceil(total / limit), page, limit },
    });
  }));

  // Get transaction by UUID
  router.get('/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const transaction = await getTransactionDetail(String(req.params.uuid));
    if (!transaction) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }
    res.json(transaction);
  }));

  // Apply tag to transaction
  router.post('/:uuid/tags/:tagUuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    await addTransactionTag(String(req.params.uuid), String(req.params.tagUuid));
    res.json({ success: true });
  }));

  // Remove tag from transaction
  router.delete('/:uuid/tags/:tagUuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    await removeTransactionTag(String(req.params.uuid), String(req.params.tagUuid));
    res.json({ success: true });
  }));

  // Bulk update transactions (review status, envelope, assignee) - MUST come before :uuid route
  router.put('/bulk', validateBody(transactionBulkUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { transactionUuids, updates } = req.body as TransactionBulkUpdateInput;
    res.json(await bulkUpdateTransactions(transactionUuids, updates));
  }));

  // Update transaction by UUID. The body is checked by transactionUpdateSchema: a
  // date that wasn't a real day, or a field of the wrong kind, reached the UPDATE (a 500).
  router.put('/:uuid', validateBody(transactionUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await updateTransaction(String(req.params.uuid), req.body as TransactionUpdateInput));
  }));

  // Create transaction
  router.post('/', validateBody(transactionCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const transaction = await createTransaction(req.body as TransactionCreateInput);
    res.status(201).json({ message: 'Transaction created successfully', transaction });
  }));

  // Bulk-create transactions (agent-driven statement/CSV backfill): see bulkCreateTransactions.
  router.post('/bulk', validateBody(bulkTransactionsCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await bulkCreateTransactions(req.body as BulkTransactionsCreateInput);
    res.status(result.dry_run ? 200 : 201).json(result);
  }));

  // Delete transaction
  router.delete('/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    await deleteTransaction(String(req.params.uuid));
    res.json({ message: 'Transaction deleted successfully' });
  }));

  // Get attachments for a transaction
  router.get('/:uuid/attachments', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const attachments = await listTransactionAttachments(String(req.params.uuid));
    if (!attachments) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }
    res.json({ attachments });
  }));

  // Split a transaction into multiple budget allocations (or re-split one). The body is
  // checked by transactionSplitSchema: two splits or more, each amount whole cents.
  router.post('/:uuid/split', validateBody(transactionSplitSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { splits } = req.body as TransactionSplitInput;
    const splitCents = splits.map((split) => {
      const cents = toCents(split.amount);
      // transactionSplitSchema refuses an amount toCents can't read.
      if (cents === null) throw new Error('A split amount passed the schema but is not whole cents');
      return cents;
    });
    res.json(await splitTransaction(String(req.params.uuid), splits as SplitInput[], splitCents));
  }));

  // Unsplit a transaction (remove all children and restore parent)
  router.delete('/:uuid/unsplit', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await unsplitTransaction(String(req.params.uuid)));
  }));

  return router;
}
