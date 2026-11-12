import type { FieldErrors, FieldValues } from 'react-hook-form';

/**
 * After a refused submit, focuses the first field (in the order given) that has an
 * error, so a keyboard or screen-reader user lands on it and hears its message (the
 * field's aria-describedby, from fieldErrorProps). For forms with fields
 * react-hook-form can't focus itself (CurrencyInput, the custom pickers): pass each
 * field's name and a selector for its control.
 */
export function focusFirstError<T extends FieldValues>(
  errors: FieldErrors<T>,
  fields: ReadonlyArray<readonly [keyof T & string, string]>,
): void {
  for (const [name, selector] of fields) {
    if (!errors[name]) continue;
    const control = document.querySelector<HTMLElement>(selector);
    if (control) {
      control.focus();
      return;
    }
  }
}
