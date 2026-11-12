import React, { useState, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { BUDGET_ITEM_TEXT_MATCHING_METHODS, budgetItemMatchingRuleCreateSchema, type BudgetItemMatchingRuleInput } from '@nuggets/shared';
import { Routes, Route, Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Target,
  Plus,
  Search,
  Edit3,
  Trash2,
  Save,
  MoreVertical,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { type BudgetItemMatchingRule } from '../services/api';
import {
  useBudgetItemsQuery,
  useMerchantsQuery,
  useBudgetItemMatchingRulesQuery,
  useCreateBudgetItemMatchingRuleMutation,
  useUpdateBudgetItemMatchingRuleMutation,
  useDeleteBudgetItemMatchingRuleMutation,
} from '../hooks/queries';
import { useConfirmation } from '../hooks/useConfirmation';
import ConfirmationDialog from '../components/ConfirmationDialog';
import SettingsPageHeader from '../components/SettingsPageHeader';
import PageLoader from '../components/PageLoader';
import { Card, Box, Flex, Text, Button, TextField, IconButton, Table, Badge, DropdownMenu } from '@radix-ui/themes';
import BudgetMatchingRuleFormFields, {
  type BudgetMatchingRuleFormData,
  createDefaultBudgetMatchingRuleForm,
} from '../components/forms/BudgetMatchingRuleFormFields';
import { errorMessage } from '../utils/errors';
import { MatchingRuleStatusBadge, useToggleMatchingRuleActive } from '../components/budget/matchingRuleStatus';
import { withUnreadableAmounts } from '../components/forms/optionalAmount';
import NotFoundPage from './NotFoundPage';
import PageContainer from '../components/PageContainer';

const BudgetMatchingRulesPage: React.FC = () => {
  return (
    <Routes>
      <Route index element={<BudgetMatchingRulesListPage />} />
      <Route path="add" element={<AddBudgetMatchingRulePage />} />
      <Route path=":uuid/edit" element={<EditBudgetMatchingRulePage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
};

const BudgetMatchingRulesListPage: React.FC = () => {
  const { data: rules = [], isLoading: loading } = useBudgetItemMatchingRulesQuery();
  const deleteRuleMutation = useDeleteBudgetItemMatchingRuleMutation();
  const toggleActive = useToggleMatchingRuleActive();
  const [searchTerm, setSearchTerm] = useState('');
  const navigate = useNavigate();
  const { confirmAsync, dialogProps } = useConfirmation();

  const filteredRules = rules.filter(rule =>
    rule.budget_item_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
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
        <PageLoader label="Loading matching rules…" />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header */}
      <SettingsPageHeader
        title="Budget Matching Rules"
        subtitle="Configure automatic budget assignment for imported transactions"
        icon={<Target size={20} className="text-[var(--accent-11)]" />}
        backPath="/settings"
        primaryAction={{
          label: 'Add Rule',
          onClick: () => navigate('/settings/budget-matching/add'),
          icon: <Plus size={16} />
        }}
      />

      {/* Search and Stats Card */}
      <Card mb="4">
        <Flex direction={{ initial: 'column', sm: 'row' }} align={{ sm: 'center' }} justify="between" gap="4">
          <Box flexGrow="1" maxWidth={{ sm: '28rem' }}>
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

      {/* Rules List */}
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
                  : 'Create your first matching rule to automatically assign budget items to imported transactions.'
                }
              </Text>
            </Flex>
            {!searchTerm && (
              <Button size="3" asChild>
                <Link to="/settings/budget-matching/add">
                  <Plus size={16} />
                  Add Your First Rule
                </Link>
              </Button>
            )}
          </Flex>
        </Card>
      ) : (
        <>
          {/* Mobile Card View */}
          <Card className="block md:hidden">
            <Flex direction="column" gap="4">
              {filteredRules.map((rule) => (
                <BudgetMatchingRuleCard
                  key={rule.id}
                  rule={rule}
                  onEdit={() => navigate(`/settings/budget-matching/${rule.uuid}/edit`)}
                  onDelete={() => handleDeleteRule(rule)}
                  onToggleActive={() => void toggleActive(rule)}
                />
              ))}
            </Flex>
          </Card>

          {/* Desktop Table View */}
          <Card className="hidden md:block">
            <Table.Root size="2">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Priority</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Method</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Matching Text</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Budget Item</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Merchant</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell justify="center">Status</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell justify="end">Actions</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filteredRules.map((rule) => (
                  <BudgetMatchingRuleRow
                    key={rule.id}
                    rule={rule}
                    onEdit={() => navigate(`/settings/budget-matching/${rule.uuid}/edit`)}
                    onDelete={() => handleDeleteRule(rule)}
                    onToggleActive={() => void toggleActive(rule)}
                  />
                ))}
              </Table.Body>
            </Table.Root>
          </Card>
        </>
      )}

      <ConfirmationDialog {...dialogProps} />
    </PageContainer>
  );
};

// Mobile Card Component
interface BudgetMatchingRuleCardProps {
  rule: BudgetItemMatchingRule;
  onEdit: () => void;
  onDelete: () => void;
  /** Switches the rule on, or off (useToggleMatchingRuleActive). */
  onToggleActive: () => void;
}

const BudgetMatchingRuleCard: React.FC<BudgetMatchingRuleCardProps> = ({ rule, onEdit, onDelete, onToggleActive }) => {
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

  const getMethodBadgeColor = (method: string): "blue" | "green" | "purple" | "orange" | "red" | "indigo" | "gray" => {
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
    <Card className="[--card-background-color:var(--gray-2)]">
      <Flex direction="column" gap="3">
        {/* Header Row */}
        <Flex align="start" justify="between">
          <Flex align="center" gap="2" flexGrow="1" flexBasis="0%" minWidth="0">
            <Box
              width="16px" height="16px" flexShrink="0" className="rounded-[var(--radius-2)]"
              style={{ /* lint:guard colour: the budget item's own colour */ backgroundColor: rule.budget_item_color || 'var(--accent-9)' }}
            ></Box>
            <Flex direction="column" gap="1" flexGrow="1" flexBasis="0%" minWidth="0">
              <Text weight="bold" color="gray" highContrast className="truncate">
                {rule.budget_item_name || 'Unknown'}
              </Text>
              {rule.merchant_name && (
                <Text size="2" color="gray" className="truncate">
                  {rule.merchant_name}
                </Text>
              )}
            </Flex>
          </Flex>
          <Flex align="center" gap="2" flexShrink="0" ml="2">
            <MatchingRuleStatusBadge active={rule.is_active} />
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <IconButton variant="ghost" size="3" aria-label="More actions">
                  <MoreVertical size={20} />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                <DropdownMenu.Item onSelect={onEdit}>
                  <Edit3 size={16} />
                  Edit Rule
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={onToggleActive}>
                  {rule.is_active ? 'Switch Rule Off' : 'Switch Rule On'}
                </DropdownMenu.Item>
                <DropdownMenu.Item color="red" onSelect={onDelete}>
                  <Trash2 size={16} />
                  Delete Rule
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </Flex>
        </Flex>

        {/* Details Grid */}
        <Flex direction="column" gap="2">
          <Flex align="center" justify="between">
            <Text size="2" color="gray">Method:</Text>
            <Badge color={getMethodBadgeColor(rule.method)} variant="soft">
              {getMethodDisplay(rule.method)}
            </Badge>
          </Flex>

          {rule.matching_text && (
            <Flex align="center" justify="between">
              <Text size="2" color="gray">Matching Text:</Text>
              <Text
                size="1"
                className="font-mono truncate max-w-[60%] bg-[var(--gray-4)] rounded-[var(--radius-2)]"
                style={{ padding: '2px 8px' }}
                title={rule.matching_text}
              >
                {rule.matching_text}
              </Text>
            </Flex>
          )}

          <Flex align="center" justify="between">
            <Text size="2" color="gray">Priority:</Text>
            <Badge variant="soft" color="gray">
              {rule.priority}
            </Badge>
          </Flex>
        </Flex>
      </Flex>
    </Card>
  );
};

// Desktop Row Component
interface BudgetMatchingRuleRowProps {
  rule: BudgetItemMatchingRule;
  onEdit: () => void;
  onDelete: () => void;
  /** Switches the rule on, or off (useToggleMatchingRuleActive). */
  onToggleActive: () => void;
}

const BudgetMatchingRuleRow: React.FC<BudgetMatchingRuleRowProps> = ({ rule, onEdit, onDelete, onToggleActive }) => {
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

  const getMethodBadgeColor = (method: string): "blue" | "green" | "purple" | "orange" | "red" | "indigo" | "gray" => {
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
          <Badge variant="soft" color="gray">
            {rule.priority}
          </Badge>
        </Table.Cell>
        
        {/* Method */}
        <Table.Cell>
          <Badge color={getMethodBadgeColor(rule.method)} variant="soft">
            {getMethodDisplay(rule.method)}
          </Badge>
        </Table.Cell>
        
        {/* Matching Text */}
        <Table.Cell>
          {rule.matching_text ? (
            <Text
              size="2"
              className="font-mono truncate bg-[var(--gray-4)] rounded-[var(--radius-2)]"
              style={{ padding: '2px 8px', display: 'inline-block' }}
              title={rule.matching_text}
            >
              {rule.matching_text}
            </Text>
          ) : rule.method === 'merchant_exact' ? (
            <Text size="2" color="gray" style={{ fontStyle: 'italic' }}>Merchant-based matching</Text>
          ) : (
            <Text size="2" color="gray">—</Text>
          )}
        </Table.Cell>
        
        {/* Budget Item */}
        <Table.Cell>
          <Flex align="center" gap="2">
            <Box
              width="16px" height="16px" flexShrink="0" className="rounded-[var(--radius-2)]"
              style={{ /* lint:guard colour: the budget item's own colour */ backgroundColor: rule.budget_item_color || 'var(--accent-9)' }}
            ></Box>
            {rule.budget_item_uuid ? (
              <Link
                to={`/budget-items/${rule.budget_item_uuid}/rules`}
                style={{ textDecoration: 'none' }}
                className="truncate hover:underline text-[var(--accent-11)]"
                title={`View rules for ${rule.budget_item_name}`}
              >
                <Text size="2">{rule.budget_item_name || 'Unknown'}</Text>
              </Link>
            ) : (
              <Text size="2" color="gray" highContrast className="truncate" title={rule.budget_item_name ?? undefined}>
                {rule.budget_item_name || 'Unknown'}
              </Text>
            )}
          </Flex>
        </Table.Cell>
        
        {/* Merchant */}
        <Table.Cell>
          {rule.merchant_name ? (
            <Text size="2" color="gray" className="truncate" title={rule.merchant_name}>
              {rule.merchant_name}
            </Text>
          ) : (
            <Text size="2" color="gray">—</Text>
          )}
        </Table.Cell>
        
        {/* Status */}
        <Table.Cell justify="center">
          <Flex justify="center">
            <MatchingRuleStatusBadge active={rule.is_active} />
          </Flex>
        </Table.Cell>
        
        {/* Actions */}
        <Table.Cell justify="end">
          <Flex gap="1" justify="end">
            <IconButton
              onClick={onEdit}
              variant="ghost"
              color="blue"
              size="2"
              aria-label="Edit rule"
              title="Edit rule"
            >
              <Edit3 size={16} />
            </IconButton>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <IconButton variant="ghost" size="2" aria-label="More actions" title="More actions">
                  <MoreVertical size={16} />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                <DropdownMenu.Item onSelect={onEdit}>
                  <Edit3 size={16} />
                  Edit Rule
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={onToggleActive}>
                  {rule.is_active ? 'Switch Rule Off' : 'Switch Rule On'}
                </DropdownMenu.Item>
                <DropdownMenu.Item color="red" onSelect={onDelete}>
                  <Trash2 size={16} />
                  Delete Rule
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </Flex>
        </Table.Cell>
      </Table.Row>
    </>
  );
};

/**
 * The body a create or an update sends. A PUT replaces the rule, so every field is sent, a
 * cleared one as none (null). The form keeps a field its method hides, so what a method
 * doesn't read goes by the method:
 * - the matching text only with a method that reads it: a rule changed to merchant matching
 *   kept its old text;
 * - the merchant picked with merchant matching. Another method sends `textRuleMerchant`, the
 *   merchant a text rule had already (MCP can scope one to a merchant, and the matcher then
 *   reads it only for that merchant's transactions), which the form doesn't show: a rule
 *   changed away from merchant matching kept its merchant, and ran on that merchant alone.
 * A bound of 0 is a bound (an empty box is none), and the rule is active as the box says.
 */
const ruleBody = (formData: BudgetMatchingRuleFormData, textRuleMerchant: number | null): BudgetItemMatchingRuleInput => ({
  budget_item_id: formData.budget_item_id,
  method: formData.method,
  matching_text: BUDGET_ITEM_TEXT_MATCHING_METHODS.includes(formData.method) ? formData.matching_text?.trim() || null : null,
  merchant_id: formData.method === 'merchant_exact' ? (formData.merchant_id ?? null) : textRuleMerchant,
  amount_min: formData.amount_min ?? null,
  amount_max: formData.amount_max ?? null,
  priority: formData.priority || 100,
  is_active: formData.is_active,
  notes: formData.notes?.trim() || null,
});

/** The form's schema, and an amount bound it can't read refused beside it (it was dropped). */
const ruleResolver = withUnreadableAmounts(zodResolver(budgetItemMatchingRuleCreateSchema));

// Add Rule Page
const AddBudgetMatchingRulePage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const preSelectedBudgetItemId = searchParams.get('budget_item_id');
  const preSelectedBudgetItemUuid = searchParams.get('budget_item_uuid');
  
  const defaultForm = createDefaultBudgetMatchingRuleForm();
  const { data: budgetItems = [] } = useBudgetItemsQuery();
  const { data: merchants = [] } = useMerchantsQuery({ lite: true });
  const createRuleMutation = useCreateBudgetItemMatchingRuleMutation();
  const saving = createRuleMutation.isPending;

  const navigate = useNavigate();

  const form = useForm<BudgetMatchingRuleFormData>({
    defaultValues: {
      ...defaultForm,
      budget_item_id: preSelectedBudgetItemId ? parseInt(preSelectedBudgetItemId) : defaultForm.budget_item_id,
      priority: 100,
      is_active: true,
    },
    resolver: ruleResolver as never,
  });
  const { handleSubmit, setValue, getValues } = form;

  const isBudgetItemPreselected = !!(preSelectedBudgetItemId || preSelectedBudgetItemUuid);

  // Convert a pre-selected budget-item UUID to its id once items load.
  useEffect(() => {
    if (preSelectedBudgetItemUuid && !preSelectedBudgetItemId && budgetItems.length > 0) {
      const matchingItem = budgetItems.find(item => item.uuid === preSelectedBudgetItemUuid);
      if (matchingItem) {
        setValue('budget_item_id', matchingItem.id);
      }
    }
  }, [budgetItems, preSelectedBudgetItemUuid, preSelectedBudgetItemId, setValue]);

  const onSubmit = async () => {
    const formData = getValues();

    // Method-specific requirements (budget item + method enforced by the schema).
    const textBasedMethods = ['exact', 'contains', 'starts_with', 'ends_with', 'regex'];
    if (textBasedMethods.includes(formData.method) && !formData.matching_text?.trim()) {
      toast.error('Matching text is required for this method');
      return;
    }

    if (formData.method === 'merchant_exact' && !formData.merchant_id) {
      toast.error('Merchant is required for merchant matching');
      return;
    }

    try {
      await createRuleMutation.mutateAsync([ruleBody(formData, null)]);

      toast.success('Budget matching rule created successfully');
      navigate('/settings/budget-matching');
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to create rule'));
    }
  };

  return (
    <PageContainer width="form">
      {/* Header */}
      <SettingsPageHeader
        title="Add Matching Rule"
        subtitle="Create a new automatic budget assignment rule"
        icon={<Target size={20} className="text-[var(--accent-11)]" />}
        backPath="/settings/budget-matching"
        primaryAction={{
          label: 'Create Rule',
          onClick: (e) => {
            e?.preventDefault();
            void handleSubmit(onSubmit)();
          },
          icon: <Save size={16} />,
          disabled: saving,
          loading: saving
        }}
      />

      <Card>
        <form onSubmit={handleSubmit(onSubmit)}>
          <BudgetMatchingRuleFormFields
            form={form}
            budgetItems={budgetItems}
            merchants={merchants}
            budgetItemDisabled={isBudgetItemPreselected}
            budgetItemPreselectedNote={isBudgetItemPreselected}
          />
        </form>
      </Card>
    </PageContainer>
  );
};

// Edit Rule Page (similar to Add but with pre-populated data)
const EditBudgetMatchingRulePage: React.FC = () => {
  const { uuid } = useParams<{ uuid: string }>();
  const defaultForm = createDefaultBudgetMatchingRuleForm();
  const { data: budgetItems = [] } = useBudgetItemsQuery();
  const { data: merchants = [] } = useMerchantsQuery({ lite: true });
  const { data: rules = [], isLoading: rulesLoading } = useBudgetItemMatchingRulesQuery();
  const updateRuleMutation = useUpdateBudgetItemMatchingRuleMutation();
  const loading = rulesLoading;
  const saving = updateRuleMutation.isPending;

  const navigate = useNavigate();

  const form = useForm<BudgetMatchingRuleFormData>({
    defaultValues: {
      ...defaultForm,
      priority: 100,
      is_active: true,
    },
    resolver: ruleResolver as never,
  });
  const { handleSubmit, reset, getValues } = form;

  // Seed the form from the rule once it loads; redirect if it can't be found.
  const seededRef = useRef(false);
  useEffect(() => {
    if (rulesLoading || seededRef.current) return;
    const rule = rules.find(r => r.uuid === uuid);
    if (rule) {
      seededRef.current = true;
      reset({
        budget_item_id: rule.budget_item_id,
        merchant_id: rule.merchant_id ?? null,
        method: rule.method,
        matching_text: rule.matching_text || null,
        // The API sends a bound as decimal text (NUMERIC); a bound of 0 is kept.
        amount_min: rule.amount_min == null ? null : Number(rule.amount_min),
        amount_max: rule.amount_max == null ? null : Number(rule.amount_max),
        priority: rule.priority,
        is_active: rule.is_active,
        notes: rule.notes || null
      });
    } else {
      toast.error('Rule not found');
      navigate('/settings/budget-matching');
    }
  }, [rulesLoading, rules, uuid, navigate, reset]);

  const onSubmit = async () => {
    if (!uuid) return;
    const formData = getValues();

    // Method-specific requirements (budget item + method enforced by the schema).
    const textBasedMethods = ['exact', 'contains', 'starts_with', 'ends_with', 'regex'];
    if (textBasedMethods.includes(formData.method) && !formData.matching_text?.trim()) {
      toast.error('Matching text is required for this method');
      return;
    }

    if (formData.method === 'merchant_exact' && !formData.merchant_id) {
      toast.error('Merchant is required for merchant matching');
      return;
    }

    try {
      // A text rule keeps the merchant it has (the form shows none for it).
      const saved = rules.find((r) => r.uuid === uuid);
      const textRuleMerchant = saved && saved.method !== 'merchant_exact' ? (saved.merchant_id ?? null) : null;
      await updateRuleMutation.mutateAsync([uuid, ruleBody(formData, textRuleMerchant)]);

      toast.success('Budget matching rule updated successfully');
      navigate('/settings/budget-matching');
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to update rule'));
    }
  };

  if (loading) {
    return (
      <PageContainer width="form">
        <PageLoader label="Loading matching rule…" />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="form">
      {/* Header */}
      <SettingsPageHeader
        title="Edit Matching Rule"
        subtitle="Modify automatic budget assignment rule"
        icon={<Target size={20} className="text-[var(--accent-11)]" />}
        backPath="/settings/budget-matching"
        primaryAction={{
          label: 'Save Changes',
          onClick: (e) => {
            e?.preventDefault();
            void handleSubmit(onSubmit)();
          },
          icon: <Save size={16} />,
          disabled: saving,
          loading: saving
        }}
      />

      <Card>
        <form onSubmit={handleSubmit(onSubmit)}>
          <BudgetMatchingRuleFormFields
            form={form}
            budgetItems={budgetItems}
            merchants={merchants}
          />
        </form>
      </Card>
    </PageContainer>
  );
};

export default BudgetMatchingRulesPage;
