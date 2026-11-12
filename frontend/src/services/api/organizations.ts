/**
 * API — Organizations: org-admin management (by org uuid) plus the
 * deployment-admin console (/admin/organizations). (base.ts prepends `/api`.) Each answer
 * is parsed with its `@nuggets/shared` schema.
 */
import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from './base';
import { parseAnswer } from './parseAnswer';
import {
  acceptedInvitationDtoSchema,
  createdInvitationDtoSchema,
  createdTenantResponseSchema,
  invitationListResponseSchema,
  invitationPreviewDtoSchema,
  memberDtoSchema,
  memberListResponseSchema,
  membershipChangedResponseSchema,
  organizationDetailSchema,
  organizationListResponseSchema,
  priceSyncRunResultResponseSchema,
  priceSyncRunsQuery,
  priceSyncRunsResponseSchema,
  priceSyncSettingsResponseSchema,
  queryString,
  simpleFinConnectionDtoSchema,
  type AcceptedInvitationDto,
  type AddMemberInput,
  type AdminOrgUpdateInput,
  type CreatedInvitationDto,
  type CreateInvitationInput,
  type CreateOrgInput,
  type CreateSimpleFinConnectionInput,
  type InvitationDto,
  type InvitationPreviewDto,
  type MemberDto,
  type OrganizationDetail,
  type OrganizationListItem,
  type OrgUpdateInput,
  type PriceSyncRunResult,
  type PriceSyncRuns,
  type PriceSyncSettings,
  type PriceSyncSettingsUpdateInput,
  type SetMemberFlagsInput,
  type SimpleFinConnectionDto,
} from '@nuggets/shared';

/** A change that answers only that it was made. */
const changed = async (answer: Promise<unknown>, name: string): Promise<{ success: true }> =>
  parseAnswer(membershipChangedResponseSchema, await answer, name);

// ---- Org-admin (addressed by org uuid) ------------------------------------

export const getOrganization = async (uuid: string): Promise<OrganizationDetail> =>
  parseAnswer(organizationDetailSchema, await apiGet<unknown>(`/organizations/${uuid}`), 'organization');

export const updateOrganization = async (uuid: string, body: OrgUpdateInput): Promise<OrganizationDetail> =>
  parseAnswer(organizationDetailSchema, await apiPatch<unknown>(`/organizations/${uuid}`, body), 'organization saved');

export const createOrgBudget = async (uuid: string, name: string): Promise<{ uuid: string }> =>
  parseAnswer(createdTenantResponseSchema, await apiPost<unknown>(`/organizations/${uuid}/tenants`, { name }), 'ledger created');

export const getOrgMembers = async (uuid: string): Promise<MemberDto[]> =>
  parseAnswer(memberListResponseSchema, await apiGet<unknown>(`/organizations/${uuid}/members`), 'organization members');

/** Add an existing user directly (deployment admins only; org admins invite). */
export const addOrgMember = async (uuid: string, input: AddMemberInput): Promise<MemberDto> =>
  parseAnswer(memberDtoSchema, await apiPost<unknown>(`/organizations/${uuid}/members`, input), 'organization member added');

export const setOrgMemberAdmin = (uuid: string, memberUuid: string, isAdmin: boolean): Promise<{ success: true }> =>
  changed(apiPatch<unknown>(`/organizations/${uuid}/members/${memberUuid}`, { isAdmin }), 'organization admin');

export const removeOrgMember = (uuid: string, memberUuid: string): Promise<{ success: true }> =>
  changed(apiDelete<unknown>(`/organizations/${uuid}/members/${memberUuid}`), 'organization member removed');

/** Set GLOBAL account flags (is_locked / login_disabled) on an org member's user. */
export const setOrgMemberFlags = (uuid: string, memberUuid: string, flags: SetMemberFlagsInput): Promise<{ success: true }> =>
  changed(apiPatch<unknown>(`/organizations/${uuid}/members/${memberUuid}/flags`, flags), 'organization member flags');

// ---- Invitations ----------------------------------------------------

/** The organization's invitations that haven't been accepted or revoked. */
export const getOrgInvitations = async (uuid: string): Promise<InvitationDto[]> =>
  parseAnswer(invitationListResponseSchema, await apiGet<unknown>(`/organizations/${uuid}/invitations`), 'invitations');

/** Invite an email address. The response's `token` is shown once, for the link. */
export const createOrgInvitation = async (uuid: string, input: CreateInvitationInput): Promise<CreatedInvitationDto> =>
  parseAnswer(createdInvitationDtoSchema, await apiPost<unknown>(`/organizations/${uuid}/invitations`, input), 'invitation');

export const revokeOrgInvitation = (uuid: string, invitationUuid: string): Promise<{ success: true }> =>
  changed(apiDelete<unknown>(`/organizations/${uuid}/invitations/${invitationUuid}`), 'invitation revoked');

/** The invited person's side: what an invitation is for (only for its addressee). */
export const inspectInvitation = async (token: string): Promise<InvitationPreviewDto> =>
  parseAnswer(invitationPreviewDtoSchema, await apiPost<unknown>('/invitations/inspect', { token }), 'invitation preview');

export const acceptInvitation = async (token: string): Promise<AcceptedInvitationDto> =>
  parseAnswer(acceptedInvitationDtoSchema, await apiPost<unknown>('/invitations/accept', { token }), 'invitation accepted');

// ---- Org-level SimpleFin connection --------------------------

/** The org's SimpleFin connection (metadata only), or null if none configured. */
export const getOrgSimpleFinConnection = async (uuid: string): Promise<SimpleFinConnectionDto | null> =>
  parseAnswer(simpleFinConnectionDtoSchema.nullable(), await apiGet<unknown>(`/organizations/${uuid}/simplefin/connection`), 'SimpleFin connection');

/** Create/replace the org's connection from a SimpleFin setup token. */
export const saveOrgSimpleFinConnection = async (
  uuid: string,
  input: CreateSimpleFinConnectionInput,
): Promise<SimpleFinConnectionDto> =>
  parseAnswer(simpleFinConnectionDtoSchema, await apiPost<unknown>(`/organizations/${uuid}/simplefin/connection`, input), 'SimpleFin connection saved');

/** Remove the org's connection and unlink its accounts across all ledgers. */
export const deleteOrgSimpleFinConnection = (uuid: string): Promise<{ success: true }> =>
  changed(apiDelete<unknown>(`/organizations/${uuid}/simplefin/connection`), 'SimpleFin connection removed');

// ---- Investment price sync (org-scoped scheduled EOD price fetch) ----------
// Its answers are @nuggets/shared's (investmentResponses.ts), parsed with their schemas.

export type { PriceSyncRun, PriceSyncSettings } from '@nuggets/shared';

export const getPriceSyncSettings = async (uuid: string): Promise<PriceSyncSettings> =>
  parseAnswer(priceSyncSettingsResponseSchema, await apiGet<unknown>(`/organizations/${uuid}/price-sync/settings`), 'price-sync settings');
export const updatePriceSyncSettings = async (uuid: string, input: PriceSyncSettingsUpdateInput): Promise<PriceSyncSettings> =>
  parseAnswer(priceSyncSettingsResponseSchema, await apiPut<unknown>(`/organizations/${uuid}/price-sync/settings`, input), 'price-sync settings saved');
export const runPriceSync = async (uuid: string): Promise<PriceSyncRunResult> =>
  parseAnswer(priceSyncRunResultResponseSchema, await apiPost<unknown>(`/organizations/${uuid}/price-sync/run`, {}), 'price-sync run');
export const getPriceSyncRuns = async (uuid: string, limit = 50, offset = 0): Promise<PriceSyncRuns> =>
  parseAnswer(
    priceSyncRunsResponseSchema,
    await apiGet<unknown>(`/organizations/${uuid}/price-sync/runs${queryString(priceSyncRunsQuery, { limit, offset })}`),
    'price-sync runs',
  );

// ---- Deployment-admin console ---------------------------------------------

export const listAllOrganizations = async (): Promise<OrganizationListItem[]> =>
  parseAnswer(organizationListResponseSchema, await apiGet<unknown>('/admin/organizations'), 'organizations');

export const createOrganization = async (input: CreateOrgInput): Promise<OrganizationDetail> =>
  parseAnswer(organizationDetailSchema, await apiPost<unknown>('/admin/organizations', input), 'organization created');

export const updateOrganizationAdmin = async (uuid: string, body: AdminOrgUpdateInput): Promise<OrganizationDetail> =>
  parseAnswer(organizationDetailSchema, await apiPatch<unknown>(`/admin/organizations/${uuid}`, body), 'organization saved');
