// The deployment admin's console (/api/admin): the Users page (UserService: accounts, their
// tokens and passkeys) and every organization in the deployment (OrganizationService).
import { Router, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { createLogger } from '../utils/logger.js';
import { setUserDeploymentAdmin } from '../services/DeploymentAdminService.js';
import { validateBody } from '../middleware/validate.js';
import { adminOrgUpdateSchema, createOrgSchema } from '@nuggets/shared';
import {
  assertOrgAdmin,
  createOrganization,
  listOrganizations,
  updateOrganization,
} from '../services/OrganizationService.js';
import {
  createUserByAdmin,
  deleteUserByAdmin,
  listAllUsers,
  listUserPasskeys,
  listUserTokens,
  removeUserPasskey,
  resetPasswordByAdmin,
  revokeUserTokens,
  updateUserByAdmin,
  userIdByUuid,
} from '../services/UserService.js';
import { imageFileFilter, IMAGE_UPLOAD_LIMITS } from '../utils/imageUpload.js';
import { requireWellFormedIds } from '../middleware/routeParams.js';
import { authHandler, type AuthenticatedRequest } from '../utils/routeHandler.js';
import { refuseNulFields } from '../middleware/nulText.js';

const logger = createLogger({ service: 'AdminRoute' });

// Multer configuration for user profile image uploads. Profile images are stored
// in the DB (user_profile_images, one per user) so they ride the backup/restore —
// buffer in memory, don't write to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  // Validate BOTH extension and MIME so a spoofed image/* MIME on an .html/.svg
  // file cannot be stored and later served as executable content (stored XSS).
  fileFilter: imageFileFilter,
  limits: IMAGE_UPLOAD_LIMITS,
});

// The deployment-admin toggle's body: the flag, as a boolean. A body without it used to
// revoke the role, so any PATCH that reached the route demoted its user.
const deploymentAdminBodySchema = z.object({ is_deployment_admin: z.boolean() });

/**
 * The deployment admin's routes, mounted at /api/admin behind authenticateToken and
 * requireDeploymentAdmin (routes.ts). The ledger's own people are
 * GET /api/tenants/current/users. A refusal (a UserError: a 404 for a uuid no user has, a
 * refused change; a ControlPlaneError) propagates to the route wrapper, which answers it
 * as itself, a refused upload 400, and anything else 500 without its text (utils/apiError.ts).
 */
export function createAdminRoutes(): Router {
  const router = Router();

  // Every user in the deployment.
  router.get('/users', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json({ users: await listAllUsers() });
  }));

  // Create a user. The account has no membership until its user accepts an invitation or
  // an admin adds them; they replace the password at first sign-in.
  router.post('/users', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const user = await createUserByAdmin(req.body);
    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        created_at: user.created_at,
      },
    });
  }));

  // Grant or revoke deployment-admin for a user (the repurposed "Administrator"
  // toggle). Deployment-wide privilege; the service guards last-admin + self-demotion.
  router.patch(
    '/users/:uuid/deployment-admin',
    requireWellFormedIds,
    validateBody(deploymentAdminBodySchema),
    authHandler(async (req: AuthenticatedRequest, res: Response) => {
      const makeAdmin = (req.body as z.infer<typeof deploymentAdminBodySchema>).is_deployment_admin;
      const userId = await userIdByUuid(String(req.params.uuid));
      await setUserDeploymentAdmin(userId, makeAdmin, req.user.userId);
      res.json({ success: true, is_deployment_admin: makeAdmin });
    })
  );

  // Update a user: profile, picture, and the lock / sign-in flags. The guards at the
  // mount run before multer, so an unauthenticated request can't make it read a file
  // (auth-before-upload rule).
  router.put(
    '/users/:uuid',
    requireWellFormedIds,
    upload.single('profile_image'),
    refuseNulFields,
    authHandler(async (req: AuthenticatedRequest, res: Response) => {
      const image = req.file ? { mimeType: req.file.mimetype, data: req.file.buffer } : undefined;
      const user = await updateUserByAdmin(String(req.params.uuid), req.body, image, req.user.userId);
      res.json({
        message: 'User updated successfully',
        user,
      });
    })
  );

  // Delete a user.
  router.delete('/users/:uuid', requireWellFormedIds, authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const deletedUser = await deleteUserByAdmin(String(req.params.uuid), req.user.userId);
    res.json({
      message: 'User deleted successfully',
      deletedUser,
    });
  }));

  // Change a user's password. Ends every session and token the user had.
  router.put('/users/:uuid/change-password', requireWellFormedIds, authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const revoked = await resetPasswordByAdmin(String(req.params.uuid), req.body.newPassword, req.user.userId);
    res.json({
      message: 'Password changed successfully',
      ...revoked,
    });
  }));

  // A user's personal access tokens (MCP tokens): list the ones that still work, or
  // revoke them all (e.g. a lost laptop, or a compromised account). Metadata only; a
  // token itself is never stored.
  router.get('/users/:uuid/tokens', requireWellFormedIds, authHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await listUserTokens(String(req.params.uuid)));
  }));

  router.delete('/users/:uuid/tokens', requireWellFormedIds, authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const revokedCount = await revokeUserTokens(String(req.params.uuid), req.user.userId);
    res.json({ message: 'Tokens revoked', revokedCount });
  }));

  // A user's passkeys (was /api/passkeys/admin/user/…): list them, or remove one (a lost
  // device). Never a key. A credential id no passkey can have (a NUL byte) is a 404.
  router.get('/users/:uuid/passkeys', requireWellFormedIds, authHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await listUserPasskeys(String(req.params.uuid)));
  }));

  router.delete(
    '/users/:uuid/passkeys/:credentialId',
    requireWellFormedIds,
    authHandler(async (req: AuthenticatedRequest, res: Response) => {
      await removeUserPasskey(String(req.params.uuid), String(req.params.credentialId), req.user.userId);
      res.json({ success: true, message: 'Passkey deleted' });
    })
  );

  // ==========================================================================
  // Organizations: every organization in the deployment (list, create, suspend,
  // restore, soft-delete). Org-scoped management (members, ledgers) lives under
  // /api/organizations/:uuid; this is the deployment-wide console.
  // ==========================================================================

  router.get('/organizations', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await listOrganizations());
  }));

  // A refusal (a ControlPlaneError) is answered as itself by the route wrapper.
  router.post('/organizations', validateBody(createOrgSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { name, adminEmail } = req.body;
    const org = await createOrganization(name, adminEmail, req.user.userId);
    logger.info({ adminId: req.user.userId, orgUuid: org.uuid }, 'Organization created');
    res.status(201).json(org);
  }));

  router.patch('/organizations/:uuid', validateBody(adminOrgUpdateSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    // Deployment admin → assertOrgAdmin(…, true) just resolves uuid → id (+404).
    const orgId = await assertOrgAdmin(req.user.userId, String(req.params.uuid), true);
    const org = await updateOrganization(orgId, req.body);
    logger.info({ adminId: req.user.userId, orgUuid: req.params.uuid }, 'Organization updated (deployment)');
    res.json(org);
  }));

  return router;
}
