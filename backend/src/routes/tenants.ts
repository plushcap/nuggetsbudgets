import { Router, Response } from 'express';
import { authHandler } from '../utils/routeHandler.js';
import { requireTenantAdmin, requireOrgAdmin, type TenantRequest } from '../middleware/tenant.js';
import { validateBody } from '../middleware/validate.js';
import {
  addMemberSchema,
  balanceAdjustmentMerchantSchema,
  setMemberAdminSchema,
  setMemberFlagsSchema,
  tenantRenameSchema,
} from '@nuggets/shared';
import {
  addTenantMember,
  getCurrentTenant,
  listTenantMemberCandidates,
  listTenantMembers,
  removeTenantMember,
  renameTenant,
  setBalanceAdjustmentMerchant,
  setTenantMemberAdmin,
  setTenantMemberFlags,
} from '../services/TenantAdminService.js';
import { listTenantUsers } from '../services/UserService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ service: 'TenantsRoute' });

/**
 * Tenant-admin management of the ACTIVE tenant. Mounted behind
 * `authenticateToken, resolveTenant, requireTenantMember`, so `req.tenant.id` is
 * the active tenant. These touch only global control-plane tables, so handlers
 * use `authHandler` + the services' `globalDb` queries (NOT `tenantHandler`).
 */
export function createTenantRoutes(): Router {
  const router = Router();

  router.get(
    '/current',
    authHandler(async (req: TenantRequest, res: Response) => {
      res.json(await getCurrentTenant(req.tenant!.id));
    })
  );

  router.patch(
    '/current',
    requireTenantAdmin,
    validateBody(tenantRenameSchema),
    authHandler(async (req: TenantRequest, res: Response) => {
      const { name } = req.body as { name: string };
      const tenant = await renameTenant(req.tenant!.id, name);
      logger.info({ userId: req.user!.userId, tenantId: req.tenant!.id }, 'Tenant renamed');
      res.json(tenant);
    })
  );

  // Set/clear the ledger's balance-adjustment merchant (used by the manual
  // "Adjust Balance" action and the SimpleFin auto-rebalance).
  router.patch(
    '/current/balance-adjustment-merchant',
    requireTenantAdmin,
    validateBody(balanceAdjustmentMerchantSchema),
    authHandler(async (req: TenantRequest, res: Response) => {
      const { merchantUuid } = req.body as { merchantUuid: string | null };
      const tenant = await setBalanceAdjustmentMerchant(req.tenant!.id, merchantUuid);
      logger.info(
        { userId: req.user!.userId, tenantId: req.tenant!.id, merchantUuid },
        'Balance adjustment merchant updated'
      );
      res.json(tenant);
    })
  );

  router.get(
    '/current/members',
    authHandler(async (req: TenantRequest, res: Response) => {
      res.json(await listTenantMembers(req.tenant!.id));
    })
  );

  // The people who can open the ledger: its members and its organization's admins,
  // for the pickers that assign one (formerly GET /api/users).
  router.get(
    '/current/users',
    authHandler(async (req: TenantRequest, res: Response) => {
      res.json(await listTenantUsers(req.tenant!.id, req.org!.id));
    })
  );

  // Members of the ledger's organization who aren't in the ledger yet: whom a
  // tenant admin may add below.
  router.get(
    '/current/member-candidates',
    requireTenantAdmin,
    authHandler(async (req: TenantRequest, res: Response) => {
      res.json(await listTenantMemberCandidates(req.tenant!.id, req.org!.id));
    })
  );

  // Only a member of the ledger's organization can be added.
  router.post(
    '/current/members',
    requireTenantAdmin,
    validateBody(addMemberSchema),
    authHandler(async (req: TenantRequest, res: Response) => {
      const { email, isAdmin } = req.body as { email: string; isAdmin: boolean };
      const member = await addTenantMember(req.tenant!.id, req.org!.id, email, isAdmin, req.user!.userId);
      logger.info(
        { userId: req.user!.userId, tenantId: req.tenant!.id, memberUuid: member.uuid },
        'Tenant member added'
      );
      res.status(201).json(member);
    })
  );

  router.patch(
    '/current/members/:uuid',
    requireTenantAdmin,
    validateBody(setMemberAdminSchema),
    authHandler(async (req: TenantRequest, res: Response) => {
      const { isAdmin } = req.body as { isAdmin: boolean };
      await setTenantMemberAdmin(req.tenant!.id, String(req.params.uuid), isAdmin);
      res.json({ success: true });
    })
  );

  router.delete(
    '/current/members/:uuid',
    requireTenantAdmin,
    authHandler(async (req: TenantRequest, res: Response) => {
      await removeTenantMember(req.tenant!.id, String(req.params.uuid));
      logger.info(
        { userId: req.user!.userId, tenantId: req.tenant!.id, memberUuid: String(req.params.uuid) },
        'Tenant member removed'
      );
      res.json({ success: true });
    })
  );

  // Set GLOBAL account flags on a member's user from the ledger members list.
  // requireOrgAdmin → org admins + deployment admins only (NOT tenant-only
  // admins); the flags live on the global users row, so this affects the user
  // across every ledger/org, and an org admin may only change them for someone
  // the organization alone answers for (applyUserAccountFlags).
  router.patch(
    '/current/members/:uuid/flags',
    requireOrgAdmin,
    validateBody(setMemberFlagsSchema),
    authHandler(async (req: TenantRequest, res: Response) => {
      const flags = req.body as { isLocked?: boolean; loginDisabled?: boolean };
      await setTenantMemberFlags(req.tenant!.id, String(req.params.uuid), flags, {
        userId: req.user!.userId,
        isDeploymentAdmin: req.isDeploymentAdmin ?? false,
        organizationId: req.org!.id,
      });
      logger.info(
        { userId: req.user!.userId, tenantId: req.tenant!.id, memberUuid: String(req.params.uuid) },
        'Tenant member account flags updated'
      );
      res.json({ success: true });
    })
  );

  return router;
}
