import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { invitationTokenSchema } from '@nuggets/shared';
import { authHandler } from '../utils/routeHandler.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { acceptInvitation, inspectInvitation } from '../services/InvitationService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ service: 'InvitationsRoute' });

/**
 * The invited person's side of organization invitations. Mounted behind
 * `authenticateToken` only: the invitee may have no ledger yet. The token travels
 * in the body (the link carries it after the #), so it never reaches a URL that is
 * logged. Both routes refuse every unusable invitation with the same answer, and
 * count against one per-user limit, right or wrong.
 */
export function createInvitationRoutes(): Router {
  const router = Router();

  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => `user:${req.user?.userId ?? 'none'}`,
      handler: (req, res) => {
        logger.warn({ userId: req.user?.userId }, 'Invitation rate limit exceeded');
        res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.', code: 'RATE_LIMITED' });
      },
    })
  );

  const parseToken = (req: AuthenticatedRequest, res: Response): string | null => {
    const parsed = invitationTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'This invitation link isn’t complete.', code: 'VALIDATION_ERROR' });
      return null;
    }
    return parsed.data.token;
  };

  /** POST /api/invitations/inspect — which organization an invitation is for. Body: { token } */
  router.post(
    '/inspect',
    authHandler(async (req: AuthenticatedRequest, res: Response) => {
      const token = parseToken(req, res);
      if (token === null) return;
      res.json(await inspectInvitation(token, req.user!.userId));
    })
  );

  /** POST /api/invitations/accept — join the organization. Body: { token } */
  router.post(
    '/accept',
    authHandler(async (req: AuthenticatedRequest, res: Response) => {
      const token = parseToken(req, res);
      if (token === null) return;
      const accepted = await acceptInvitation(token, req.user!.userId);
      logger.info(
        { userId: req.user!.userId, orgUuid: accepted.organization.uuid, isAdmin: accepted.isAdmin },
        'Organization invitation accepted'
      );
      res.json(accepted);
    })
  );

  return router;
}
