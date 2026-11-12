import { useCallback, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Trash } from 'lucide-react';
import { exportMerchants, mergeMerchants, removeUnusedMerchants, type Merchant } from '../services/api';
import { invalidateTransactionData, merchantKeys, useDeleteMerchantMutation } from './queries';
import { useConfirmation } from './useConfirmation';
import type { ConfirmationDialogProps } from '../components/ConfirmationDialog';
import { errorMessage } from '../utils/errors';
import { logger } from '../utils/logger';
import { saveBlob } from '../utils/saveBlob';
import { todayLocal } from '../utils/dateUtils';

export interface MerchantListActions {
  /** The merchant a dialog is open for, and which dialog. */
  selectedMerchant: Merchant | null;
  dialog: 'delete' | 'merge' | null;
  /** The delete dialog's replacement merchant, and the merge dialog's target (uuids). */
  replacementMerchant: string | null;
  setReplacementMerchant: (uuid: string | null) => void;
  targetMerchant: string | null;
  setTargetMerchant: (uuid: string | null) => void;
  openDelete: (merchant: Merchant) => void;
  openMerge: (merchant: Merchant) => void;
  /** Closes either dialog and forgets its choices. */
  closeDialog: () => void;
  deleteSelected: () => Promise<void>;
  mergeSelected: () => Promise<void>;
  removeUnused: () => Promise<void>;
  exportAll: () => Promise<void>;
  exporting: boolean;
  /** The remove-unused confirmation's dialog. */
  confirmationProps: ConfirmationDialogProps;
}

/**
 * What the merchant list does to merchants: delete one (moving what uses it to a
 * replacement), merge one into another, remove the unused ones, and export them all.
 */
export function useMerchantListActions(): MerchantListActions {
  const queryClient = useQueryClient();
  const deleteMerchantMutation = useDeleteMerchantMutation();
  const { confirmAsync, dialogProps } = useConfirmation();
  const [selectedMerchant, setSelectedMerchant] = useState<Merchant | null>(null);
  const [dialog, setDialog] = useState<'delete' | 'merge' | null>(null);
  const [replacementMerchant, setReplacementMerchant] = useState<string | null>(null);
  const [targetMerchant, setTargetMerchant] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Stable, so the memoized merchant cards don't re-render for them.
  const openDelete = useCallback((merchant: Merchant) => {
    setSelectedMerchant(merchant);
    setDialog('delete');
  }, []);
  const openMerge = useCallback((merchant: Merchant) => {
    setSelectedMerchant(merchant);
    setDialog('merge');
  }, []);

  const closeDialog = () => {
    setDialog(null);
    setSelectedMerchant(null);
    setReplacementMerchant(null);
    setTargetMerchant(null);
  };

  const deleteSelected = async () => {
    if (!selectedMerchant) return;
    try {
      await deleteMerchantMutation.mutateAsync({
        uuid: selectedMerchant.uuid,
        ...(replacementMerchant ? { replacementMerchantUuid: replacementMerchant } : {}),
      });
      toast.success('Merchant deleted successfully');
      // The list refreshes through the mutation's invalidation.
      closeDialog();
    } catch (error) {
      if (errorMessage(error, '').includes('Merchant in use')) {
        toast.error('This merchant is in use. Please select a replacement merchant.');
      } else {
        toast.error('Failed to delete merchant');
      }
    }
  };

  const mergeSelected = async () => {
    if (!selectedMerchant || !targetMerchant) return;
    try {
      await mergeMerchants(selectedMerchant.uuid, targetMerchant);
      toast.success('Merchants merged successfully');
      closeDialog();
      // A merge moves the source merchant's transactions to the target.
      invalidateTransactionData(queryClient);
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to merge merchants'));
    }
  };

  const removeUnused = async () => {
    const confirmed = await confirmAsync({
      title: 'Remove Unused Merchants',
      message: 'Remove all merchants that nothing in this ledger uses?\n\nThis action cannot be undone.',
      variant: 'warning',
      confirmText: 'Remove Unused',
      cancelText: 'Cancel',
      icon: <Trash size={24} />,
      details: [
        'A merchant is kept while a transaction, attachment, budget item, recurring item or budget-item rule uses it, or budget-item suggestions have learned from it',
        'Associated matching rules will also be removed',
        'This cleanup helps reduce clutter in your merchant list',
      ],
    });
    if (!confirmed) return;

    try {
      const result = await removeUnusedMerchants();
      toast.success(result.message);
      if (result.removedCount > 0) {
        void queryClient.invalidateQueries({ queryKey: merchantKeys.all });
      }
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to remove unused merchants'));
    }
  };

  const exportAll = async () => {
    setExporting(true);
    try {
      saveBlob(await exportMerchants(), `merchants_${todayLocal()}.csv`);
      toast.success('Merchants exported');
    } catch (error) {
      logger.error({ err: error }, 'Failed to export merchants');
      toast.error(errorMessage(error, 'Failed to export merchants'));
    } finally {
      setExporting(false);
    }
  };

  return {
    selectedMerchant,
    dialog,
    replacementMerchant,
    setReplacementMerchant,
    targetMerchant,
    setTargetMerchant,
    openDelete,
    openMerge,
    closeDialog,
    deleteSelected,
    mergeSelected,
    removeUnused,
    exportAll,
    exporting,
    confirmationProps: dialogProps,
  };
}
