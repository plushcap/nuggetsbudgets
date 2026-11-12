import React, { useId, useMemo } from 'react';
import { toast } from 'react-hot-toast';
import { Archive, ArchiveRestore, Merge, Trash2 } from 'lucide-react';
import { Box, Button, Callout, Checkbox, Dialog, Flex, Heading, Separator, Text } from '@radix-ui/themes';
import {
  useArchiveBudgetItemMutation,
  useBudgetItemUsageQuery,
  useBudgetItemsQuery,
  useDeleteBudgetItemMutation,
  useMergeBudgetItemMutation,
  useRestoreBudgetItemMutation,
} from '../../hooks/queries';
import RadixBudgetItemSelector from '../RadixBudgetItemSelector';
import PageLoader from '../PageLoader';
import { formatCurrency } from '../../utils/currency';
import { DateUtils } from '../../utils/dateUtils';
import { useSeededState } from '../../hooks/useSeededState';
import { budgetExpenseType, mergeUnlinksGoalsMessage } from '@nuggets/shared';

export interface RetiringItem {
  uuid: string;
  name: string;
  income: boolean;
}

/** What happened, so the caller can leave a page about an item that's gone. */
export type RetireOutcome = 'archived' | 'merged' | 'deleted' | 'restored';

interface RetireBudgetItemDialogProps {
  item: RetiringItem | null;
  onClose: () => void;
  onDone?: (outcome: RetireOutcome) => void;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const errorMessage = (error: unknown, fallback: string) => (error instanceof Error && error.message) || fallback;

/**
 * Retiring a budget item: archive it (hidden from new work, history kept),
 * merge it into another item, or delete it when nothing uses it. An archived
 * item gets Restore instead.
 */
const RetireBudgetItemDialog: React.FC<RetireBudgetItemDialogProps> = ({ item, onClose, onDone }) => {
  const usage = useBudgetItemUsageQuery(item?.uuid ?? null);
  const mergeHeadingId = useId();
  const { data: budgetItems = [] } = useBudgetItemsQuery();
  const archive = useArchiveBudgetItemMutation();
  const restore = useRestoreBudgetItemMutation();
  const merge = useMergeBudgetItemMutation();
  const remove = useDeleteBudgetItemMutation();
  // Another item starts over: no merge target, rules moving with the merge.
  const [intoId, setIntoId] = useSeededState<number | null>(() => null, [item?.uuid]);
  const [moveRules, setMoveRules] = useSeededState(() => true, [item?.uuid]);

  // Merge targets: same kind (income or expense), not itself.
  const targets = useMemo(
    () => budgetItems.filter((candidate) =>
      candidate.uuid !== item?.uuid && (candidate.expense_type === budgetExpenseType.enum.Income) === (item?.income ?? false)),
    [budgetItems, item],
  );
  const into = targets.find((candidate) => candidate.id === intoId) ?? null;

  const finish = (outcome: RetireOutcome, message: string) => {
    toast.success(message);
    onClose();
    onDone?.(outcome);
  };

  const run = async (work: () => Promise<unknown>, outcome: RetireOutcome, message: string, failure: string) => {
    try {
      await work();
      finish(outcome, message);
    } catch (error) {
      toast.error(errorMessage(error, failure));
    }
  };

  const data = usage.data;
  const funded = !!data && data.balance !== 0;
  // A goal counts only envelopes: while a goal links this item, now or before, it merges only into
  // one that rolls over (the server refuses the rest, 409 MERGE_UNLINKS_GOALS).
  const unlinksGoals = !!data && !!into && into.rollover !== true && data.linked_goals.length > 0;
  const busy = archive.isPending || restore.isPending || merge.isPending || remove.isPending;

  return (
    <Dialog.Root open={!!item} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content maxWidth="560px">
        <Dialog.Title>{data?.archived ? 'Restore' : 'Archive or delete'} {item?.name}</Dialog.Title>
        {!data ? (
          usage.isError
            ? <Callout.Root color="red"><Callout.Text>{errorMessage(usage.error, 'Couldn’t load this budget item.')}</Callout.Text></Callout.Root>
            : <PageLoader minHeight="8rem" />
        ) : (
          <Flex direction="column" gap="4">
            <Dialog.Description size="2" color="gray">
              {data.transactions > 0
                ? `${plural(data.transactions, 'transaction', 'transactions')}, ${DateUtils.formatForDisplay(data.first_transaction_date as string)} to ${DateUtils.formatForDisplay(data.last_transaction_date as string)}`
                : 'No transactions'}
              {` · ${plural(data.rules, 'matching rule', 'matching rules')}`}
              {data.budget_periods > 0 && ` · budgets in ${plural(data.budget_periods, 'period', 'periods')}`}
              {data.attachments > 0 && ` · ${plural(data.attachments, 'attachment', 'attachments')}`}
              {data.balance !== 0 && ` · holds ${formatCurrency(data.balance)}`}
            </Dialog.Description>

            {data.archived ? (
              <Flex direction="column" gap="2">
                <Text size="2">It’s archived: hidden from the budget page, new periods and the budget-item pickers. Restoring brings it back, including in periods created since.</Text>
                <Box>
                  <Button loading={restore.isPending} disabled={busy} onClick={() => item && run(() => restore.mutateAsync(item.uuid), 'restored', `${item.name} restored`, 'Couldn’t restore it')}>
                    <ArchiveRestore size={16} /> Restore
                  </Button>
                </Box>
              </Flex>
            ) : (
              <>
                {funded && (
                  <Callout.Root highContrast color="amber">
                    <Callout.Text>
                      It holds {formatCurrency(data.balance)}. Transfer that to another budget item from the Budget page first; an envelope with money in it can’t be archived or merged.
                    </Callout.Text>
                  </Callout.Root>
                )}

                <Flex direction="column" gap="2">
                  <Heading as="h3" size="3">Archive</Heading>
                  <Text size="2" color="gray">
                    Hides it from the budget page, new periods and the budget-item pickers, and stops new transactions matching to it. Its transactions, budget history and reports stay, and you can restore it.
                  </Text>
                  <Box>
                    <Button variant="soft" disabled={funded || busy} loading={archive.isPending} onClick={() => item && run(() => archive.mutateAsync(item.uuid), 'archived', `${item.name} archived`, 'Couldn’t archive it')}>
                      <Archive size={16} /> Archive
                    </Button>
                  </Box>
                </Flex>

                <Separator size="4" />

                <Flex direction="column" gap="2">
                  <Heading as="h3" size="3" id={mergeHeadingId}>Merge into another item</Heading>
                  <Text size="2" color="gray">
                    Moves its transactions to another {item?.income ? 'income' : 'expense'} item, then archives it. Past periods’ budgets stay on {item?.name}, so their budget-versus-actual changes for both items.
                  </Text>
                  <RadixBudgetItemSelector aria-labelledby={mergeHeadingId} value={intoId} onChange={setIntoId} budgetItems={targets} placeholder="Choose the item to merge into…" />
                  {data.rules > 0 && (
                    <Text as="label" size="2">
                      <Flex gap="2" align="center">
                        <Checkbox checked={moveRules} onCheckedChange={(checked) => setMoveRules(checked === true)} />
                        Also move its {plural(data.rules, 'matching rule', 'matching rules')}
                      </Flex>
                    </Text>
                  )}
                  {into && !unlinksGoals && (
                    <Text size="2">
                      Moves {plural(data.transactions, 'transaction', 'transactions')}{moveRules && data.rules > 0 ? ` and ${plural(data.rules, 'rule', 'rules')}` : ''} to {into.name}.
                    </Text>
                  )}
                  {into && unlinksGoals && (
                    <Callout.Root highContrast color="amber" role="status">
                      <Callout.Text>
                        {mergeUnlinksGoalsMessage(item?.name ?? '', into.name, data.linked_goals)}
                      </Callout.Text>
                    </Callout.Root>
                  )}
                  <Box>
                    <Button
                      variant="soft"
                      disabled={!into || funded || unlinksGoals || busy}
                      loading={merge.isPending}
                      onClick={() => item && into && run(
                        () => merge.mutateAsync({ uuid: item.uuid, intoUuid: into.uuid, moveRules }),
                        'merged',
                        `${item.name} merged into ${into.name}`,
                        'Couldn’t merge it',
                      )}
                    >
                      <Merge size={16} /> Merge and archive
                    </Button>
                  </Box>
                </Flex>

                <Separator size="4" />

                <Flex direction="column" gap="2">
                  <Heading as="h3" size="3">Delete</Heading>
                  {data.can_delete ? (
                    <>
                      <Text size="2" color="gray">Nothing uses it, so it can be deleted for good.</Text>
                      <Box>
                        <Button color="red" variant="soft" disabled={busy} loading={remove.isPending} onClick={() => item && run(() => remove.mutateAsync(item.uuid), 'deleted', `${item.name} deleted`, 'Couldn’t delete it')}>
                          <Trash2 size={16} /> Delete for good
                        </Button>
                      </Box>
                    </>
                  ) : (
                    <Text size="2" color="gray">It has transactions, budget history or attachments, so it can’t be deleted. Archive it, or merge it into another item.</Text>
                  )}
                </Flex>
              </>
            )}

            <Flex justify="end">
              <Dialog.Close><Button variant="soft" color="gray">Close</Button></Dialog.Close>
            </Flex>
          </Flex>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default RetireBudgetItemDialog;
