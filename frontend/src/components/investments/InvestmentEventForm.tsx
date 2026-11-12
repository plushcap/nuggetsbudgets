import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Controller, useForm, useWatch, type Control, type DefaultValues, type FieldValues } from 'react-hook-form';
import { Box, Button, Callout, Card, Flex, Grid, Select, Switch, Text, TextField } from '@radix-ui/themes';
import { Info } from 'lucide-react';
import toast from 'react-hot-toast';
import PageHeader from '../PageHeader';
import CurrencyInput from '../CurrencyInput';
import RadixDatePicker from '../RadixDatePicker';
import FieldError, { fieldErrorDescribedBy, fieldErrorProps } from '../forms/FieldError';
import { optionalAmountInput, nullableAmountInput } from '../forms/optionalAmount';
import { useAccountsQuery } from '../../hooks/queries/accounts';
import { useSecuritiesQuery } from '../../hooks/queries/investments';
import { logger } from '../../utils/logger';
import { apiErrorMessage } from '../../utils/errors';
import { EMPTY_LIST } from '../../utils/emptyList';
import {
  formProblemId,
  investmentEventProblems,
  investmentEventResolver,
  shownFields,
  textFor,
  type AmountSpec,
  type DecimalSpec,
  type FieldRow,
  type FieldSpec,
  type FieldText,
  type InvestmentEventConfig,
  type OptionLists,
  type ValueFieldSpec,
} from './investmentEventForm';

/**
 * The investment event pages' one form: a header and a card of the fields the
 * config lists (investmentEventConfigs.tsx), on react-hook-form. See investmentEventForm.ts
 * for how a submit is checked. A page renders it inside its PageContainer.
 */

/** Focuses a control by id, or the first focusable control inside it (a date picker's button). */
const focusControl = (id: string) => {
  const element = document.getElementById(id);
  if (!element) return;
  const target = element.matches('input, button, textarea, [tabindex]')
    ? element
    : element.querySelector<HTMLElement>('input, button, textarea, [tabindex]');
  (target ?? element).focus();
};

interface FieldProps<T extends FieldValues, C> {
  control: Control<T>;
  values: T;
  context: C;
  lists: OptionLists;
  shown: (id: string) => string | null;
}

const Note: React.FC<{ text: string }> = ({ text }) => (
  <Callout.Root color="gray" variant="soft" mt="2">
    <Callout.Icon><Info size={16} /></Callout.Icon>
    <Callout.Text>{text}</Callout.Text>
  </Callout.Root>
);

const noteFor = <T,>(note: FieldText<T> | undefined, values: T) => (note === undefined ? null : <Note text={textFor(note, values)} />);

/** A share count or ratio box: text, sent as typed. */
function DecimalControl<T extends FieldValues, C>({ spec, control, values, problem }: { spec: DecimalSpec<T, C>; control: Control<T>; values: T; problem: string | null }) {
  return (
    <Controller
      control={control}
      name={spec.name}
      render={({ field }) => (
        <TextField.Root
          id={spec.id}
          type="number"
          min="0"
          step={spec.step}
          {...(spec.max !== undefined ? { max: spec.max } : {})}
          {...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {})}
          {...(spec.labelHidden ? { 'aria-label': textFor(spec.label, values), style: { width: 110 } } : {})}
          value={(field.value as string | undefined) ?? ''}
          onChange={(e) => field.onChange(e.target.value)}
          onBlur={field.onBlur}
          {...fieldErrorProps(spec.id, problem)}
        />
      )}
    />
  );
}

/** An amount or a price, in CurrencyInput: NaN when unreadable; an optional one is 0 when empty, a required one null. */
function AmountControl<T extends FieldValues, C>({ spec, control, problem }: { spec: AmountSpec<T, C>; control: Control<T>; problem: string | null }) {
  return (
    <Controller
      control={control}
      name={spec.name}
      render={({ field }) =>
        spec.optional ? (
          <CurrencyInput id={spec.id} decimals={spec.decimals} placeholder="$0.00" {...optionalAmountInput(field)} {...fieldErrorProps(spec.id, problem)} />
        ) : (
          <CurrencyInput
            id={spec.id}
            ref={field.ref}
            decimals={spec.decimals}
            placeholder="$0.00"
            {...nullableAmountInput(field.value as number | null, (amount) => field.onChange(amount))}
            onBlur={field.onBlur}
            {...fieldErrorProps(spec.id, problem)}
          />
        )
      }
    />
  );
}

function ValueField<T extends FieldValues, C>({ spec, control, values, lists, shown }: FieldProps<T, C> & { spec: ValueFieldSpec<T, C> }) {
  const label = textFor(spec.label, values);
  const problem = shown(spec.id);
  const message = <FieldError fieldId={spec.id} message={problem} />;

  switch (spec.kind) {
    case 'select':
      return (
        <Flex direction="column" gap="1">
          <Text as="label" htmlFor={spec.id} size="2" weight="medium">{label}</Text>
          <Controller
            control={control}
            name={spec.name}
            render={({ field }) => (
              <Select.Root value={field.value as string} onValueChange={field.onChange}>
                <Select.Trigger
                  id={spec.id}
                  {...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {})}
                  style={{ width: '100%' }}
                  {...fieldErrorProps(spec.id, problem)}
                />
                <Select.Content>
                  {spec.options(lists, values).map((option) => <Select.Item key={option.value} value={option.value}>{option.label}</Select.Item>)}
                </Select.Content>
              </Select.Root>
            )}
          />
          {message}
          {noteFor(spec.note, values)}
        </Flex>
      );
    case 'date': {
      const describedBy = fieldErrorDescribedBy(spec.id, problem);
      return (
        <Flex direction="column" gap="1">
          <Text as="div" id={`${spec.id}-label`} size="2" weight="medium">{label}</Text>
          <Controller
            control={control}
            name={spec.name}
            render={({ field }) => (
              <RadixDatePicker
                id={spec.id}
                aria-labelledby={`${spec.id}-label`}
                value={field.value as string}
                onChange={field.onChange}
                {...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {})}
              />
            )}
          />
          {message}
        </Flex>
      );
    }
    case 'decimal':
      return (
        <Flex direction="column" gap="1">
          <Text as="label" htmlFor={spec.id} size="2" weight="medium">{label}</Text>
          <DecimalControl spec={spec} control={control} values={values} problem={problem} />
          {message}
          {noteFor(spec.note, values)}
        </Flex>
      );
    case 'amount':
      return (
        <Flex direction="column" gap="1">
          <Text as="label" htmlFor={spec.id} size="2" weight="medium">{label}</Text>
          <AmountControl spec={spec} control={control} problem={problem} />
          {message}
          {noteFor(spec.note, values)}
        </Flex>
      );
    case 'switch': {
      const toggle = (
        <Flex align="center" gap="2" width="fit-content" asChild>
          <label>
            <Controller
              control={control}
              name={spec.name}
              render={({ field }) => <Switch id={spec.id} checked={field.value as boolean} onCheckedChange={field.onChange} />}
            />
            <Text size="2">{label}</Text>
          </label>
        </Flex>
      );
      return spec.note === undefined ? toggle : (
        <Flex direction="column" gap="1">
          {toggle}
          {noteFor(spec.note, values)}
        </Flex>
      );
    }
    case 'text':
      return (
        <Flex direction="column" gap="1">
          <Text as="label" htmlFor={spec.id} size="2" weight="medium">{label}</Text>
          <Controller
            control={control}
            name={spec.name}
            render={({ field }) => (
              <TextField.Root
                id={spec.id}
                value={field.value as string}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
                {...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {})}
                {...fieldErrorProps(spec.id, problem)}
              />
            )}
          />
          {message}
        </Flex>
      );
  }
}

function Field<T extends FieldValues, C>(props: FieldProps<T, C> & { spec: FieldSpec<T, C> }) {
  const { spec, control, values, context, shown } = props;
  if (spec.when && !spec.when(values)) return null;
  if (spec.kind === 'custom') return <>{spec.render({ control, values, context, shown })}</>;
  if (spec.kind === 'ratio') {
    const parts = spec.parts.filter((part) => part.when?.(values) ?? true);
    return (
      <Flex direction="column" gap="2">
        <Text as="div" id={`${spec.id}-label`} size="2" weight="medium">{spec.label}</Text>
        <Flex align="center" gap="2" role="group" aria-labelledby={`${spec.id}-label`}>
          {parts.map((part, index) => (
            <React.Fragment key={part.id}>
              {index > 0 && <Text size="4" aria-hidden="true">:</Text>}
              <DecimalControl spec={part} control={control} values={values} problem={shown(part.id)} />
            </React.Fragment>
          ))}
        </Flex>
        {parts.map((part) => <FieldError key={part.id} fieldId={part.id} message={shown(part.id)} />)}
        {spec.note !== undefined && <Note text={spec.note} />}
      </Flex>
    );
  }
  return <ValueField {...props} spec={spec} />;
}

function Row<T extends FieldValues, C>({ row, ...props }: FieldProps<T, C> & { row: FieldRow<T, C> }) {
  if (!Array.isArray(row)) return <Field {...props} spec={row as FieldSpec<T, C>} />;
  const specs = (row as readonly FieldSpec<T, C>[]).filter((spec) => spec.when?.(props.values) ?? true);
  if (specs.length === 0) return null;
  return (
    <Grid columns={{ initial: '1', sm: '2' }} gap="3">
      {specs.map((spec) => <Field key={spec.id} {...props} spec={spec} />)}
    </Grid>
  );
}

export function InvestmentEventForm<T extends FieldValues, C, B>({ config }: { config: InvestmentEventConfig<T, C, B> }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: accounts = EMPTY_LIST } = useAccountsQuery(false, { enabled: config.accounts === true });
  const { data: securities = EMPTY_LIST } = useSecuritiesQuery(config.allSecurities ?? false);
  const lists = useMemo<OptionLists>(() => ({ accounts, securities }), [accounts, securities]);
  const send = config.useSend();

  const [defaultValues] = useState(() => config.defaults(params));
  const { control, handleSubmit, getValues, formState: { submitCount, isSubmitting } } = useForm<T, C>({
    defaultValues: defaultValues as DefaultValues<T>,
    // Given anew each render (react-hook-form reads the latest), with this render's lookups
    // (below) as its context: it runs only when a submit or a change is checked, after them.
    resolver: (submitted) => investmentEventResolver(config)(submitted, lookups),
    // The first field with a problem is focused by its id, after the render that shows it.
    shouldFocusError: false,
  });
  // Every value, from the first render on (the default values until a field changes).
  const values = useWatch({ control }) as T;
  // What else the form reads for its values (a sale's open lots).
  const lookups = config.useLookups(values);

  const problems = useMemo(() => new Map(investmentEventProblems(config, values, lookups)), [config, values, lookups]);
  const live = useMemo(
    () => new Set(shownFields(config.rows, values).filter((spec) => spec.kind !== 'custom' && spec.live).map((spec) => spec.id)),
    [config, values],
  );
  // None until a submit is tried (a live field's from the start); then they follow the fields.
  const shown = (id: string): string | null => (submitCount > 0 || live.has(id) ? problems.get(id) ?? null : null);

  // Focus after the render that shows the messages, so the field is read with its own.
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (focusRequest) focusControl(focusRequest.id);
  }, [focusRequest]);

  const onValid = async (submitted: T) => {
    try {
      await send(config.toRequest(submitted, lookups), submitted);
      toast.success(config.successMessage);
      navigate(config.backPath);
    } catch (err) {
      logger.error({ err }, config.failureMessage);
      toast.error(apiErrorMessage(err, config.failureMessage));
    }
  };
  const onInvalid = () => {
    const first = investmentEventProblems(config, getValues(), lookups)[0];
    if (first) setFocusRequest({ id: first[0] });
  };

  const formId = formProblemId(config.id);
  const fieldProps = { control, values, context: lookups, lists, shown };
  return (
    <>
      <PageHeader title={config.title} {...(config.subtitle !== undefined ? { subtitle: config.subtitle } : {})} icon={config.icon} backPath={config.backPath} />
      <Card>
        <form noValidate onSubmit={handleSubmit(onValid, onInvalid)}>
          <Flex direction="column" gap="4" p="2">
            {config.rows.map((row, index) => <Row key={index} {...fieldProps} row={row} />)}
            {shown(formId) && (
              <Box id={formId} tabIndex={-1}>
                <FieldError fieldId={formId} message={shown(formId)} />
              </Box>
            )}
            <Flex gap="3" justify="end">
              <Button type="button" variant="soft" color="gray" onClick={() => navigate(config.backPath)}>Cancel</Button>
              <Button type="submit" disabled={isSubmitting}>{config.submitLabel}</Button>
            </Flex>
          </Flex>
        </form>
      </Card>
    </>
  );
}

export default InvestmentEventForm;
