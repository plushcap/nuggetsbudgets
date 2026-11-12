import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getOrganization,
  getOrgMembers,
  updateOrganization,
  createOrgBudget,
  addOrgMember,
  setOrgMemberAdmin,
  setOrgMemberFlags,
  removeOrgMember,
  getOrgInvitations,
  createOrgInvitation,
  revokeOrgInvitation,
  inspectInvitation,
  acceptInvitation,
  listAllOrganizations,
  createOrganization,
  updateOrganizationAdmin,
  getOrgSimpleFinConnection,
  saveOrgSimpleFinConnection,
  deleteOrgSimpleFinConnection,
  getPriceSyncSettings,
  updatePriceSyncSettings,
  runPriceSync,
  getPriceSyncRuns,
} from '../../services/api';
import { organizationKeys, tenantKeys, accountKeys } from './keys';
import type {
  AddMemberInput,
  AdminOrgUpdateInput,
  CreateInvitationInput,
  CreateOrgInput,
  CreateSimpleFinConnectionInput,
  OrgUpdateInput,
  SetMemberFlagsInput,
} from '@nuggets/shared';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

export function useOrganizationQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({
    queryKey: organizationKeys.detail(uuid ?? ''),
    queryFn: () => getOrganization(uuid as string),
    enabled: !!uuid,
    ...options,
  });
}

export function useOrgMembersQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({
    queryKey: organizationKeys.members(uuid ?? ''),
    queryFn: () => getOrgMembers(uuid as string),
    enabled: !!uuid,
    ...options,
  });
}

export function useAllOrganizationsQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: organizationKeys.list(), queryFn: listAllOrganizations, ...options });
}

// Org changes ripple to the org detail/members, the deployment list, AND the
// membership summary feeding the switcher (creating a budget, renames).
function useInvalidateOrgs() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: organizationKeys.all });
    void qc.invalidateQueries({ queryKey: tenantKeys.all });
  };
}

export function useUpdateOrganizationMutation() {
  const invalidate = useInvalidateOrgs();
  return useMutation({
    mutationFn: ({ uuid, body }: { uuid: string; body: OrgUpdateInput }) => updateOrganization(uuid, body),
    onSuccess: invalidate,
  });
}

export function useCreateOrgBudgetMutation() {
  const invalidate = useInvalidateOrgs();
  return useMutation({
    mutationFn: ({ uuid, name }: { uuid: string; name: string }) => createOrgBudget(uuid, name),
    onSuccess: invalidate,
  });
}

export function useAddOrgMemberMutation() {
  const invalidate = useInvalidateOrgs();
  return useMutation({
    mutationFn: ({ uuid, input }: { uuid: string; input: AddMemberInput }) => addOrgMember(uuid, input),
    onSuccess: invalidate,
  });
}

export function useSetOrgMemberAdminMutation() {
  const invalidate = useInvalidateOrgs();
  return useMutation({
    mutationFn: ({ uuid, memberUuid, isAdmin }: { uuid: string; memberUuid: string; isAdmin: boolean }) =>
      setOrgMemberAdmin(uuid, memberUuid, isAdmin),
    onSuccess: invalidate,
  });
}

export function useRemoveOrgMemberMutation() {
  const invalidate = useInvalidateOrgs();
  return useMutation({
    mutationFn: ({ uuid, memberUuid }: { uuid: string; memberUuid: string }) => removeOrgMember(uuid, memberUuid),
    onSuccess: invalidate,
  });
}

export function useSetOrgMemberFlagsMutation() {
  const invalidate = useInvalidateOrgs();
  return useMutation({
    mutationFn: ({ uuid, memberUuid, flags }: { uuid: string; memberUuid: string; flags: SetMemberFlagsInput }) =>
      setOrgMemberFlags(uuid, memberUuid, flags),
    onSuccess: invalidate,
  });
}

// ---- Invitations ----------------------------------------------------

export function useOrgInvitationsQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({
    queryKey: organizationKeys.invitations(uuid ?? ''),
    queryFn: () => getOrgInvitations(uuid as string),
    enabled: !!uuid,
    ...options,
  });
}

export function useCreateOrgInvitationMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, input }: { uuid: string; input: CreateInvitationInput }) => createOrgInvitation(uuid, input),
    onSuccess: (_data, { uuid }) => void qc.invalidateQueries({ queryKey: organizationKeys.invitations(uuid) }),
  });
}

export function useRevokeOrgInvitationMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, invitationUuid }: { uuid: string; invitationUuid: string }) =>
      revokeOrgInvitation(uuid, invitationUuid),
    onSuccess: (_data, { uuid }) => void qc.invalidateQueries({ queryKey: organizationKeys.invitations(uuid) }),
  });
}

/**
 * What an invitation link is for, for the signed-in person it was sent to. Asked
 * once: each look counts against the invitation endpoints' rate limit, and once the
 * invitation is accepted it can't be looked at again. So its key is outside
 * `organizationKeys.all`, which accepting invalidates.
 */
export function useInvitationPreviewQuery(token: string, options?: QueryOverrides) {
  return useQuery({
    queryKey: ['invitationPreview', token] as const,
    queryFn: () => inspectInvitation(token),
    retry: false,
    staleTime: Infinity,
    refetchOnReconnect: false,
    meta: { suppressErrorToast: true },
    ...options,
  });
}

/** Accept an invitation: the person joins the organization, so their ledgers and roles change. */
export function useAcceptInvitationMutation() {
  const invalidate = useInvalidateOrgs();
  return useMutation({ mutationFn: (token: string) => acceptInvitation(token), onSuccess: invalidate });
}

// ---- Deployment-admin console ---------------------------------------------

export function useCreateOrganizationMutation() {
  const invalidate = useInvalidateOrgs();
  return useMutation({ mutationFn: (input: CreateOrgInput) => createOrganization(input), onSuccess: invalidate });
}

export function useUpdateOrganizationAdminMutation() {
  const invalidate = useInvalidateOrgs();
  return useMutation({
    mutationFn: ({ uuid, body }: { uuid: string; body: AdminOrgUpdateInput }) => updateOrganizationAdmin(uuid, body),
    onSuccess: invalidate,
  });
}

// ---- Org SimpleFin connection --------------------------------

export function useOrgSimpleFinConnectionQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({
    queryKey: organizationKeys.simplefin(uuid ?? ''),
    queryFn: () => getOrgSimpleFinConnection(uuid as string),
    enabled: !!uuid,
    ...options,
  });
}

export function useSaveOrgSimpleFinConnectionMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, input }: { uuid: string; input: CreateSimpleFinConnectionInput }) =>
      saveOrgSimpleFinConnection(uuid, input),
    onSuccess: (_data, { uuid }) => {
      void qc.invalidateQueries({ queryKey: organizationKeys.simplefin(uuid) });
    },
  });
}

export function useDeleteOrgSimpleFinConnectionMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (uuid: string) => deleteOrgSimpleFinConnection(uuid),
    onSuccess: (_data, uuid) => {
      void qc.invalidateQueries({ queryKey: organizationKeys.simplefin(uuid) });
      // Disconnecting unlinks accounts across the org's ledgers.
      void qc.invalidateQueries({ queryKey: accountKeys.all });
    },
  });
}

// ---- Investment price sync -------------------------------------------------

export function usePriceSyncSettingsQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({
    queryKey: organizationKeys.priceSync(uuid ?? ''),
    queryFn: () => getPriceSyncSettings(uuid as string),
    enabled: !!uuid,
    ...options,
  });
}

export function usePriceSyncRunsQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({
    queryKey: organizationKeys.priceSyncRuns(uuid ?? ''),
    queryFn: () => getPriceSyncRuns(uuid as string),
    enabled: !!uuid,
    ...options,
  });
}

export function useUpdatePriceSyncSettingsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, input }: { uuid: string; input: { enabled?: boolean; schedule_time?: string; timezone?: string } }) =>
      updatePriceSyncSettings(uuid, input),
    onSuccess: (_data, { uuid }) => void qc.invalidateQueries({ queryKey: organizationKeys.priceSync(uuid) }),
  });
}

export function useRunPriceSyncMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (uuid: string) => runPriceSync(uuid),
    onSuccess: (_data, uuid) => {
      void qc.invalidateQueries({ queryKey: organizationKeys.priceSyncRuns(uuid) });
      void qc.invalidateQueries({ queryKey: organizationKeys.priceSync(uuid) });
    },
  });
}
