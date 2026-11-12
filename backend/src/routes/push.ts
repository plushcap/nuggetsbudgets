import { Router, Response } from 'express';
import { z } from 'zod';
import { isAllowedPushEndpoint } from '../services/PushNotificationService.js';
import type { RouteDependencies } from './dependencies.js';
import { authHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ service: 'PushRoute' });

const endpointSchema = z.string().max(2048).refine(isAllowedPushEndpoint, 'Not a browser push service endpoint');

// Matches PushSubscription.toJSON(); expirationTime is accepted and ignored.
const subscriptionSchema = z.object({
  endpoint: endpointSchema,
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(256),
  }),
});

const unsubscribeSchema = z.object({ endpoint: z.string().max(2048) });

/**
 * Web Push for the signed-in person's own devices. Not tenant-scoped: a device
 * gets its person's alerts from every tenant they belong to.
 */
export function createPushRoutes({ pushService }: Pick<RouteDependencies, 'pushService'>): Router {
  const router = Router();

  /**
   * GET /api/push/public-key — the VAPID key a browser subscribes with.
   */
  router.get('/public-key', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json({ publicKey: await pushService.getPublicKey() });
  }));

  /**
   * GET /api/push/subscriptions/count — how many devices the person gets push on.
   */
  router.get('/subscriptions/count', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json({ count: await pushService.countSubscriptions(req.user.userId) });
  }));

  /**
   * POST /api/push/subscriptions — turn on push for this browser.
   * Body: PushSubscription.toJSON()
   */
  router.post('/subscriptions', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const parsed = subscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid push subscription', errors: parsed.error.flatten() });
      return;
    }
    const userAgent = req.get('user-agent')?.slice(0, 512) ?? null;
    const uuid = await pushService.subscribe(req.user.userId, parsed.data, userAgent);
    res.status(201).json({ uuid });
  }));

  /**
   * POST /api/push/subscriptions/remove — turn off push for this browser.
   * Body: { endpoint }. Only the person's own device rows are removed.
   */
  router.post('/subscriptions/remove', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const parsed = unsubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'endpoint is required' });
      return;
    }
    const removed = await pushService.unsubscribe(req.user.userId, parsed.data.endpoint);
    res.json({ removed });
  }));

  /**
   * POST /api/push/test — send a test notification to all of the person's devices.
   */
  router.post('/test', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await pushService.sendToUser(req.user.userId, {
      title: 'Nuggets notifications are on',
      body: 'This is how Nuggets alerts will look on this device.',
      url: '/profile',
      tag: 'test',
    });
    logger.info({ userId: req.user.userId, ...result }, 'Sent test push notification');
    res.json(result);
  }));

  return router;
}
