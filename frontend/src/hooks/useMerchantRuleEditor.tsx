import { useState } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'react-hot-toast';
import { Trash2 } from 'lucide-react';
import { merchantRuleCreateSchema } from '@nuggets/shared';
import type { Merchant, MerchantRule } from '../services/api';
import { createDefaultMerchantRuleForm, type MerchantRuleFormData } from '../types/forms';
import {
  useCreateMerchantRuleMutation,
  useDeleteMerchantRuleMutation,
  useUpdateMerchantRuleMutation,
} from './queries';
import { useConfirmation } from './useConfirmation';
import type { ConfirmationDialogProps } from '../components/ConfirmationDialog';
import { errorMessage } from '../utils/errors';

export interface MerchantRuleEditor {
  form: UseFormReturn<MerchantRuleFormData>;
  /** Whether the add/edit form is showing, and the rule it edits (null: a new rule). */
  formOpen: boolean;
  editingRule: MerchantRule | null;
  openNew: () => void;
  startEdit: (rule: MerchantRule) => void;
  /** Closes the form and empties it. */
  closeForm: () => void;
  /** Saves the form's rule: an update of the rule being edited, else a new one for the merchant. */
  save: () => Promise<void>;
  saving: boolean;
  /** Asks, then deletes the rule. */
  deleteRule: (rule: MerchantRule) => Promise<void>;
  /** The delete confirmation's dialog. */
  confirmationProps: ConfirmationDialogProps;
}

/** The merchant rules page's add, edit and delete of a merchant's matching rules. */
export function useMerchantRuleEditor(merchant: Merchant | null): MerchantRuleEditor {
  const [formOpen, setFormOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<MerchantRule | null>(null);
  const form = useForm<MerchantRuleFormData>({
    defaultValues: createDefaultMerchantRuleForm(),
    resolver: zodResolver(merchantRuleCreateSchema) as never,
  });
  const createRuleMutation = useCreateMerchantRuleMutation();
  const updateRuleMutation = useUpdateMerchantRuleMutation();
  const deleteRuleMutation = useDeleteMerchantRuleMutation();
  const { confirmAsync, dialogProps } = useConfirmation();

  const closeForm = () => {
    form.reset(createDefaultMerchantRuleForm());
    setFormOpen(false);
    setEditingRule(null);
  };

  const startEdit = (rule: MerchantRule) => {
    setEditingRule(rule);
    form.reset({ method: rule.method, matching_text: rule.matching_text });
    setFormOpen(true);
  };

  const save = async () => {
    const values = form.getValues();
    const ruleData = { method: values.method, matching_text: values.matching_text.trim() };
    if (editingRule) {
      try {
        await updateRuleMutation.mutateAsync({ ruleUuid: editingRule.uuid, ruleData });
        toast.success('Rule updated successfully');
        closeForm();
      } catch (error) {
        toast.error(errorMessage(error, 'Failed to update rule'));
      }
      return;
    }

    if (!merchant) return;
    try {
      await createRuleMutation.mutateAsync({ merchantUuid: merchant.uuid, ruleData });
      toast.success('Rule created successfully');
      closeForm();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to create rule'));
    }
  };

  const deleteRule = async (rule: MerchantRule) => {
    const confirmed = await confirmAsync({
      title: 'Delete Merchant Rule',
      message: `Are you sure you want to delete the rule "${rule.matching_text}"?\n\nThis action cannot be undone.`,
      variant: 'danger',
      confirmText: 'Delete Rule',
      cancelText: 'Cancel',
      icon: <Trash2 size={24} />,
    });
    if (!confirmed) return;

    try {
      await deleteRuleMutation.mutateAsync(rule.uuid);
      toast.success('Rule deleted successfully');
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to delete rule'));
    }
  };

  return {
    form,
    formOpen,
    editingRule,
    openNew: () => setFormOpen(true),
    startEdit,
    closeForm,
    save,
    saving: createRuleMutation.isPending || updateRuleMutation.isPending,
    deleteRule,
    confirmationProps: dialogProps,
  };
}
