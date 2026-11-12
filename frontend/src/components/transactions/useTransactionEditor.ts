import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch, type DefaultValues, type PathValue } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import type { TransactionWithSplits } from '@nuggets/shared';
import * as api from '../../services/api';
import { useUpdateTransactionMutation } from '../../hooks/queries';
import { useKeyedDebounce } from '../../hooks/useKeyedDebounce';
import { apiErrorMessage } from '../../utils/errors';
import { logger } from '../../utils/logger';
import type { EditTransactionFormData } from '../../types/forms';
import type { Tag } from '../TagSelector';
import { AMOUNT_FIELD_ID } from './AmountField';
import { LINK_FIELD_ID, checkedLink } from './ExternalReferenceFields';
import type { FieldSaveStatus } from './TransactionFieldParts';
import { transactionReviewStatus } from '@nuggets/shared';

/** The fields that save on their own, as the API names them. */
export type TransactionFieldName =
  | 'type'
  | 'merchant_id'
  | 'budget_period_id'
  | 'budget_item_id'
  | 'transaction_date'
  | 'amount'
  | 'status'
  | 'review_status'
  | 'assigned_to'
  | 'external_transaction_id'
  | 'external_link'
  | 'notes';

/** How long a typed field waits before it saves. */
const FIELD_SAVE_DELAY_MS = 1000;

/**
 * The form holds each value as the database has it; only what's rendered shows a label.
 * Save Changes sends the form as it is.
 */
const formValuesOf = (transaction: TransactionWithSplits): DefaultValues<EditTransactionFormData> => ({
  amount: transaction.amount || 0,
  transaction_date: transaction.transaction_date || '',
  type: transaction.type || 'expense',
  status: transaction.status || 'pending',
  review_status: transaction.review_status || 'needs review',
  account_id: transaction.account_id,
  budget_item_id: transaction.budget_item_id || null,
  merchant_id: transaction.merchant_id || null,
  budget_period_id: transaction.budget_period_id || null,
  assigned_to: transaction.assigned_to || null,
  notes: transaction.notes || '',
  external_transaction_id: transaction.external_transaction_id || '',
  external_link: transaction.external_link || '',
});

const EMPTY_FORM: DefaultValues<EditTransactionFormData> = {
  amount: 0,
  transaction_date: '',
  type: 'expense',
  status: 'pending',
  review_status: 'needs review',
  account_id: 0,
  budget_item_id: null,
  merchant_id: null,
  budget_period_id: null,
  assigned_to: null,
  notes: '',
  external_transaction_id: '',
  external_link: '',
};

interface TransactionEditorOptions {
  /** The transaction's uuid from the route. */
  uuid: string | undefined;
  /** The transaction as GET /transactions/:uuid answers it, once it has. */
  transaction: TransactionWithSplits | null;
  /** The transaction's tags, as their query answers them. */
  transactionTags: Tag[];
  /** Where Save Changes and Cancel lead back to. */
  returnTo: string;
}

/**
 * Every save the transaction detail page makes: each field on its own as it changes
 * (debounced while typing, at once when picked), Save Changes for all of them, the tags,
 * and the approval toggle.
 *
 * A field save still waiting when the page goes runs then (useKeyedDebounce); Cancel drops
 * them. Save Changes holds them while it runs: it writes every field, so they'd only repeat
 * it. They're dropped once it has saved and put back if it fails, so an edit made just
 * before it still saves on its own, not lost with it.
 */
export function useTransactionEditor({ uuid, transaction, transactionTags, returnTo }: TransactionEditorOptions) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const startInEditMode = searchParams.get('edit') === 'true';
  const updateTransactionMutation = useUpdateTransactionMutation();

  const [isEditing, setIsEditing] = useState(startInEditMode);
  // The page's own writes (Save Changes, approval, delete, unsplit): their buttons wait.
  const [saving, setSaving] = useState(false);

  // Fields autosave individually (saveField); there's no single submit-validation step, so
  // the resolver is intentionally omitted and onChange handlers write through setValue.
  const { reset, setValue, getValues, control } = useForm<EditTransactionFormData>({ defaultValues: EMPTY_FORM });
  const values = useWatch({ control });

  const [savingFields, setSavingFields] = useState<ReadonlySet<string>>(new Set());
  const [lastSaveTime, setLastSaveTime] = useState<Partial<Record<TransactionFieldName, Date>>>({});
  const fieldSaves = useKeyedDebounce(FIELD_SAVE_DELAY_MS);

  // The amount box holds text that isn't an amount: nothing of it is saved, and Save
  // Changes is refused beside the box (`amountRefused`) until it reads.
  const [amountUnreadable, setAmountUnreadable] = useState(false);
  const [amountRefused, setAmountRefused] = useState(false);
  const amountProblem = amountRefused && amountUnreadable ? 'Not an amount: enter it like 1,234.56.' : null;
  // Save Changes sends the link as its box would save it, and never one the box refuses:
  // typed here, Save Changes is refused beside the box (`linkRefused`) until it reads.
  const [linkRefused, setLinkRefused] = useState(false);

  // The merchant box's text: the transaction's merchant name until something is typed or
  // chosen for this transaction.
  const [merchantTyped, setMerchantTyped] = useState<{ transactionId: number; text: string } | null>(null);
  const merchantSearch =
    transaction && merchantTyped?.transactionId === transaction.id ? merchantTyped.text : (transaction?.merchant_name ?? '');
  const setMerchantSearch = (text: string) => {
    if (transaction) setMerchantTyped({ transactionId: transaction.id, text });
  };

  // The tags shown: the transaction's, as the query has them, unless they were changed here
  // since that answer arrived (a newer answer replaces the change).
  const [tagsChange, setTagsChange] = useState<{ from: Tag[]; tags: Tag[] } | null>(null);
  const selectedTags = tagsChange?.from === transactionTags ? tagsChange.tags : transactionTags;

  // Seed the form from the transaction: once per transaction while it is edited, so what is
  // typed stays; while it isn't, the form follows the saved transaction (a Cancel, an answer
  // after a field's save), so Edit starts from what is saved (a Cancel kept what was
  // typed, the amount's unreadable text among it, and Save Changes then refused or sent it).
  // A split's own row isn't edited here: the page goes to its parent.
  const seededTxIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!transaction || (transaction.parent_transaction_id && transaction.parent_transaction_uuid)) return;
    if (seededTxIdRef.current === transaction.id && isEditing) return;
    seededTxIdRef.current = transaction.id;
    reset(formValuesOf(transaction));
  }, [transaction, reset, isEditing]);

  const fieldStatus = (fieldName: TransactionFieldName): FieldSaveStatus => ({
    isSaving: savingFields.has(fieldName),
    lastSaveTime: lastSaveTime[fieldName],
  });

  /** Save one field: at once (`immediate`), or once typing pauses. A save of it still waiting is replaced. */
  const saveField = async (fieldName: TransactionFieldName, value: unknown, immediate = false) => {
    if (!transaction || !isEditing) return;
    fieldSaves.cancel(fieldName);
    const label = fieldName.replace('_', ' ');

    const performUpdate = async () => {
      try {
        setSavingFields((prev) => new Set(prev).add(fieldName));
        await updateTransactionMutation.mutateAsync({ uuid: transaction.uuid, data: { [fieldName]: value } });
        setLastSaveTime((prev) => ({ ...prev, [fieldName]: new Date() }));
        toast.success(`${label} updated`, { duration: 2000, style: { fontSize: '14px', padding: '8px 12px' } });
      } catch (error) {
        logger.error({ err: error, fieldName, uuid }, 'Failed to update field');
        // The server's reason when it gave one (an income on a liability account).
        toast.error(apiErrorMessage(error, `Failed to update ${label}`), { duration: 3000 });
      } finally {
        setSavingFields((prev) => {
          const next = new Set(prev);
          next.delete(fieldName);
          return next;
        });
      }
    };

    if (immediate) {
      await performUpdate();
    } else {
      fieldSaves.schedule(fieldName, performUpdate);
    }
  };

  /** Set a field in the form and save it. */
  const changeField = <K extends TransactionFieldName & keyof EditTransactionFormData>(
    fieldName: K,
    value: EditTransactionFormData[K],
    immediate: boolean,
  ) => {
    setValue(fieldName, value as PathValue<EditTransactionFormData, K>);
    void saveField(fieldName, value, immediate);
  };

  const changeAmount = (parsed: number | null, unreadable: boolean) => {
    setAmountUnreadable(unreadable);
    if (!unreadable) setAmountRefused(false);
    // NaN for text it can't read, so a reset is a change the box sees and drops it.
    setValue('amount', unreadable ? Number.NaN : (parsed ?? 0));
    // An empty box or text that isn't an amount has nothing to save, and drops the save still
    // waiting from an earlier keystroke: the 15 of "15o" was saved a second later, while the
    // box was flagged.
    if (parsed === null) {
      fieldSaves.cancel('amount');
      return;
    }
    if (isEditing) void saveField('amount', parsed, false);
  };

  /** Save Changes: every field at once, then back to where the page was opened from. */
  const save = async () => {
    if (!transaction) return;
    // Sent, it would be null. The box says why, and takes the focus.
    if (amountUnreadable && !transaction.is_split_parent) {
      setAmountRefused(true);
      document.getElementById(AMOUNT_FIELD_ID)?.focus();
      return;
    }
    const { external_link: linkText = '', ...fields } = getValues();
    const { link } = checkedLink(linkText);
    // A stored link the box would refuse (saved before links were checked) that nobody changed
    // is left as it is, so the rest still saves.
    if (link === null && linkText !== (transaction.external_link ?? '')) {
      setLinkRefused(true);
      document.getElementById(LINK_FIELD_ID)?.focus();
      return;
    }
    const heldFieldSaves = fieldSaves.takeAll();

    try {
      setSaving(true);
      const updateData = {
        ...fields,
        ...(link === null ? {} : { external_link: link }),
        merchant_name: merchantSearch.trim() || undefined,
      };
      try {
        await updateTransactionMutation.mutateAsync({ uuid: transaction.uuid, data: updateData });
      } catch (error) {
        fieldSaves.putBack(heldFieldSaves);
        throw error;
      }

      setIsEditing(false);
      // Clean up the URL by removing the edit parameter
      if (searchParams.get('edit') === 'true') {
        navigate(`/transactions/${transaction.uuid}`, { replace: true });
      }
      toast.success('Transaction updated successfully');
      // Back to the page it was opened from (tasks or transactions)
      navigate(returnTo);
    } catch (error) {
      logger.error({ err: error, uuid }, 'Failed to update transaction');
      toast.error(apiErrorMessage(error, 'Failed to update transaction'));
    } finally {
      setSaving(false);
    }
  };

  /** Cancel: what was typed is dropped, not saved when the page goes. */
  const cancel = () => {
    fieldSaves.cancelAll();
    setIsEditing(false);
    setAmountUnreadable(false);
    setAmountRefused(false);
    setLinkRefused(false);

    if (searchParams.get('edit') === 'true') {
      navigate(`/transactions/${uuid}`, { replace: true });
      if (transaction) reset(formValuesOf(transaction));
      navigate(returnTo);
    }
  };

  /** Mark the transaction reviewed, or not. */
  const toggleApproval = async () => {
    if (!transaction) return;
    try {
      setSaving(true);
      const newReviewStatus = transaction.review_status === transactionReviewStatus.enum.reviewed ? 'needs review' : 'reviewed';
      // Mutation invalidation refetches the transaction (updating related fields).
      await updateTransactionMutation.mutateAsync({ uuid: transaction.uuid, data: { review_status: newReviewStatus } });
      setValue('review_status', newReviewStatus);
      toast.success(`Transaction ${newReviewStatus === transactionReviewStatus.enum.reviewed ? 'approved' : 'unapproved'} successfully`);
    } catch (error) {
      logger.error({ err: error, uuid }, 'Failed to toggle approval status');
      toast.error('Failed to update approval status');
    } finally {
      setSaving(false);
    }
  };

  /** The tags picked now: those added are applied and those removed taken off, one by one. */
  const changeTags = async (newTags: Tag[]) => {
    if (!uuid) return;
    const currentIds = new Set(selectedTags.map((t) => t.id));
    const newIds = new Set(newTags.map((t) => t.id));
    try {
      for (const tag of newTags.filter((t) => !currentIds.has(t.id))) {
        await api.addTransactionTag(uuid, tag.id);
      }
      for (const tag of selectedTags.filter((t) => !newIds.has(t.id))) {
        await api.removeTransactionTag(uuid, tag.id);
      }
      setTagsChange({ from: transactionTags, tags: newTags });
      toast.success('Tags updated');
    } catch (error) {
      logger.error({ err: error }, 'Failed to update tags');
      toast.error('Failed to update tags');
    }
  };

  /** Run one of the page's other writes (delete, unsplit) with its buttons waiting. */
  const whileSaving = async (write: () => Promise<void>) => {
    setSaving(true);
    try {
      await write();
    } finally {
      setSaving(false);
    }
  };

  return {
    values,
    /** Set a field in the form without saving it (a link saves when its box loses focus). */
    setValue,
    isEditing,
    startEditing: () => setIsEditing(true),
    saving,
    whileSaving,
    fieldStatus,
    saveField,
    changeField,
    changeAmount,
    amountProblem,
    linkRefused,
    merchantSearch,
    setMerchantSearch,
    selectedTags,
    changeTags,
    save,
    cancel,
    toggleApproval,
  };
}

export type TransactionEditor = ReturnType<typeof useTransactionEditor>;
