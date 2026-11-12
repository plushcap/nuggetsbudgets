import React from 'react';
import { Badge, Box, Flex, IconButton, Text } from '@radix-ui/themes';
import { Edit3, Trash2 } from 'lucide-react';
import type { MerchantRule } from '../../services/api';
import { formatInstantDate } from '../../utils/dateUtils';
import { MERCHANT_RULE_METHOD_DESCRIPTIONS, MERCHANT_RULE_METHOD_LABELS } from './merchantFields';

interface MerchantRuleItemProps {
  rule: MerchantRule;
  onEdit: (rule: MerchantRule) => void;
  onDelete: (rule: MerchantRule) => void;
}

/** One of a merchant's matching rules: its method and text, when it was made, and its actions. */
const MerchantRuleItem: React.FC<MerchantRuleItemProps> = ({ rule, onEdit, onDelete }) => (
  <Box p="4" className="bg-[var(--gray-2)] border border-[var(--gray-6)] rounded-[var(--radius-3)]">
    <Flex align="start" justify="between" gap="4">
      <Flex direction="column" gap="2" flexGrow="1">
        <Flex align="center" gap="3">
          <Badge color="blue" variant="soft">
            {MERCHANT_RULE_METHOD_LABELS[rule.method]}
          </Badge>
          <Text size="4" weight="medium" color="gray" highContrast>
            "{rule.matching_text}"
          </Text>
        </Flex>
        <Text size="2" color="gray">
          {MERCHANT_RULE_METHOD_DESCRIPTIONS[rule.method]}
        </Text>
        <Text size="1" color="gray">
          Created {formatInstantDate(rule.created_at)}
          {rule.updated_at !== rule.created_at && ` • Updated ${formatInstantDate(rule.updated_at)}`}
        </Text>
      </Flex>
      <Flex gap="2">
        <IconButton variant="ghost" color="gray" onClick={() => onEdit(rule)} aria-label="Edit rule">
          <Edit3 size={16} />
        </IconButton>
        <IconButton variant="ghost" color="red" onClick={() => onDelete(rule)} aria-label="Delete rule">
          <Trash2 size={16} />
        </IconButton>
      </Flex>
    </Flex>
  </Box>
);

export default MerchantRuleItem;
