import React from 'react';
import { Box } from '@radix-ui/themes';
import { ClockIcon, CircleCheck, Lock, UserCheck, TriangleAlert, Eye, HelpCircle } from 'lucide-react';
import { REVIEW_STATUS_LABELS, TRANSACTION_STATUS_LABELS, vocabularyLabel, transactionStatus } from '@nuggets/shared';

/** A transaction's status as an icon, its label in the tooltip. */
export const TransactionStatusIcon: React.FC<{ status: string }> = ({ status }) => {
  const title = vocabularyLabel(TRANSACTION_STATUS_LABELS, status);
  switch (status) {
    case transactionStatus.enum.pending:
      return <Box title={title}><ClockIcon size={16} className="text-[var(--gray-11)]" /></Box>;
    case transactionStatus.enum.cleared:
      return <Box title={title}><CircleCheck size={16} className="text-[var(--green-12)]" /></Box>;
    case transactionStatus.enum.reconciled:
      return <Box title={title}><Lock size={16} className="text-[var(--gray-12)]" /></Box>;
    default:
      return <Box title={title}><HelpCircle size={16} className="text-[var(--gray-11)]" /></Box>;
  }
};

/** A transaction's review status as an icon, its label in the tooltip. */
export const ReviewStatusIcon: React.FC<{ status: string }> = ({ status }) => {
  switch (status) {
    case 'reviewed':
      return <Box title={REVIEW_STATUS_LABELS.reviewed}><UserCheck size={16} className="text-[var(--green-12)]" /></Box>;
    case 'flagged':
      return <Box title={REVIEW_STATUS_LABELS.flagged}><TriangleAlert size={16} className="text-[var(--yellow-12)]" /></Box>;
    default:
      return <Box title="Not Reviewed"><Eye size={16} className="text-[var(--red-11)]" /></Box>;
  }
};
