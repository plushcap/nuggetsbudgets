import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getBudgetItems, createBudgetItem, updateBudgetItem, deleteBudgetItem,
  getBudgetItemUsage, archiveBudgetItem, restoreBudgetItem, mergeBudgetItem,
  getBudgetPeriods, createBudgetPeriod, deleteBudgetPeriod,
  getBudgetPeriodItems, updateBudgetAmount, getBudgetEventHistory,
  getBudgetItemMatchingRules, getBudgetItemMatchingRulesByBudgetItem,
  createBudgetItemMatchingRule, updateBudgetItemMatchingRule, deleteBudgetItemMatchingRule,
  getBudgetItemActivity, getBudgetItemTransactions,
  getBudgetPeriodsManagement, createManagedBudgetPeriod, getEnvelopeTransfers,
} from '../../services/api';
import { budgetKeys } from './keys';
import { invalidateTransactionData } from './invalidation';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

// ---- queries ----------------------------------------------------------------

export function useBudgetItemsQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: [...budgetKeys.all, 'items'], queryFn: getBudgetItems, ...options });
}
export function useBudgetPeriodsQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: budgetKeys.periods(), queryFn: getBudgetPeriods, ...options });
}
export function useBudgetPeriodsManagementQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: [...budgetKeys.all, 'periodsManagement'], queryFn: getBudgetPeriodsManagement, ...options });
}
export function useEnvelopeTransfersQuery(periodUuid: string | undefined, options?: QueryOverrides) {
  return useQuery({
    queryKey: [...budgetKeys.all, 'envelopeTransfers', periodUuid ?? ''],
    queryFn: () => getEnvelopeTransfers(periodUuid as string),
    enabled: !!periodUuid,
    ...options,
  });
}
export function useBudgetPeriodItemsQuery(periodUuid: string | undefined, budgetItemUuid?: string, options?: QueryOverrides) {
  return useQuery({
    queryKey: [...budgetKeys.periodItems(periodUuid ?? ''), { budgetItemUuid }],
    queryFn: () => getBudgetPeriodItems(periodUuid as string, budgetItemUuid),
    enabled: !!periodUuid,
    ...options,
  });
}
export function useBudgetEventHistoryQuery(...args: Parameters<typeof getBudgetEventHistory>) {
  const [uuid] = args;
  return useQuery({ queryKey: [...budgetKeys.all, 'eventHistory', args], queryFn: () => getBudgetEventHistory(...args), enabled: !!uuid });
}
export function useBudgetItemMatchingRulesQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: [...budgetKeys.all, 'matchingRules'], queryFn: getBudgetItemMatchingRules, ...options });
}
export function useBudgetItemMatchingRulesByItemQuery(budgetItemUuid: string | undefined, options?: QueryOverrides) {
  return useQuery({ queryKey: [...budgetKeys.item(budgetItemUuid ?? ''), 'matchingRules'], queryFn: () => getBudgetItemMatchingRulesByBudgetItem(budgetItemUuid as string), enabled: !!budgetItemUuid, ...options });
}
/** A budget period item's budget events, by the period item's uuid (uuids in URLs). */
export function useBudgetItemActivityQuery(budgetPeriodItemUuid: string | undefined, options?: QueryOverrides) {
  return useQuery({ queryKey: [...budgetKeys.all, 'activity', budgetPeriodItemUuid ?? ''], queryFn: () => getBudgetItemActivity(budgetPeriodItemUuid as string), enabled: !!budgetPeriodItemUuid, ...options });
}
/** A budget period item's transactions, by the period item's uuid. */
export function useBudgetItemTransactionsQuery(budgetPeriodItemUuid: string | undefined, options?: QueryOverrides) {
  return useQuery({ queryKey: [...budgetKeys.all, 'itemTransactions', budgetPeriodItemUuid ?? ''], queryFn: () => getBudgetItemTransactions(budgetPeriodItemUuid as string), enabled: !!budgetPeriodItemUuid, ...options });
}

// ---- mutations --------------------------------------------------------------

function useInvalidateBudgets() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: budgetKeys.all });
}
// Merges move transactions, and matching rules re-assign them: everything derived
// from transactions refreshes (budgets included).
function useInvalidateBudgetsAndTransactions() {
  const qc = useQueryClient();
  return () => invalidateTransactionData(qc);
}

export function useCreateBudgetItemMutation() {
  const invalidate = useInvalidateBudgets();
  return useMutation({ mutationFn: (data: Parameters<typeof createBudgetItem>[0]) => createBudgetItem(data), onSuccess: invalidate });
}
export function useUpdateBudgetItemMutation() {
  const invalidate = useInvalidateBudgets();
  return useMutation({ mutationFn: ({ uuid, data }: { uuid: string; data: Parameters<typeof updateBudgetItem>[1] }) => updateBudgetItem(uuid, data), onSuccess: invalidate });
}
export function useDeleteBudgetItemMutation() {
  const invalidate = useInvalidateBudgets();
  return useMutation({ mutationFn: (uuid: string) => deleteBudgetItem(uuid), onSuccess: invalidate });
}

/** What archiving, deleting or merging an item touches (its transactions, rules, balance). */
export function useBudgetItemUsageQuery(uuid: string | null) {
  return useQuery({
    queryKey: [...budgetKeys.item(uuid ?? ''), 'usage'],
    queryFn: () => getBudgetItemUsage(uuid as string),
    enabled: !!uuid,
    // Fresh every time the dialog opens: a balance or count from before a transfer would mislead.
    staleTime: 0,
  });
}
export function useArchiveBudgetItemMutation() {
  const invalidate = useInvalidateBudgets();
  return useMutation({ mutationFn: (uuid: string) => archiveBudgetItem(uuid), onSuccess: invalidate });
}
export function useRestoreBudgetItemMutation() {
  const invalidate = useInvalidateBudgets();
  return useMutation({ mutationFn: (uuid: string) => restoreBudgetItem(uuid), onSuccess: invalidate });
}
// Moving transactions changes transaction lists too.
export function useMergeBudgetItemMutation() {
  const invalidate = useInvalidateBudgetsAndTransactions();
  return useMutation({
    mutationFn: ({ uuid, intoUuid, moveRules }: { uuid: string; intoUuid: string; moveRules: boolean }) =>
      mergeBudgetItem(uuid, { into_uuid: intoUuid, move_rules: moveRules }),
    onSuccess: invalidate,
  });
}
export function useCreateBudgetPeriodMutation() {
  const invalidate = useInvalidateBudgets();
  return useMutation({ mutationFn: (args: Parameters<typeof createBudgetPeriod>) => createBudgetPeriod(...args), onSuccess: invalidate });
}
// Creating a period assigns it the transactions in its dates; deleting one unassigns them.
export function useCreateManagedBudgetPeriodMutation() {
  const invalidate = useInvalidateBudgetsAndTransactions();
  return useMutation({ mutationFn: (args: Parameters<typeof createManagedBudgetPeriod>) => createManagedBudgetPeriod(...args), onSuccess: invalidate });
}
export function useDeleteBudgetPeriodMutation() {
  const invalidate = useInvalidateBudgetsAndTransactions();
  return useMutation({ mutationFn: (uuid: string) => deleteBudgetPeriod(uuid), onSuccess: invalidate });
}
export function useUpdateBudgetAmountMutation() {
  const invalidate = useInvalidateBudgets();
  return useMutation({ mutationFn: (args: Parameters<typeof updateBudgetAmount>) => updateBudgetAmount(...args), onSuccess: invalidate });
}
export function useCreateBudgetItemMatchingRuleMutation() {
  const invalidate = useInvalidateBudgetsAndTransactions();
  return useMutation({ mutationFn: (args: Parameters<typeof createBudgetItemMatchingRule>) => createBudgetItemMatchingRule(...args), onSuccess: invalidate });
}
export function useUpdateBudgetItemMatchingRuleMutation() {
  const invalidate = useInvalidateBudgetsAndTransactions();
  return useMutation({ mutationFn: (args: Parameters<typeof updateBudgetItemMatchingRule>) => updateBudgetItemMatchingRule(...args), onSuccess: invalidate });
}
export function useDeleteBudgetItemMatchingRuleMutation() {
  const invalidate = useInvalidateBudgetsAndTransactions();
  return useMutation({ mutationFn: (ruleUuid: string) => deleteBudgetItemMatchingRule(ruleUuid), onSuccess: invalidate });
}
