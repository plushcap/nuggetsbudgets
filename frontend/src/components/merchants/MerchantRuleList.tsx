import React from 'react';
import { Button, Card, Flex, Text } from '@radix-ui/themes';
import { Plus, Settings } from 'lucide-react';
import type { MerchantRule } from '../../services/api';
import MerchantRuleItem from './MerchantRuleItem';

interface MerchantRuleListProps {
  rules: MerchantRule[];
  onAdd: () => void;
  onEdit: (rule: MerchantRule) => void;
  onDelete: (rule: MerchantRule) => void;
}

/** A merchant's matching rules, or an invitation to add the first. */
const MerchantRuleList: React.FC<MerchantRuleListProps> = ({ rules, onAdd, onEdit, onDelete }) => (
  <Card>
    <Flex direction="column" gap="2" mb="4">
      <Text size="5" weight="bold" color="gray" highContrast>
        Current Rules
      </Text>
      <Text size="2" color="gray">
        These rules will automatically assign transactions to this merchant
      </Text>
    </Flex>

    {rules.length === 0 ? (
      <Flex direction="column" align="center" gap="4" py="9">
        <Settings size={64} className="text-[var(--gray-6)]" />
        <Flex direction="column" align="center" gap="2">
          <Text size="4" weight="bold" color="gray" highContrast>
            No rules yet
          </Text>
          <Text size="2" color="gray">
            Add your first matching rule to automatically categorize transactions
          </Text>
        </Flex>
        <Button color="blue" size="3" onClick={onAdd}>
          <Plus size={20} />
          Add Rule
        </Button>
      </Flex>
    ) : (
      <Flex direction="column" gap="4">
        {rules.map((rule) => (
          <MerchantRuleItem key={rule.id} rule={rule} onEdit={onEdit} onDelete={onDelete} />
        ))}
      </Flex>
    )}
  </Card>
);

export default MerchantRuleList;
