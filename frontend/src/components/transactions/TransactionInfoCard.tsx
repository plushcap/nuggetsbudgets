import React from 'react';
import { Box, Button, Card, Flex, Grid, Heading, Text, TextArea } from '@radix-ui/themes';
import { Calendar, Trash2 } from 'lucide-react';
import {
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
  TRANSACTION_STATUSES,
  TRANSACTION_STATUS_LABELS,
  TRANSACTION_TYPE_LABELS,
  vocabularyLabel,
  type TransactionWithSplits,
  transactionType,
} from '@nuggets/shared';
import type { BudgetItem, BudgetPeriod, MerchantLite, User } from '../../services/api';
import type { EditTransactionFormData } from '../../types/forms';
import { periodsNewestFirst } from '../../utils/budgetPeriods';
import { DateUtils } from '../../utils/dateUtils';
import { TRANSACTION_TYPE_OPTIONS } from '../../utils/vocabularyOptions';
import RadixDatePicker from '../RadixDatePicker';
import type { Tag } from '../TagSelector';
import { AmountField } from './AmountField';
import { BudgetItemField } from './BudgetItemField';
import { ExternalIdField, ExternalLinkField } from './ExternalReferenceFields';
import { MerchantField } from './MerchantField';
import { FieldCaption, FieldStatus, ReadOnlyValue } from './TransactionFieldParts';
import { TransactionSelectField } from './TransactionSelectField';
import { ReviewStatusIcon, TransactionStatusIcon } from './TransactionStatusIcons';
import { TransactionTagsField } from './TransactionTagsField';
import type { TransactionEditor } from './useTransactionEditor';
import { personName } from '../../utils/personName';

/** A picker's "none" choice: Radix Select takes no empty value. */
const NONE = 'null';
const idOrNone = (id: number | null | undefined) => (id ? id.toString() : NONE);
const idFromChoice = (choice: string) => (choice && choice !== NONE ? parseInt(choice, 10) : null);

interface TransactionInfoCardProps {
  transaction: TransactionWithSplits;
  editor: TransactionEditor;
  budgetItems: BudgetItem[];
  budgetPeriods: BudgetPeriod[];
  merchants: MerchantLite[];
  users: User[];
  tags: Tag[];
  onDelete: () => void;
}

/**
 * The transaction's fields, shown, or edited while the page is in edit mode: each saves on
 * its own as it changes, and Save Changes saves them all (useTransactionEditor).
 */
export const TransactionInfoCard: React.FC<TransactionInfoCardProps> = ({
  transaction,
  editor,
  budgetItems,
  budgetPeriods,
  merchants,
  users,
  tags,
  onDelete,
}) => {
  const { values, isEditing: editing, fieldStatus, changeField } = editor;
  const type = values.type ?? '';
  const status = values.status ?? '';
  const reviewStatus = values.review_status ?? '';

  // A liability account takes no income (the server refuses one). One from before that
  // rule keeps Income shown, so it saves as it is.
  const typeOptions = TRANSACTION_TYPE_OPTIONS.filter(
    (t) => t !== 'income' || transaction.account_class !== 'Liability' || transaction.type === transactionType.enum.income,
  ).map((t) => ({ value: t, label: TRANSACTION_TYPE_LABELS[t] }));

  return (
    <Card>
      <Heading as="h2" size="4" mb="6">Transaction Information</Heading>

      <Grid columns={{ initial: '1', md: '2' }} gap="6">
        <TransactionSelectField
          id="transaction-type"
          label="Type"
          editing={editing}
          status={fieldStatus('type')}
          value={type}
          options={typeOptions}
          keepUnlistedValue
          labels={TRANSACTION_TYPE_LABELS}
          onChange={(value) => changeField('type', value as EditTransactionFormData['type'], true)}
          display={<Text color="gray" highContrast>{vocabularyLabel(TRANSACTION_TYPE_LABELS, values.type)}</Text>}
        />

        <MerchantField
          editing={editing}
          status={fieldStatus('merchant_id')}
          search={editor.merchantSearch}
          onSearchChange={editor.setMerchantSearch}
          merchantId={values.merchant_id ?? null}
          onChoose={(merchantId) => changeField('merchant_id', merchantId, true)}
          merchants={merchants}
          merchantName={transaction.merchant_name ?? null}
        />

        <TransactionSelectField
          id="transaction-budget-period"
          label="Budget Period"
          editing={editing}
          status={fieldStatus('budget_period_id')}
          value={idOrNone(values.budget_period_id)}
          options={[
            { value: NONE, label: 'No budget period' },
            ...periodsNewestFirst(budgetPeriods).map((period) => ({ value: period.id.toString(), label: period.name })),
          ]}
          placeholder="No budget period"
          onChange={(value) => changeField('budget_period_id', idFromChoice(value), true)}
          display={
            transaction.budget_period_name ? (
              <Flex align="center" gap="2">
                <Calendar size={16} className="text-[var(--accent-11)]" />
                <Text weight="medium" color="gray" highContrast>
                  {transaction.budget_period_name}
                </Text>
              </Flex>
            ) : (
              <Text color="gray">No budget period</Text>
            )
          }
        />

        <BudgetItemField
          editing={editing}
          status={fieldStatus('budget_item_id')}
          isSplitParent={transaction.is_split_parent}
          value={values.budget_item_id ?? null}
          onChange={(budgetItemId) => changeField('budget_item_id', budgetItemId, true)}
          budgetItems={budgetItems}
          budgetItemName={transaction.budget_item_name ?? null}
          budgetItemUuid={transaction.budget_item_uuid ?? null}
        />

        <TransactionTagsField
          editing={editing}
          selectedTags={editor.selectedTags}
          tags={tags}
          onChange={(newTags) => void editor.changeTags(newTags)}
        />

        <Box>
          <FieldCaption id="transaction-date">
            Date
            <FieldStatus {...fieldStatus('transaction_date')} />
          </FieldCaption>
          {editing ? (
            <RadixDatePicker
              aria-labelledby="transaction-date"
              value={values.transaction_date ?? ''}
              onChange={(date) => changeField('transaction_date', date, true)}
              size="3"
            />
          ) : (
            <ReadOnlyValue>
              <Text color="gray" highContrast>{DateUtils.formatDateUS(transaction.transaction_date)}</Text>
            </ReadOnlyValue>
          )}
        </Box>

        <AmountField
          editing={editing}
          status={fieldStatus('amount')}
          isSplitParent={transaction.is_split_parent}
          value={values.amount ?? 0}
          onChange={editor.changeAmount}
          problem={editor.amountProblem}
          savedAmount={transaction.amount}
        />

        <TransactionSelectField
          id="transaction-status"
          label="Status"
          editing={editing}
          status={fieldStatus('status')}
          value={status}
          options={TRANSACTION_STATUSES.map((s) => ({ value: s, label: TRANSACTION_STATUS_LABELS[s] }))}
          keepUnlistedValue
          labels={TRANSACTION_STATUS_LABELS}
          onChange={(value) => changeField('status', value as EditTransactionFormData['status'], true)}
          display={
            <Flex align="center" gap="2">
              <TransactionStatusIcon status={status} />
              <Text color="gray" highContrast>{vocabularyLabel(TRANSACTION_STATUS_LABELS, values.status)}</Text>
            </Flex>
          }
        />

        <TransactionSelectField
          id="transaction-review-status"
          label="Review Status"
          editing={editing}
          status={fieldStatus('review_status')}
          value={reviewStatus}
          options={REVIEW_STATUSES.map((s) => ({ value: s, label: REVIEW_STATUS_LABELS[s] }))}
          keepUnlistedValue
          labels={REVIEW_STATUS_LABELS}
          onChange={(value) => changeField('review_status', value as EditTransactionFormData['review_status'], true)}
          display={
            <Flex align="center" gap="2">
              <ReviewStatusIcon status={reviewStatus} />
              <Text color="gray" highContrast>{vocabularyLabel(REVIEW_STATUS_LABELS, values.review_status)}</Text>
            </Flex>
          }
        />

        <TransactionSelectField
          id="transaction-assigned-to"
          label="Assigned To"
          editing={editing}
          status={fieldStatus('assigned_to')}
          value={idOrNone(values.assigned_to)}
          options={[
            { value: NONE, label: 'Unassigned' },
            ...users.map((user) => ({ value: user.id.toString(), label: personName(user) })),
          ]}
          placeholder="Unassigned"
          onChange={(value) => changeField('assigned_to', idFromChoice(value), true)}
          display={<Text color="gray" highContrast>{transaction.assigned_user || 'Unassigned'}</Text>}
        />

        <ExternalIdField
          editing={editing}
          status={fieldStatus('external_transaction_id')}
          value={values.external_transaction_id ?? ''}
          onChange={(value) => changeField('external_transaction_id', value, false)}
        />

        <ExternalLinkField
          editing={editing}
          status={fieldStatus('external_link')}
          value={values.external_link ?? ''}
          onChange={(value) => editor.setValue('external_link', value)}
          onCommit={(value) => void editor.saveField('external_link', value, true)}
          refused={editor.linkRefused}
        />

        <Box gridColumn={{ md: 'span 2' }}>
          <FieldCaption htmlFor={editing ? 'transaction-notes' : undefined}>
            Notes
            <FieldStatus {...fieldStatus('notes')} />
          </FieldCaption>
          {editing ? (
            <TextArea
              id="transaction-notes"
              variant="surface"
              size="3"
              value={values.notes ?? ''}
              onChange={(e) => changeField('notes', e.target.value, false)}
              rows={3}
              placeholder="Add notes about this transaction..."
              resize="none"
            />
          ) : (
            <ReadOnlyValue minHeight="88px">
              <Text color="gray" highContrast>{values.notes || 'No notes'}</Text>
            </ReadOnlyValue>
          )}
        </Box>
      </Grid>

      {editing && (
        // Delete on the left and Cancel / Save on the right; stacked on a phone, Save on top.
        <Flex
          direction={{ initial: 'column-reverse', sm: 'row' }}
          align={{ sm: 'center' }}
          justify="between"
          gap="3"
          mt="6"
          pt="6"
          className="border-t border-[var(--gray-6)]"
        >
          <Button variant="soft" color="red" size="3" onClick={onDelete} disabled={editor.saving}>
            <Trash2 size={16} />
            Delete
          </Button>
          <Flex direction={{ initial: 'column-reverse', sm: 'row' }} align={{ initial: 'stretch', sm: 'center' }} gap="3">
            <Button variant="soft" color="gray" size="3" onClick={editor.cancel}>
              Cancel
            </Button>
            <Button size="3" onClick={() => void editor.save()} disabled={editor.saving} loading={editor.saving}>
              Save Changes
            </Button>
          </Flex>
        </Flex>
      )}
    </Card>
  );
};
