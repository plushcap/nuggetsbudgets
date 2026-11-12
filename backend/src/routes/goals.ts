import { Router, Response } from 'express';
import multer from 'multer';
import {
    goalAccountLinkSchema,
    goalBalanceHistoryQuery,
    goalBudgetItemLinkSchema,
    goalCreateSchema,
    goalProgressHistoryQuery,
    goalUpdateSchema,
} from '@nuggets/shared';
import { GoalService } from '../services/GoalService.js';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { imageFileFilter, IMAGE_UPLOAD_LIMITS } from '../utils/imageUpload.js';
import { parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import { refuseNulFields } from '../middleware/nulText.js';

// Configure multer for goal image uploads. Images are stored in the DB
// (stored_images) so they ride the backup/restore — buffer in memory, don't
// write to disk. imageFileFilter validates BOTH extension and MIME.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: IMAGE_UPLOAD_LIMITS,
    fileFilter: imageFileFilter
});

/**
 * /api/goals: savings goals (Savings budget items of type Goal), their links to accounts
 * and envelopes, their progress and balance histories, and their images.
 * Each route checks its input (a shared schema) and calls GoalService, which takes no pool:
 * it runs on the request's tenant transaction. A goal, account or envelope is named by its
 * uuid in a URL. A refusal (a goal that isn't there 404, an account or
 * envelope that can't be linked 404/400, a range too long 400) propagates to the route
 * wrapper, which answers it and rolls back what was written.
 */
export function createGoalRoutes(): Router {
    const router = Router();
    const goalService = new GoalService();

    /**
     * GET /api/goals
     * List all goals with current progress
     */
    router.get('/', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
        res.json({ goals: await goalService.listGoals() });
    }));

    /**
     * GET /api/goals/:uuid
     * Get single goal with full details
     */
    router.get('/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
        res.json({ goal: await goalService.getGoal(String(req.params.uuid)) });
    }));

    /**
     * POST /api/goals
     * Create a new goal. goalCreateSchema (shared): name, target_amount (> 0) and
     * target_date required; status defaults to 'active'.
     */
    router.post('/', validateBody(goalCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
        res.status(201).json({ goal: await goalService.createGoal(req.body) });
    }));

    /**
     * PUT /api/goals/:uuid
     * Update goal details: the fields sent (goalUpdateSchema)
     */
    router.put('/:uuid', validateBody(goalUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
        res.json({ goal: await goalService.updateGoal(String(req.params.uuid), req.body) });
    }));

    /**
     * DELETE /api/goals/:uuid
     * Soft delete a goal (set status to archived)
     */
    router.delete('/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
        const goal = await goalService.archiveGoal(String(req.params.uuid));
        res.json({ message: 'Goal archived successfully', goal });
    }));

    /**
     * POST /api/goals/:uuid/accounts — Body: { account_id }
     * Link an account to a goal from today on (the history before today is unchanged).
     * An account of another ledger, or none, is a 400 INVALID_REFERENCE.
     */
    router.post('/:uuid/accounts', validateBody(goalAccountLinkSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
        await goalService.linkAccount(String(req.params.uuid), req.body.account_id);
        res.status(201).json({ message: 'Account associated successfully' });
    }));

    /**
     * DELETE /api/goals/:uuid/accounts/:accountUuid
     * Unlink an account from a goal from today on: the link is closed, not deleted
     */
    router.delete('/:uuid/accounts/:accountUuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
        await goalService.unlinkAccount(String(req.params.uuid), String(req.params.accountUuid));
        res.json({ message: 'Account association removed successfully' });
    }));

    /**
     * POST /api/goals/:uuid/budget-items — Body: { budget_item_id }
     * Link a budget item (it must be rollover=true) to a goal from today on. No such
     * item of the ledger is a 400 INVALID_REFERENCE, one without rollover a 400
     * BUDGET_ITEM_NOT_ROLLOVER.
     */
    router.post('/:uuid/budget-items', validateBody(goalBudgetItemLinkSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
        await goalService.linkBudgetItem(String(req.params.uuid), req.body.budget_item_id);
        res.status(201).json({ message: 'Budget item associated successfully' });
    }));

    /**
     * DELETE /api/goals/:uuid/budget-items/:budgetItemUuid
     * Unlink a budget item from a goal from today on: the link is closed, not deleted
     */
    router.delete('/:uuid/budget-items/:budgetItemUuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
        await goalService.unlinkBudgetItem(String(req.params.uuid), String(req.params.budgetItemUuid));
        res.json({ message: 'Budget item association removed successfully' });
    }));

    /**
     * GET /api/goals/:uuid/progress-history?start_date&end_date
     * The goal's progress at each month end in the range, and today when it is in it,
     * computed from the balances (GoalService.getProgressHistory). The range is
     * the goal's life so far by default, and at most ten years: a start after the end, or a
     * longer range, is a 400.
     */
    router.get('/:uuid/progress-history', validateQuery(goalProgressHistoryQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
        const { start_date, end_date } = parsedQuery(req, goalProgressHistoryQuery);
        res.json({ history: await goalService.progressHistoryOf(String(req.params.uuid), { startDate: start_date, endDate: end_date }) });
    }));

    /**
     * GET /api/goals/:uuid/balance-history?limit&period
     * The balance of the accounts the goal counts now, over time
     */
    router.get('/:uuid/balance-history', validateQuery(goalBalanceHistoryQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
        res.json({ history: await goalService.balanceHistory(String(req.params.uuid), parsedQuery(req, goalBalanceHistoryQuery)) });
    }));

    /**
     * GET /api/goals/:uuid/account-balance-history?limit&period
     * The same, account by account
     */
    router.get('/:uuid/account-balance-history', validateQuery(goalBalanceHistoryQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
        res.json({ accounts: await goalService.accountBalanceHistory(String(req.params.uuid), parsedQuery(req, goalBalanceHistoryQuery)) });
    }));

    /**
     * POST /api/goals/:uuid/image
     * Upload an image for a goal
     */
    router.post('/:uuid/image', upload.single('image'), refuseNulFields, tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
        if (!req.file) {
            res.status(400).json({
                error: 'No image file provided',
                code: 'VALIDATION_ERROR'
            });
            return;
        }
        const imagePath = await goalService.setImage(String(req.params.uuid), req.file, req.user?.userId ?? null);
        res.json({
            message: 'Image uploaded successfully',
            image_path: imagePath
        });
    }));

    /**
     * DELETE /api/goals/:uuid/image
     * Delete the image for a goal
     */
    router.delete('/:uuid/image', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
        await goalService.deleteImage(String(req.params.uuid));
        res.json({ message: 'Image deleted successfully' });
    }));

    return router;
}
