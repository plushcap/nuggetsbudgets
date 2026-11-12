import type { ControllerRenderProps, FieldError, FieldErrors, FieldValues, Path, Resolver } from 'react-hook-form';
import type { z } from 'zod';
import { isMoneyRangeMessage } from '@nuggets/shared';

/**
 * Why an amount can't be stored (DECIMAL(12,2), ±9,999,999,999.99), in words for people, or
 * null: the request schema's message names the body's key, and gives a minus bound to a
 * box that takes no negatives. The sign of the amount says which the box is: a box that takes
 * no negatives can't hold a negative.
 */
export function amountRangeProblem(amount: unknown): string | null {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) < 1e10) return null;
  return value < 0 ? 'Enter an amount between -9,999,999,999.99 and 9,999,999,999.99.' : 'Enter an amount up to 9,999,999,999.99.';
}

/**
 * A form's own schema refuses an amount the column can't hold, in amountRangeProblem's words:
 * `.superRefine(refuseAmountPastColumn)`. Without it the form sent it, and the server's refusal
 * (which names the body's key) came back as a toast.
 */
export function refuseAmountPastColumn(amount: number | null, ctx: z.RefinementCtx): void {
  const problem = amountRangeProblem(amount);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
}

/**
 * An optional amount in a react-hook-form form. Empty is 0, as these fields
 * always read it; text CurrencyInput can't read ("15o" for 150, "1e2") is NaN in the form,
 * which withUnreadableAmounts refuses: the submit stops, the field's message shows beside it,
 * react-hook-form focuses it (CurrencyInput takes field.ref), and nothing is sent. Mapped to 0
 * with the empty box, a typo saved a budget of 0 with a success toast; the code before kept
 * the last number it read (15) and saved that.
 */
export const UNREADABLE_AMOUNT_MESSAGE = 'Not an amount: enter it like 1,234.56, or leave it empty.';

/** Whether a form value is an unreadable amount (optionalAmountInput's NaN). */
export const isUnreadableAmount = (value: unknown): boolean => typeof value === 'number' && Number.isNaN(value);

/**
 * CurrencyInput's ref, value, onChange and onBlur for an optional amount field rendered by a
 * Controller: 0 shows as an empty box, an empty box is 0 (or `onAmount`'s 0), unreadable text
 * NaN. `onAmount` sees each readable amount (0 for empty), for a field mirrored into another.
 */
export function optionalAmountInput<T extends FieldValues, N extends Path<T>>(
  field: ControllerRenderProps<T, N>,
  onAmount?: (amount: number) => void,
) {
  return {
    ref: field.ref,
    // The form's message says the text isn't an amount: it is the box's one message.
    hideOwnHint: true,
    value: field.value === 0 ? null : ((field.value as number | null | undefined) ?? null),
    onChange: (parsed: number | null, unreadable: boolean) => {
      if (unreadable) {
        field.onChange(Number.NaN);
        return;
      }
      field.onChange(parsed ?? 0);
      onAmount?.(parsed ?? 0);
    },
    onBlur: field.onBlur,
  };
}

/** The message for a required amount's text that can't be read: it can't be left empty. */
export const UNREADABLE_REQUIRED_AMOUNT_MESSAGE = 'Not an amount: enter it like 1,234.56.';

/**
 * CurrencyInput's value and onChange for an amount held as `number | null`, null for an empty
 * box (a required amount not given yet, or a rule's bound that has none), with text it can't
 * read held as NaN: a reset (to empty, or to the amount it had) is then a change the
 * box sees, and the text it kept goes. Held as null, as the empty box is, a reset to null left
 * the old text in the box. The form refuses NaN (a schema's `z.number({ error })` gives its
 * message for NaN too), so it is never sent: JSON sends NaN as null.
 */
export function nullableAmountInput(
  value: number | null | undefined,
  onChange: (amount: number | null) => void,
): { value: number | null; onChange: (parsed: number | null, unreadable: boolean) => void } {
  return {
    value: value ?? null,
    onChange: (parsed, unreadable) => onChange(unreadable ? Number.NaN : parsed),
  };
}

/**
 * `resolver`, refusing as well every top-level field on screen that holds an unreadable amount,
 * with UNREADABLE_AMOUNT_MESSAGE, or the field's own in `messages` (a required one can't be left
 * empty), since the form's schema may not check the field at all, or would say "expected
 * number". Only a field the form has mounted: one hidden (a section a choice
 * took away, which keeps its values for when it comes back) would stop the save with nothing on
 * screen to say why. Such a field goes on to the submit as undefined, so it isn't sent: JSON
 * sends NaN as null, which would empty the stored amount. A form whose sections can hide sends
 * the values its submit handler is given, not getValues().
 */
export function withUnreadableAmounts<T extends FieldValues, C, R>(
  resolver: Resolver<T, C, R>,
  messages: Partial<Record<Path<T>, string>> = {},
): Resolver<T, C, R> {
  return async (values, context, options) => {
    const result = await resolver(values, context, options);
    // The schema's message for an amount past the column, said for people (amountRangeProblem).
    const schemaErrors = result.errors as Record<string, FieldError | undefined>;
    for (const [name, error] of Object.entries(schemaErrors)) {
      const said = error?.message && isMoneyRangeMessage(error.message) ? amountRangeProblem(values[name]) : null;
      if (error && said) schemaErrors[name] = { ...error, message: said };
    }
    const fields = options.fields as Record<string, { mount?: boolean } | undefined>;
    const unreadable = Object.keys(values).filter((name) => isUnreadableAmount(values[name]) && fields[name]?.mount === true);
    if (unreadable.length > 0) {
      const errors: Record<string, FieldError> = { ...(result.errors as Record<string, FieldError>) };
      const said = messages as Record<string, string | undefined>;
      for (const name of unreadable) errors[name] = { type: 'unreadable', message: said[name] ?? UNREADABLE_AMOUNT_MESSAGE };
      return { values: {}, errors: errors as FieldErrors<T> };
    }
    const passed = result.values as Record<string, unknown>;
    const hidden = Object.keys(passed).filter((name) => isUnreadableAmount(passed[name]));
    if (hidden.length === 0) return result;
    const stripped = { ...passed, ...Object.fromEntries(hidden.map((name) => [name, undefined])) };
    return { ...result, values: stripped } as Awaited<ReturnType<Resolver<T, C, R>>>;
  };
}
