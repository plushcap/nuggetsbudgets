import { Router, Response } from 'express';
import {
  notificationHistoryQuery,
  notificationSettingsUpdateSchema,
  saveNotificationRulesRequestSchema,
  setNotificationPreferencesRequestSchema,
  testNotificationEmailRequestSchema,
  type NotificationRules,
  type NotificationSettingsUpdate,
  type SetNotificationPreferencesRequest,
  type TestNotificationEmailRequest,
} from '@nuggets/shared';
import type { RouteDependencies } from './dependencies.js';
import { EmailDeliveryService } from '../services/EmailDeliveryService.js';
import { NotificationAdminService } from '../services/notifications/NotificationAdminService.js';
import { clearNotificationHistory, notificationHistory } from '../services/notifications/history.js';
import { requireTenantAdmin } from '../middleware/tenant.js';
import { parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import { authHandler, tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ service: 'NotificationRoute' });

/**
 * The email preview's Content-Security-Policy, in place of the backend's deny-all one
 * (app.ts). The page is the email as mail clients get it: MJML output styled inline,
 * the logo from the notification_logo_url setting (any https URL), and the Google
 * stylesheet MJML links for the Roboto in its font stack. No scripts.
 */
export const EMAIL_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src https: data:; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * The active ledger's notifications (/api/notifications), mounted behind authenticateToken,
 * resolveTenant and requireTenantMember: its rules, each person's choice of how they reach
 * them, and (for its admins) what was sent. The deployment's own settings are
 * {@link createNotificationAdminRoutes}'.
 */
export function createNotificationRoutes({ notificationRuleService: ruleService }: Pick<RouteDependencies, 'notificationRuleService'>): Router {
  const router = Router();
  const emailService = new EmailDeliveryService();

  /**
   * The active tenant's notification rules (its saved ones, or the defaults).
   * GET /api/notifications/rules — any member.
   */
  router.get('/rules', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json((await ruleService.readRules()).rules);
  }));

  /**
   * Replace the active tenant's notification rules.
   * PUT /api/notifications/rules — tenant admins. Body: { rules: NotificationRule[] }
   */
  router.put('/rules', requireTenantAdmin, validateBody(saveNotificationRulesRequestSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await ruleService.saveRules(req.body as NotificationRules, req.user.userId));
  }));

  /**
   * The signed-in person's choice of how each of the tenant's enabled rules reaches them.
   * GET /api/notifications/preferences
   */
  router.get('/preferences', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await ruleService.getPreferences(req.user.userId, await emailService.isConfigured()));
  }));

  /**
   * Change some of the signed-in person's choices; a rule the tenant doesn't have is a 400
   * (NotificationRuleError, answered by the route wrapper).
   * PUT /api/notifications/preferences — Body: { rules: [{ rule, email?, push? }] }
   */
  router.put('/preferences', validateBody(setNotificationPreferencesRequestSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const request = req.body as SetNotificationPreferencesRequest;
    res.json(await ruleService.setPreferences(req.user.userId, request, await emailService.isConfigured()));
  }));

  /**
   * The tenant's notification history, a page at a time.
   * GET /api/notifications/history — tenant admins (it names every member and their email).
   * Query params: page (default: 1), limit (default: 20), status (optional), type (optional)
   */
  router.get('/history', requireTenantAdmin, validateQuery(notificationHistoryQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json({ success: true, ...(await notificationHistory(parsedQuery(req, notificationHistoryQuery))) });
  }));

  /**
   * Delete all of the tenant's notification history.
   * DELETE /api/notifications/history — tenant admins.
   */
  router.delete('/history', requireTenantAdmin, tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const deletedCount = await clearNotificationHistory();
    logger.info({ userId: req.user.userId, deletedCount }, 'Notification history cleared');
    res.json({
      success: true,
      message: `Successfully deleted ${deletedCount} notification records`,
      deletedCount,
    });
  }));

  return router;
}

/**
 * The deployment's notifications (/api/admin/notifications), mounted behind
 * authenticateToken and requireDeploymentAdmin, with no ledger: the SMTP settings, the
 * scheduler, the queue, and the test email and preview. They read only the deployment's
 * settings, the schedulers and each ledger's queue in short transactions of their own, so
 * no handler holds a ledger transaction (authHandler); the test email waits on the mail
 * server.
 */
export function createNotificationAdminRoutes({
  lifecycleService,
  config,
}: Pick<RouteDependencies, 'lifecycleService' | 'config'>): Router {
  const router = Router();
  const admin = new NotificationAdminService();
  // Where the test email's links point.
  const clientUrl = config.CLIENT_URL || 'http://localhost:3000';

  /** GET /api/admin/notifications/settings — the SMTP settings (the password only as set or not). */
  router.get('/settings', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await admin.readSettings());
  }));

  /** POST /api/admin/notifications/settings — Body: { settings }, only notificationSettingsUpdateSchema's keys. */
  router.post('/settings', validateBody(notificationSettingsUpdateSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { settings } = req.body as { settings: NotificationSettingsUpdate };
    const { schedulerChanged, keys } = await admin.saveSettings(settings, req.user.userId);

    // A change the scheduler reads restarts it. The settings are saved either way.
    if (schedulerChanged) {
      try {
        logger.info({ userId: req.user.userId, updatedSettings: keys }, 'Notification scheduler settings updated, restarting scheduler');
        await lifecycleService.updateNotificationSchedulerConfiguration();
      } catch (error) {
        logger.error({ err: error, userId: req.user.userId }, 'Error updating notification scheduler configuration');
      }
    }
    res.json({ success: true, message: 'Settings updated successfully' });
  }));

  /** GET /api/admin/notifications/status — whether email can go, the scheduler, and the deployment's queue. */
  router.get('/status', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const { configured, enabled, queue } = await admin.status();
    res.json({ configured, enabled, scheduler: await lifecycleService.getNotificationSchedulerStatus(), queue });
  }));

  /**
   * Send a test email through the deployment's SMTP account.
   * POST /api/admin/notifications/test — Body: { recipient, templateType: 'transaction-review' | 'budget-overspending' }
   */
  router.post('/test', validateBody(testNotificationEmailRequestSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const messageId = await admin.sendTestEmail(req.body as TestNotificationEmailRequest, req.user.userId, clientUrl);
    res.json({ success: true, message: 'Test email sent successfully', messageId });
  }));

  /** GET /api/admin/notifications/preview/:templateType — the email in the browser (HTML). */
  router.get('/preview/:templateType', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const html = await admin.previewEmail(String(req.params.templateType));
    res.setHeader('Content-Security-Policy', EMAIL_PREVIEW_CSP);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }));

  /** POST /api/admin/notifications/scheduler/start */
  router.post('/scheduler/start', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    await lifecycleService.startNotificationScheduler();
    logger.info({ userId: req.user.userId }, 'Notification scheduler started successfully');
    res.json({ success: true, message: 'Notification scheduler started successfully' });
  }));

  /** POST /api/admin/notifications/scheduler/stop */
  router.post('/scheduler/stop', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    await lifecycleService.stopNotificationScheduler();
    logger.info({ userId: req.user.userId }, 'Notification scheduler stopped successfully');
    res.json({ success: true, message: 'Notification scheduler stopped successfully' });
  }));

  /** POST /api/admin/notifications/scheduler/restart */
  router.post('/scheduler/restart', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    await lifecycleService.restartNotificationScheduler();
    logger.info({ userId: req.user.userId }, 'Notification scheduler restarted successfully');
    res.json({ success: true, message: 'Notification scheduler restarted successfully' });
  }));

  return router;
}
