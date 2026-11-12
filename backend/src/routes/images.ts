import { Router, Response } from 'express';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { imageForViewer } from '../services/ImageService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serves images stored in the DB. Runs under `tenantHandler`, whose transaction
 * ImageService reads on (getDb(), RLS-scoped): a ledger's image (account/goal/merchant)
 * is visible only in that ledger. A profile picture (user_profile_images, no ledger) is served to its owner
 * and to people who share an organization or a ledger with them. A browser
 * `<img src="/api/images/:uuid">` carries the httpOnly session cookie
 * automatically, so it authenticates the same way the (auth-gated) /uploads static
 * mount always did.
 */
export function createImagesRoutes(): Router {
  const router = Router();

  router.get('/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const uuid = String(req.params.uuid);
    if (!UUID_RE.test(uuid)) {
      res.status(400).json({ error: 'Invalid image id' });
      return;
    }

    // Content-addressed by uuid (immutable): a client that already holds it can
    // short-circuit via If-None-Match.
    if (req.headers['if-none-match'] === `"${uuid}"`) {
      res.status(304).end();
      return;
    }

    const image = await imageForViewer(uuid, req.user.userId);
    if (!image) {
      res.status(404).json({ error: 'Image not found' });
      return;
    }

    res.setHeader('Content-Type', image.mimeType);
    // Stored types are validated raster images, but defend in depth anyway.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    // A given uuid's bytes never change (a re-upload mints a new uuid), so it's
    // safe to cache hard. Private: it is a ledger's image, or someone's profile picture.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('ETag', `"${uuid}"`);
    res.send(image.data);
  }));

  return router;
}
