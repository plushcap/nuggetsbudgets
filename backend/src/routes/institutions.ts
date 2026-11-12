import { Router, Response } from 'express';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { validateBody } from '../middleware/validate.js';
import { institutionCreateSchema, institutionUpdateSchema, type InstitutionWriteInput } from '@nuggets/shared';
import { createLogger } from '../utils/logger.js';
import { InstitutionService } from '../services/institutions/InstitutionService.js';

const logger = createLogger({ service: 'InstitutionsRoute' });

/**
 * A ledger's institutions (/api/institutions): list, read, create, rename, delete. The
 * handlers check the body (institutionCreateSchema / institutionUpdateSchema) and call
 * InstitutionService; its refusals (InstitutionError: not found, accounts still at it) are
 * answered by the route wrapper. Log lines carry ids, never an institution's name.
 */
export function createInstitutionsRoutes(): Router {
  const router = Router();
  const institutions = new InstitutionService();

  router.get('/', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.status(200).json(await institutions.list());
  }));

  router.get('/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await institutions.find(String(req.params.uuid)));
  }));

  router.post('/', validateBody(institutionCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const created = await institutions.create(req.body as InstitutionWriteInput);
    logger.info({ userId: req.user.userId, institutionId: created.id }, 'Institution created');
    res.status(201).json(created);
  }));

  router.put('/:uuid', validateBody(institutionUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const uuid = String(req.params.uuid);
    const updated = await institutions.update(uuid, req.body as InstitutionWriteInput);
    logger.info({ userId: req.user.userId, institutionUuid: uuid, institutionId: updated.id }, 'Institution updated');
    res.json(updated);
  }));

  router.delete('/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const uuid = String(req.params.uuid);
    const deleted = await institutions.remove(uuid);
    logger.info({ userId: req.user.userId, institutionUuid: uuid, institutionId: deleted.id }, 'Institution deleted');
    res.json({
      success: true,
      deleted,
      message: 'Institution deleted successfully',
    });
  }));

  return router;
}
