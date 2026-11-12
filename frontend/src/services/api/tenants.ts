/**
 * API — Multi-tenant: the caller's tenants, the active-tenant switch, and
 * tenant-admin management of the active tenant. (base.ts prepends `/api`.) Each answer is
 * parsed with its `@nuggets/shared` schema.
 */
import { apiGet, apiPost, apiPatch, apiDelete } from './base';
import { parseAnswer } from './parseAnswer';
import {
  activeTenantResponseSchema,
  memberCandidateListResponseSchema,
  memberDtoSchema,
  memberListResponseSchema,
  membershipChangedResponseSchema,
  membershipSummarySchema,
  tenantDetailSchema,
  type ActiveTenantResponse,
  type AddMemberInput,
  type TenantDetail,
  type MemberCandidateDto,
  type MemberDto,
  type MembershipSummary,
  type SetMemberFlagsInput,
} from '@nuggets/shared';

/** A change that answers only that it was made. */
const changed = async (answer: Promise<unknown>, name: string): Promise<{ success: true }> =>
  parseAnswer(membershipChangedResponseSchema, await answer, name);

/** The caller's tenants + active tenant + role context (works with none active). */
export const getMyTenants = async (): Promise<MembershipSummary> =>
  parseAnswer(membershipSummarySchema, await apiGet<unknown>('/auth/tenants'), 'ledgers');

/** Switch the browser session's active tenant. */
export const setActiveTenant = async (tenantUuid: string): Promise<ActiveTenantResponse> =>
  parseAnswer(activeTenantResponseSchema, await apiPost<unknown>('/auth/active-tenant', { tenantUuid }), 'active ledger');

export const getCurrentTenant = async (): Promise<TenantDetail> =>
  parseAnswer(tenantDetailSchema, await apiGet<unknown>('/tenants/current'), 'ledger');

export const updateCurrentTenant = async (name: string): Promise<TenantDetail> =>
  parseAnswer(tenantDetailSchema, await apiPatch<unknown>('/tenants/current', { name }), 'ledger saved');

/** Set (or clear, with `null`) the ledger's balance-adjustment merchant. */
export const setBalanceAdjustmentMerchant = async (merchantUuid: string | null): Promise<TenantDetail> =>
  parseAnswer(tenantDetailSchema, await apiPatch<unknown>('/tenants/current/balance-adjustment-merchant', { merchantUuid }), 'ledger saved');

export const getTenantMembers = async (): Promise<MemberDto[]> =>
  parseAnswer(memberListResponseSchema, await apiGet<unknown>('/tenants/current/members'), 'ledger members');

/** Members of the ledger's organization who aren't in the ledger yet (ledger admins). */
export const getTenantMemberCandidates = async (): Promise<MemberCandidateDto[]> =>
  parseAnswer(memberCandidateListResponseSchema, await apiGet<unknown>('/tenants/current/member-candidates'), 'ledger member candidates');

/** Add a member of the ledger's organization to the ledger. */
export const addTenantMember = async (input: AddMemberInput): Promise<MemberDto> =>
  parseAnswer(memberDtoSchema, await apiPost<unknown>('/tenants/current/members', input), 'ledger member added');

export const setTenantMemberAdmin = (uuid: string, isAdmin: boolean): Promise<{ success: true }> =>
  changed(apiPatch<unknown>(`/tenants/current/members/${uuid}`, { isAdmin }), 'ledger admin');

export const removeTenantMember = (uuid: string): Promise<{ success: true }> =>
  changed(apiDelete<unknown>(`/tenants/current/members/${uuid}`), 'ledger member removed');

/** Set GLOBAL account flags (is_locked / login_disabled) on a ledger member's user. */
export const setTenantMemberFlags = (uuid: string, flags: SetMemberFlagsInput): Promise<{ success: true }> =>
  changed(apiPatch<unknown>(`/tenants/current/members/${uuid}/flags`, flags), 'ledger member flags');
