import React from 'react';
import { Badge, Box, Button, Flex, Heading, IconButton, Text } from '@radix-ui/themes';
import { AlertTriangle, ArrowLeft, Check, Edit3, Split } from 'lucide-react';
import type { TransactionWithSplits } from '@nuggets/shared';
import { DateUtils } from '../../utils/dateUtils';
import { transactionReviewStatus } from '@nuggets/shared';

interface TransactionDetailHeaderProps {
  transaction: TransactionWithSplits;
  isEditing: boolean;
  saving: boolean;
  onBack: () => void;
  onToggleApproval: () => void;
  onEdit: () => void;
}

/** The page's title (its one <h1>), with Back, the review toggle and Edit. */
export const TransactionDetailHeader: React.FC<TransactionDetailHeaderProps> = ({
  transaction,
  isEditing,
  saving,
  onBack,
  onToggleApproval,
  onEdit,
}) => {
  const reviewed = transaction.review_status === transactionReviewStatus.enum.reviewed;
  return (
    <Flex direction={{ initial: 'column', lg: 'row' }} align={{ lg: 'start' }} justify="between" gap="4">
      <Flex align="center" gap="3">
        {/* A flex box, not a block: a block's line box sat the button 2px above the title's middle. */}
        <Flex flexShrink="0">
          <IconButton variant="ghost" color="gray" onClick={onBack} aria-label="Go back">
            <ArrowLeft size={20} />
          </IconButton>
        </Flex>
        <Box flexGrow="1" minWidth="0">
          <Heading as="h1" size="6">
            <Flex align="center" gap="2" wrap="wrap">
              Transaction Details
              {transaction.is_split_parent && (
                <Badge color="purple" size="2">
                  <Split size={12} />
                  Split
                </Badge>
              )}
            </Flex>
          </Heading>
          <Text as="div" size="2" color="gray" mt="1" truncate>
            {transaction.merchant_name || 'Unknown Merchant'} • {DateUtils.formatDateUS(transaction.transaction_date)}
          </Text>
        </Box>
      </Flex>

      {/* Full width on a phone, on the right on a desktop */}
      <Flex direction={{ initial: 'column', sm: 'row' }} gap="3" flexShrink={{ lg: '0' }}>
        <Button onClick={onToggleApproval} disabled={saving} loading={saving} size="3" color={reviewed ? 'green' : 'amber'}>
          {reviewed ? <Check size={16} /> : <AlertTriangle size={16} />}
          {reviewed ? 'Reviewed' : 'Not Reviewed'}
        </Button>
        {!isEditing && (
          <Button variant="soft" color="gray" size="3" onClick={onEdit}>
            <Edit3 size={16} />
            Edit
          </Button>
        )}
      </Flex>
    </Flex>
  );
};
