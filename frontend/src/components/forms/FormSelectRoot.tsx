import React from 'react';
import { Select } from '@radix-ui/themes';

type SelectRootProps = React.ComponentProps<typeof Select.Root>;

/**
 * `Select.Root` for a controlled Select inside a `<form>`. Use it for every such
 * Select: it drops an empty value Radix reports from the form's hidden select.
 *
 * Inside a form, Radix Select renders a hidden native `<select>` (its
 * SelectBubbleInput) so the value takes part in form submission. When the controlled
 * `value` changes after mount (a form `reset()` once its record loads, an option list
 * that arrives later), Radix writes the value into that native select and dispatches a
 * `change`. If the `<option>` for the value isn't registered yet, the native select
 * can't hold it and reads back `''`. Up to radix-ui 1.7.0 (`@radix-ui/react-select`
 * 2.3.8) that `change` bubbled, so the select's own handler called
 * `onValueChange('')`: the field became `''` (or `NaN` through `parseInt`), the trigger
 * went blank, and the form refused to save. Since radix-ui 1.8.0 (react-select 2.4.0)
 * a programmatic sync doesn't bubble and React doesn't call that handler, so Radix no
 * longer reports it. This wrapper stays as a guard: the first test in
 * `__tests__/FormSelectRoot.test.tsx` fails if Radix starts reporting it again, and a
 * `change` that does bubble from the hidden select (an autofill or script writing a
 * value with no option) still reaches `onValueChange` as `''`.
 *
 * No item in these forms has the value `''`, so no choice a person makes is `''`, and
 * ignoring it is safe. The controlled value is left as it was, and the trigger shows it
 * as soon as its item registers. Since
 * react-select 2.3.1 (radix-ui 1.6.0) Radix allows a `Select.Item` with value `''` as
 * a "clear" option; this wrapper would drop that choice, so give a "none" item a value
 * of its own (`"none"`, `"null"`), as the forms here do.
 */
const FormSelectRoot: React.FC<SelectRootProps> = ({ onValueChange, ...props }) => (
  <Select.Root
    {...props}
    onValueChange={(value) => {
      if (value !== '') onValueChange?.(value);
    }}
  />
);

export default FormSelectRoot;
