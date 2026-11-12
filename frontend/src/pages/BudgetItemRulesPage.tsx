import React, { useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Target,
  Plus,
  Search,
  Edit3,
  Trash2,
  ArrowLeft,
  MoreVertical,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { type BudgetItemMatchingRule } from '../services/api';
import {
  useBudgetItemsQuery,
  useBudgetItemMatchingRulesByItemQuery,
  useDeleteBudgetItemMatchingRuleMutation,
} from '../hooks/queries';
import { useConfirmation } from '../hooks/useConfirmation';
import ConfirmationDialog from '../components/ConfirmationDialog';
import { Card, Flex, Heading, Text, Button, TextField, IconButton, Table, Badge, DropdownMenu, ScrollArea, Box } from '@radix-ui/themes';
import PageLoader from '../components/PageLoader';
import { errorMessage } from '../utils/errors';
import { MatchingRuleStatusBadge, useToggleMatchingRuleActive } from '../components/budget/matchingRuleStatus';
import { chosenColourProps } from '../utils/textColor';
import PageContainer from '../components/PageContainer';

const BudgetItemRulesPage: React.FC = () => {
  const { budgetItemUuid } = useParams<{ budgetItemUuid: string }>();
  const [searchTerm, setSearchTerm] = useState('');
  const navigate = useNavigate();
  const { confirmAsync, dialogProps } = useConfirmation();

  const { data: rules = [], isLoading: rulesLoading } = useBudgetItemMatchingRulesByItemQuery(budgetItemUuid);
  const { data: budgetItems = [], isLoading: itemsLoading } = useBudgetItemsQuery();
  const budgetItem = useMemo(
    () => budgetItems.find(bi => bi.uuid === budgetItemUuid) ?? null,
    [budgetItems, budgetItemUuid],
  );
  const loading = rulesLoading || itemsLoading;

  const deleteRuleMutation = useDeleteBudgetItemMatchingRuleMutation();
  const toggleActive = useToggleMatchingRuleActive();

  const filteredRules = rules.filter(rule =>
    rule.merchant_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    rule.matching_text?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    rule.method.toLowerCase().includes(searchTerm.toLowerCase()) ||
    rule.notes?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleDeleteRule = async (rule: BudgetItemMatchingRule) => {
    const confirmed = await confirmAsync({
      title: 'Delete Matching Rule',
      message: `Are you sure you want to delete this budget matching rule?\n\nRule: ${rule.method} "${rule.matching_text || 'N/A'}"\nBudget Item: ${rule.budget_item_name}`,
      variant: 'danger',
      confirmText: 'Delete Rule',
      cancelText: 'Keep Rule',
      icon: <Trash2 size={24} />,
      details: [
        'This will stop automatic assignment for matching transactions',
        'Existing transaction assignments will not be affected',
        'This action cannot be undone'
      ]
    });

    if (!confirmed) return;

    try {
      await deleteRuleMutation.mutateAsync(rule.uuid);
      toast.success('Budget matching rule deleted successfully');
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to delete rule'));
    }
  };

  if (loading) {
    return (
      <PageContainer>
        <PageLoader label="Loading rules…" />
      </PageContainer>
    );
  }

  if (!budgetItem) {
    return (
      <PageContainer>
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Target size={48} className="text-[var(--gray-11)]" />
            <Flex direction="column" align="center" gap="2">
              <Text size="4" weight="bold" color="gray" highContrast>
                Budget Item Not Found
              </Text>
              <Text size="2" color="gray">
                The budget item you're looking for could not be found.
              </Text>
            </Flex>
            <Button size="3" onClick={() => navigate(-1)}>
              Go Back
            </Button>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header */}
      <Flex align="center" justify="between" mb="6">
        <Flex align="center" gap="3">
          <IconButton
            variant="ghost"
            color="gray"
            onClick={() => navigate(-1)}
            aria-label="Back to previous page"
            size="3"
          >
            <ArrowLeft size={20} />
          </IconButton>
          <Flex width="40px" height="40px" align="center" justify="center" {...chosenColourProps(budgetItem.color, 'accent', 'rounded-[var(--radius-5)]')}>
            <Target size={20} aria-hidden="true" />
          </Flex>
          <Flex direction="column" gap="1">
            <Heading as="h1" size="6" weight="bold" color="gray" highContrast>
              {budgetItem.name} Rules
            </Heading>
            <Text size="2" color="gray">
              Automatic assignment rules for this budget item
            </Text>
          </Flex>
        </Flex>
        <Button color="blue" size="3" asChild>
          <Link to={`/settings/budget-matching/add?budget_item_uuid=${budgetItemUuid}`}>
            <Plus size={16} />
            Add Rule
          </Link>
        </Button>
      </Flex>

      {/* Search and Stats Card */}
      <Card mb="4">
        <Flex direction={{ initial: 'column', sm: 'row' }} align={{ sm: 'center' }} justify="between" gap="4">
          <Box flexGrow="1" flexBasis="0%" className="sm:max-w-md">
            <TextField.Root
              aria-label="Search rules"
              placeholder="Search rules..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              size="3"
              variant="surface"
            >
              <TextField.Slot>
                <Search size={16} />
              </TextField.Slot>
            </TextField.Root>
          </Box>
          <Flex align="center" justify={{ initial: 'between', sm: 'start' }} gap="4">
            <Text size="2" color="gray">
              Total: <Text weight="medium" color="gray" highContrast>{filteredRules.length}</Text>
            </Text>
            <Text size="2" color="green" highContrast>
              Active: <Text weight="medium">{filteredRules.filter(r => r.is_active).length}</Text>
            </Text>
            <Text size="2" color="gray">
              Inactive: <Text weight="medium">{filteredRules.filter(r => !r.is_active).length}</Text>
            </Text>
          </Flex>
        </Flex>
      </Card>

      {/* Rules Table */}
      {filteredRules.length === 0 ? (
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Target size={48} className="text-[var(--gray-6)]" />
            <Flex direction="column" align="center" gap="2">
              <Text size="4" weight="bold" color="gray" highContrast>
                {searchTerm ? 'No matching rules found' : 'No budget matching rules yet'}
              </Text>
              <Text size="2" color="gray" align="center">
                {searchTerm
                  ? 'Try adjusting your search terms to find what you\'re looking for.'
                  : `Create your first matching rule for "${budgetItem.name}" to automatically assign this budget item to imported transactions.`
                }
              </Text>
            </Flex>
            {!searchTerm && (
              <Button color="blue" size="3" asChild>
                <Link to={`/settings/budget-matching/add?budget_item_uuid=${budgetItemUuid}`}>
                  <Plus size={16} />
                  Add Your First Rule
                </Link>
              </Button>
            )}
          </Flex>
        </Card>
      ) : (
        <Card>
          <ScrollArea scrollbars="horizontal">
          <Table.Root size="2">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Priority</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Method</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Matching Text</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Merchant</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell justify="center">Status</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell justify="end">Actions</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {filteredRules.map((rule) => (
                <BudgetRuleRow
                  key={rule.id}
                  rule={rule}
                  onEdit={() => navigate(`/settings/budget-matching/${rule.uuid}/edit`)}
                  onDelete={() => handleDeleteRule(rule)}
                  onToggleActive={() => void toggleActive(rule)}
                />
              ))}
            </Table.Body>
          </Table.Root>
          </ScrollArea>
        </Card>
      )}

      <ConfirmationDialog {...dialogProps} />
    </PageContainer>
  );
};

interface BudgetRuleRowProps {
  rule: BudgetItemMatchingRule;
  onEdit: () => void;
  onDelete: () => void;
  /** Switches the rule on, or off (useToggleMatchingRuleActive). */
  onToggleActive: () => void;
}

const BudgetRuleRow: React.FC<BudgetRuleRowProps> = ({ rule, onEdit, onDelete, onToggleActive }) => {
  const getMethodDisplay = (method: string) => {
    const methodMap = {
      'exact': 'Exact Match',
      'contains': 'Contains',
      'starts_with': 'Starts With', 
      'ends_with': 'Ends With',
      'regex': 'Regex Pattern',
      'merchant_exact': 'Merchant Match'
    };
    return methodMap[method as keyof typeof methodMap] || method;
  };

  const getMethodColor = (method: string): "blue" | "green" | "purple" | "orange" | "red" | "indigo" | "gray" => {
    const colorMap: { [key: string]: "blue" | "green" | "purple" | "orange" | "red" | "indigo" | "gray" } = {
      'exact': 'blue',
      'contains': 'green',
      'starts_with': 'purple',
      'ends_with': 'orange',
      'regex': 'red',
      'merchant_exact': 'indigo'
    };
    return colorMap[method] || 'gray';
  };

  return (
    <>
      <Table.Row>
        {/* Priority */}
        <Table.Cell>
          <Badge color="gray" variant="soft">
            {rule.priority}
          </Badge>
        </Table.Cell>

        {/* Method */}
        <Table.Cell>
          <Badge color={getMethodColor(rule.method)} variant="soft">
            {getMethodDisplay(rule.method)}
          </Badge>
        </Table.Cell>

        {/* Matching Text */}
        <Table.Cell>
          {rule.matching_text ? (
            <Text size="2" color="gray" highContrast style={{ fontFamily: 'monospace' }} truncate title={rule.matching_text}>
              {rule.matching_text}
            </Text>
          ) : rule.method === 'merchant_exact' ? (
            <Text size="2" color="gray" style={{ fontStyle: 'italic' }}>
              Merchant-based matching
            </Text>
          ) : (
            <Text size="2" color="gray">
              —
            </Text>
          )}
        </Table.Cell>

        {/* Merchant */}
        <Table.Cell>
          {rule.merchant_name ? (
            <Text size="2" color="gray" truncate title={rule.merchant_name}>
              {rule.merchant_name}
            </Text>
          ) : (
            <Text size="2" color="gray">
              —
            </Text>
          )}
        </Table.Cell>

        {/* Status */}
        <Table.Cell justify="center">
          <MatchingRuleStatusBadge active={rule.is_active} />
        </Table.Cell>

        {/* Actions */}
        <Table.Cell justify="end">
          <Flex gap="2" justify="end">
            <IconButton
              variant="ghost"
              color="gray"
              onClick={onEdit}
              aria-label="Edit rule"
              title="Edit rule"
              size="1"
            >
              <Edit3 size={16} />
            </IconButton>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <IconButton
                  variant="ghost"
                  color="gray"
                  aria-label="More actions"
                  title="More actions"
                  size="1"
                >
                  <MoreVertical size={16} />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                <DropdownMenu.Item onSelect={onEdit}>
                  <Edit3 size={16} /> Edit Rule
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={onToggleActive}>
                  {rule.is_active ? 'Switch Rule Off' : 'Switch Rule On'}
                </DropdownMenu.Item>
                <DropdownMenu.Item color="red" onSelect={onDelete}>
                  <Trash2 size={16} /> Delete Rule
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </Flex>
        </Table.Cell>
      </Table.Row>
    </>
  );
};

export default BudgetItemRulesPage;