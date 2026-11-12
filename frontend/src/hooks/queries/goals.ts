import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getGoals, getGoal, createGoal, updateGoal,
  getGoalBalanceHistory, getGoalAccountBalanceHistory,
  uploadGoalImage, deleteGoalImage,
  associateAccountWithGoal, removeAccountFromGoal,
  associateBudgetItemWithGoal, removeBudgetItemFromGoal,
} from '../../services/api';
import { goalKeys, budgetKeys, accountKeys } from './keys';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

export function useGoalsQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: goalKeys.list(), queryFn: getGoals, ...options });
}
export function useGoalQuery(uuid: string | undefined, options?: QueryOverrides) {
  return useQuery({ queryKey: goalKeys.detail(uuid ?? ''), queryFn: () => getGoal(uuid as string), enabled: !!uuid, ...options });
}
export function useGoalBalanceHistoryQuery(...args: Parameters<typeof getGoalBalanceHistory>) {
  const [uuid] = args;
  return useQuery({ queryKey: [...goalKeys.detail(uuid as string), 'balanceHistory', args.slice(1)], queryFn: () => getGoalBalanceHistory(...args), enabled: !!uuid });
}
export function useGoalAccountBalanceHistoryQuery(...args: Parameters<typeof getGoalAccountBalanceHistory>) {
  const [uuid] = args;
  return useQuery({ queryKey: [...goalKeys.detail(uuid as string), 'accountBalanceHistory', args.slice(1)], queryFn: () => getGoalAccountBalanceHistory(...args), enabled: !!uuid });
}

function useInvalidateGoals() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: goalKeys.all });
    void qc.invalidateQueries({ queryKey: budgetKeys.all }); // goals are a budget-item type
    void qc.invalidateQueries({ queryKey: accountKeys.all }); // goals link to accounts
  };
}
export function useCreateGoalMutation() {
  const invalidate = useInvalidateGoals();
  return useMutation({ mutationFn: (data: Parameters<typeof createGoal>[0]) => createGoal(data), onSuccess: invalidate });
}
export function useUpdateGoalMutation() {
  const invalidate = useInvalidateGoals();
  return useMutation({ mutationFn: ({ uuid, data }: { uuid: string; data: Parameters<typeof updateGoal>[1] }) => updateGoal(uuid, data), onSuccess: invalidate });
}
export function useUploadGoalImageMutation() {
  const invalidate = useInvalidateGoals();
  return useMutation({ mutationFn: ({ uuid, formData }: { uuid: string; formData: Parameters<typeof uploadGoalImage>[1] }) => uploadGoalImage(uuid, formData), onSuccess: invalidate });
}
export function useDeleteGoalImageMutation() {
  const invalidate = useInvalidateGoals();
  return useMutation({ mutationFn: (uuid: string) => deleteGoalImage(uuid), onSuccess: invalidate });
}
export function useAssociateAccountWithGoalMutation() {
  const invalidate = useInvalidateGoals();
  return useMutation({ mutationFn: ({ uuid, accountId }: { uuid: string; accountId: number }) => associateAccountWithGoal(uuid, accountId), onSuccess: invalidate });
}
export function useRemoveAccountFromGoalMutation() {
  const invalidate = useInvalidateGoals();
  return useMutation({ mutationFn: ({ uuid, accountUuid }: { uuid: string; accountUuid: string }) => removeAccountFromGoal(uuid, accountUuid), onSuccess: invalidate });
}
export function useAssociateBudgetItemWithGoalMutation() {
  const invalidate = useInvalidateGoals();
  return useMutation({ mutationFn: ({ uuid, budgetItemId }: { uuid: string; budgetItemId: number }) => associateBudgetItemWithGoal(uuid, budgetItemId), onSuccess: invalidate });
}
export function useRemoveBudgetItemFromGoalMutation() {
  const invalidate = useInvalidateGoals();
  return useMutation({ mutationFn: ({ uuid, budgetItemUuid }: { uuid: string; budgetItemUuid: string }) => removeBudgetItemFromGoal(uuid, budgetItemUuid), onSuccess: invalidate });
}
