import React, { useEffect, useId } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'react-hot-toast';
import { Badge, Button, Callout, Dialog, Flex, Select, Table, Text, TextArea, TextField } from '@radix-ui/themes';
import type { BillOccurrence, BillStatus, UnplacedBillPayment } from '@nuggets/shared';
import {
  useBillDueDatesQuery,
  useBillPaymentCandidatesQuery,
  useLinkBillPaymentMutation,
  usePlaceBillPaymentMutation,
  useResolveBillOccurrenceMutation,
} from '../../hooks/queries';
import CurrencyInput from '../CurrencyInput';
import { amountRangeProblem, nullableAmountInput } from '../forms/optionalAmount';
import PageLoader from '../PageLoader';
import { formatCurrency } from '../../utils/currency';
import { DateUtils } from '../../utils/dateUtils';
import { useSeededState } from '../../hooks/useSeededState';
import FieldError, { fieldErrorProps } from '../forms/FieldError';

export const statusWords: Record<BillStatus, string> = {
  paid: 'Paid',
  partly_paid: 'Partly paid',
  overdue: 'Overdue',
  due_soon: 'Due soon',
  upcoming: 'Upcoming',
  skipped: 'Skipped',
};

export const statusColor: Record<BillStatus, 'green' | 'amber' | 'red' | 'gray'> = {
  paid: 'green',
  partly_paid: 'amber',
  overdue: 'red',
  due_soon: 'amber',
  upcoming: 'gray',
  skipped: 'gray',
};

const errorMessage = (error: unknown, fallback: string) => (error instanceof Error && error.message) || fallback;

interface OccurrenceDialogProps {
  occurrence: BillOccurrence | null;
  onClose: () => void;
}

/** Pick a transaction to link to a due date: the bill's own by default, or search everything. */
export const LinkPaymentDialog: React.FC<OccurrenceDialogProps> = ({ occurrence, onClose }) => {
  // A new due date starts with an empty search.
  const [words, setWords] = useSeededState(() => '', [occurrence?.uuid]);
  const [query, setQuery] = useSeededState(() => '', [occurrence?.uuid]);
  const candidates = useBillPaymentCandidatesQuery(occurrence?.uuid ?? null, query);
  const link = useLinkBillPaymentMutation();

  const choose = async (transactionUuid: string) => {
    if (!occurrence) return;
    try {
      await link.mutateAsync({ occurrenceUuid: occurrence.uuid, transactionUuid });
      toast.success(`Linked to ${occurrence.bill.name}`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, 'Couldn’t link that transaction'));
    }
  };

  return (
    <Dialog.Root open={!!occurrence} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content maxWidth="760px">
        <Dialog.Title>Link a payment</Dialog.Title>
        <Dialog.Description size="2" mb="4">
          {occurrence && `${occurrence.bill.name}, due ${DateUtils.formatForDisplay(occurrence.due_date)}. `}
          Showing this bill’s recent payments; search to pick any transaction.
        </Dialog.Description>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(words.trim());
          }}
        >
          <Flex gap="2" mb="4">
            <TextField.Root
              value={words}
              onChange={(event) => setWords(event.target.value)}
              placeholder="Search description, merchant or budget item"
              aria-label="Search transactions"
              style={{ flexGrow: 1 }}
            />
            <Button type="submit" variant="soft">Search</Button>
          </Flex>
        </form>

        {candidates.isPending ? (
          <PageLoader minHeight="8rem" />
        ) : (candidates.data ?? []).length === 0 ? (
          <Text size="2" color="gray">No transactions found.</Text>
        ) : (
          <Table.Root size="1">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Date</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Description</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell justify="end">Amount</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {(candidates.data ?? []).map((candidate) => (
                <Table.Row key={candidate.transaction_uuid}>
                  <Table.Cell>{DateUtils.formatForDisplay(candidate.date)}</Table.Cell>
                  <Table.Cell>
                    <Text as="div">{candidate.description ?? 'No description'}</Text>
                    <Text as="div" size="1" color="gray">
                      {[candidate.account, candidate.budget_item].filter(Boolean).join(' · ')}
                      {candidate.linked_due_date && ` · pays the ${DateUtils.formatForDisplay(candidate.linked_due_date)} bill`}
                    </Text>
                  </Table.Cell>
                  <Table.Cell justify="end">{formatCurrency(candidate.amount)}</Table.Cell>
                  <Table.Cell justify="end">
                    <Button size="1" variant="soft" loading={link.isPending} onClick={() => choose(candidate.transaction_uuid)}>
                      {candidate.linked_due_date ? 'Move here' : 'Link'}
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}

        <Flex justify="end" mt="4">
          <Dialog.Close><Button variant="soft" color="gray">Close</Button></Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
};

interface MarkPaidValues {
  paid_date: string;
  paid_amount: number | null;
  note: string;
}

/** Mark a due date paid without a transaction: paid from an account Nuggets doesn't track. */
export const MarkPaidDialog: React.FC<OccurrenceDialogProps & { today: string }> = ({ occurrence, onClose, today }) => {
  const resolve = useResolveBillOccurrenceMutation();
  const { control, register, handleSubmit, reset, formState: { errors } } = useForm<MarkPaidValues>({
    defaultValues: { paid_date: today, paid_amount: null, note: '' },
  });

  useEffect(() => {
    if (occurrence) reset({ paid_date: today, paid_amount: occurrence.expected, note: occurrence.note ?? '' });
  }, [occurrence, reset, today]);

  const onSubmit = async (values: MarkPaidValues) => {
    if (!occurrence) return;
    try {
      await resolve.mutateAsync({
        occurrenceUuid: occurrence.uuid,
        body: { resolution: 'paid_manually', paid_date: values.paid_date, paid_amount: values.paid_amount, note: values.note || null },
      });
      toast.success(`${occurrence.bill.name} marked paid`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, 'Couldn’t mark it paid'));
    }
  };

  return (
    <Dialog.Root open={!!occurrence} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content maxWidth="480px">
        <Dialog.Title>Mark paid by hand</Dialog.Title>
        <Dialog.Description size="2" mb="4">
          For a payment Nuggets has no transaction for{occurrence ? `: ${occurrence.bill.name}, due ${DateUtils.formatForDisplay(occurrence.due_date)}` : ''}.
        </Dialog.Description>
        <form onSubmit={handleSubmit(onSubmit)}>
          <Flex direction="column" gap="3">
            <Flex direction="column" gap="1">
              <Text as="label" htmlFor="bill-paid-date" size="2" weight="medium">Paid on</Text>
              <TextField.Root id="bill-paid-date" type="date" {...register('paid_date', { required: 'Give the date it was paid.' })} {...fieldErrorProps('bill-paid-date', errors.paid_date)} />
              <FieldError fieldId="bill-paid-date" message={errors.paid_date?.message} />
            </Flex>
            <Flex direction="column" gap="1">
              <Text as="label" htmlFor="bill-paid-amount" size="2" weight="medium">Amount paid</Text>
              <Controller
                control={control}
                name="paid_amount"
                rules={{ validate: (value) => (value != null && value > 0 ? (amountRangeProblem(value) ?? true) : 'Give the amount paid.') }}
                render={({ field }) => (
                  <CurrencyInput id="bill-paid-amount" {...nullableAmountInput(field.value, field.onChange)} {...fieldErrorProps('bill-paid-amount', errors.paid_amount)} />
                )}
              />
              <FieldError fieldId="bill-paid-amount" message={errors.paid_amount?.message} />
            </Flex>
            <Flex direction="column" gap="1">
              <Text as="label" htmlFor="bill-paid-note" size="2" weight="medium">Note</Text>
              <TextArea id="bill-paid-note" placeholder="Optional: paid in cash, from another account…" {...register('note')} />
            </Flex>
            <Flex justify="end" gap="2" mt="2">
              <Dialog.Close><Button type="button" variant="soft" color="gray">Cancel</Button></Dialog.Close>
              <Button type="submit" loading={resolve.isPending}>Mark paid</Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
};

/** Skip a due date this time (a waived or paused bill), so it isn't overdue. */
export const SkipDialog: React.FC<OccurrenceDialogProps> = ({ occurrence, onClose }) => {
  const resolve = useResolveBillOccurrenceMutation();
  const { register, handleSubmit, reset } = useForm<{ note: string }>({ defaultValues: { note: '' } });

  useEffect(() => {
    if (occurrence) reset({ note: occurrence.note ?? '' });
  }, [occurrence, reset]);

  const onSubmit = async ({ note }: { note: string }) => {
    if (!occurrence) return;
    try {
      await resolve.mutateAsync({ occurrenceUuid: occurrence.uuid, body: { resolution: 'skipped', note: note || null } });
      toast.success(`${occurrence.bill.name} skipped this time`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, 'Couldn’t skip it'));
    }
  };

  return (
    <Dialog.Root open={!!occurrence} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content maxWidth="480px">
        <Dialog.Title>Skip this time</Dialog.Title>
        <Dialog.Description size="2" mb="4">
          {occurrence && `${occurrence.bill.name}, due ${DateUtils.formatForDisplay(occurrence.due_date)}, won’t count as due or overdue. Later due dates are unchanged.`}
        </Dialog.Description>
        <form onSubmit={handleSubmit(onSubmit)}>
          <Flex direction="column" gap="3">
            <Flex direction="column" gap="1">
              <Text as="label" htmlFor="bill-skip-note" size="2" weight="medium">Why</Text>
              <TextArea id="bill-skip-note" placeholder="Optional: waived, paused, credit applied…" {...register('note')} />
            </Flex>
            <Flex justify="end" gap="2" mt="2">
              <Dialog.Close><Button type="button" variant="soft" color="gray">Cancel</Button></Dialog.Close>
              <Button type="submit" loading={resolve.isPending}>Skip</Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
};

/** Place a bill payment no due date took on one of the bill's due dates, including a future one. */
export const PlacePaymentDialog: React.FC<{ payment: UnplacedBillPayment | null; onClose: () => void }> = ({ payment, onClose }) => {
  const fieldId = useId();
  const dueDates = useBillDueDatesQuery(payment?.bill.uuid ?? null);
  const place = usePlaceBillPaymentMutation();
  // A new payment starts with no due date chosen.
  const [dueDate, setDueDate] = useSeededState<string | null>(() => null, [payment?.transaction_uuid]);

  const submit = async () => {
    if (!payment || !dueDate) return;
    try {
      await place.mutateAsync({ billUuid: payment.bill.uuid, transactionUuid: payment.transaction_uuid, dueDate });
      toast.success(`Placed on the ${DateUtils.formatForDisplay(dueDate)} ${payment.bill.name} bill`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, 'Couldn’t place that payment'));
    }
  };

  return (
    <Dialog.Root open={!!payment} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content maxWidth="480px">
        <Dialog.Title>Which due date does it pay?</Dialog.Title>
        <Dialog.Description size="2" mb="4">
          {payment && `${formatCurrency(payment.amount)} on ${DateUtils.formatForDisplay(payment.date)}, in ${payment.bill.name}.`}
        </Dialog.Description>
        {dueDates.isPending ? (
          <PageLoader minHeight="6rem" />
        ) : dueDates.isError ? (
          <Callout.Root color="red"><Callout.Text>{errorMessage(dueDates.error, 'Couldn’t load the due dates.')}</Callout.Text></Callout.Root>
        ) : (
          <Flex direction="column" gap="1">
            <Text as="label" htmlFor={`${fieldId}-due-date`} size="2" weight="medium" id="place-due-date-label">Due date</Text>
            <Select.Root value={dueDate ?? undefined} onValueChange={setDueDate}>
              <Select.Trigger id={`${fieldId}-due-date`} placeholder="Choose a due date" aria-labelledby="place-due-date-label" />
              <Select.Content>
                {(dueDates.data ?? []).map((due) => (
                  <Select.Item key={due.due_date} value={due.due_date}>
                    {DateUtils.formatForDisplay(due.due_date)} · {formatCurrency(due.expected)} · {statusWords[due.status]}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>
        )}
        <Flex justify="end" gap="2" mt="4">
          <Dialog.Close><Button type="button" variant="soft" color="gray">Cancel</Button></Dialog.Close>
          <Button onClick={submit} disabled={!dueDate} loading={place.isPending}>Place it</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
};

export const StatusBadge: React.FC<{ status: BillStatus }> = ({ status }) => (
  <Badge highContrast color={statusColor[status]} variant="soft" radius="full">{statusWords[status]}</Badge>
);
