import { useQuery, useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { Merchant, MerchantLite } from '../../services/api';
import {
  // institutions
  getInstitutions, getInstitution, createInstitution, updateInstitution, deleteInstitution,
  // categories
  getCategories, createCategory, updateCategory, deleteCategory,
  // merchants
  getMerchants, getPaginatedMerchants, getMerchant, createMerchant, updateMerchant, deleteMerchant,
  getMerchantRules, createMerchantRule, updateMerchantRule, deleteMerchantRule,
  // tags
  getTags, getTag, createTag, updateTag, deleteTag, getReportRoots, updateTagReportRoot,
  getBudgetItemTags, addTagToBudgetItem, removeTagFromBudgetItem,
  getTagSummary, getTagTransactions, getTagBreakdown, getTagTimeseries,
} from '../../services/api';
import {
  institutionKeys, accountKeys, categoryKeys, merchantKeys, tagKeys, transactionKeys,
} from './keys';

/**
 * Shared hooks for the "reference data" domains: institutions, categories,
 * merchants, tags. These lists are looked up by many screens (selectors,
 * forms), so sharing query keys here means one fetch per screen instead of
 * one per page. Reference data changes rarely → longer staleTime.
 */

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };
const REFERENCE_STALE_TIME = 5 * 60_000;

// ---------------------------------------------------------------- institutions

export function useInstitutionsQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: institutionKeys.list(), queryFn: getInstitutions, staleTime: REFERENCE_STALE_TIME, ...options });
}
export function useInstitutionQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({ queryKey: institutionKeys.detail(uuid ?? ''), queryFn: () => getInstitution(uuid as string), enabled: !!uuid, ...options });
}
function useInvalidateInstitutions() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: institutionKeys.all });
    void qc.invalidateQueries({ queryKey: accountKeys.all });
  };
}
export function useCreateInstitutionMutation() {
  const invalidate = useInvalidateInstitutions();
  return useMutation({ mutationFn: (data: Parameters<typeof createInstitution>[0]) => createInstitution(data), onSuccess: invalidate });
}
export function useUpdateInstitutionMutation() {
  const invalidate = useInvalidateInstitutions();
  return useMutation({ mutationFn: ({ uuid, data }: { uuid: string; data: Parameters<typeof updateInstitution>[1] }) => updateInstitution(uuid, data), onSuccess: invalidate });
}
export function useDeleteInstitutionMutation() {
  const invalidate = useInvalidateInstitutions();
  return useMutation({ mutationFn: (uuid: string) => deleteInstitution(uuid), onSuccess: invalidate });
}

// ------------------------------------------------------------------ categories

export function useCategoriesQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: categoryKeys.list(), queryFn: getCategories, staleTime: REFERENCE_STALE_TIME, ...options });
}
function useInvalidateCategories() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: categoryKeys.all });
    void qc.invalidateQueries({ queryKey: transactionKeys.all });
  };
}
export function useCreateCategoryMutation() {
  const invalidate = useInvalidateCategories();
  return useMutation({ mutationFn: (data: Parameters<typeof createCategory>[0]) => createCategory(data), onSuccess: invalidate });
}
export function useUpdateCategoryMutation() {
  const invalidate = useInvalidateCategories();
  return useMutation({ mutationFn: ({ uuid, data }: { uuid: string; data: Parameters<typeof updateCategory>[1] }) => updateCategory(uuid, data), onSuccess: invalidate });
}
export function useDeleteCategoryMutation() {
  const invalidate = useInvalidateCategories();
  return useMutation({ mutationFn: (uuid: string) => deleteCategory(uuid), onSuccess: invalidate });
}

// ------------------------------------------------------------------- merchants

/** The ledger's merchants: `{ lite: true }` answers only what a selector needs (MerchantLite). */
export function useMerchantsQuery(opts: { lite: true }, options?: QueryOverrides): UseQueryResult<MerchantLite[]>;
export function useMerchantsQuery(opts?: { lite?: false }, options?: QueryOverrides): UseQueryResult<Merchant[]>;
export function useMerchantsQuery(opts?: { lite?: boolean }, options?: QueryOverrides): UseQueryResult<Merchant[] | MerchantLite[]> {
  return useQuery({ queryKey: [...merchantKeys.list(), opts ?? {}], queryFn: () => getMerchants(opts), staleTime: REFERENCE_STALE_TIME, ...options });
}
export function usePaginatedMerchantsQuery(
  params: { page: number; limit: number; search?: string },
  options?: QueryOverrides,
) {
  return useQuery({
    queryKey: [...merchantKeys.all, 'paginated', params],
    queryFn: () => getPaginatedMerchants(params.page, params.limit, params.search),
    ...options,
  });
}
export function useMerchantQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({ queryKey: merchantKeys.detail(uuid ?? ''), queryFn: () => getMerchant(uuid as string), enabled: !!uuid, ...options });
}
export function useMerchantRulesQuery(merchantUuid: string | undefined, options?: QueryOverrides) {
  return useQuery({ queryKey: [...merchantKeys.detail(merchantUuid ?? ''), 'rules'], queryFn: () => getMerchantRules(merchantUuid as string), enabled: !!merchantUuid, ...options });
}
function useInvalidateMerchants() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: merchantKeys.all });
    void qc.invalidateQueries({ queryKey: transactionKeys.all });
  };
}
export function useCreateMerchantMutation() {
  const invalidate = useInvalidateMerchants();
  return useMutation({ mutationFn: (data: Parameters<typeof createMerchant>[0]) => createMerchant(data), onSuccess: invalidate });
}
export function useUpdateMerchantMutation() {
  const invalidate = useInvalidateMerchants();
  return useMutation({ mutationFn: ({ uuid, data }: { uuid: string; data: Parameters<typeof updateMerchant>[1] }) => updateMerchant(uuid, data), onSuccess: invalidate });
}
export function useDeleteMerchantMutation() {
  const invalidate = useInvalidateMerchants();
  return useMutation({ mutationFn: ({ uuid, replacementMerchantUuid }: { uuid: string; replacementMerchantUuid?: string }) => deleteMerchant(uuid, replacementMerchantUuid), onSuccess: invalidate });
}
export function useCreateMerchantRuleMutation() {
  const invalidate = useInvalidateMerchants();
  return useMutation({ mutationFn: ({ merchantUuid, ruleData }: { merchantUuid: string; ruleData: Parameters<typeof createMerchantRule>[1] }) => createMerchantRule(merchantUuid, ruleData), onSuccess: invalidate });
}
export function useUpdateMerchantRuleMutation() {
  const invalidate = useInvalidateMerchants();
  return useMutation({ mutationFn: ({ ruleUuid, ruleData }: { ruleUuid: string; ruleData: Parameters<typeof updateMerchantRule>[1] }) => updateMerchantRule(ruleUuid, ruleData), onSuccess: invalidate });
}
export function useDeleteMerchantRuleMutation() {
  const invalidate = useInvalidateMerchants();
  return useMutation({ mutationFn: (ruleUuid: string) => deleteMerchantRule(ruleUuid), onSuccess: invalidate });
}

// ------------------------------------------------------------------------ tags

export function useTagsQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: tagKeys.list(), queryFn: getTags, staleTime: REFERENCE_STALE_TIME, ...options });
}
export function useTagQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({ queryKey: tagKeys.detail(uuid ?? ''), queryFn: () => getTag(uuid as string), enabled: !!uuid, ...options });
}
export function useTagSummaryQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({ queryKey: [...tagKeys.detail(uuid ?? ''), 'summary'], queryFn: () => getTagSummary(uuid as string), enabled: !!uuid, ...options });
}
export function useTagTransactionsQuery(uuid: string | undefined, params?: Parameters<typeof getTagTransactions>[1], options?: QueryOverrides) {
  return useQuery({ queryKey: [...tagKeys.detail(uuid ?? ''), 'transactions', params ?? {}], queryFn: () => getTagTransactions(uuid as string, params), enabled: !!uuid, ...options });
}
export function useTagBreakdownQuery(uuid: string | undefined, params?: Parameters<typeof getTagBreakdown>[1], options?: QueryOverrides) {
  return useQuery({ queryKey: [...tagKeys.detail(uuid ?? ''), 'breakdown', params ?? {}], queryFn: () => getTagBreakdown(uuid as string, params), enabled: !!uuid, ...options });
}
export function useTagTimeseriesQuery(uuid: string | undefined, params?: Parameters<typeof getTagTimeseries>[1], options?: QueryOverrides) {
  return useQuery({ queryKey: [...tagKeys.detail(uuid ?? ''), 'timeseries', params ?? {}], queryFn: () => getTagTimeseries(uuid as string, params), enabled: !!uuid, ...options });
}
export function useReportRootsQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: [...tagKeys.all, 'reportRoots'], queryFn: getReportRoots, staleTime: REFERENCE_STALE_TIME, ...options });
}
export function useBudgetItemTagsQuery(budgetItemUuid: string | undefined, options?: QueryOverrides) {
  return useQuery({ queryKey: [...tagKeys.all, 'budgetItem', budgetItemUuid ?? ''], queryFn: () => getBudgetItemTags(budgetItemUuid as string), enabled: !!budgetItemUuid, ...options });
}
function useInvalidateTags() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: tagKeys.all });
    void qc.invalidateQueries({ queryKey: transactionKeys.all });
  };
}
export function useCreateTagMutation() {
  const invalidate = useInvalidateTags();
  return useMutation({ mutationFn: (data: Parameters<typeof createTag>[0]) => createTag(data), onSuccess: invalidate });
}
export function useUpdateTagMutation() {
  const invalidate = useInvalidateTags();
  return useMutation({ mutationFn: ({ uuid, data }: { uuid: string; data: Parameters<typeof updateTag>[1] }) => updateTag(uuid, data), onSuccess: invalidate });
}
export function useDeleteTagMutation() {
  const invalidate = useInvalidateTags();
  return useMutation({ mutationFn: (uuid: string) => deleteTag(uuid), onSuccess: invalidate });
}
export function useUpdateTagReportRootMutation() {
  const invalidate = useInvalidateTags();
  return useMutation({ mutationFn: ({ uuid, data }: { uuid: string; data: Parameters<typeof updateTagReportRoot>[1] }) => updateTagReportRoot(uuid, data), onSuccess: invalidate });
}
export function useAddTagToBudgetItemMutation() {
  const invalidate = useInvalidateTags();
  return useMutation({ mutationFn: ({ budgetItemUuid, tagId }: { budgetItemUuid: string; tagId: number }) => addTagToBudgetItem(budgetItemUuid, tagId), onSuccess: invalidate });
}
export function useRemoveTagFromBudgetItemMutation() {
  const invalidate = useInvalidateTags();
  return useMutation({ mutationFn: ({ budgetItemUuid, tagId }: { budgetItemUuid: string; tagId: number }) => removeTagFromBudgetItem(budgetItemUuid, tagId), onSuccess: invalidate });
}
