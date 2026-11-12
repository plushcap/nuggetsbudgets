import type { ReactNode } from 'react';
import type { Control, FieldErrors, FieldValues, Path, Resolver } from 'react-hook-form';
import type { z } from 'zod';
import type { Security } from '@nuggets/shared';
import type { Account } from '../../services/api';
import { isUnreadableAmount, UNREADABLE_REQUIRED_AMOUNT_MESSAGE } from '../forms/optionalAmount';

/**
 * The investment event pages' one form: what an event's field config says, and
 * what the form does with it, apart from drawing it (InvestmentEventForm.tsx).
 *
 * A config lists its fields in rows, in the order they're checked and focused. Each field
 * names the form value it edits and the DOM id of its control (its label, its message and the
 * focus go by the id), and may say when it shows and why its value can't be sent. A submit
 * is refused while a shown field has a problem; once none has, the request the config builds
 * is checked with the event's `@nuggets/shared` schema, the one the route checks it with, so
 * nothing the route would refuse is sent. Problems show beside their fields once a submit has
 * been tried, and follow the fields as they change (a `live` field's from the start); the
 * submit button stays enabled and focuses the first field with one (CLAUDE.md's form rules).
 */

export interface Option {
  value: string;
  label: string;
}

/** The lists a select's options come from. */
export interface OptionLists {
  accounts: readonly Account[];
  securities: readonly Security[];
}

/** A label or note: fixed, or worked out from the values (a corporate action's own words). */
export type FieldText<T> = string | ((values: T) => string);

interface SpecBase<T> {
  /** The control's DOM id. */
  id: string;
  /** Shown only while this holds (a reinvestment price, an action's own figures). */
  when?: (values: T) => boolean;
}

interface ValueSpec<T, C> extends SpecBase<T> {
  /** The form value the control edits. */
  name: Path<T>;
  label: FieldText<T>;
  /** Why the value can't be sent, or null. */
  problem?: (values: T, context: C) => string | null;
  /** Its problem shows as it is typed, before any submit. */
  live?: boolean;
  /** A note under the field. */
  note?: FieldText<T>;
}

export interface SelectSpec<T, C> extends ValueSpec<T, C> {
  kind: 'select';
  options: (lists: OptionLists, values: T) => Option[];
  placeholder?: string;
}

export interface DateSpec<T, C> extends ValueSpec<T, C> {
  kind: 'date';
}

/** A share count, ratio or percentage: text sent as typed, in a number field. */
export interface DecimalSpec<T, C> extends ValueSpec<T, C> {
  kind: 'decimal';
  step: string;
  max?: string;
  placeholder?: string;
  /** Named by aria-label instead of a label above it (a ratio's two sides). */
  labelHidden?: boolean;
}

/** An amount in dollars, or a price (4 decimals), entered with CurrencyInput. */
export interface AmountSpec<T, C> extends ValueSpec<T, C> {
  kind: 'amount';
  decimals: 2 | 4;
  /** Empty is 0 and unreadable text NaN (forms/optionalAmount.ts); else empty is null. */
  optional?: boolean;
}

export interface SwitchSpec<T, C> extends ValueSpec<T, C> {
  kind: 'switch';
}

export interface TextSpec<T, C> extends ValueSpec<T, C> {
  kind: 'text';
  placeholder?: string;
}

/** Two decimals side by side, `a : b` (a split's new and old shares). */
export interface RatioSpec<T, C> extends SpecBase<T> {
  kind: 'ratio';
  label: string;
  parts: readonly [DecimalSpec<T, C>, DecimalSpec<T, C>];
  note?: string;
}

export interface CustomFieldProps<T extends FieldValues, C> {
  control: Control<T>;
  values: T;
  context: C;
  /** The problem shown for a control id, or null. */
  shown: (id: string) => string | null;
}

/** A field the config draws itself (a sale's lots), with problems on the ids it draws. */
export interface CustomSpec<T extends FieldValues, C> extends SpecBase<T> {
  kind: 'custom';
  problems?: (values: T, context: C) => ReadonlyArray<readonly [string, string | null]>;
  render: (props: CustomFieldProps<T, C>) => ReactNode;
}

export type ValueFieldSpec<T, C> =
  | SelectSpec<T, C>
  | DateSpec<T, C>
  | DecimalSpec<T, C>
  | AmountSpec<T, C>
  | SwitchSpec<T, C>
  | TextSpec<T, C>;

export type FieldSpec<T extends FieldValues, C> = ValueFieldSpec<T, C> | RatioSpec<T, C> | CustomSpec<T, C>;

/** One field across the row, or several side by side (from sm up). */
export type FieldRow<T extends FieldValues, C> = FieldSpec<T, C> | readonly FieldSpec<T, C>[];

export interface InvestmentEventConfig<T extends FieldValues, C = undefined, B = unknown> {
  /** Starts the ids that aren't a field's own (the form-wide message's). */
  id: string;
  title: string;
  subtitle?: string;
  icon: ReactNode;
  /** Where Cancel, the header's back link and a recorded event go. */
  backPath: string;
  submitLabel: string;
  successMessage: string;
  /** The toast when the API refuses without a reason it gives, and the log line. */
  failureMessage: string;
  /** The form's first values, from the page's query string. */
  defaults: (params: URLSearchParams) => T;
  rows: readonly FieldRow<T, C>[];
  /** Has an account field: the form asks for the accounts (the others never did). */
  accounts?: boolean;
  /** Lists every security, the inactive ones too (a price for one no longer held). */
  allSecurities?: boolean;
  /** What else the form reads from the API for these values (a sale's open lots). A hook. */
  useLookups: (values: T) => C;
  /** The request body. */
  toRequest: (values: T, context: C) => B;
  /** The `@nuggets/shared` schema the route checks this body with. */
  requestSchema: (values: T) => z.ZodType;
  /** The control a request schema issue is about, by the body's key, where no field has that name. */
  requestFields?: Readonly<Record<string, string>>;
  /** Sends the body. A hook. */
  useSend: () => (body: B, values: T) => Promise<unknown>;
}

/** The id of the message for a problem no one field has (the request schema's, unmapped). */
export const formProblemId = (configId: string): string => `${configId}-form`;

/** The label or note for these values. */
export const textFor = <T>(text: FieldText<T>, values: T): string => (typeof text === 'function' ? text(values) : text);

/** The fields shown for these values, in order: a row's side by side, a ratio's two parts. */
export function shownFields<T extends FieldValues, C>(
  rows: readonly FieldRow<T, C>[],
  values: T,
): Array<ValueFieldSpec<T, C> | CustomSpec<T, C>> {
  const shows = (spec: { when?: (values: T) => boolean }) => spec.when?.(values) ?? true;
  const fields: Array<ValueFieldSpec<T, C> | CustomSpec<T, C>> = [];
  for (const row of rows) {
    for (const spec of Array.isArray(row) ? (row as readonly FieldSpec<T, C>[]) : [row as FieldSpec<T, C>]) {
      if (!shows(spec)) continue;
      if (spec.kind === 'ratio') fields.push(...spec.parts.filter(shows));
      else fields.push(spec);
    }
  }
  return fields;
}

/**
 * Why these values can't be sent, as [control id, message] in the fields' order: the shown
 * fields' own problems, else the request schema's issues, each on the field it names, in
 * words for people (fieldIssueMessage). An issue no shown field has goes on the form as a
 * whole, as the schema says it: it is a body key no field edits.
 */
export function investmentEventProblems<T extends FieldValues, C, B>(
  config: InvestmentEventConfig<T, C, B>,
  values: T,
  context: C,
): Array<[string, string]> {
  const fields = shownFields(config.rows, values);
  const found: Array<[string, string]> = [];
  for (const spec of fields) {
    if (spec.kind === 'custom') {
      for (const [id, message] of spec.problems?.(values, context) ?? []) if (message) found.push([id, message]);
      continue;
    }
    // A required amount's text the box can't read (NaN, nullableAmountInput) is refused as no
    // amount is, in the field's words; the box says why beside them.
    const unreadable = spec.kind === 'amount' && !spec.optional && isUnreadableAmount((values as Record<string, unknown>)[spec.name]);
    const message = unreadable
      ? (spec.problem?.({ ...values, [spec.name]: null } as T, context) ?? UNREADABLE_REQUIRED_AMOUNT_MESSAGE)
      : spec.problem?.(values, context);
    if (message) found.push([spec.id, message]);
  }
  if (found.length > 0) return found;

  const checked = config.requestSchema(values).safeParse(config.toRequest(values, context));
  if (checked.success) return [];
  for (const issue of checked.error.issues) {
    const key = String(issue.path[0] ?? '');
    const named = config.requestFields?.[key] ?? fields.find((spec) => spec.kind !== 'custom' && spec.name === key)?.id;
    const spec = fields.find((field) => field.id === named);
    const id = spec ? spec.id : formProblemId(config.id);
    if (found.some(([seen]) => seen === id)) continue;
    found.push([id, spec && spec.kind !== 'custom' ? fieldIssueMessage(issue, key, spec.kind, textFor(spec.label, values)) : issue.message]);
  }
  return found;
}

/** A label as a sentence says it: without a note in parentheses, its first letter small. */
const inSentence = (label: string): string => {
  const plain = label.replace(/\s*\([^)]*\)/g, '').trim();
  return plain.charAt(0).toLowerCase() + plain.slice(1);
};

/** A decimal's whole digits grouped by thousands: 99999999.9999 is 99,999,999.9999. */
const grouped = (decimal: string): string => {
  const [whole = '', fraction] = decimal.split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? withCommas : `${withCommas}.${fraction}`;
};

/**
 * A request schema issue on a field, said for people. The schema's text is the
 * API's, written for a caller: it names the body's key (`price_per_share must be a number
 * between -99999999.9999 and 99999999.9999`, decimalInput's and the investment schemas'
 * forms), or is Zod's own (`Invalid UUID`, for a choice the list doesn't have). A date's
 * (calendarDay) is written for people already, and kept.
 */
export function fieldIssueMessage(issue: { code: string; message: string }, key: string, kind: ValueFieldSpec<unknown, unknown>['kind'], label: string): string {
  const name = inSentence(label);
  if (kind === 'select') return `Choose the ${name} from the list.`;
  if (!issue.message.startsWith(`${key} `)) return issue.code === 'custom' ? issue.message : `Check the ${name}.`;
  const rest = issue.message.slice(key.length + 1);
  const range = /^must be (?:a number )?between -\S+ and (\S+)$/.exec(rest);
  if (range?.[1]) return `Enter the ${name}, up to ${grouped(range[1])}.`;
  const places = /^must be a number with at most (\d+) decimal places?$/.exec(rest);
  if (places?.[1]) return `Enter the ${name} with at most ${places[1]} decimal place${places[1] === '1' ? '' : 's'}.`;
  if (rest === 'must be a number') return `Enter the ${name} as a number.`;
  if (rest === 'must be greater than zero') return `Enter the ${name}, more than 0.`;
  if (rest === 'must be zero or more') return `Enter the ${name}, 0 or more.`;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${rest}.`;
}

/**
 * The form's resolver: refuses a submit with investmentEventProblems' messages, by control id,
 * in order (the first is the one to focus). Its context is the config's lookups.
 */
export function investmentEventResolver<T extends FieldValues, C, B>(config: InvestmentEventConfig<T, C, B>): Resolver<T, C> {
  return async (values, context) => {
    const problems = investmentEventProblems(config, values, context as C);
    if (problems.length === 0) return { values, errors: {} };
    const errors = Object.fromEntries(problems.map(([id, message]) => [id, { type: 'validate', message }]));
    return { values: {}, errors: errors as FieldErrors<T> };
  };
}
