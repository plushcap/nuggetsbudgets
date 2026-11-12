import React, { useId, useRef, useState } from 'react';
import { Controller, get, useFieldArray, useForm, useWatch, type Control } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Callout, Card, Checkbox, Flex, Grid, Heading, Link, Select, Text, TextField, VisuallyHidden } from '@radix-ui/themes';
import FormSelectRoot from '../components/forms/FormSelectRoot';
import { BellRing, Info, Plus, Save, Trash2 } from 'lucide-react';
import type { z } from 'zod';
import {
  NOTIFICATION_AUDIENCES,
  NOTIFICATION_SEND_BY,
  notificationRulesSchema,
  type NotificationAudience,
  type NotificationSendBy,
  type Condition,
  type NotificationRuleKind,
  type NotificationRules,
} from '@nuggets/shared';
import SettingsPageHeader from '../components/SettingsPageHeader';
import PageLoader from '../components/PageLoader';
import { ConditionEditor } from '../components/notifications/ConditionEditor';
import { useAuth } from '../contexts/AuthContext';
import { useNotificationRulesQuery, useSaveNotificationRulesMutation } from '../hooks/queries/settingsExtras';
import { logger } from '../utils/logger';
import { apiErrorMessage } from '../utils/errors';
import FieldError, { fieldErrorProps } from '../components/forms/FieldError';
import PageContainer from '../components/PageContainer';

/**
 * The ledger's notification rules: what
 * Nuggets tells the ledger's members about, and when. Any member can look;
 * ledger admins edit. Each person then picks, in My Profile, which rules reach
 * them by email and by phone.
 */

type RulesValues = z.input<typeof notificationRulesSchema>;
type RulesResult = z.output<typeof notificationRulesSchema>;
type RulesControl = Control<RulesValues, unknown, RulesResult>;

const kindIntro: Record<NotificationRuleKind, string> = {
  budget_item: 'When a budget item in the current period matches this — once per item each period:',
  transaction: 'When a transaction added in the last week matches this — once per transaction:',
  review_reminder: 'A reminder to each person with transactions assigned to them that need review, while this holds:',
  digest: 'A summary of the week: money in and out, budget items over budget, and what’s waiting for review.',
  bill: 'When a bill payment due matches this — once for each due date:',
};

const weekdays = [
  ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'],
  ['5', 'Friday'], ['6', 'Saturday'], ['7', 'Sunday'],
] as const;

const hourFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });
const hours = Array.from({ length: 24 }, (_, hour) => [String(hour), hourFormat.format(new Date(2026, 0, 1, hour))] as const);
const everyDaysChoices = [1, 2, 3, 5, 7, 14, 30].map((days) => [String(days), days === 1 ? 'Every day' : `Every ${days} days`] as const);
// Each list's values come from @nuggets/shared, so a choice can't drift from what the server checks.
const AUDIENCE_LABELS: Readonly<Record<NotificationAudience, string>> = {
  everyone: 'Everyone in this ledger',
  assignee: 'Only the person it’s assigned to',
};
const SEND_BY_LABELS: Readonly<Record<NotificationSendBy, string>> = {
  both: 'Email and phone',
  email: 'Email only',
  push: 'Phone & browser only',
};
const audiences = NOTIFICATION_AUDIENCES.map((value) => [value, AUDIENCE_LABELS[value]] as const);
const sendByChoices = NOTIFICATION_SEND_BY.map((value) => [value, SEND_BY_LABELS[value]] as const);

/**
 * A key for a rule added here, never one an earlier rule had: people's choices
 * and what was sent are kept by key, and a new rule mustn't inherit an old one's.
 */
function newKey(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The first message in a branch of react-hook-form's errors, such as a condition's. */
function firstMessage(tree: unknown): string | undefined {
  if (typeof tree !== 'object' || tree === null) return undefined;
  if ('message' in tree && typeof tree.message === 'string' && tree.message) return tree.message;
  for (const [key, child] of Object.entries(tree)) {
    if (key === 'ref' || key === 'types') continue;
    const message = firstMessage(child);
    if (message) return message;
  }
  return undefined;
}

/** A field label with its rule said to screen readers: "Name for The week in review". */
function labelIn(label: string, rule: string): React.ReactNode {
  return (
    <>
      {label} <VisuallyHidden>for {rule}</VisuallyHidden>
    </>
  );
}

/**
 * A refused save's reason, and its problems with the field each names (validateBody's
 * `details`: `{ field: 'rules.1.when', message }`), as the API helpers leave them.
 */
function serverProblems(error: unknown): { message: string; issues: { field: string; message: string }[] } {
  const details = (error as { details?: unknown } | null)?.details;
  return {
    message: apiErrorMessage(error, 'The rules didn’t save. Try again.'),
    issues: Array.isArray(details)
      ? details.filter((d): d is { field: string; message: string } => typeof d?.field === 'string' && typeof d?.message === 'string')
      : [],
  };
}

const NotificationRulesPage: React.FC = () => {
  const rules = useNotificationRulesQuery({ meta: { suppressErrorToast: true } });

  return (
    <PageContainer>
      <SettingsPageHeader
        title="Notifications"
        subtitle="What this ledger tells its members about, and when"
        icon={<BellRing size={20} className="text-[var(--accent-11)]" />}
        backPath="/settings"
      />
      {rules.isPending ? (
        <PageLoader />
      ) : rules.isError ? (
        <Callout.Root color="red">
          <Callout.Icon><Info size={16} /></Callout.Icon>
          <Callout.Text>
            The notification rules didn't load.{' '}
            <Button variant="ghost" size="1" onClick={() => void rules.refetch()}>Try again</Button>
          </Callout.Text>
        </Callout.Root>
      ) : (
        <RulesForm rules={rules.data} />
      )}
    </PageContainer>
  );
};

function RulesForm({ rules }: { rules: NotificationRules }) {
  const { tenantRole, orgRole, isDeploymentAdmin } = useAuth();
  const readOnly = !(tenantRole === 'admin' || orgRole === 'admin' || isDeploymentAdmin);
  const save = useSaveNotificationRulesMutation();
  const [message, setMessage] = useState<string>();
  const [saved, setSaved] = useState(false);
  const { control, register, handleSubmit, reset, setError, formState } = useForm<RulesValues, unknown, RulesResult>({
    resolver: zodResolver(notificationRulesSchema),
    defaultValues: rules,
  });
  const list = useFieldArray({ control, name: 'rules' });
  const values = useWatch({ control, name: 'rules' });
  const form = useRef<HTMLFormElement>(null);

  const submit = handleSubmit(async (changed) => {
    setMessage(undefined);
    try {
      reset(await save.mutateAsync(changed));
      setSaved(true);
    } catch (error) {
      logger.error({ err: error }, 'Failed to save notification rules');
      const problems = serverProblems(error);
      let placed = false;
      for (const issue of problems.issues) {
        // A problem within one rule ("rules.1.when"), placed on that field.
        if (/^rules\.\d+\../.test(issue.field)) {
          setError(issue.field as `rules.${number}.label`, { message: issue.message });
          placed = true;
        }
      }
      if (!placed) setMessage(problems.message);
    }
  });

  const add = (rule: RulesValues['rules'][number]) => {
    setSaved(false);
    list.append(rule);
  };

  return (
    <form ref={form} onSubmit={(event) => void submit(event)} noValidate>
      <Flex direction="column" gap="4">
        <Text size="2" color="gray">
          Send by sets the channels a rule may use. Within those, each person chooses how it reaches them in{' '}
          <Link asChild size="2">
            <RouterLink to="/profile">My Profile</RouterLink>
          </Link>
          .{readOnly && ' Only ledger admins can change the rules.'}
        </Text>

        {list.fields.length === 0 && <Text size="2" color="gray">No rules, so no notifications.</Text>}

        {list.fields.map((field, index) => {
          const rule = values[index];
          if (!rule) return null;
          const label = rule.label || `Rule ${index + 1}`;
          const headingId = `notification-rule-${index}`;
          const conditionError = firstMessage(get(formState.errors, `rules.${index}.when`));
          const labelError = formState.errors.rules?.[index]?.label?.message;
          return (
            <Card key={field.id} role="group" aria-labelledby={headingId}>
              <Flex direction="column" gap="4" p="2">
                <Flex justify="between" align="center" gap="3">
                  <Heading as="h3" size="4" id={headingId} tabIndex={-1} data-rule-heading>{label}</Heading>
                  {!readOnly && (
                    <Button
                      type="button"
                      variant="ghost"
                      color="gray"
                      aria-label={`Remove ${label}`}
                      onClick={() => {
                        setSaved(false);
                        list.remove(index);
                        // The button goes with its rule, so focus moves to the rule
                        // that takes its place, or to adding one.
                        window.setTimeout(() => {
                          const next = form.current?.querySelectorAll<HTMLElement>('[data-rule-heading]')[index]
                            ?? form.current?.querySelector<HTMLElement>('[data-add-rule]');
                          next?.focus();
                        });
                      }}
                    >
                      <Trash2 size={16} />
                      Remove
                    </Button>
                  )}
                </Flex>

                <Controller
                  control={control}
                  name={`rules.${index}.enabled`}
                  render={({ field: enabled }) => (
                    <Text as="label" size="2">
                      <Flex gap="2" align="center">
                        <Checkbox
                          disabled={readOnly}
                          checked={enabled.value === true}
                          onCheckedChange={(checked) => enabled.onChange(checked === true)}
                        />
                        {labelIn('Send it', label)}
                      </Flex>
                    </Text>
                  )}
                />

                <Grid columns={{ initial: '1', sm: '2' }} gap="4">
                  <Flex direction="column" gap="1">
                    <Text as="label" size="2" weight="medium" htmlFor={`${headingId}-label`}>{labelIn('Name', label)}</Text>
                    <TextField.Root
                      id={`${headingId}-label`}
                      readOnly={readOnly}
                      {...register(`rules.${index}.label`)}
                      {...fieldErrorProps(`${headingId}-label`, labelError)}
                    />
                    <FieldError fieldId={`${headingId}-label`} message={labelError} />
                  </Flex>
                  <ChoiceField control={control} name={`rules.${index}.sendBy`} label={labelIn('Send by', label)} choices={sendByChoices} readOnly={readOnly} />
                  {rule.kind === 'transaction' && (
                    <ChoiceField control={control} name={`rules.${index}.audience`} label={labelIn('Who gets it', label)} choices={audiences} readOnly={readOnly} />
                  )}
                  {rule.kind === 'review_reminder' && (
                    <ChoiceField control={control} name={`rules.${index}.everyDays`} label={labelIn('At most', label)} choices={everyDaysChoices} readOnly={readOnly} />
                  )}
                  {rule.kind === 'review_reminder' && (
                    <ChoiceField control={control} name={`rules.${index}.hour`} label={labelIn('Not before, in the application time zone', label)} choices={hours} readOnly={readOnly} />
                  )}
                </Grid>

                <Text size="2" color="gray">{kindIntro[rule.kind]}</Text>

                {rule.kind !== 'digest' && (
                  <Flex direction="column" gap="1">
                    <Controller
                      control={control}
                      name={`rules.${index}.when`}
                      render={({ field: when }) => (
                        <ConditionEditor
                          // The schema's input type for a recursive condition is wide;
                          // the form only holds conditions the editor made.
                          value={when.value as Condition}
                          onChange={(next) => {
                            setSaved(false);
                            when.onChange(next);
                          }}
                          kind={rule.kind as Exclude<NotificationRuleKind, 'digest'>}
                          label={`${label}, sent when`}
                          readOnly={readOnly}
                        />
                      )}
                    />
                    {conditionError && <Text size="2" color="red" role="alert">{conditionError}</Text>}
                  </Flex>
                )}

                {rule.kind === 'digest' && (
                  <Grid columns={{ initial: '1', sm: '2' }} gap="4">
                    <ChoiceField control={control} name={`rules.${index}.weekday`} label={labelIn('Day', label)} choices={weekdays} readOnly={readOnly} />
                    <ChoiceField control={control} name={`rules.${index}.hour`} label={labelIn('Time, in the application time zone', label)} choices={hours} readOnly={readOnly} />
                  </Grid>
                )}
              </Flex>
            </Card>
          );
        })}

        {(formState.errors.rules?.root?.message ?? formState.errors.rules?.message) && (
          <Text size="2" color="red" role="alert">{formState.errors.rules?.root?.message ?? formState.errors.rules?.message}</Text>
        )}
        {message && <Text size="2" color="red" role="alert">{message}</Text>}

        {!readOnly && (
          <Flex gap="3" wrap="wrap" align="center">
            <Button
              type="button"
              variant="soft"
              data-add-rule
              disabled={list.fields.length >= 20}
              onClick={() => add({ key: newKey('budget'), label: 'Most of a budget used', enabled: true, sendBy: 'both', kind: 'budget_item', when: { all: [{ fact: 'percent_used', gte: 90 }, { fact: 'budgeted', gt: 0 }] } })}
            >
              <Plus size={16} />
              Budget item rule
            </Button>
            <Button
              type="button"
              variant="soft"
              disabled={list.fields.length >= 20}
              onClick={() => add({
                key: newKey('transaction'),
                label: 'A transaction that matches',
                enabled: true,
                sendBy: 'both',
                kind: 'transaction',
                audience: 'everyone',
                when: { all: [{ fact: 'type', is: 'expense' }, { fact: 'size', gte: 500 }] },
              })}
            >
              <Plus size={16} />
              Transaction rule
            </Button>
            <Button
              type="button"
              variant="soft"
              disabled={list.fields.length >= 20}
              onClick={() => add({ key: newKey('review'), label: 'Transactions waiting for review', enabled: true, sendBy: 'both', kind: 'review_reminder', when: { fact: 'unreviewed_count', gte: 10 }, everyDays: 3, hour: 9 })}
            >
              <Plus size={16} />
              Review reminder
            </Button>
            <Button
              type="button"
              variant="soft"
              disabled={list.fields.length >= 20}
              onClick={() => add({ key: newKey('digest'), label: 'The week in review', enabled: true, sendBy: 'both', kind: 'digest', weekday: 7, hour: 18 })}
            >
              <Plus size={16} />
              Weekly digest
            </Button>
            <Button
              type="button"
              variant="soft"
              disabled={list.fields.length >= 20}
              onClick={() => add({
                key: newKey('bill'),
                label: 'A bill due soon',
                enabled: true,
                sendBy: 'both',
                kind: 'bill',
                when: { all: [{ fact: 'paid', is: false }, { fact: 'skipped', is: false }, { fact: 'days_until_due', gte: 0 }, { fact: 'days_until_due', lte: 3 }] },
              })}
            >
              <Plus size={16} />
              Bill rule
            </Button>
            <Box flexGrow="1" />
            <Text size="2" color="gray" role="status">{saved && !formState.isDirty ? 'Saved.' : ''}</Text>
            <Button type="submit" loading={save.isPending} disabled={!formState.isDirty}>
              <Save size={16} />
              Save the rules
            </Button>
          </Flex>
        )}
      </Flex>
    </form>
  );
}

function ChoiceField({
  control,
  name,
  label,
  choices,
  readOnly,
}: {
  control: RulesControl;
  name: `rules.${number}.audience` | `rules.${number}.weekday` | `rules.${number}.hour` | `rules.${number}.everyDays` | `rules.${number}.sendBy`;
  label: React.ReactNode;
  choices: readonly (readonly [string, string])[];
  readOnly: boolean;
}) {
  const labelId = useId();
  return (
    <Flex direction="column" gap="1">
      <Text size="2" weight="medium" id={labelId}>{label}</Text>
      <Controller
        control={control}
        name={name}
        render={({ field }) => {
          const current = String(field.value);
          // A value set elsewhere (MCP, say) that isn't one of the choices stays shown.
          const shown = choices.some(([value]) => value === current) ? choices : [...choices, [current, current] as const];
          return (
            <FormSelectRoot value={current} onValueChange={field.onChange} disabled={readOnly}>
              <Select.Trigger aria-labelledby={labelId} />
              <Select.Content position="popper">
                {shown.map(([value, text]) => (
                  <Select.Item key={value} value={value}>{text}</Select.Item>
                ))}
              </Select.Content>
            </FormSelectRoot>
          );
        }}
      />
    </Flex>
  );
}

export default NotificationRulesPage;
