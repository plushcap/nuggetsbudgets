import React from 'react';
import { Badge } from '@radix-ui/themes';
import { toast } from 'react-hot-toast';
import type { BudgetItemMatchingRule } from '../../services/api';
import { useUpdateBudgetItemMatchingRuleMutation } from '../../hooks/queries';
import { errorMessage } from '../../utils/errors';

/**
 * A matching rule's status, in words: the rules lists answer inactive rules too, so the
 * pages say which is which (an icon with a title said it to the mouse only).
 */
export const MatchingRuleStatusBadge: React.FC<{ active: boolean }> = ({ active }) =>
  active ? (
    <Badge color="green" highContrast variant="soft">Active</Badge>
  ) : (
    <Badge color="gray" variant="soft">Inactive</Badge>
  );

/**
 * Switches a rule on or off from a list (an inactive rule couldn't be reached to switch it
 * on again). A PUT replaces the rule, so the whole rule goes, as the list has it, with only
 * `is_active` changed; a bound is sent as the number the list read it as (0 is a bound).
 */
export function useToggleMatchingRuleActive(): (rule: BudgetItemMatchingRule) => Promise<void> {
  const update = useUpdateBudgetItemMatchingRuleMutation();
  return async (rule) => {
    try {
      await update.mutateAsync([
        rule.uuid,
        {
          budget_item_id: rule.budget_item_id,
          method: rule.method,
          matching_text: rule.matching_text ?? null,
          merchant_id: rule.merchant_id ?? null,
          amount_min: rule.amount_min ?? null,
          amount_max: rule.amount_max ?? null,
          priority: rule.priority,
          is_active: !rule.is_active,
          notes: rule.notes ?? null,
        },
      ]);
      toast.success(rule.is_active ? 'Rule switched off' : 'Rule switched on');
    } catch (error) {
      toast.error(errorMessage(error, rule.is_active ? 'Failed to switch the rule off' : 'Failed to switch the rule on'));
    }
  };
}
