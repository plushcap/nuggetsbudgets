import React from 'react';
import { Text } from '@radix-ui/themes';

/** The id of a field's validation message: `<field id>-error`. */
export const fieldErrorId = (fieldId: string): string => `${fieldId}-error`;

/**
 * The props that tie a field to its validation message: `aria-invalid` while it has an
 * error, and `aria-describedby` naming the message (then any hint ids passed in), so a
 * screen reader says what's wrong, first, when the field takes the focus. Spread them on the
 * control whose id is `fieldId` (a TextField, Select.Trigger, CurrencyInput or picker).
 */
export const fieldErrorProps = (
  fieldId: string,
  error: unknown,
  ...hintIds: (string | false | null | undefined)[]
): { 'aria-invalid'?: true; 'aria-describedby'?: string } => {
  const ids = [error ? fieldErrorId(fieldId) : undefined, ...hintIds].filter(Boolean).join(' ');
  return {
    ...(error ? { 'aria-invalid': true as const } : {}),
    ...(ids ? { 'aria-describedby': ids } : {}),
  };
};

/**
 * fieldErrorProps' `aria-describedby` alone, for the custom pickers: a button, which
 * `aria-invalid` doesn't apply to, still reads the message after its name.
 */
export const fieldErrorDescribedBy = (
  fieldId: string,
  error: unknown,
  ...hintIds: (string | false | null | undefined)[]
): string | undefined => fieldErrorProps(fieldId, error, ...hintIds)['aria-describedby'];

interface FieldErrorProps {
  /** The id of the field the message is about (see fieldErrorProps). */
  fieldId: string;
  /** The message; nothing is shown without one (`errors.x?.message` passes undefined). */
  message?: string | null | undefined;
}

/** A field's validation message, shown under it and read with it (fieldErrorProps). */
const FieldError: React.FC<FieldErrorProps> = ({ fieldId, message }) =>
  message ? (
    <Text as="p" id={fieldErrorId(fieldId)} size="1" color="red">
      {message}
    </Text>
  ) : null;

export default FieldError;
