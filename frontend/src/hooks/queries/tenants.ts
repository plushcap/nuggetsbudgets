import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getCurrentTenant,
  getTenantMembers,
  getTenantMemberCandidates,
  updateCurrentTenant,
  addTenantMember,
  setTenantMemberAdmin,
  setTenantMemberFlags,
  removeTenantMember,
  setBalanceAdjustmentMerchant,
} from '../../services/api';
import { tenantKeys } from './keys';
import type { AddMemberInput, SetMemberFlagsInput } from '@nuggets/shared';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

export function useCurrentTenantQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: tenantKeys.current(), queryFn: getCurrentTenant, ...options });
}

export function useTenantMembersQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: tenantKeys.members(), queryFn: getTenantMembers, ...options });
}

/** Members of the ledger's organization who aren't in the ledger yet (ledger admins only). */
export function useTenantMemberCandidatesQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: tenantKeys.memberCandidates(), queryFn: getTenantMemberCandidates, ...options });
}

// Member/rename changes ripple to the tenant detail, the member list, AND the
// membership summary that feeds the switcher (all under tenantKeys.all).
function useInvalidateTenant() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: tenantKeys.all });
}

export function useRenameTenantMutation() {
  const invalidate = useInvalidateTenant();
  return useMutation({ mutationFn: (name: string) => updateCurrentTenant(name), onSuccess: invalidate });
}

export function useAddTenantMemberMutation() {
  const invalidate = useInvalidateTenant();
  return useMutation({ mutationFn: (input: AddMemberInput) => addTenantMember(input), onSuccess: invalidate });
}

export function useSetTenantMemberAdminMutation() {
  const invalidate = useInvalidateTenant();
  return useMutation({
    mutationFn: ({ uuid, isAdmin }: { uuid: string; isAdmin: boolean }) => setTenantMemberAdmin(uuid, isAdmin),
    onSuccess: invalidate,
  });
}

export function useRemoveTenantMemberMutation() {
  const invalidate = useInvalidateTenant();
  return useMutation({ mutationFn: (uuid: string) => removeTenantMember(uuid), onSuccess: invalidate });
}

/** Set/clear the ledger's balance-adjustment merchant. Pass `null` to clear. */
export function useSetBalanceAdjustmentMerchantMutation() {
  const invalidate = useInvalidateTenant();
  return useMutation({
    mutationFn: (merchantUuid: string | null) => setBalanceAdjustmentMerchant(merchantUuid),
    onSuccess: invalidate,
  });
}

export function useSetTenantMemberFlagsMutation() {
  const invalidate = useInvalidateTenant();
  return useMutation({
    mutationFn: ({ uuid, flags }: { uuid: string; flags: SetMemberFlagsInput }) => setTenantMemberFlags(uuid, flags),
    onSuccess: invalidate,
  });
}
