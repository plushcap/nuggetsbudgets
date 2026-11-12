import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import {
  merchantApplyRulesSchema,
  merchantCreateSchema,
  merchantListQuery,
  merchantDeleteSchema,
  merchantMergeSchema,
  merchantPageQuery,
  merchantRuleCreateSchema,
  merchantSearchQuery,
  merchantUpdateSchema,
  type MerchantApplyRulesInput,
  type MerchantDeleteInput,
  type MerchantMergeInput,
} from '@nuggets/shared';
import { createLogger } from '../utils/logger.js';
import { answerMalformedId, hasMalformedId } from '../middleware/routeParams.js';
import { imageFileFilter, IMAGE_UPLOAD_LIMITS } from '../utils/imageUpload.js';
import { answerInvalidPattern } from '../utils/userRegex.js';
import { MerchantService } from '../services/merchants/MerchantService.js';
import { MerchantRuleService, MERCHANT_RULE_METHODS } from '../services/merchants/MerchantRuleService.js';
import { refuseNulFields } from '../middleware/nulText.js';

const logger = createLogger({ service: 'MerchantsRoute' });

const MAX_NAME_LENGTH = 255;

const NAME_TOO_LONG = { error: 'Invalid input', message: 'Merchant name must be 255 characters or less' };

// Merchant images are stored in the database (stored_images), so they ride the backup:
// buffer in memory, don't write to disk. Both the extension and the MIME type are
// checked, so a spoofed image/* MIME on an .html/.svg file can't be stored and served.
const merchantImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: IMAGE_UPLOAD_LIMITS,
  fileFilter: imageFileFilter,
});

/**
 * The 400 for a rule body without a method or text, or with an unknown method or a
 * regex that could stall the server; answered, true, when it is one.
 */
function answerInvalidRule(res: Response, method: unknown, matchingText: unknown): boolean {
  if (!method || !matchingText) {
    res.status(400).json({ error: 'Missing required fields', message: 'Method and matching text are required' });
    return true;
  }
  if (!(MERCHANT_RULE_METHODS as readonly unknown[]).includes(method)) {
    res.status(400).json({ error: 'Invalid method', message: 'Method must be one of: ' + MERCHANT_RULE_METHODS.join(', ') });
    return true;
  }
  return answerInvalidPattern(res, method, matchingText);
}

/**
 * A rule body (POST /:uuid/rules, PUT /rules/:uuid): first the answers these routes have
 * always given (answerInvalidRule), then merchantRuleCreateSchema, the rules form's own
 * schema, for the rest: text that isn't a string, or is blank. A path that names
 * nothing is the 404 first, as validateBody answers it.
 */
const ruleBody = [
  (req: Request, res: Response, next: NextFunction): void => {
    if (hasMalformedId(res)) {
      answerMalformedId(res);
      return;
    }
    const { method, matching_text } = (req.body ?? {}) as { method?: unknown; matching_text?: unknown };
    if (answerInvalidRule(res, method, matching_text)) return;
    next();
  },
  validateBody(merchantRuleCreateSchema),
];

/**
 * The merchant routes: merchants (lists, search, CRUD, merging, images) and their
 * matching rules (CRUD, preview and apply). The handlers check the request (the shared
 * merchant schemas), call the services in services/merchants/ and shape the answer; the
 * services' refusals (MerchantError) are answered by the route wrapper.
 */
export function createMerchantsRoutes(): Router {
  const router = Router();
  const merchants = new MerchantService();
  const rules = new MerchantRuleService();

  // ?fields=lite answers id, uuid, name and website only, without the transaction and
  // rule counts, which join the whole transactions table: enough for a selector.
  router.get('/', validateQuery(merchantListQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await merchants.list(parsedQuery(req, merchantListQuery).fields === 'lite'));
  }));

  // A page of merchants, optionally searched by name, website and notes. A page or limit
  // below 1 made a negative OFFSET or LIMIT, a 500: queryPage bounds them.
  router.get('/paginated', validateQuery(merchantPageQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { page, limit, search, fields } = parsedQuery(req, merchantPageQuery);
    const { merchants: rows, total } = await merchants.listPage({
      search: search ?? '',
      limit,
      offset: (page - 1) * limit,
      lite: fields === 'lite',
    });
    res.json({ merchants: rows, pagination: { total, totalPages: Math.ceil(total / limit), page, limit } });
  }));

  // Autocomplete by name.
  router.get('/search', validateQuery(merchantSearchQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { q } = parsedQuery(req, merchantSearchQuery);
    res.json(q === undefined || q.trim().length === 0 ? [] : await merchants.search(q));
  }));

  router.get('/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await merchants.find(String(req.params.uuid)));
  }));

  // merchantCreateSchema checks the name and that the website is an http(s) URL.
  router.post('/', validateBody(merchantCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { name, merchant_website, merchant_accountid, merchant_image, notes, instructions, transaction_auto_tag_id } = req.body;
    if (name.length > MAX_NAME_LENGTH) {
      res.status(400).json(NAME_TOO_LONG);
      return;
    }
    res.status(201).json(await merchants.create({
      name, merchant_website, merchant_accountid, merchant_image, notes, instructions, transaction_auto_tag_id,
    }));
  }));

  // merchantUpdateSchema: merchant_website is an http(s) URL, as on create.
  router.put('/:uuid', validateBody(merchantUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const uuid = String(req.params.uuid);
    const { name, merchant_website, merchant_accountid, merchant_image, notes, instructions, transaction_auto_tag_id } = req.body;

    logger.info({ uuid }, 'Updating merchant');
    if (!name) {
      logger.warn({ uuid }, 'Merchant update failed: name is required');
      res.status(400).json({ error: 'Missing required fields', message: 'Name is required' });
      return;
    }
    if (name.length > MAX_NAME_LENGTH) {
      logger.warn({ uuid, nameLength: name.length }, 'Merchant update failed: name too long');
      res.status(400).json(NAME_TOO_LONG);
      return;
    }

    res.json(await merchants.update(uuid, {
      name, merchant_website, merchant_accountid, merchant_image, notes, instructions, transaction_auto_tag_id,
    }));
  }));

  // A merchant in use needs a replacement (by uuid) that takes over its uses. A DELETE
  // usually has no body, which Express 5 leaves undefined where no parser ran (the schema
  // reads that as none).
  router.delete('/:uuid', validateBody(merchantDeleteSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { replacementMerchantId } = req.body as MerchantDeleteInput;
    await merchants.remove(String(req.params.uuid), replacementMerchantId ?? null);
    res.status(204).send();
  }));

  // Merges this merchant (deleted) into targetMerchantUuid's (kept).
  router.post('/:uuid/merge', validateBody(merchantMergeSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { targetMerchantUuid } = req.body as MerchantMergeInput;
    await merchants.merge(String(req.params.uuid), targetMerchantUuid);
    res.json({ message: 'Merchants merged successfully', targetMerchantUuid });
  }));

  router.post('/:uuid/upload-image', merchantImageUpload.single('merchant_image'), refuseNulFields, tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const merchant = await merchants.replaceImage(String(req.params.uuid), req.file, req.user?.userId ?? null);
    res.json({ message: 'Image uploaded successfully', merchant });
  }));

  // ============================================================================
  // MATCHING RULES
  // ============================================================================

  router.get('/:uuid/rules', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await rules.list(String(req.params.uuid)));
  }));

  router.post('/:uuid/rules', ...ruleBody, tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { method, matching_text } = req.body;
    res.status(201).json(await rules.create(String(req.params.uuid), method, matching_text));
  }));

  // The transactions the merchant's rules would give it. It takes no body.
  router.post('/:uuid/test-rules', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { ruleCount, matchingTransactions, skippedRules } = await rules.preview(String(req.params.uuid));
    if (ruleCount === 0) {
      res.json({ matchingTransactions: [], message: 'No rules defined for this merchant' });
      return;
    }

    const skippedNote = skippedRules.length > 0
      ? ` (${skippedRules.length} regular expression rule${skippedRules.length === 1 ? '' : 's'} couldn’t be checked: ${skippedRules.some((r) => r.reason === 'too_slow') ? 'too slow to run' : 'not a pattern the database accepts'})`
      : '';
    res.json({
      matchingTransactions,
      totalRules: ruleCount,
      skippedRules,
      message: (matchingTransactions.length > 0
        ? `Found ${matchingTransactions.length} matching transactions`
        : 'No matching transactions found') + skippedNote,
    });
  }));

  // Gives the merchant the transactions named (by id).
  router.post('/:uuid/apply-rules', validateBody(merchantApplyRulesSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { transactionIds } = req.body as MerchantApplyRulesInput;
    const { updatedCount, merchantName } = await rules.apply(String(req.params.uuid), transactionIds);
    res.json({ updatedCount, merchantName, message: `Applied merchant "${merchantName}" to ${updatedCount} transactions` });
  }));

  router.put('/rules/:uuid', ...ruleBody, tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { method, matching_text } = req.body;
    res.json(await rules.update(String(req.params.uuid), method, matching_text));
  }));

  router.delete('/rules/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    await rules.remove(String(req.params.uuid));
    res.status(204).send();
  }));

  // ============================================================================
  // ADMINISTRATION
  // ============================================================================

  // Deletes the merchants nothing uses: no transaction, attachment, budget item, recurring
  // item, budget-item rule or usage history, and not the balance-adjustment merchant. A
  // lock it can't get is a 409 RECORD_BUSY (lockRowsForDelete).
  router.post('/admin/remove-unused', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const removed = await merchants.removeUnused();
    res.json(removed.length === 0
      ? { message: 'No unused merchants found', removedCount: 0, removedMerchants: [] }
      : { message: `Successfully removed ${removed.length} unused merchants`, removedCount: removed.length, removedMerchants: removed });
  }));

  return router;
}
