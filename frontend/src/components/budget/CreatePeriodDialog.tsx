import React, { useState } from 'react';
import { Button, Dialog, Flex, Select, Text } from '@radix-ui/themes';
import toast from 'react-hot-toast';
import type { BudgetPeriod } from '../../services/api';
import { useCreateBudgetPeriodMutation } from '../../hooks/queries';
import { errorResponseData } from '../../utils/errors';
import { logger } from '../../utils/logger';

const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: new Date(2000, i).toLocaleDateString('en-US', { month: 'long' }),
}));

/**
 * The dialog that creates a budget period, for a month of last year, this year or next, opened
 * by `trigger` (the header's button, or the empty state's: a ledger with no periods yet needs a
 * way forward). `showPeriod` shows the first period it matches once the list is fresh: the
 * one created, or the one another member created first.
 */
const CreatePeriodDialog: React.FC<{
  trigger: React.ReactElement;
  budgetPeriods: BudgetPeriod[];
  showPeriod: (match: (period: BudgetPeriod) => boolean) => Promise<void>;
}> = ({ trigger, budgetPeriods, showPeriod }) => {
  const createPeriod = useCreateBudgetPeriodMutation();
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [month, setMonth] = useState<number>(new Date().getMonth() + 1);
  const thisYear = new Date().getFullYear();

  const create = async () => {
    const monthLabel = new Date(year, month - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    if (budgetPeriods.some((p) => p.year === year && p.month_number === month)) {
      toast.error('This budget period already exists');
      return;
    }
    try {
      const created = await createPeriod.mutateAsync([year, month]);
      await showPeriod((p) => p.id === created.id);
      toast.success(`Budget period created for ${monthLabel}`);
      setOpen(false);
    } catch (err) {
      // Another member created the month since this list loaded: show theirs.
      if (errorResponseData(err)?.code === 'BUDGET_PERIOD_EXISTS') {
        await showPeriod((p) => p.year === year && p.month_number === month);
        toast(`${monthLabel} already has a budget period, so it's shown instead`);
        setOpen(false);
        return;
      }
      logger.error({ err }, 'Failed to create budget period');
      toast.error('Failed to create budget period');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>{trigger}</Dialog.Trigger>

      <Dialog.Content maxWidth="450px">
        <Dialog.Title>Create Budget Period</Dialog.Title>
        <Dialog.Description size="2" mb="4">
          Select the month and year for the new budget period.
        </Dialog.Description>

        <Flex direction="column" gap="3">
          <Flex asChild direction="column">
            <label>
            <Text as="div" size="2" mb="1" weight="bold">Month</Text>
            <Select.Root value={String(month)} onValueChange={(value) => setMonth(parseInt(value))}>
              <Select.Trigger />
              <Select.Content>
                {MONTHS.map((m) => (
                  <Select.Item key={m.value} value={String(m.value)}>{m.label}</Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            </label>
          </Flex>

          <Flex asChild direction="column">
            <label>
            <Text as="div" size="2" mb="1" weight="bold">Year</Text>
            <Select.Root value={String(year)} onValueChange={(value) => setYear(parseInt(value))}>
              <Select.Trigger />
              <Select.Content>
                {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
                  <Select.Item key={y} value={String(y)}>{y}</Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            </label>
          </Flex>
        </Flex>

        <Flex gap="3" mt="4" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray">Cancel</Button>
          </Dialog.Close>
          <Button onClick={create}>Create Period</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default CreatePeriodDialog;
