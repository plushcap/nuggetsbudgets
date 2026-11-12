import { Router, type Response } from 'express';
import {
  DEPLOYMENT_TIME_ZONE_ERROR,
  deploymentSettingsUpdateSchema,
  type DeploymentSettings,
  type DeploymentSettingsUpdateInput,
} from '@nuggets/shared';
import { validateBody } from '../middleware/validate.js';
import { authHandler, type AuthenticatedRequest } from '../utils/routeHandler.js';
import { readSystemSetting, writeSystemSetting } from '../services/systemSettings.js';
import { isAppTimeZone } from '../utils/appDate.js';
import { clampTenantsOnDeploymentZone } from '../services/goalDayRanges.js';
import { sendError } from '../utils/apiError.js';
import { createLogger } from '../utils/logger.js';
import type { RouteDependencies } from './dependencies.js';

const logger = createLogger({ service: 'DeploymentSettingsRoute' });

/**
 * The deployment's own settings, for its admins: its time zone,
 * `application_timezone` in system_settings. It is the zone of every ledger that hasn't
 * set its own (app_timezone() reads the ledger's tenant_settings row first; a ledger's
 * admins set that on its General settings page, POST /api/settings/general) and of the
 * deployment's own jobs, such as the backup schedule. Mounted at
 * /api/admin/deployment-settings behind authenticateToken and requireDeploymentAdmin
 * (routes.ts); a personal access token can't reach it (middleware/tokenAccess.ts).
 * system_settings is a control-plane table (no RLS); it is read and written through
 * services/systemSettings.ts, on the app's pool, or in the caller's transaction when there
 * is one (a test's, rolled back). The answers' shape is `@nuggets/shared`'s.
 */
async function readDeploymentSettings(): Promise<DeploymentSettings> {
  return { application_timezone: (await readSystemSetting('application_timezone'))?.trim() || 'UTC' };
}

export function createDeploymentSettingsRoutes({ lifecycleService }: Pick<RouteDependencies, 'lifecycleService'>): Router {
  const router = Router();

  /** GET /api/admin/deployment-settings */
  router.get('/', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json({ settings: await readDeploymentSettings() });
  }));

  /** PUT /api/admin/deployment-settings: `{ settings: { application_timezone } }`. */
  router.put('/', validateBody(deploymentSettingsUpdateSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const zone = (req.body as DeploymentSettingsUpdateInput).settings.application_timezone;
    if (zone === undefined) {
      res.json({ success: true, settings: await readDeploymentSettings() });
      return;
    }
    if (!(await isAppTimeZone(zone))) {
      sendError(res, 400, 'VALIDATION_ERROR', DEPLOYMENT_TIME_ZONE_ERROR);
      return;
    }

    // The row the install seeds, kept as it is but for its value.
    await writeSystemSetting('application_timezone', zone, { category: 'general', settingType: 'string' });
    logger.info({ userId: req.user.userId, keys: ['application_timezone'] }, 'Deployment settings updated');

    // Every tenant without a zone of its own may have a new today: its goal history's ranges of
    // days, written in the old one, are clamped to it, each tenant in a transaction of its own,
    // now that the zone is written. On every save, changed or not: the
    // clamp is idempotent, so saving again clamps a tenant this save couldn't, which the answer
    // counts. The zone stays written either way.
    let notice: { tenants_not_clamped?: number; notice: string } | null = null;
    const retry = 'save the time zone again to retry.';
    try {
      const { failed } = await clampTenantsOnDeploymentZone();
      if (failed > 0) {
        notice = {
          tenants_not_clamped: failed,
          notice: `${failed} ${failed === 1 ? "tenant's" : "tenants'"} goal history could not be moved to the new time zone; ${retry}`,
        };
      }
    } catch (err) {
      logger.error({ err }, "Could not clamp the tenants' goal ranges to the new time zone");
      notice = { notice: `The tenants' goal history could not be moved to the new time zone; ${retry}` };
    }

    // The backup schedule is read in this zone: arm it again from it.
    try {
      await lifecycleService.updateBackupSchedulerConfiguration();
    } catch (err) {
      logger.error({ err }, 'Could not re-arm the backup scheduler in the new time zone');
    }
    res.json({ success: true, settings: await readDeploymentSettings(), ...notice });
  }));

  return router;
}
