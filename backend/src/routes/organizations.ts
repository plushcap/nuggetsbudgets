import { Router, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { authHandler } from '../utils/routeHandler.js';
import { requireDeploymentAdmin, type TenantRequest } from '../middleware/tenant.js';
import { parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import {
  addMemberSchema,
  createInvitationSchema,
  createSimpleFinConnectionSchema,
  createTenantSchema,
  orgUpdateSchema,
  priceSyncRunsQuery,
  priceSyncSettingsUpdateSchema,
  setMemberAdminSchema,
  setMemberFlagsSchema,
  type CreateInvitationInput,
  type OrgUpdateInput,
} from '@nuggets/shared';
import { DEFAULT_PRICE_SYNC_TIME, DEFAULT_PRICE_SYNC_TIMEZONE, priceSyncService } from '../services/investments/PriceSyncService.js';
import {
  addOrgMember,
  assertOrgAdmin,
  getOrganizationDetail,
  listOrgMembers,
  removeOrgMember,
  setOrgMemberAdmin,
  setOrgMemberFlags,
  updateOrganization,
} from '../services/OrganizationService.js';
import { createInvitation, listInvitations, revokeInvitation } from '../services/InvitationService.js';
import {
  createConnection as createSimpleFinConnection,
  deleteConnection as deleteSimpleFinConnection,
  getConnection as getSimpleFinConnection,
} from '../services/OrganizationSimpleFinService.js';
import { createTenant } from '../services/TenantAdminService.js';
import { ControlPlaneError } from '../services/controlPlaneErrors.js';
import { DomainError } from '../services/domainErrors.js';
import { answerError } from '../utils/apiError.js';
import { isUuid } from '../middleware/routeParams.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ service: 'OrganizationsRoute' });

/** A request whose `:uuid` names an organization the caller administers. */
interface OrgAdminRequest extends TenantRequest {
  orgId?: number;
}

/**
 * Org-admin management, addressed by org uuid in the URL (which may differ from
 * the active budget's org). Mounted behind `authenticateToken, resolveTenant`
 * (for `req.isDeploymentAdmin`); the `uuid` param handler authorizes via `assertOrgAdmin`.
 * Global control-plane tables → `authHandler` + `globalDb`, never `tenantHandler`. The
 * organization's own tables (SimpleFin connection, price-sync settings and runs) are under
 * the organization RLS policy: their services open `withOrganization(orgId)` themselves.
 */
export function createOrganizationRoutes(): Router {
  const router = Router();

  const isDeploymentAdmin = (req: TenantRequest) => req.isDeploymentAdmin ?? false;

  // Every route here is addressed by org uuid and is for that org's admins. Check it
  // once, before any route's own middleware (body validation, rate limiting) runs, so a
  // caller who isn't an admin gets 403 rather than a validation error. A refusal (a
  // DomainError) answers in its own status and code; any other failure goes to
  // next(err), the error handler's generic 500. The handlers below let theirs propagate
  // to the route wrapper, which answers them the same way.
  router.param('uuid', async (req: OrgAdminRequest, res: Response, next: NextFunction, uuid: string) => {
    try {
      req.orgId = await assertOrgAdmin(req.user!.userId, String(uuid), isDeploymentAdmin(req));
    } catch (err) {
      if (err instanceof DomainError) answerError(err, res);
      // next() with a falsy value would carry on to the route as if the check had passed.
      else next(err instanceof Error ? err : new Error(`Org admin check failed: ${String(err)}`));
      return;
    }
    next();
  });

  // A member uuid that can't be one names no member: the 404 an unknown one gets, after
  // the admin check above (Express runs param callbacks in path order). It reached SQL,
  // which refused it with a 500.
  router.param('memberUuid', (_req: OrgAdminRequest, res: Response, next: NextFunction, memberUuid: string) => {
    if (isUuid(memberUuid)) next();
    else answerError(new ControlPlaneError(404, 'MEMBER_NOT_FOUND', 'Member not found in this organization.'), res);
  });

  router.get(
    '/:uuid',
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      res.json(await getOrganizationDetail(orgId));
    })
  );

  router.patch(
    '/:uuid',
    validateBody(orgUpdateSchema),
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      const org = await updateOrganization(orgId, req.body as OrgUpdateInput);
      logger.info({ userId: req.user!.userId, orgId }, 'Organization updated');
      res.json(org);
    })
  );

  router.post(
    '/:uuid/tenants',
    validateBody(createTenantSchema),
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      const { name } = req.body as { name: string };
      const created = await createTenant(orgId, name, req.user!.userId);
      logger.info({ userId: req.user!.userId, orgId, tenantUuid: created.uuid }, 'Tenant created');
      res.status(201).json(created);
    })
  );

  router.get(
    '/:uuid/members',
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      res.json(await listOrgMembers(orgId));
    })
  );

  // Adding an existing user directly is for deployment admins: an organization's
  // own admins invite people (below), so joining takes the person's consent and
  // the answer can't tell an admin whether an address has an account.
  router.post(
    '/:uuid/members',
    requireDeploymentAdmin,
    validateBody(addMemberSchema),
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      const { email, isAdmin } = req.body as { email: string; isAdmin: boolean };
      const member = await addOrgMember(orgId, email, isAdmin, req.user!.userId);
      res.status(201).json(member);
    })
  );

  router.patch(
    '/:uuid/members/:memberUuid',
    validateBody(setMemberAdminSchema),
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      const { isAdmin } = req.body as { isAdmin: boolean };
      await setOrgMemberAdmin(orgId, String(req.params.memberUuid), isAdmin);
      res.json({ success: true });
    })
  );

  router.delete(
    '/:uuid/members/:memberUuid',
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      await removeOrgMember(orgId, String(req.params.memberUuid));
      res.json({ success: true });
    })
  );

  // Set GLOBAL account flags (is_locked / login_disabled) on a member's user.
  // Org admins + deployment admins only (assertOrgAdmin). These live on the
  // global users row, so the change affects the user across every ledger/org,
  // and an org admin may only change them for someone the organization alone
  // answers for (applyUserAccountFlags).
  router.patch(
    '/:uuid/members/:memberUuid/flags',
    validateBody(setMemberFlagsSchema),
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      const flags = req.body as { isLocked?: boolean; loginDisabled?: boolean };
      await setOrgMemberFlags(orgId, String(req.params.memberUuid), flags, {
        userId: req.user!.userId,
        isDeploymentAdmin: isDeploymentAdmin(req),
      });
      logger.info(
        { userId: req.user!.userId, orgId, memberUuid: String(req.params.memberUuid) },
        'Org member account flags updated'
      );
      res.json({ success: true });
    })
  );

  // ---- Invitations ---------------------------------------------------
  // How people join an organization: an admin invites an email address and shares
  // the link; a signed-in user with that address accepts it (routes/invitations.ts).
  // Creating one answers the same whether or not the address has an account or is
  // already a member.

  router.get(
    '/:uuid/invitations',
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      res.json(await listInvitations(req.orgId!));
    })
  );

  router.post(
    '/:uuid/invitations',
    validateBody(createInvitationSchema),
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      const created = await createInvitation(orgId, req.body as CreateInvitationInput, req.user!.userId);
      logger.info(
        { userId: req.user!.userId, orgId, invitationUuid: created.invitation.uuid },
        'Organization invitation created'
      );
      res.status(201).json(created);
    })
  );

  router.delete(
    '/:uuid/invitations/:invitationUuid',
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      await revokeInvitation(orgId, String(req.params.invitationUuid));
      logger.info(
        { userId: req.user!.userId, orgId, invitationUuid: String(req.params.invitationUuid) },
        'Organization invitation revoked'
      );
      res.json({ success: true });
    })
  );

  // ---- SimpleFin: organization-level connection --------------
  // The paid SimpleFin connection is owned by the org and shared across its
  // ledgers. Org admins manage it here; the access credential never leaves the
  // server (only status/metadata is returned).

  router.get(
    '/:uuid/simplefin/connection',
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      res.json(await getSimpleFinConnection(orgId));
    })
  );

  router.post(
    '/:uuid/simplefin/connection',
    validateBody(createSimpleFinConnectionSchema),
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      const connection = await createSimpleFinConnection(
        orgId,
        req.body as { setupToken: string; label?: string },
        req.user!.userId
      );
      logger.info({ userId: req.user!.userId, orgId }, 'SimpleFin connection configured');
      res.status(201).json(connection);
    })
  );

  router.delete(
    '/:uuid/simplefin/connection',
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      await deleteSimpleFinConnection(orgId);
      logger.info({ userId: req.user!.userId, orgId }, 'SimpleFin connection removed');
      res.json({ success: true });
    })
  );

  // --- investment price sync (scheduled EOD price fetch) ---------------------
  // Limit manual runs to avoid hammering the price provider.
  const priceSyncRunLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 12,
    // Per user; ipKeyGenerator collapses an IPv6 fallback to its subnet (express-rate-limit v8).
    keyGenerator: (req) => req.user?.userId?.toString() || ipKeyGenerator(req.ip || ''),
  });

  router.get(
    '/:uuid/price-sync/settings',
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      const settings = await priceSyncService.getSettings(orgId);
      // Return defaults (disabled) when no row exists yet: 17:00 US Eastern, after the
      // US market close (PriceSyncService's DEFAULT_PRICE_SYNC_*).
      res.json(
        settings ?? {
          organization_id: orgId,
          enabled: false,
          schedule_time: DEFAULT_PRICE_SYNC_TIME,
          timezone: DEFAULT_PRICE_SYNC_TIMEZONE,
          provider: 'stooq',
          last_run_at: null,
        }
      );
    })
  );

  router.put(
    '/:uuid/price-sync/settings',
    validateBody(priceSyncSettingsUpdateSchema),
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      const settings = await priceSyncService.upsertSettings(orgId, req.body, req.user!.userId);
      logger.info({ userId: req.user!.userId, orgId, enabled: settings.enabled }, 'Price-sync settings updated');
      res.json(settings);
    })
  );

  router.post(
    '/:uuid/price-sync/run',
    priceSyncRunLimiter,
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      const result = await priceSyncService.runForOrg(orgId, { trigger: 'user', userId: req.user!.userId });
      res.json(result);
    })
  );

  router.get(
    '/:uuid/price-sync/runs',
    validateQuery(priceSyncRunsQuery),
    authHandler(async (req: OrgAdminRequest, res: Response) => {
      const orgId = req.orgId!;
      const { limit, offset } = parsedQuery(req, priceSyncRunsQuery);
      res.json(await priceSyncService.listRuns(orgId, limit, offset));
    })
  );

  return router;
}
