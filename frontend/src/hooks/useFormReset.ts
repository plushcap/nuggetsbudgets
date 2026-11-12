import { useLayoutEffect, useRef } from 'react';
import type { FieldValues, UseFormReset } from 'react-hook-form';

/**
 * Starts a react-hook-form form over from `values` whenever one of `keys` changes (a
 * dialog opening or closing, the record it is for changing), before the browser
 * paints, so what was typed last time never shows. The form's first values are its
 * `defaultValues`; this handles the changes after that.
 *
 * useForm's own `values` option isn't enough for a dialog: it resets only when the
 * values differ from the last ones passed, so a dialog that opens on the same empty
 * values again would keep what was typed before. `keys` are reset keys, chosen by
 * hand, as for useSeededState.
 */
export function useFormReset<T extends FieldValues>(reset: UseFormReset<T>, values: T, keys: readonly unknown[]): void {
  const mounted = useRef(false);
  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    reset(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `keys` are the reset keys
  }, keys);
}
