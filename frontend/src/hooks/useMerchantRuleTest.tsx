import { useState } from 'react';
import { toast } from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Settings } from 'lucide-react';
import { applyMerchantRules, testMerchantRules, type Merchant } from '../services/api';
import { invalidateTransactionData } from './queries';
import { useConfirmation } from './useConfirmation';
import type { ConfirmationDialogProps } from '../components/ConfirmationDialog';
import { errorMessage } from '../utils/errors';

export type MerchantRuleTestResults = Awaited<ReturnType<typeof testMerchantRules>>;
export type MerchantRuleMatch = MerchantRuleTestResults['matchingTransactions'][number];

export interface MerchantRuleTest {
  /** The last test's answer: the transactions the rules match that aren't the merchant's yet. */
  results: MerchantRuleTestResults | null;
  testing: boolean;
  applying: boolean;
  /** The ids of the matches chosen to apply the merchant to. */
  selected: ReadonlySet<number>;
  /** Whether every match is chosen (and there is at least one). */
  allSelected: boolean;
  runTest: () => Promise<void>;
  /** Chooses every match, or none once all are chosen. */
  toggleAll: () => void;
  toggle: (transactionId: number) => void;
  /** Asks, then sets the merchant on the chosen matches and tests again. */
  applySelected: () => Promise<void>;
  /** The apply confirmation's dialog. */
  confirmationProps: ConfirmationDialogProps;
}

/** The merchant rules page's "Test Rules": find what the rules match, and apply the merchant to it. */
export function useMerchantRuleTest(merchant: Merchant): MerchantRuleTest {
  const queryClient = useQueryClient();
  const [testing, setTesting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<MerchantRuleTestResults | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const { confirmAsync, dialogProps } = useConfirmation();

  const runTest = async () => {
    try {
      setTesting(true);
      setResults(await testMerchantRules(merchant.uuid));
      setSelected(new Set());
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to test rules'));
    } finally {
      setTesting(false);
    }
  };

  const matchCount = results?.matchingTransactions.length ?? 0;
  const allSelected = matchCount > 0 && selected.size === matchCount;

  const toggleAll = () => {
    if (!results) return;
    const allIds = new Set(results.matchingTransactions.map((t) => t.id));
    setSelected(selected.size === allIds.size ? new Set() : allIds);
  };

  const toggle = (transactionId: number) => {
    const next = new Set(selected);
    if (next.has(transactionId)) next.delete(transactionId);
    else next.add(transactionId);
    setSelected(next);
  };

  const applySelected = async () => {
    if (selected.size === 0) {
      toast.error('Please select transactions to apply rules to');
      return;
    }
    const confirmed = await confirmAsync({
      title: 'Apply Merchant Rules',
      message: `Apply "${merchant.name}" to ${selected.size} selected transactions?\n\nThis will update the merchant assignment for these transactions.`,
      variant: 'info',
      confirmText: 'Apply Rules',
      cancelText: 'Cancel',
      icon: <Settings size={24} />,
    });
    if (!confirmed) return;

    try {
      setApplying(true);
      const result = await applyMerchantRules(merchant.uuid, Array.from(selected));
      toast.success(result.message);
      // The rules reassigned these transactions' merchant (and with it, budget items and tags).
      invalidateTransactionData(queryClient);
      await runTest();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to apply rules'));
    } finally {
      setApplying(false);
    }
  };

  return {
    results,
    testing,
    applying,
    selected,
    allSelected,
    runTest,
    toggleAll,
    toggle,
    applySelected,
    confirmationProps: dialogProps,
  };
}
