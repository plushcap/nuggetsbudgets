import React, { useEffect, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { Button, Flex, Grid, Heading, Text } from '@radix-ui/themes';
import { formatMoney } from '@nuggets/shared';
import {
  useTransactionQuery,
  useTransactionTagsQuery,
  useBudgetItemsQuery,
  useBudgetPeriodsQuery,
  useMerchantsQuery,
  useUsersQuery,
  useTagsQuery,
  useTransactionAttachmentsQuery,
  useDeleteTransactionMutation,
} from '../hooks/queries';
import { useConfirmation } from '../hooks/useConfirmation';
import PageLoader from '../components/PageLoader';
import PageContainer from '../components/PageContainer';
import LoadError from '../components/LoadError';
import ConfirmationDialog from '../components/ConfirmationDialog';
import RecordActivity from '../components/RecordActivity';
import RecordNotifyBanner from '../components/RecordNotifyBanner';
import { TransactionDetailHeader } from '../components/transactions/TransactionDetailHeader';
import { TransactionInfoCard } from '../components/transactions/TransactionInfoCard';
import { SplitAllocationsCard } from '../components/transactions/SplitAllocationsCard';
import { TransactionAttachmentsCard } from '../components/transactions/TransactionAttachmentsCard';
import { TransactionSidebar } from '../components/transactions/TransactionSidebar';
import { useTransactionEditor } from '../components/transactions/useTransactionEditor';
import { DateUtils } from '../utils/dateUtils';
import { EMPTY_LIST } from '../utils/emptyList';
import { errorStatus } from '../utils/errors';
import { logger } from '../utils/logger';
import { sameOriginPath } from '../utils/safeUrls';

/**
 * One transaction: its fields (shown, or edited with each saving on its own:
 * useTransactionEditor), its splits, attachments, budget assignment and import, and the
 * activity on it. A split's own page is its parent's.
 */
const TransactionDetailPage: React.FC = () => {
  const { uuid } = useParams<{ uuid: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const startInEditMode = searchParams.get('edit') === 'true';
  // Where Back, Save Changes and Cancel lead: the page it was opened from, a path on this app
  // (searchParams has decoded it once, which is all it was encoded).
  const returnTo = sameOriginPath(searchParams.get('returnTo')) ?? '/transactions';

  // Data (query-owned)
  const transactionQuery = useTransactionQuery(uuid);
  const { data: transactionData, isLoading: loading } = transactionQuery;
  // A failure the server didn't call "no such transaction" (a 500, a restart) is shown as
  // one, with a retry, not as "doesn't exist".
  const loadFailed = transactionQuery.isError && ![400, 404].includes(errorStatus(transactionQuery.error) ?? 0);
  const transaction = transactionData ?? null;
  const { data: budgetItems = [] } = useBudgetItemsQuery();
  const { data: budgetPeriods = [] } = useBudgetPeriodsQuery();
  const { data: merchants = [] } = useMerchantsQuery({ lite: true });
  const { data: users = [] } = useUsersQuery();
  const { data: tags = [] } = useTagsQuery();
  const { data: txTags = EMPTY_LIST } = useTransactionTagsQuery(uuid);
  const { data: attachmentsResponse } = useTransactionAttachmentsQuery(uuid);
  const attachments = useMemo(() => {
    const a = Array.isArray(attachmentsResponse) ? attachmentsResponse : attachmentsResponse?.attachments;
    return Array.isArray(a) ? a : [];
  }, [attachmentsResponse]);
  const deleteTransactionMutation = useDeleteTransactionMutation();

  const editor = useTransactionEditor({ uuid, transaction, transactionTags: txTags, returnTo });
  const { confirmAsync, dialogProps } = useConfirmation();

  // A split is edited on its parent's page, which takes the split's place in the history, so
  // Back doesn't land on the split and come straight back. returnTo goes along encoded.
  useEffect(() => {
    if (!transaction?.parent_transaction_id || !transaction.parent_transaction_uuid) return;
    logger.info({ parentTransactionUuid: transaction.parent_transaction_uuid }, 'Child transaction detected, redirecting to parent');
    const params = new URLSearchParams(startInEditMode ? { edit: 'true' } : {});
    params.set('returnTo', returnTo);
    navigate(`/transactions/${encodeURIComponent(transaction.parent_transaction_uuid)}?${params}`, { replace: true });
  }, [transaction, navigate, startInEditMode, returnTo]);

  const handleDelete = async () => {
    if (!transaction) return;
    const confirmed = await confirmAsync({
      title: 'Delete Transaction',
      message: `Are you sure you want to delete this transaction?\n\nAmount: ${formatMoney(transaction.amount)}\nDate: ${DateUtils.formatDateUS(transaction.transaction_date)}\n\n${transaction.transfer_transaction_id ? 'This is one side of a transfer, so its other side is deleted too.\n\n' : ''}This action cannot be undone.`,
      variant: 'danger',
      confirmText: 'Delete Transaction',
      cancelText: 'Cancel',
    });
    if (!confirmed) return;

    await editor.whileSaving(async () => {
      try {
        await deleteTransactionMutation.mutateAsync(transaction.uuid);
        toast.success('Transaction deleted successfully');
        navigate(returnTo);
      } catch (error) {
        logger.error({ err: error, uuid }, 'Failed to delete transaction');
        toast.error('Failed to delete transaction');
      }
    });
  };

  if (loading) {
    return (
      <PageContainer>
        <PageLoader label="Loading transaction details…" />
      </PageContainer>
    );
  }

  if (!transaction && loadFailed) {
    return (
      <LoadError
        title="Couldn't load this transaction"
        message="The server didn't answer, or failed to. Try again in a moment."
        error={transactionQuery.error}
        onRetry={() => void transactionQuery.refetch()}
        retrying={transactionQuery.isFetching}
      />
    );
  }

  if (!transaction) {
    return (
      <PageContainer>
        <Flex direction="column" align="center" gap="4" py="9">
          <AlertTriangle size={64} className="text-[var(--gray-11)]" />
          <Heading as="h2" size="5">Transaction not found</Heading>
          <Text color="gray" align="center">
            The transaction you're looking for doesn't exist or may have been deleted.
          </Text>
          <Button onClick={() => navigate(returnTo)}>
            <ArrowLeft size={16} />
            Go Back
          </Button>
        </Flex>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Flex direction="column" gap="6">
        <TransactionDetailHeader
          transaction={transaction}
          isEditing={editor.isEditing}
          saving={editor.saving}
          onBack={() => navigate(returnTo)}
          onToggleApproval={() => void editor.toggleApproval()}
          onEdit={editor.startEditing}
        />

        {/* Agent notify banner (open questions/flags) for this transaction */}
        <RecordNotifyBanner subjectType="transaction" subjectUuid={transaction.uuid} />

        {/* The transaction, its splits and attachments; the side column below it on a phone */}
        <Grid columns={{ initial: '1', lg: '4' }} gap="6">
          <Flex direction="column" gap="6" gridColumn={{ lg: 'span 3' }}>
            <TransactionInfoCard
              transaction={transaction}
              editor={editor}
              budgetItems={budgetItems}
              budgetPeriods={budgetPeriods}
              merchants={merchants}
              users={users}
              tags={tags}
              onDelete={() => void handleDelete()}
            />
            <SplitAllocationsCard
              transaction={transaction}
              budgetItems={budgetItems}
              tags={tags}
              saving={editor.saving}
              whileSaving={editor.whileSaving}
              confirmAsync={confirmAsync}
            />
            <TransactionAttachmentsCard transaction={transaction} attachments={attachments} confirmAsync={confirmAsync} />
          </Flex>
          <TransactionSidebar transaction={transaction} />
        </Grid>

        {/* Agent & human activity / reasoning log for this transaction */}
        <RecordActivity subjectType="transaction" subjectUuid={transaction.uuid} />
      </Flex>

      <ConfirmationDialog {...dialogProps} />
    </PageContainer>
  );
};

export default TransactionDetailPage;
