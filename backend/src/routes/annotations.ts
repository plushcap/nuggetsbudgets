import { Router, Response } from 'express';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import {
  annotationCreateSchema,
  annotationInboxQuery,
  annotationManualResolveSchema,
  annotationThreadsQuery,
  annotationTimelineQuery,
  annotationUpdateSchema,
  type AnnotationCreateInput,
  type AnnotationManualResolveInput,
  type AnnotationUpdateInput,
} from '@nuggets/shared';
import { createLogger } from '../utils/logger.js';
import { AnnotationService } from '../services/annotations/AnnotationService.js';

const logger = createLogger({ service: 'AnnotationsRoute' });

/**
 * Annotations (/api/annotations): the agent⇄human reasoning and discussion log on a
 * ledger's records. The handlers check the query or body (the shared
 * annotation schemas) and call AnnotationService; its refusals (AnnotationError) are
 * answered by the route wrapper.
 */
export function createAnnotationsRoutes(): Router {
  const router = Router();
  const annotations = new AnnotationService();

  // Tenant-wide counts for nav badges: open threads + how many want a banner.
  router.get('/counts', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await annotations.counts());
  }));

  // Cross-record inbox of thread roots (newest first) for the global Activity page.
  router.get('/threads', validateQuery(annotationThreadsQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { limit, status, notify } = parsedQuery(req, annotationThreadsQuery);
    res.json({ threads: await annotations.threads({ limit, status, notifyOnly: notify }) });
  }));

  // The agent's inbox, polled with a cursor:
  //   GET /api/annotations/inbox?since=<iso>&since_uuid=<thread uuid>&limit=
  // (AnnotationService.inbox).
  router.get('/inbox', validateQuery(annotationInboxQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { limit, since, since_uuid } = parsedQuery(req, annotationInboxQuery);
    res.json(await annotations.inbox({ limit, since, sinceUuid: since_uuid }));
  }));

  // The threaded timeline for one record:
  //   GET /api/annotations?subject_type=transaction&subject_uuid=<uuid>
  router.get('/', validateQuery(annotationTimelineQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { subject_type, subject_uuid } = parsedQuery(req, annotationTimelineQuery);
    res.json(await annotations.timeline(subject_type, subject_uuid));
  }));

  // Create a root annotation (subject_type + subject_uuid) or a reply (parent_uuid).
  router.post('/', validateBody(annotationCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.status(201).json(await annotations.create(req.body as AnnotationCreateInput, req.user.userId));
  }));

  // Manually resolve open thread(s) from the Activity page:
  //   POST /api/annotations/manual-resolve   { uuid } | { scope: 'all' | 'reviewed' }
  router.post('/manual-resolve', validateBody(annotationManualResolveSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const input = req.body as AnnotationManualResolveInput;
    const resolved = await annotations.manualResolve(input, req.user.userId);
    logger.info({ userId: req.user.userId, scope: input.scope ?? 'single', resolved }, 'Annotation threads manually resolved');
    res.json({ resolved });
  }));

  // Update lifecycle / surfacing (and body, except on append-only agent entries).
  router.patch('/:uuid', validateBody(annotationUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await annotations.update(String(req.params.uuid), req.body as AnnotationUpdateInput, req.user.userId));
  }));

  return router;
}
