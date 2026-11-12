import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { withUnreadableAmounts } from '../components/forms/optionalAmount';
import { budgetItemCreateSchema } from '@nuggets/shared';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Wallet, Save } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Card, Flex, Button, SegmentedControl } from '@radix-ui/themes';
import { logger } from '../utils/logger';
import { sameOriginPath } from '../utils/safeUrls';
import SettingsPageHeader from '../components/SettingsPageHeader';
import {
  useCreateBudgetItemMutation,
  useCategoriesQuery,
  useTagsQuery,
  useAddTagToBudgetItemMutation,
} from '../hooks/queries';
import type { Tag } from '../services/api';
import IncomeFormFields, { type IncomeFormData, createDefaultIncomeForm } from '../components/forms/IncomeFormFields';
import ExpenseFormFields, { type ExpenseFormData, createDefaultExpenseForm } from '../components/forms/ExpenseFormFields';
import BillFormFields, { type BillFormData, createDefaultBillForm } from '../components/forms/BillFormFields';
import { centsToAmount, perMonthRoundedUp, toCents } from '../utils/currency';
import PageContainer from '../components/PageContainer';

/**
 * Unified "Add Budget Item" page (`/budget-items/add`).
 *
 * Income, Expense, and Bill are one `budget_item` entity, so a single create
 * surface with a kind selector replaces the three former `/settings/{...}/add`
 * pages. Each kind's form lives here as a small component;
 * they share the create → apply-tags → toast → navigate flow and one action bar.
 */
type BudgetItemKind = 'income' | 'expense' | 'bill';

const isKind = (value: string | null): value is BudgetItemKind =>
  value === 'income' || value === 'expense' || value === 'bill';

/**
 * Shared submit flow for a new budget item: create it, apply any locally-held
 * tags (which need the new item's uuid), then toast + navigate back. Each kind
 * keeps its own typed payload and create mutation; this owns the rest.
 */
function useSubmitNewBudgetItem(returnTo: string) {
  const navigate = useNavigate();
  const addTagMutation = useAddTagToBudgetItemMutation();

  return async (
    create: () => Promise<{ uuid: string }>,
    tags: Tag[],
    messages: { success: string; error: string },
  ) => {
    try {
      const created = await create();
      for (const tag of tags) {
        await addTagMutation.mutateAsync({ budgetItemUuid: created.uuid, tagId: tag.id });
      }
      toast.success(messages.success);
      navigate(returnTo);
    } catch (err) {
      logger.error({ err }, messages.error);
      toast.error(messages.error);
    }
  };
}

/** Cancel + submit footer, shared by all three create forms. */
const CreateActions: React.FC<{ label: string; loading: boolean; returnTo: string }> = ({ label, loading, returnTo }) => (
  <Flex gap="3" justify="end" pt="6" mt="6" className="border-t border-[var(--gray-6)]">
    <Button asChild variant="soft" color="gray" size="3">
      <Link to={returnTo}>Cancel</Link>
    </Button>
    <Button type="submit" disabled={loading} loading={loading} size="3">
      <Save size={16} />
      {label}
    </Button>
  </Flex>
);

interface AddFormProps {
  /** Where Cancel and a successful create navigate to. */
  returnTo?: string;
}

export const IncomeAddForm: React.FC<AddFormProps> = ({ returnTo = '/budgets' }) => {
  const createBudgetItemMutation = useCreateBudgetItemMutation();
  const { data: tags = [] } = useTagsQuery();
  const submitNew = useSubmitNewBudgetItem(returnTo);
  const saving = createBudgetItemMutation.isPending;

  const [selectedTags, setSelectedTags] = useState<Tag[]>([]);
  const [autoTag, setAutoTag] = useState<Tag | null>(null);

  const form = useForm<IncomeFormData>({
    defaultValues: createDefaultIncomeForm(),
    resolver: withUnreadableAmounts(zodResolver(budgetItemCreateSchema)) as never,
  });

  const onSubmit = () =>
    submitNew(
      () =>
        createBudgetItemMutation.mutateAsync({
          ...form.getValues(),
          expense_type: 'Income' as const,
          type: 'Monthly' as const,
          rollover: false,
          isbill: false,
          recurring_payment: false,
          transaction_auto_tag_id: autoTag?.id || null,
        }),
      selectedTags,
      { success: 'Income created successfully!', error: 'Failed to save income' },
    );

  return (
    <Card>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <IncomeFormFields
          form={form}
          loading={saving}
          tags={tags}
          selectedTags={selectedTags}
          onTagsChange={setSelectedTags}
          autoTag={autoTag}
          onAutoTagChange={setAutoTag}
          budgetItemUuid={null}
        />
        <CreateActions label="Create Income" loading={saving} returnTo={returnTo} />
      </form>
    </Card>
  );
};

export const ExpenseAddForm: React.FC<AddFormProps> = ({ returnTo = '/budgets' }) => {
  const { data: categories = [], isLoading: categoriesLoading } = useCategoriesQuery();
  const createBudgetItemMutation = useCreateBudgetItemMutation();
  const { data: tags = [] } = useTagsQuery();
  const submitNew = useSubmitNewBudgetItem(returnTo);
  const saving = createBudgetItemMutation.isPending;

  const [selectedTags, setSelectedTags] = useState<Tag[]>([]);
  const [autoTag, setAutoTag] = useState<Tag | null>(null);

  const form = useForm<ExpenseFormData>({
    defaultValues: createDefaultExpenseForm(),
    resolver: withUnreadableAmounts(zodResolver(budgetItemCreateSchema)) as never,
  });

  const onSubmit = () =>
    submitNew(
      () => {
        const expenseData = {
          ...form.getValues(),
          isbill: false, // Always false for expenses
          recurring_payment: false, // Always false for expenses
          transaction_auto_tag_id: autoTag?.id || null,
        };
        // Recurring-payment fields are not used for expenses.
        delete expenseData.recurring_payment_amount;
        delete expenseData.recurring_payment_frequency;
        delete expenseData.recurring_next_payment_date;
        return createBudgetItemMutation.mutateAsync(expenseData);
      },
      selectedTags,
      { success: 'Expense created successfully!', error: 'Failed to create expense' },
    );

  return (
    <Card>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <ExpenseFormFields
          form={form}
          categories={categories}
          loading={categoriesLoading}
          tags={tags}
          selectedTags={selectedTags}
          onTagsChange={setSelectedTags}
          autoTag={autoTag}
          onAutoTagChange={setAutoTag}
          budgetItemUuid={null}
        />
        <CreateActions label="Create Expense" loading={saving} returnTo={returnTo} />
      </form>
    </Card>
  );
};

export const BillAddForm: React.FC<AddFormProps> = ({ returnTo = '/budgets' }) => {
  const createBudgetItemMutation = useCreateBudgetItemMutation();
  const { data: tags = [] } = useTagsQuery();
  const submitNew = useSubmitNewBudgetItem(returnTo);
  const saving = createBudgetItemMutation.isPending;

  const [selectedTags, setSelectedTags] = useState<Tag[]>([]);
  const [autoTag, setAutoTag] = useState<Tag | null>(null);

  const form = useForm<BillFormData>({
    defaultValues: createDefaultBillForm(),
    resolver: withUnreadableAmounts(zodResolver(budgetItemCreateSchema)) as never,
  });

  // The values the resolver passes on, not getValues(): an envelope amount hidden by a monthly
  // frequency that can't be read is left out there (withUnreadableAmounts).
  const onSubmit = (formData: BillFormData) => {
    const frequency = formData.recurring_payment_frequency || 1;

    // Derive default_budget_amount from the payment amount when not set.
    let defaultBudgetAmount = formData.default_budget_amount;
    if (!defaultBudgetAmount && formData.recurring_payment_amount) {
      const startingBalance = formData.rollover_starting_balance || 0;
      // In whole cents, rounded up only when the months don't divide it: Math.ceil(x * 100)
      // asked 150.31 of a 150.30 bill.
      const remaining = centsToAmount(Math.max(0, toCents(formData.recurring_payment_amount) - toCents(startingBalance)));
      defaultBudgetAmount = perMonthRoundedUp(remaining, frequency);
    }

    return submitNew(
      () =>
        createBudgetItemMutation.mutateAsync({
          ...formData,
          // Bill-specific defaults.
          recurring_payment: true,
          isbill: true,
          expense_type: 'Expense' as const,
          subtype: 'Fixed' as const,
          type: frequency === 1 ? ('Monthly' as const) : ('Envelope' as const),
          rollover: frequency > 1,
          recurring_payment_frequency: frequency,
          // Left out when the form has none.
          ...(defaultBudgetAmount !== undefined ? { default_budget_amount: defaultBudgetAmount } : {}),
          transaction_auto_tag_id: autoTag?.id || null,
        }),
      selectedTags,
      { success: 'Bill created successfully', error: 'Failed to save bill' },
    );
  };

  return (
    <Card>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <BillFormFields
          form={form}
          loading={saving}
          tags={tags}
          selectedTags={selectedTags}
          onTagsChange={setSelectedTags}
          autoTag={autoTag}
          onAutoTagChange={setAutoTag}
          budgetItemUuid={null}
        />
        <CreateActions label="Create Bill" loading={saving} returnTo={returnTo} />
      </form>
    </Card>
  );
};

const AddBudgetItemPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const kindParam = searchParams.get('kind');
  const [kind, setKind] = useState<BudgetItemKind>(isKind(kindParam) ? kindParam : 'expense');

  // Cancel / post-create return target (the Budget page by default).
  const returnTo = sameOriginPath(searchParams.get('returnTo')) ?? '/budgets';

  return (
    <PageContainer width="form">
      <SettingsPageHeader
        title="Add Budget Item"
        subtitle="Create an income source, expense, or bill"
        icon={<Wallet size={20} className="text-[var(--accent-11)]" />}
        iconBackground="bg-[var(--accent-3)]"
        backPath={returnTo}
      />

      <Flex direction="column" gap="4" mt="6">
        <SegmentedControl.Root
          aria-label="Kind of budget item"
          value={kind}
          onValueChange={(value) => setKind(value as BudgetItemKind)}
          size="3"
        >
          <SegmentedControl.Item value="income">Income</SegmentedControl.Item>
          <SegmentedControl.Item value="expense">Expense</SegmentedControl.Item>
          <SegmentedControl.Item value="bill">Bill</SegmentedControl.Item>
        </SegmentedControl.Root>

        {kind === 'income' && <IncomeAddForm returnTo={returnTo} />}
        {kind === 'expense' && <ExpenseAddForm returnTo={returnTo} />}
        {kind === 'bill' && <BillAddForm returnTo={returnTo} />}
      </Flex>
    </PageContainer>
  );
};

export default AddBudgetItemPage;
