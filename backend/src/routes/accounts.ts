import { Router } from 'express';
import multer from 'multer';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { requireOrgAdmin } from '../middleware/tenant.js';
import { answerInvalidBody, parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import {
  accountAdjustBalanceSchema,
  accountInstructionsSchema,
  type AccountInstructionsInput,
  accountBalanceHistoryQuery,
  accountCreateSchema,
  accountListQuery,
  accountRegisterQuery,
} from '@nuggets/shared';
import { imageFileFilter, IMAGE_UPLOAD_LIMITS } from '../utils/imageUpload.js';
import { createLogger } from '../utils/logger.js';
import {
  accountRegister,
  getAccount,
  getAccountBalance,
  getAccountBalanceHistory,
  listAccounts,
  zeroBalanceAudit,
} from '../services/accounts/AccountQueries.js';
import {
  AccountUpdateInvalidError,
  adjustAccountBalance,
  createAccount,
  deleteAccount,
  setAccountInstructions,
  updateAccount,
  type AccountImageUpload,
} from '../services/accounts/AccountService.js';
import {
  connectAccountToBank,
  disconnectAccountFromBank,
  updateAccountImportSettings,
} from '../services/accounts/AccountBankSettings.js';
import { refuseNulFields } from '../middleware/nulText.js';

const logger = createLogger({ service: 'AccountsRoute' });

/**
 * The account routes (/api/accounts). Each handler reads the request, calls the account
 * services (services/accounts/) and shapes the answer; the services hold the queries and
 * the rules, and refuse a request with an AccountError, which propagates to the route
 * wrapper (tenantHandler) to be answered.
 */

/** The uploaded image, if the request had one. */
const uploadedImage = (req: AuthenticatedRequest): AccountImageUpload | undefined =>
  req.file ? { mimeType: req.file.mimetype, data: req.file.buffer } : undefined;

// The account services take no pool: they run on the request's tenant transaction.
export function createAccountsRoutes(): Router {
  const router = Router();

  // Account images are stored in the DB (stored_images), so they ride the backup and
  // restore: buffer them in memory rather than writing to disk.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: IMAGE_UPLOAD_LIMITS,
    // Validate BOTH extension and MIME so a spoofed image/* MIME on an .html/.svg
    // file cannot be stored and later served as executable content (stored XSS).
    fileFilter: imageFileFilter
  });

  // Get all accounts
  router.get('/', validateQuery(accountListQuery), tenantHandler(async (req, res) => {
    const { include_hidden, exclude_closed, exclude_balance } = parsedQuery(req, accountListQuery);
    const accounts = await listAccounts({
      includeHidden: include_hidden,
      excludeClosed: exclude_closed,
      excludeBalance: exclude_balance,
    });
    res.status(200).json({ accounts });
  }));

  // Zero-balance / adjustment audit for a budget period (Close-Out), computed on the
  // server. MUST be registered before `/:uuid` so "zero-balance" is not captured as an
  // account uuid.
  router.get('/zero-balance/:periodUuid', tenantHandler(async (req, res) => {
    res.status(200).json(await zeroBalanceAudit(String(req.params.periodUuid)));
  }));

  // Get single account by UUID
  router.get('/:uuid', tenantHandler(async (req, res) => {
    res.status(200).json(await getAccount(String(req.params.uuid)));
  }));

  // Create new account. The body is validated and coerced by accountCreateSchema (shared):
  // required fields, enums, defaults, and FormData boolean/number coercion.
  router.post('/', upload.single('account_image'), refuseNulFields, validateBody(accountCreateSchema), tenantHandler(async (req, res) => {
    res.status(201).json(await createAccount(req.body, uploadedImage(req), req.user.userId));
  }));

  /**
   * PUT /api/accounts/:uuid/instructions
   * Narrow endpoint that only updates the `instructions` field. Distinct from
   * the full PUT below, which requires name/account_type/account_group.
   * Designed for the MCP server, so an AI agent can record per-account context
   * without having to re-send every other field.
   */
  router.put('/:uuid/instructions', validateBody(accountInstructionsSchema), tenantHandler(async (req, res) => {
    const { instructions } = req.body as AccountInstructionsInput;
    res.json(await setAccountInstructions(String(req.params.uuid), instructions));
  }));

  // Update existing account (including hiding and closing it, and replacing its image).
  router.put('/:uuid', upload.single('account_image'), refuseNulFields, tenantHandler(async (req, res) => {
    const uuid = String(req.params.uuid);
    logger.info({ uuid, hasFile: !!req.file }, 'Updating account');
    try {
      res.status(200).json(await updateAccount(uuid, req.body, uploadedImage(req), req.user.userId));
    } catch (err) {
      if (!(err instanceof AccountUpdateInvalidError)) throw err;
      answerInvalidBody(req, res, err.zodError);
    }
  }));

  // Delete account
  router.delete('/:uuid', tenantHandler(async (req, res) => {
    const { name } = await deleteAccount(String(req.params.uuid));
    res.json({
      message: 'Account deleted successfully',
      details: `Account "${name}" and all associated records have been permanently deleted.`
    });
  }));

  // Get account balance history (month-end balances from the transactions): `limit`
  // points, 12 by default, at most 120.
  router.get('/:uuid/balance-history', validateQuery(accountBalanceHistoryQuery), tenantHandler(async (req, res) => {
    const { limit } = parsedQuery(req, accountBalanceHistoryQuery);
    res.json(await getAccountBalanceHistory(String(req.params.uuid), limit));
  }));

  // Get the current balance of an account (calculate_account_balance).
  // null + balance_unavailable when it can't be computed, never a silent $0.
  router.get('/:uuid/balance', tenantHandler(async (req, res) => {
    res.json(await getAccountBalance(String(req.params.uuid)));
  }));

  // Manual balance adjustment: ONE "balance adjustment" transaction makes the account's
  // balance the target the member entered.
  router.post('/:uuid/adjust-balance', validateBody(accountAdjustBalanceSchema), tenantHandler(async (req, res) => {
    const { targetBalance } = req.body as { targetBalance: unknown };
    res.json(await adjustAccountBalance(String(req.params.uuid), targetBalance, req.user.userId));
  }));

  // Get account transactions with pagination and search
  router.get('/:uuid/transactions', validateQuery(accountRegisterQuery), tenantHandler(async (req, res) => {
    const { page, limit, ...filters } = parsedQuery(req, accountRegisterQuery);
    const { transactions, total } = await accountRegister(String(req.params.uuid), filters, { page, limit, offset: (page - 1) * limit });
    res.json({
      transactions,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  }));

  // Connect account to bank. Org admins only: the bank accounts come from the
  // organization's SimpleFin connection, which covers every ledger in it.
  router.post('/:uuid/connect-bank', requireOrgAdmin, tenantHandler(async (req, res) => {
    const { import_account_id } = req.body;
    if (!import_account_id) {
      res.status(400).json({ error: 'Import account ID is required' });
      return;
    }
    await connectAccountToBank(String(req.params.uuid), import_account_id);
    res.json({ success: true });
  }));

  // Update import settings for account
  router.patch('/:uuid/import-settings', tenantHandler(async (req, res) => {
    await updateAccountImportSettings(String(req.params.uuid), req.body);
    res.json({ success: true });
  }));

  // Disconnect account from bank
  router.post('/:uuid/disconnect-bank', tenantHandler(async (req, res) => {
    await disconnectAccountFromBank(String(req.params.uuid));
    res.json({ success: true });
  }));

  return router;
}
