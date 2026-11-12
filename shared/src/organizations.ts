import { z } from 'zod';
import { QUERY_MAX_PAGE, queryInt, uuid } from './primitives.js';
import { instant, nullableInstant } from './responses.js';

/**
 * Multi-tenant management types.
 *
 * A "tenant" is a household's ledger; an "organization" groups tenants. The
 * underlying control-plane tables are global (no RLS); access is enforced in the
 * backend services. These schemas validate the management endpoints' request
 * bodies server-side and are reused by the management forms on the client.
 */

// ---- Status + role enums --------------------------------------------------

export const organizationStatus = z.enum(['active', 'suspended', 'deleted']);
export type OrganizationStatus = z.infer<typeof organizationStatus>;

export const tenantStatus = z.enum(['active', 'suspended', 'deleted']);
export type TenantStatus = z.infer<typeof tenantStatus>;

/** Effective role a user holds on a tenant or organization. */
export const memberRole = z.enum(['admin', 'member']);
export type MemberRole = z.infer<typeof memberRole>;
export type TenantRole = MemberRole;
export type OrgRole = MemberRole;

export const deploymentRole = z.enum(['admin', 'support']);
export type DeploymentRole = z.infer<typeof deploymentRole>;

// ---- Request bodies (validated server-side, reused by client forms) --------

const nameField = z
  .string({ error: 'Name is required' })
  .trim()
  .min(1, 'Name is required')
  .max(100, 'Name must be 100 characters or less');

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Valid email is required' }));

/** POST /api/auth/active-tenant */
export const setActiveTenantSchema = z.object({ tenantUuid: uuid });
export type SetActiveTenantInput = z.infer<typeof setActiveTenantSchema>;

/** PATCH /api/tenants/current */
export const tenantRenameSchema = z.object({ name: nameField });
export type TenantRenameInput = z.infer<typeof tenantRenameSchema>;

/**
 * PATCH /api/tenants/current/balance-adjustment-merchant
 * `merchantUuid: null` clears the ledger's balance-adjustment merchant.
 */
export const balanceAdjustmentMerchantSchema = z.object({ merchantUuid: uuid.nullable() });
export type BalanceAdjustmentMerchantInput = z.infer<typeof balanceAdjustmentMerchantSchema>;

/** POST /api/organizations/:uuid/tenants */
export const createTenantSchema = z.object({ name: nameField });
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

/**
 * POST /api/tenants/current/members (the person must already be a member of the
 * ledger's organization) and POST /api/organizations/:uuid/members (deployment
 * admins only; an organization's own admins invite instead).
 */
export const addMemberSchema = z.object({
  email: emailField,
  isAdmin: z.boolean().optional().default(false),
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;

/** POST /api/organizations/:uuid/invitations */
export const createInvitationSchema = z.object({
  email: emailField,
  isAdmin: z.boolean().optional().default(false),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

/** The one-time secret in an invitation link: 32 random bytes, base64url. */
export const invitationToken = z
  .string({ error: 'This invitation link isn’t complete.' })
  .regex(/^[A-Za-z0-9_-]{43}$/, 'This invitation link isn’t complete.');

/** POST /api/invitations/inspect and POST /api/invitations/accept */
export const invitationTokenSchema = z.object({ token: invitationToken });
export type InvitationTokenInput = z.infer<typeof invitationTokenSchema>;

/** PATCH …/members/:uuid */
export const setMemberAdminSchema = z.object({ isAdmin: z.boolean() });
export type SetMemberAdminInput = z.infer<typeof setMemberAdminSchema>;

/**
 * PATCH …/members/:uuid/flags — set GLOBAL account flags on the member's user
 * (is_locked / login_disabled). At least one flag must be supplied. Authorized
 * for organization admins and deployment admins (not tenant-only admins); an
 * organization admin only for a person whose every membership is in that
 * organization and who isn't a deployment admin.
 */
export const setMemberFlagsSchema = z
  .object({
    isLocked: z.boolean().optional(),
    loginDisabled: z.boolean().optional(),
  })
  .refine((v) => v.isLocked !== undefined || v.loginDisabled !== undefined, {
    message: 'Provide at least one flag to change.',
  });
export type SetMemberFlagsInput = z.infer<typeof setMemberFlagsSchema>;

/**
 * PATCH /api/organizations/:uuid (org admins). Only the name: suspending or deleting an
 * organization is the deployment admin's control, so its own admins can't undo it.
 */
export const orgUpdateSchema = z.strictObject({
  name: nameField,
});
export type OrgUpdateInput = z.infer<typeof orgUpdateSchema>;

/** PATCH /api/admin/organizations/:uuid (deployment admins) */
export const adminOrgUpdateSchema = z.object({
  name: nameField.optional(),
  status: organizationStatus.optional(),
});
export type AdminOrgUpdateInput = z.infer<typeof adminOrgUpdateSchema>;

/** POST /api/admin/organizations */
export const createOrgSchema = z.object({
  name: nameField,
  adminEmail: emailField.optional(),
});
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

// ---- Query strings -----------------------------------------------------------

/**
 * GET /api/organizations/:uuid/price-sync/runs: a page of the organization's price-sync
 * runs, newest first, by offset (as the backend's pagination.ts offsetParams reads it: a
 * value that isn't a number falls back, a limit past 100 is 100).
 */
export const priceSyncRunsQuery = z.object({
  limit: queryInt({ min: 1, max: 100, default: 50 }),
  offset: queryInt({ min: 0, max: QUERY_MAX_PAGE * 100, default: 0 }),
});

// ---- Response DTOs (strict schemas, the types inferred from them) -----------------

export const memberUserDtoSchema = z.object({
  uuid: z.uuid(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  profileImage: z.string().nullable(),
  isLocked: z.boolean(),
  loginDisabled: z.boolean(),
});
export type MemberUserDto = z.infer<typeof memberUserDtoSchema>;

/** A membership row (tenant_users or organization_users). `uuid` is the row's. */
export const memberDtoSchema = z.object({
  uuid: z.uuid(),
  isAdmin: z.boolean(),
  createdAt: nullableInstant,
  user: memberUserDtoSchema,
});
export type MemberDto = z.infer<typeof memberDtoSchema>;
export const memberListResponseSchema = z.array(memberDtoSchema);

/** A member of the ledger's organization who isn't in the ledger yet (GET /api/tenants/current/member-candidates). */
export const memberCandidateDtoSchema = z.object({
  userUuid: z.uuid(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
});
export type MemberCandidateDto = z.infer<typeof memberCandidateDtoSchema>;
export const memberCandidateListResponseSchema = z.array(memberCandidateDtoSchema);

/** An invitation that hasn't been accepted or revoked. `expired` ones can't be accepted. */
export const invitationStatus = z.enum(['pending', 'expired']);
export type InvitationStatus = z.infer<typeof invitationStatus>;

const invitedByDto = z.object({ firstName: z.string().nullable(), lastName: z.string().nullable() }).nullable();

/** GET /api/organizations/:uuid/invitations row. The token is never part of it. */
export const invitationDtoSchema = z.object({
  uuid: z.uuid(),
  email: z.string(),
  isAdmin: z.boolean(),
  status: invitationStatus,
  createdAt: instant,
  expiresAt: instant,
  invitedBy: invitedByDto,
});
export type InvitationDto = z.infer<typeof invitationDtoSchema>;
export const invitationListResponseSchema = z.array(invitationDtoSchema);

/**
 * POST /api/organizations/:uuid/invitations. `token` goes in the link the admin
 * shares; it is shown only here and can't be read back.
 */
export const createdInvitationDtoSchema = z.object({
  invitation: invitationDtoSchema,
  token: z.string(),
});
export type CreatedInvitationDto = z.infer<typeof createdInvitationDtoSchema>;

const organizationRef = z.object({ uuid: z.uuid(), name: z.string() });

/** POST /api/invitations/inspect: what accepting would do, for the invited person only. */
export const invitationPreviewDtoSchema = z.object({
  organization: organizationRef,
  email: z.string(),
  isAdmin: z.boolean(),
  expiresAt: instant,
  invitedBy: invitedByDto,
  alreadyMember: z.boolean(),
});
export type InvitationPreviewDto = z.infer<typeof invitationPreviewDtoSchema>;

/** POST /api/invitations/accept */
export const acceptedInvitationDtoSchema = z.object({
  organization: organizationRef,
  isAdmin: z.boolean(),
});
export type AcceptedInvitationDto = z.infer<typeof acceptedInvitationDtoSchema>;

/** A tenant the caller can access, with their effective role on it. */
export const tenantSummarySchema = z.object({
  uuid: z.uuid(),
  name: z.string(),
  status: tenantStatus,
  organizationUuid: z.uuid(),
  organizationName: z.string(),
  role: memberRole,
  isActiveTenant: z.boolean(),
});
export type TenantSummary = z.infer<typeof tenantSummarySchema>;

/** An organization the caller belongs to, with their role in it. */
export const organizationSummarySchema = z.object({
  uuid: z.uuid(),
  name: z.string(),
  status: organizationStatus,
  role: memberRole,
});
export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;

/** The active tenant, as the switcher names it. */
export const activeTenantSchema = z.object({
  uuid: z.uuid(),
  name: z.string(),
  organizationUuid: z.uuid(),
  organizationName: z.string(),
});

/** Everything the client needs to render the switcher + role-gated settings (GET /api/auth/tenants, and /me's `membership`). */
export const membershipSummarySchema = z.object({
  isDeploymentAdmin: z.boolean(),
  activeTenant: activeTenantSchema.nullable(),
  tenantRole: memberRole.nullable(),
  orgRole: memberRole.nullable(),
  tenants: z.array(tenantSummarySchema),
  organizations: z.array(organizationSummarySchema),
});
export type MembershipSummary = z.infer<typeof membershipSummarySchema>;

/** POST /api/auth/active-tenant: the tenant the session now acts in. */
export const activeTenantResponseSchema = z.object({ activeTenant: activeTenantSchema.nullable() });
export type ActiveTenantResponse = z.infer<typeof activeTenantResponseSchema>;

/** GET /api/tenants/current, and the answer of its renames. */
export const tenantDetailSchema = z.object({
  uuid: z.uuid(),
  name: z.string(),
  status: tenantStatus,
  organization: organizationRef,
  memberCount: z.number().int(),
  /** Merchant assigned to balance-adjustment transactions; null when unset. */
  balanceAdjustmentMerchant: organizationRef.nullable(),
});
export type TenantDetail = z.infer<typeof tenantDetailSchema>;

/** A tenant within an organization (org-admin view). */
export const orgTenantSummarySchema = z.object({
  uuid: z.uuid(),
  name: z.string(),
  status: tenantStatus,
  memberCount: z.number().int(),
});
export type OrgTenantSummary = z.infer<typeof orgTenantSummarySchema>;

/** GET /api/organizations/:uuid, its edits' answers, and a deployment admin's create and edit. */
export const organizationDetailSchema = z.object({
  uuid: z.uuid(),
  name: z.string(),
  status: organizationStatus,
  tenants: z.array(orgTenantSummarySchema),
  memberCount: z.number().int(),
});
export type OrganizationDetail = z.infer<typeof organizationDetailSchema>;

/** GET /api/admin/organizations row (deployment-wide). */
export const organizationListItemSchema = z.object({
  uuid: z.uuid(),
  name: z.string(),
  status: organizationStatus,
  tenantCount: z.number().int(),
  memberCount: z.number().int(),
});
export type OrganizationListItem = z.infer<typeof organizationListItemSchema>;
export const organizationListResponseSchema = z.array(organizationListItemSchema);

/** POST /api/organizations/:uuid/tenants (201): the new tenant. */
export const createdTenantResponseSchema = z.object({ uuid: z.uuid() });

/**
 * A membership change, an invitation revoked, an account's flags set, an organization's
 * SimpleFin connection removed: done.
 */
export const membershipChangedResponseSchema = z.object({ success: z.literal(true) });
