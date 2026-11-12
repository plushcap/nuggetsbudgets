import { Router, Response } from 'express';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { validateBody } from '../middleware/validate.js';
import { categoryCreateSchema, categoryUpdateSchema, type CategoryWriteInput } from '@nuggets/shared';
import { createLogger } from '../utils/logger.js';
import { CategoryService } from '../services/categories/CategoryService.js';

const logger = createLogger({ service: 'CategoriesRoute' });

/**
 * A ledger's categories (/api/categories): list, create, rename, delete. The handlers
 * check the body (categoryCreateSchema / categoryUpdateSchema) and call CategoryService;
 * its refusals (CategoryError: not found, a name taken, a category in use) are answered by
 * the route wrapper. Log lines carry ids, never a category's name.
 */
export function createCategoriesRoutes(): Router {
  const router = Router();
  const categories = new CategoryService();

  router.get('/', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await categories.list());
  }));

  router.post('/', validateBody(categoryCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const created = await categories.create(req.body as CategoryWriteInput);
    logger.info({ userId: req.user.userId, categoryId: created.id }, 'Category created');
    res.status(201).json(created);
  }));

  router.put('/:uuid', validateBody(categoryUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const uuid = String(req.params.uuid);
    const updated = await categories.update(uuid, req.body as CategoryWriteInput);
    logger.info({ userId: req.user.userId, categoryUuid: uuid, categoryId: updated.id }, 'Category updated');
    res.json(updated);
  }));

  router.delete('/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const uuid = String(req.params.uuid);
    const categoryId = await categories.remove(uuid);
    logger.info({ userId: req.user.userId, categoryUuid: uuid, categoryId }, 'Category deleted');
    res.status(204).send();
  }));

  return router;
}
