import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Controller, useForm } from 'react-hook-form';
import CurrencyInput from '../CurrencyInput';
import { optionalAmountInput } from '../forms/optionalAmount';

/** A parent that owns the value, as forms do; `outside` changes it from elsewhere. */
function Harness({ start, onChange, decimals }: { start: number | null; onChange?: (value: number | null) => void; decimals?: 2 | 4 }) {
  const [value, setValue] = useState<number | null>(start);
  return (
    <Theme>
      <CurrencyInput
        id="amount"
        decimals={decimals}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
      <button type="button" onClick={() => setValue(2500)}>outside</button>
    </Theme>
  );
}

const box = () => screen.getByRole('textbox');

describe('CurrencyInput', () => {
  it('drops kept unreadable text once a value comes in from outside, even when that value is later cleared', async () => {
    const view = (value: number | null) => (
      <Theme>
        <CurrencyInput value={value} onChange={() => {}} />
        <button type="button">elsewhere</button>
      </Theme>
    );
    const { rerender } = render(view(null));
    await userEvent.type(box(), '12abc');
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    // Unreadable text stays in sight after blur, so the person sees what to fix.
    expect(box()).toHaveValue('12abc');
    rerender(view(40));
    expect(box()).toHaveValue('40.00');
    // A reset to empty from outside is empty, not the old text.
    rerender(view(null));
    expect(box()).toHaveValue('');
  });

  // A reset straight from unreadable text to empty kept the text, so the
  // transaction filter remounted its boxes to clear them.
  it("drops kept unreadable text when an optional field's form resets it straight to empty", async () => {
    function OptionalForm() {
      const { control, reset } = useForm<{ fee: number }>({ defaultValues: { fee: 0 } });
      return (
        <Theme>
          <Controller control={control} name="fee" render={({ field }) => <CurrencyInput id="fee" {...optionalAmountInput(field)} />} />
          <button type="button" onClick={() => reset({ fee: 0 })}>reset</button>
        </Theme>
      );
    }
    render(<OptionalForm />);
    await userEvent.type(box(), '15o');
    await userEvent.click(screen.getByRole('button', { name: 'reset' }));
    // The form held NaN for the text; reset to 0, the box is given null: empty, not "15o".
    expect(box()).toHaveValue('');
    expect(box()).not.toHaveAttribute('aria-invalid');
  });

  it('drops kept unreadable text when the value its parent holds for it (NaN) is reset to none', async () => {
    const view = (value: number | null) => (
      <Theme>
        <CurrencyInput value={value} onChange={() => {}} />
        <button type="button">elsewhere</button>
      </Theme>
    );
    const { rerender } = render(view(null));
    await userEvent.type(box(), '1/2');
    rerender(view(Number.NaN));
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(box()).toHaveValue('1/2');
    // Re-rendered as it was, it keeps the text.
    rerender(view(Number.NaN));
    expect(box()).toHaveValue('1/2');
    rerender(view(null));
    expect(box()).toHaveValue('');
  });

  it('keeps marks it refuses in sight, typed or pasted, instead of dropping them', async () => {
    // "1/2" showed, and was read, as 12; "50%" as 50.
    const onChange = vi.fn();
    render(<Theme><CurrencyInput value={null} onChange={onChange} allowNegative /></Theme>);
    await userEvent.type(box(), '1/2');
    expect(box()).toHaveValue('1/2');
    expect(onChange).toHaveBeenLastCalledWith(null, true);
    expect(box()).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(box());
    await userEvent.paste('50%');
    expect(box()).toHaveValue('50%');
    expect(onChange).toHaveBeenLastCalledWith(null, true);
    await userEvent.clear(box());
    // A sign before the number is read; the space after it goes, and a currency sign after
    // the number stays in sight, read.
    await userEvent.type(box(), '+ 1.234,56 €');
    expect(box()).toHaveValue('+1.234,56 €');
    expect(onChange).toHaveBeenLastCalledWith(1234.56, false);
    await userEvent.clear(box());
    await userEvent.paste('‎1,234.56-');
    expect(onChange).toHaveBeenLastCalledWith(-1234.56, false);
  });

  // In a box that takes no negatives, a refused paste lost its `-` and `(` and
  // showed as a plain number (`10-20` as 1020), unflagged, then emptied when focus left. Its
  // tabs and line breaks became spaces, or went: `12\n34` showed as 12 34, refused.
  const NOT_AN_AMOUNT = 'Not an amount: enter it like 1,234.56 or 1.234,56, with at most two decimals.';
  const NO_NEGATIVE = "This can't be negative: enter the amount without a minus sign or parentheses.";
  it.each([
    ['1-2', '1-2', NOT_AN_AMOUNT],
    ['(12', '(12', NO_NEGATIVE],
    ['--12', '--12', NOT_AN_AMOUNT],
    ['2026-11-10', '2026-11-10', NOT_AN_AMOUNT],
    ['10-20', '10-20', NOT_AN_AMOUNT],
    ['12€50', '12€50', NOT_AN_AMOUNT],
    ['12 34', '12 34', NOT_AN_AMOUNT],
    ['12\r\n34', '12\u21b534', NOT_AN_AMOUNT],
    ['1\t234', '1\u21e5234', NOT_AN_AMOUNT],
    [' 1\n2\n\n3 \n', '1\u21b52\u21b5\u21b53', NOT_AN_AMOUNT],
  ])('keeps a refused paste as pasted, flagged, in a box that takes no negatives: %j', async (pasted, shown, hint) => {
    const onChange = vi.fn();
    render(
      <Theme>
        <CurrencyInput value={null} onChange={onChange} />
        <button type="button">elsewhere</button>
      </Theme>,
    );
    await userEvent.click(box());
    await userEvent.paste(pasted);
    expect(box()).toHaveValue(shown);
    expect(box()).toHaveAttribute('aria-invalid', 'true');
    expect(box()).toHaveAccessibleDescription(hint);
    expect(onChange).toHaveBeenLastCalledWith(null, true);
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(box()).toHaveValue(shown);
    expect(box()).toHaveAttribute('aria-invalid', 'true');
  });

  it('marks the tabs and line breaks of a refused paste where negatives are taken too, and reads a readable one', async () => {
    const onChange = vi.fn();
    render(<Theme><CurrencyInput value={null} onChange={onChange} allowNegative /></Theme>);
    await userEvent.click(box());
    await userEvent.paste('1\n234');
    expect(box()).toHaveValue('1\u21b5234');
    expect(onChange).toHaveBeenLastCalledWith(null, true);
    await userEvent.clear(box());
    // A line break around a readable amount (a spreadsheet cell's) goes with it.
    await userEvent.paste('-12\r\n');
    expect(box()).toHaveValue('-12');
    expect(onChange).toHaveBeenLastCalledWith(-12, false);
  });

  // Typed, a negative lost its sign (`-5` showed and read as 5) and `(12)` left
  // `12)`, refused; pasted, `(12)` read as 12.
  it.each(['-5', '12-', '(12)', '-$5', '(1,234.56)'])(
    'refuses a negative where none is taken, typed or pasted alike, and says why: %j',
    async (text) => {
      const shown = text.replace('$', '');
      const onChange = vi.fn();
      render(
        <Theme>
          <CurrencyInput value={null} onChange={onChange} />
          <button type="button">elsewhere</button>
        </Theme>,
      );
      await userEvent.type(box(), text);
      expect(box()).toHaveValue(shown);
      expect(box()).toHaveAttribute('aria-invalid', 'true');
      expect(box()).toHaveAccessibleDescription(NO_NEGATIVE);
      expect(onChange).toHaveBeenLastCalledWith(null, true);
      await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
      expect(box()).toHaveValue(shown);
      expect(box()).toHaveAttribute('aria-invalid', 'true');

      await userEvent.clear(box());
      await userEvent.paste(text);
      expect(box()).toHaveValue(text);
      expect(box()).toHaveAccessibleDescription(NO_NEGATIVE);
      expect(onChange).toHaveBeenLastCalledWith(null, true);
    },
  );

  it("says a negative where none is taken can't be one from its first digit, and takes zero and a plus", async () => {
    const onChange = vi.fn();
    render(<Theme><CurrencyInput value={null} onChange={onChange} /></Theme>);
    await userEvent.type(box(), '(');
    expect(box()).not.toHaveAttribute('aria-invalid');
    expect(onChange).toHaveBeenLastCalledWith(null, false);
    await userEvent.type(box(), '1');
    expect(box()).toHaveValue('(1');
    expect(box()).toHaveAccessibleDescription(NO_NEGATIVE);
    await userEvent.clear(box());
    await userEvent.type(box(), '-0');
    expect(onChange).toHaveBeenLastCalledWith(0, false);
    await userEvent.clear(box());
    await userEvent.type(box(), '+5');
    expect(onChange).toHaveBeenLastCalledWith(5, false);
    expect(box()).not.toHaveAttribute('aria-invalid');
  });

  it('keeps a minus, a currency sign or a space typed inside the number in sight, refused', async () => {
    // Each vanished as it was typed: 1-2 showed and read as 12, 12€50 as 1250, 12 34 as 1234.
    const onChange = vi.fn();
    render(
      <Theme>
        <CurrencyInput value={null} onChange={onChange} />
        <button type="button">elsewhere</button>
      </Theme>,
    );
    for (const typed of ['1-2', '12€50']) {
      await userEvent.clear(box());
      await userEvent.type(box(), typed);
      expect(box()).toHaveValue(typed);
      expect(box()).toHaveAttribute('aria-invalid', 'true');
      expect(onChange).toHaveBeenLastCalledWith(null, true);
    }
    // 12 34 could still be 12 345 as it is typed: refused, and flagged once the box is left.
    await userEvent.clear(box());
    await userEvent.type(box(), '12 34');
    expect(box()).toHaveValue('12 34');
    expect(box()).not.toHaveAttribute('aria-invalid');
    expect(onChange).toHaveBeenLastCalledWith(null, true);
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(box()).toHaveValue('12 34');
    expect(box()).toHaveAttribute('aria-invalid', 'true');
    expect(box()).toHaveAccessibleDescription(/not an amount/i);
    // Before the number, a currency sign goes; a sign stays (a negative here is refused).
    await userEvent.clear(box());
    await userEvent.type(box(), '+$5');
    expect(box()).toHaveValue('+5');
    expect(onChange).toHaveBeenLastCalledWith(5, false);
    await userEvent.clear(box());
    await userEvent.type(box(), '1 234');
    expect(box()).toHaveValue('1 234');
    expect(onChange).toHaveBeenLastCalledWith(1234, false);
  });

  // Typing an accounting negative read "Not an amount" from the `(1` until the `)`.
  it("doesn't flag an accounting negative while it is typed, and refuses one left without its )", async () => {
    const onChange = vi.fn();
    render(
      <Theme>
        <CurrencyInput value={null} onChange={onChange} allowNegative />
        <button type="button">elsewhere</button>
      </Theme>,
    );
    await userEvent.type(box(), '(12.00');
    expect(box()).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(/Not an amount/)).not.toBeInTheDocument();
    // Its form is still told it isn't an amount yet.
    expect(onChange).toHaveBeenLastCalledWith(null, true);
    await userEvent.type(box(), ')');
    expect(onChange).toHaveBeenLastCalledWith(-12, false);

    // Left without its `)`, it is refused, and shown so.
    await userEvent.clear(box());
    await userEvent.type(box(), '(12');
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(box()).toHaveValue('(12');
    expect(box()).toHaveAttribute('aria-invalid', 'true');
    expect(box()).toHaveAccessibleDescription(/not an amount/i);
    // Text that wouldn't read even closed is flagged as it is typed.
    await userEvent.clear(box());
    await userEvent.type(box(), '(12o');
    expect(box()).toHaveAttribute('aria-invalid', 'true');
  });

  // A grouped number read "Not an amount" as it was typed, from the `1 2` of
  // 1 234,56 or the `1'` of 1'234.50, until its group of three was there.
  describe('a grouped number being typed', () => {
    /** Types `text` a key at a time, and gives what the box showed each time it was flagged. */
    const typeWatchingFlags = async (text: string): Promise<string[]> => {
      const flagged: string[] = [];
      for (const key of text) {
        await userEvent.keyboard(key);
        if (box().getAttribute('aria-invalid') === 'true') flagged.push((box() as HTMLInputElement).value);
      }
      return flagged;
    };
    const field = () => (
      <Theme>
        <CurrencyInput value={null} onChange={onChange} allowNegative />
        <button type="button">elsewhere</button>
      </Theme>
    );
    const onChange = vi.fn();

    it.each([
      ['1 234,56', 1234.56],
      ["1'234.50", 1234.5],
      ['(1 234,56)', -1234.56],
      ['12 345 678,90', 12345678.9],
      ['1 234,56 €', 1234.56],
    ])('is never flagged on the way to %j, which it reads', async (typed, read) => {
      render(field());
      await userEvent.click(box());
      expect(await typeWatchingFlags(typed)).toEqual([]);
      expect(box()).toHaveValue(typed);
      expect(onChange).toHaveBeenLastCalledWith(read, false);
    });

    it.each(['1 2', '1 23', "1'", "1'2", "1'23", '12 3', '12 345 6', '(1 2'])(
      'refuses %j unflagged while it is typed, and flags it when the box is left so',
      async (typed) => {
        render(field());
        await userEvent.click(box());
        expect(await typeWatchingFlags(typed)).toEqual([]);
        expect(onChange).toHaveBeenLastCalledWith(null, true);
        expect(screen.queryByText(/not an amount/i)).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
        expect(box()).toHaveValue(typed);
        expect(box()).toHaveAttribute('aria-invalid', 'true');
        expect(box()).toHaveAccessibleDescription(/not an amount/i);
      },
    );

    it.each([['12o', '12o'], ['1 2o', '1 2o'], ['1 2345', '1 2345'], ['1 234 56,7', '1 234 56,']])(
      'flags %j as soon as nothing typed after it could make it an amount',
      async (typed, firstFlagged) => {
        render(field());
        await userEvent.click(box());
        expect((await typeWatchingFlags(typed))[0]).toBe(firstFlagged);
        expect(box()).toHaveAttribute('aria-invalid', 'true');
      },
    );

    // A third decimal says at once that it is one too many: a dot isn't waited on as a space is,
    // so a European 1.234,56 is flagged at its 1.234, until the comma.
    it('flags more decimals than the box takes as they are typed, a dot-grouped 1.234 included', async () => {
      render(field());
      await userEvent.click(box());
      expect(await typeWatchingFlags('12.345')).toEqual(['12.345']);
      await userEvent.clear(box());
      expect(await typeWatchingFlags('1.234,56')).toEqual(['1.234']);
      expect(onChange).toHaveBeenLastCalledWith(1234.56, false);
    });

    it('is shown for what it is at once when pasted', async () => {
      render(field());
      await userEvent.click(box());
      await userEvent.paste('1 2');
      expect(box()).toHaveValue('1 2');
      expect(box()).toHaveAttribute('aria-invalid', 'true');
    });
  });

  it('tells unreadable text from an empty box, typed or pasted', async () => {
    // Both are null to onChange; an optional field's form refuses the one and not the other.
    const onUnreadableChange = vi.fn();
    render(<Theme><CurrencyInput value={null} onChange={() => {}} onUnreadableChange={onUnreadableChange} /></Theme>);
    await userEvent.type(box(), '1.234');
    expect(onUnreadableChange).toHaveBeenLastCalledWith(true);
    await userEvent.clear(box());
    expect(onUnreadableChange).toHaveBeenLastCalledWith(false);
    await userEvent.paste('1.234,5,6');
    expect(onUnreadableChange).toHaveBeenLastCalledWith(true);
    await userEvent.clear(box());
    await userEvent.paste('$1,234.56');
    expect(onUnreadableChange).toHaveBeenLastCalledWith(false);
  });

  it('shows the value with thousands separators, and the plain number while focused', async () => {
    render(<Harness start={1234.5} />);
    expect(box()).toHaveValue('1,234.50');
    await userEvent.click(box());
    expect(box()).toHaveValue('1234.5');
    await userEvent.tab();
    expect(box()).toHaveValue('1,234.50');
  });

  it('shows an empty box for no value, focused or not', async () => {
    render(<Harness start={null} />);
    expect(box()).toHaveValue('');
    await userEvent.click(box());
    expect(box()).toHaveValue('');
  });

  it('keeps a half-typed number while focused and reports what it parses to', async () => {
    const onChange = vi.fn();
    render(<Harness start={null} onChange={onChange} />);
    await userEvent.click(box());
    await userEvent.type(box(), '12.');
    expect(box()).toHaveValue('12.');
    expect(onChange).toHaveBeenLastCalledWith(12);
    await userEvent.type(box(), '5');
    expect(onChange).toHaveBeenLastCalledWith(12.5);
    await userEvent.tab();
    expect(box()).toHaveValue('12.50');
  });

  it('strips $, commas and spaces from a paste', async () => {
    const onChange = vi.fn();
    render(<Harness start={null} onChange={onChange} />);
    await userEvent.click(box());
    await userEvent.paste('$1,234.56 ');
    expect(box()).toHaveValue('1234.56');
    expect(onChange).toHaveBeenLastCalledWith(1234.56);
  });

  it('reports an emptied box as null', async () => {
    const onChange = vi.fn();
    render(<Harness start={40} onChange={onChange} />);
    await userEvent.clear(box());
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(box()).toHaveValue('');
  });

  it('follows a value changed from outside while not focused', async () => {
    render(<Harness start={10} />);
    await act(async () => screen.getByRole('button', { name: 'outside' }).click());
    expect(box()).toHaveValue('2,500.00');
  });

  describe('a value given with more places than it shows', () => {
    // A sum of floats: 1880.91 − (600.10 + 250.20 + 0.30) is 1030.3100000000002. The box shows
    // 1,030.31, and a form that sent the value it was given sent what the API refuses.
    it('sends it back at the two decimals it shows', async () => {
      const onChange = vi.fn();
      render(<Harness start={1880.91 - (600.1 + 250.2 + 0.3)} onChange={onChange} />);
      expect(box()).toHaveValue('1,030.31');
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(1030.31);
    });

    it('rounds it as it shows it: 1.005 shows, and is sent, as 1.01', () => {
      // toFixed(2) and Math.round(x * 100) both make 1.005 1.00 (its double is 1.00499…); the
      // box shows 1.01, so that is what it sends.
      const onChange = vi.fn();
      render(<Harness start={1.005} onChange={onChange} />);
      expect(box()).toHaveValue('1.01');
      expect(onChange).toHaveBeenCalledWith(1.01);
    });

    it('sends a price back at the four decimals it shows', () => {
      const onChange = vi.fn();
      render(<Harness start={12.345678} decimals={4} onChange={onChange} />);
      expect(box()).toHaveValue('12.3457');
      expect(onChange).toHaveBeenCalledWith(12.3457);
    });

    it('sends nothing for a value it shows as it is, nor for none', () => {
      const onChange = vi.fn();
      const { unmount } = render(<Harness start={1030.31} onChange={onChange} />);
      expect(box()).toHaveValue('1,030.31');
      unmount();
      render(<Theme><CurrencyInput value={Number.NaN} onChange={onChange} /></Theme>);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  it('keeps what is being typed when the value changes from outside, until focus leaves', async () => {
    render(<Harness start={10} />);
    await userEvent.click(box());
    await userEvent.type(box(), '5');
    expect(box()).toHaveValue('105');
    // A programmatic click leaves focus in the box.
    await act(async () => screen.getByRole('button', { name: 'outside' }).click());
    expect(box()).toHaveFocus();
    expect(box()).toHaveValue('105');
    await userEvent.tab();
    expect(box()).toHaveValue('2,500.00');
  });

  it('reads a European paste by its decimal comma', async () => {
    const onChange = vi.fn();
    render(<Harness start={null} onChange={onChange} />);
    await userEvent.click(box());
    await userEvent.paste('1.234,56');
    expect(onChange).toHaveBeenLastCalledWith(1234.56);
    await userEvent.tab();
    expect(box()).toHaveValue('1,234.56');
    expect(box()).not.toHaveAttribute('aria-invalid');
  });

  it('keeps and flags a paste it cannot read, instead of cutting it to another number', async () => {
    const onChange = vi.fn();
    render(<Harness start={null} onChange={onChange} />);
    await userEvent.click(box());
    await userEvent.paste('12.345');
    expect(onChange).toHaveBeenLastCalledWith(null);
    await userEvent.tab();
    // Still there after leaving the box, marked and explained.
    expect(box()).toHaveValue('12.345');
    expect(box()).toHaveAttribute('aria-invalid', 'true');
    expect(box()).toHaveAccessibleDescription(/not an amount/i);
  });

  it('keeps and flags letters, typed or pasted, instead of dropping them', async () => {
    // A pasted 1e2 was read as 12; typed, the e vanished and the box showed 12.
    const onChange = vi.fn();
    const onUnreadableChange = vi.fn();
    render(<Theme><CurrencyInput value={null} onChange={onChange} onUnreadableChange={onUnreadableChange} /></Theme>);
    await userEvent.click(box());
    await userEvent.paste('1e2');
    // null, and unreadable: its form refuses it rather than read it as empty.
    expect(onChange).toHaveBeenLastCalledWith(null, true);
    expect(onUnreadableChange).toHaveBeenLastCalledWith(true);
    expect(box()).toHaveValue('1e2');
    await userEvent.tab();
    expect(box()).toHaveValue('1e2');
    expect(box()).toHaveAttribute('aria-invalid', 'true');
    expect(box()).toHaveAccessibleDescription(/not an amount/i);

    await userEvent.clear(box());
    await userEvent.type(box(), '1e2');
    expect(box()).toHaveValue('1e2');
    expect(onChange).toHaveBeenLastCalledWith(null, true);
    expect(onUnreadableChange).toHaveBeenLastCalledWith(true);
    // Without the letter it's an amount.
    await userEvent.type(box(), '{Backspace}{Backspace}02');
    expect(box()).toHaveValue('102');
    expect(onChange).toHaveBeenLastCalledWith(102, false);
    await userEvent.clear(box());
    // Empty isn't unreadable.
    expect(onChange).toHaveBeenLastCalledWith(null, false);
    expect(onUnreadableChange).toHaveBeenLastCalledWith(false);
  });

  it('reads a pasted amount with its currency code', async () => {
    const onChange = vi.fn();
    render(<Harness start={null} onChange={onChange} />);
    await userEvent.click(box());
    await userEvent.paste('USD 1,234.56');
    expect(onChange).toHaveBeenLastCalledWith(1234.56);
    expect(box()).toHaveValue('1234.56');
  });

  describe('with 4 decimals, for a price', () => {
    it('takes a price to four decimal places, and shows it so', async () => {
      const onChange = vi.fn();
      render(<Harness start={null} onChange={onChange} decimals={4} />);
      await userEvent.click(box());
      await userEvent.type(box(), '1234.5678');
      expect(onChange).toHaveBeenLastCalledWith(1234.5678);
      expect(box()).not.toHaveAttribute('aria-invalid');
      await userEvent.tab();
      expect(box()).toHaveValue('1,234.5678');
      await userEvent.click(box());
      expect(box()).toHaveValue('1234.5678');
    });

    it('reads a European price by its decimal comma', async () => {
      const onChange = vi.fn();
      render(<Harness start={null} onChange={onChange} decimals={4} />);
      await userEvent.click(box());
      await userEvent.paste('1.234,5678');
      expect(onChange).toHaveBeenLastCalledWith(1234.5678);
      await userEvent.tab();
      expect(box()).toHaveValue('1,234.5678');
    });

    it('flags a price that could be read two ways, and says how to write it', async () => {
      const onChange = vi.fn();
      render(<Harness start={null} onChange={onChange} decimals={4} />);
      await userEvent.click(box());
      await userEvent.type(box(), '1.234');
      expect(onChange).toHaveBeenLastCalledWith(null);
      expect(box()).toHaveAttribute('aria-invalid', 'true');
      expect(box()).toHaveAccessibleDescription(/at most four decimals.*1\.2340/i);
      await userEvent.type(box(), '0');
      expect(onChange).toHaveBeenLastCalledWith(1.234);
      expect(box()).not.toHaveAttribute('aria-invalid');
    });

    it('edits a three-decimal value as text it reads back the same', async () => {
      // String(1.234) is "1.234", which it refuses: focused, the box shows 1.2340.
      const onChange = vi.fn();
      render(<Harness start={1.234} onChange={onChange} decimals={4} />);
      expect(box()).toHaveValue('1.234');
      await userEvent.click(box());
      expect(box()).toHaveValue('1.2340');
      expect(box()).not.toHaveAttribute('aria-invalid');
      await userEvent.tab();
      expect(box()).toHaveValue('1.234');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('keeps two decimals by default', async () => {
      const onChange = vi.fn();
      render(<Harness start={null} onChange={onChange} />);
      await userEvent.click(box());
      await userEvent.type(box(), '12.3456');
      expect(onChange).toHaveBeenLastCalledWith(null);
      expect(box()).toHaveAccessibleDescription(/at most two decimals/i);
    });
  });

  it("keeps a dollar prefix's $ as it is typed, and reads a typed minus sign", async () => {
    const onChange = vi.fn();
    render(<Theme><CurrencyInput value={null} onChange={onChange} allowNegative /></Theme>);
    await userEvent.click(box());
    await userEvent.type(box(), 'US$12');
    expect(box()).toHaveValue('US$12');
    expect(onChange).toHaveBeenLastCalledWith(12, false);
    await userEvent.clear(box());
    await userEvent.type(box(), '$\u22125');
    expect(box()).toHaveValue('-5');
    expect(onChange).toHaveBeenLastCalledWith(-5, false);
  });

  // A refused box was described by the form's message and its own, nearly the
  // same; a caller whose message says why asks for its own hint to stay out (hideOwnHint).
  it('leaves its own hint out while the form shows an error for it, when asked to', async () => {
    const box = (props: { hideOwnHint?: boolean; refused?: boolean }) => (
      <Theme>
        <p id="amount-error">Form message.</p>
        <CurrencyInput
          id="amount"
          aria-label="Amount"
          value={null}
          onChange={vi.fn()}
          {...(props.hideOwnHint ? { hideOwnHint: true } : {})}
          {...(props.refused ? { 'aria-invalid': true, 'aria-describedby': 'amount-error' } : {})}
        />
      </Theme>
    );
    const { rerender } = render(box({ hideOwnHint: true }));
    const amount = screen.getByRole('textbox', { name: 'Amount' });
    await userEvent.type(amount, '15o');
    // No error from the form yet: the box explains itself.
    expect(amount).toHaveAccessibleDescription('Not an amount: enter it like 1,234.56 or 1.234,56, with at most two decimals.');
    rerender(box({ hideOwnHint: true, refused: true }));
    expect(amount).toHaveAccessibleDescription('Form message.');
    expect(screen.queryByText('Not an amount: enter it like 1,234.56 or 1.234,56, with at most two decimals.')).not.toBeInTheDocument();
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    // Not asked (a required field's "Enter the amount." doesn't say why): both stay.
    rerender(box({ refused: true }));
    expect(amount).toHaveAccessibleDescription('Form message. Not an amount: enter it like 1,234.56 or 1.234,56, with at most two decimals.');
    // That it takes no negative is the box's to say: that stays, asked or not.
    rerender(box({ hideOwnHint: true, refused: true }));
    await userEvent.clear(amount);
    await userEvent.type(amount, '-15');
    expect(amount).toHaveAccessibleDescription("Form message. This can't be negative: enter the amount without a minus sign or parentheses.");
  });

  it('takes aria-invalid and aria-describedby from its form', () => {
    render(
      <Theme>
        <p id="amount-error">Enter the amount.</p>
        <CurrencyInput id="amount" aria-label="Amount" value={null} onChange={vi.fn()} aria-invalid aria-describedby="amount-error" />
      </Theme>,
    );
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveAccessibleDescription('Enter the amount.');
  });
});
