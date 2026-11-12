import { Router, Response, Request } from 'express';
import { unsubscribeRequestSchema } from '@nuggets/shared';
import type { RouteDependencies } from './dependencies.js';
import { createRateLimiter } from '../middleware/security.js';
import { asyncHandler } from '../utils/routeHandler.js';

/**
 * The links in notification emails. No sign-in: the signed token in the link
 * is the credential, and all it can do is stop one rule's email for the person
 * it was sent to. Inspecting changes nothing, so the page can ask before
 * stopping (a mail scanner that opens links stops nothing). Both count against
 * one per-IP limit, right or wrong, so tokens can't be guessed at speed. A link that
 * doesn't work is a NotificationRuleError (404), answered by the route wrapper.
 */
export function createNotificationLinkRoutes({
  notificationRuleService: ruleService,
}: Pick<RouteDependencies, 'notificationRuleService'>): Router {
  const router = Router();
  router.use(createRateLimiter(15 * 60 * 1000, 20));

  const handle = (action: (token: string) => Promise<{ label: string }>) =>
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = unsubscribeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'This link isn’t complete.' });
        return;
      }
      res.json(await action(parsed.data.token));
    });

  /** POST /api/notification-links/inspect — which rule a link would stop. Body: { token } */
  router.post('/inspect', handle((token) => ruleService.inspectUnsubscribeLink(token)));

  /** POST /api/notification-links/unsubscribe — stop that rule's email. Body: { token } */
  router.post('/unsubscribe', handle((token) => ruleService.unsubscribe(token)));

  return router;
}
