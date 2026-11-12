import React, { useEffect, useEffectEvent, useId, useState } from 'react';
import { Text, TextField } from '@radix-ui/themes';
import { currencySymbol, formatMoneyDefaults, supportedMoneyLocale } from '@nuggets/shared';
import { INVISIBLE, parseAmount } from '../utils/parseAmount';

/**
 * Reusable currency input.
 *
 * Why this exists: the inline pattern used across the app
 *   `if (!/^(\d+\.?\d{0,2})?$/.test(value)) return;`
 * silently rejects pasted values like `$1,234.56` or `1,234.56` because
 * commas/dollar signs/whitespace fail the regex. This component reads them
 * (utils/parseAmount), on input AND on paste, so copy/paste from bank UIs,
 * spreadsheets, and emails all "just work."
 *
 * Behavior:
 *   - Reads `$1,234.56`, `1.234,56`, `1 234,56 €` and `(1,234.56)`:
 *     the decimal separator is worked out, not assumed to be a dot.
 *   - Text it can't read as an amount (more than two decimals, `1.234`, which could be
 *     either way, a letter: `1e2`, or another mark: `1/2`, `50%`) is kept in the
 *     box, marked `aria-invalid`, and explained under it, and reported as `null`; it is never
 *     cut down to some other number. A typed letter or mark stays in the box too, rather
 *     than vanish (a currency code at either end, `USD 12`, is read as a `$` is). With
 *     `hideOwnHint`, while the form shows its error
 *     for the field (`aria-invalid`), that is the box's one message.
 *   - Text typed on the way to an amount (`1 2` before `1 234`, `(12` before `(12)`) is
 *     refused, but flagged only once the box loses the focus as it is (numberBeingTyped).
 *   - On blur, formats the number with thousands separators
 *     (e.g. `1234.5`  → `1,234.50`) for visual scanning.
 *   - On focus, switches back to the raw decimal string so editing isn't fiddly.
 *   - Calls `onChange(numericValue, unreadable)` whenever the parsed value changes.
 *     Empty / unreadable input is reported as `null`; the second argument (and
 *     `onUnreadableChange`) tells them apart, for an optional field whose form must refuse
 *     unreadable text rather than read it as empty (forms/optionalAmount.ts).
 *   - Takes `aria-invalid` / `aria-describedby` from its form (fieldErrorProps).
 *   - `decimals` (default 2) is how many decimal places it takes: 4 for a price or an amount
 *     per share, which the API keeps to 4 places. parseAmount's rules hold at 4 too.
 *   - A `value` with more places than it shows (a float sum: 1030.3100000000002, shown as
 *     1,030.31) is sent back through `onChange` as shown, so the form sends what the box
 *     shows; the API refuses more than its places. A readable value is left alone.
 *
 * Use this anywhere the app currently has a hand-rolled regex-gated amount
 * input. See migration in TransferMoneyPage for an example.
 */

type RadixSize = '1' | '2' | '3';
type RadixColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'gray';

export interface CurrencyInputProps {
  /** Current value in dollars. Pass `null` or `undefined` for an empty input. */
  value: number | null | undefined;
  /**
   * Called with the parsed numeric value, or null for an empty box or unreadable text, and
   * whether the text is unreadable: an optional field's form refuses that rather than read it
   * as empty or keep the last number (forms/optionalAmount.ts).
   */
  onChange: (value: number | null, unreadable: boolean) => void;
  /** Called with whether the text typed or pasted is unreadable (and reported to onChange as null). */
  onUnreadableChange?: (unreadable: boolean) => void;
  /**
   * Called with whether the text is a number being typed (numberBeingTyped: `(12.00` before its
   * `)`, `1 2` before `1 234`): unreadable yet, but not flagged while it is typed, so a caller
   * that says itself why text isn't an amount can wait too. False again on blur, where
   * it is refused.
   */
  onPendingChange?: (pending: boolean) => void;
  /** Called on blur. */
  onBlur?: () => void;
  /** The text box, so a form can focus it on a refused submit (react-hook-form's field.ref). */
  ref?: React.Ref<HTMLInputElement>;
  id?: string;
  name?: string;
  /** A name for a field without a visible label (e.g. "Minimum amount"). */
  'aria-label'?: string;
  /**
   * Leave the box's own hint out while the form shows its error for the field (aria-invalid):
   * only for a caller whose message says itself that the text isn't an amount, so the
   * box has one message. Otherwise the form's message (say "Enter the price per share.") would
   * be all that is left, and nothing would say why the text was refused.
   */
  hideOwnHint?: boolean;
  /** The form's verdict on the field (fieldErrorProps); unreadable text marks it too. */
  'aria-invalid'?: boolean;
  /** Ids of the field's hint and error messages (fieldErrorProps). */
  'aria-describedby'?: string;
  placeholder?: string;
  /** Radix size. Defaults to '3'. */
  size?: RadixSize;
  /** Radix color (e.g. 'red' for validation error). */
  color?: RadixColor | undefined;
  disabled?: boolean;
  required?: boolean;
  /**
   * When false (default), a negative (`-12`, `12-`, `(12)`) is refused, kept in sight with a
   * hint that the box takes none, as typed or pasted alike (typed, its sign was dropped,
   * and `(12)` left `12)`; pasted, it read as 12). True on fields like balance adjustments.
   */
  allowNegative?: boolean;
  /** The most decimal places it reads: 2 (default) for money, 4 for a price or an amount per share. */
  decimals?: 2 | 4;
  /**
   * Currency symbol shown in the left slot. Accepts a string (default: the ledger's currency's
   * sign, currencySymbol(), '$' until it sets one: LedgerMoneyFormat) or
   * any React node (e.g. a Lucide icon). Pass null/false to hide the slot.
   */
  symbol?: React.ReactNode;
  className?: string;
}

/** The locale the ledger writes amounts in (LedgerMoneyFormat), as this browser can write it. */
const ledgerLocale = (): string => supportedMoneyLocale(formatMoneyDefaults().locale);

/**
 * `value` grouped and with its decimals as the ledger writes amounts (its locale,
 * LedgerMoneyFormat: 1,234.56 in en-US, 1.234,56 in de-DE, 12,34,567.89 in en-IN), which
 * parseAmount reads back under that locale.
 */
const formatWithCommas = (value: number, decimals: number): string => {
  const options = { minimumFractionDigits: 2, maximumFractionDigits: decimals };
  try {
    return value.toLocaleString(ledgerLocale(), options);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return value.toLocaleString('en-US', options);
  }
};

/**
 * `value` as the box shows it, as a number: rounded by toLocaleString, as formatWithCommas
 * rounds it, which isn't toFixed's rounding (1.005 shows as 1.01, and its toFixed(2) is
 * "1.00"). -0 is 0.
 */
const shownValue = (value: number, decimals: number): number =>
  Number(value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: decimals })) || 0;

/**
 * `value` as text to edit, which parseAmount reads back as `value`: String(1234.5) is
 * "1234.5", and with 4 decimals 1.234 is "1.2340" (parseAmount refuses "1.234", which could
 * be 1234).
 */
const editableText = (value: number, allowNegative: boolean, decimals: number): string => {
  const text = String(value);
  return parseAmount(text, allowNegative, decimals, ledgerLocale()).invalid ? value.toFixed(decimals) : text;
};

/**
 * What the box shows while typing: what was typed, less what stands before the number and the
 * box has already (a currency sign: its own `$` is there; a space) and invisible marks. A sign
 * stays, where no negative is taken too (refused there, as a paste of it is). Everything the
 * reader refuses stays in sight, so the box shows what it can't read rather than another
 * number: letters, other marks (`1/2`, `50%`), and, in the number, a minus, a currency
 * sign or a space (`1-2`, `12€50`, `12 34`). A `$` after a letter (US$) stays too.
 */
const sanitize = (raw: string): string =>
  raw
    .replace(INVISIBLE, '')
    .replace(/\u2212/g, '-')
    .replace(/^\s*([-+(]?)\s*\p{Sc}*\s*/u, '$1');

/**
 * Whether refused `text` is a negative where none is taken: `-12`, `12-`, `(12)`, and `(12`
 * as it is typed. The box says so rather than that it isn't an amount.
 */
const negativeRefused = (text: string, allowNegative: boolean, decimals: number): boolean => {
  if (allowNegative) return false;
  const close = /^\s*\(/.test(text) && !text.includes(')') ? ')' : '';
  const read = parseAmount(`${text}${close}`, true, decimals, ledgerLocale()).value;
  return read !== null && read < 0;
};

/**
 * A group of three being typed after a space or an apostrophe, the ways a thousands group is
 * typed (`1 2`, `1'`, `12 345 6` before `1 234`, `1'000`, `12 345 678`).
 */
const GROUP_BEING_TYPED = /[ \u00a0\u2007\u2009\u202f'\u2019]\d{0,2}$/u;

/**
 * Whether refused `text` is a number being typed: the rest of a group of three it is typing
 * (GROUP_BEING_TYPED), and the `)` of an accounting negative where negatives are taken
 * (`(12.00`, `(1 2`), makes it an amount the reader takes. Text that nothing typed after it
 * could make one (`12o`, `1-2`, `1 2345`) isn't, nor are more decimals than the box takes
 * (`12.345`, which says so at once, though a European `1.234,56` passes through it).
 */
const numberBeingTyped = (text: string, allowNegative: boolean, decimals: number): boolean => {
  const close = allowNegative && /^\s*\(/.test(text) && !text.includes(')') ? ')' : '';
  const endings = GROUP_BEING_TYPED.test(text) ? ['', '0', '00', '000'] : [''];
  return endings.some((ending) => parseAmount(`${text}${ending}${close}`, allowNegative, decimals, ledgerLocale()).value !== null);
};

/**
 * A paste the reader refused, as the box keeps it: as pasted, without invisible marks or the
 * space and line breaks around it, and with a mark for each tab (⇥) and line break (↵)
 * inside it, which a text box shows as a space or drops (`1\n234` showed as
 * 1 234 or 1234, a readable number, refused).
 */
const refusedPaste = (pasted: string): string =>
  pasted.replace(INVISIBLE, '').trim().replace(/\r\n|[\r\n]/g, '\u21b5').replace(/\t/g, '\u21e5');

const CurrencyInput: React.FC<CurrencyInputProps> = ({
  value,
  onChange,
  onUnreadableChange,
  onPendingChange,
  onBlur,
  ref,
  id,
  name,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  hideOwnHint = false,
  'aria-describedby': describedBy,
  placeholder = '0.00',
  size = '3',
  color,
  disabled = false,
  required = false,
  allowNegative = false,
  decimals = 2,
  symbol = currencySymbol(),
  className,
}) => {
  const hasValue = value !== null && value !== undefined && !Number.isNaN(value);
  // While focused the box shows what is being typed, held apart from `value` so a
  // half-finished number (e.g. "12.") stays as typed. Otherwise it shows `value`,
  // formatted, so a change from outside (a form reset, server data) shows at once.
  const [focused, setFocused] = useState(false);
  // The text being typed, and the reader's verdict on it: a paste is read as pasted, and kept
  // as pasted when refused, so its verdict is the paste's, not that of the text it shows.
  const [draft, setDraft] = useState({ text: '', refused: false, typed: false });
  // Text that isn't an amount stays in the box after it loses focus, so the person sees what
  // to fix, until a value comes in from outside.
  const [rejected, setRejected] = useState(false);
  // Any change of `value` while the box isn't focused comes from outside (a form reset, server
  // data), and replaces the kept text for good, a reset to empty included: an optional
  // field's NaN (optionalAmountInput) reset to 0 reaches the box as NaN, then null. A parent
  // that held null for the text made no change in a reset to null, so every parent holds NaN
  // for it: optionalAmountInput, nullableAmountInput (forms/optionalAmount.ts), the
  // transaction filter. (Set during render, React's way to adjust state to a prop; it
  // re-renders before painting.)
  const [seenValue, setSeenValue] = useState(value);
  if (!Object.is(value, seenValue)) {
    setSeenValue(value);
    if (rejected && !focused) setRejected(false);
  }
  const hintId = `${useId()}-amount-hint`;
  const showingDraft = focused || (rejected && !hasValue);
  const text = showingDraft ? draft.text : hasValue ? formatWithCommas(value, decimals) : '';
  // A number being typed (numberBeingTyped), `(12.00` before its `)` or `1 2` before `1 234`,
  // isn't flagged while the box has the focus: it read "Not an amount" from the `(1` or
  // the `1 2` on. It is still refused (the form is told), and flagged if the box loses the
  // focus as it is. A paste is shown for what it is at once.
  const beingTyped = focused && draft.typed && draft.refused && numberBeingTyped(draft.text, allowNegative, decimals);
  const unreadable = showingDraft && draft.refused && !beingTyped;

  // A value from outside with more places than the box shows goes back to the form as shown,
  // so what the form sends is what the box shows. What is typed or pasted is read to
  // those places already, so this never answers one.
  const sendShown = useEffectEvent((shown: number) => onChange(shown, false));
  useEffect(() => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    const shown = shownValue(value, decimals);
    if (shown !== value) sendShown(shown);
  }, [value, decimals]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const cleaned = sanitize(e.target.value);
    const parsed = parseAmount(cleaned, allowNegative, decimals, ledgerLocale());
    setDraft({ text: cleaned, refused: parsed.invalid, typed: true });
    onChange(parsed.value, parsed.invalid);
    onUnreadableChange?.(parsed.invalid);
    onPendingChange?.(parsed.invalid && numberBeingTyped(cleaned, allowNegative, decimals));
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    // Read the whole paste at once (`$1,234.56`, `1.234,56`) rather than let the
    // browser insert it into what's there. A readable amount shows as a plain number;
    // anything else stays as pasted, marked, so it isn't silently changed: cleaned up as
    // typing is, a refused `1-2` showed as 12 in a box that takes no negatives.
    const pasted = e.clipboardData.getData('text');
    if (pasted == null) return;
    e.preventDefault();
    const parsed = parseAmount(pasted, allowNegative, decimals, ledgerLocale());
    const shown = parsed.value !== null
      ? editableText(parsed.value, allowNegative, decimals)
      : parsed.invalid ? refusedPaste(pasted) : sanitize(pasted);
    setDraft({ text: shown, refused: parsed.invalid, typed: false });
    onChange(parsed.value, parsed.invalid);
    onUnreadableChange?.(parsed.invalid);
    onPendingChange?.(false);
  };

  const handleFocus = () => {
    setFocused(true);
    // While focused, drop the thousands separators so editing isn't awkward; unreadable
    // text that was kept comes back as it was.
    if (!(rejected && !hasValue)) setDraft({ text: hasValue ? editableText(value, allowNegative, decimals) : '', refused: false, typed: false });
    setRejected(false);
  };

  const handleBlur = () => {
    // Unfocused, the box shows the formatted value again (or keeps text it couldn't read).
    setFocused(false);
    setRejected(draft.refused);
    onPendingChange?.(false);
    if (onBlur) onBlur();
  };

  // One message for the field: a caller whose error says the text isn't an amount asks
  // for the box's own hint to stay out while that error shows (aria-invalid, fieldErrorProps).
  // That a negative isn't taken here is the box's to say, so that hint stays.
  const negativeHint = unreadable && negativeRefused(draft.text, allowNegative, decimals);
  const showHint = unreadable && (negativeHint || !(hideOwnHint && ariaInvalid));
  const describedByIds = [describedBy, showHint ? hintId : undefined].filter(Boolean).join(' ') || undefined;

  // The Tailwind arbitrary selector `[&_input]:pl-2!` adds 8px of left padding
  // to the actual <input> nested inside Radix's TextField.Root, which gives a
  // visual gap between the divider following the $ slot and the typed digits.
  // Without this, the slot pads its OWN right edge but the input itself sits
  // flush against the divider line.
  const rootClassName = [
    '[&_input]:pl-2!',
    className,
  ].filter(Boolean).join(' ');

  return (
    <>
      <TextField.Root
        ref={ref}
        id={id}
        name={name}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid || unreadable || undefined}
        aria-describedby={describedByIds}
        type="text"
        inputMode="decimal"
        value={text}
        onChange={handleChange}
        onPaste={handlePaste}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={placeholder}
        size={size}
        color={unreadable ? 'red' : color}
        disabled={disabled}
        required={required}
        className={rootClassName}
      >
        {symbol !== null && symbol !== false && symbol !== '' ? (
          // Extra right padding so the symbol isn't crammed against the divider.
          // aria-hidden: a <label> wrapped around the field would otherwise put the
          // symbol into the field's name ("Amount $").
          <TextField.Slot style={{ paddingRight: 6 }} aria-hidden="true">{symbol}</TextField.Slot>
        ) : null}
      </TextField.Root>
      {showHint && (
        <Text as="p" id={hintId} size="1" color="red" mt="1">
          {negativeHint
            ? "This can't be negative: enter the amount without a minus sign or parentheses."
            : decimals === 4
            ? 'Not an amount: enter it like 1,234.5678 or 1.234,5678, with at most four decimals. Write three as four (1.2340): 1.234 could be 1234.'
            : 'Not an amount: enter it like 1,234.56 or 1.234,56, with at most two decimals.'}
        </Text>
      )}
    </>
  );
};

export default CurrencyInput;
