import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { Select, Theme } from '@radix-ui/themes';
import FormSelectRoot from '../FormSelectRoot';

/**
 * Inside a <form>, Radix Select keeps a hidden native <select>. A controlled value
 * that changes after mount, before its <option> is registered, reads back as '' from that
 * select. Up to radix-ui 1.7.0 (@radix-ui/react-select 2.3.8) Radix synced the value with a
 * bubbling `change`, so its own onChange reported that '' through onValueChange. Since
 * radix-ui 1.8.0 (react-select 2.4.0) a programmatic sync doesn't bubble, so React never
 * calls that onChange. FormSelectRoot stays as a guard against any '' Radix reports.
 */
type Root = typeof Select.Root;

function Harness({ Root, onValueChange }: { Root: Root; onValueChange: (value: string) => void }) {
  const [value, setValue] = useState('a');
  const [options, setOptions] = useState(['a']);
  return (
    <Theme>
      <form>
        {/* What Radix reports goes back into the value, as a react-hook-form Controller does. */}
        <Root
          value={value}
          onValueChange={(next) => {
            onValueChange(next);
            setValue(next);
          }}
        >
          <Select.Trigger aria-label="Pick" />
          <Select.Content>
            {options.map((option) => (
              <Select.Item key={option} value={option}>{`Option ${option}`}</Select.Item>
            ))}
          </Select.Content>
        </Root>
      </form>
      {/* The value moves to 'b' a render before its option exists, as a form reset
          ahead of a loading option list does. */}
      <button type="button" onClick={() => setValue('b')}>set b</button>
      <button type="button" onClick={() => setOptions(['a', 'b'])}>add b</button>
    </Theme>
  );
}

const trigger = () => screen.getByRole('combobox', { name: 'Pick' });
const hiddenSelect = () => document.querySelector('select') as HTMLSelectElement;

const moveToUnregisteredValue = async () => {
  await act(async () => screen.getByRole('button', { name: 'set b' }).click());
  await act(async () => screen.getByRole('button', { name: 'add b' }).click());
};

/** The hidden select reads back '' (no option holds the value) and a change bubbles from
 *  it: what Radix up to 1.7.0 dispatched itself for a value set before its option, and what an autofill or
 *  script writing a value with no option still does. */
const bubbleEmptyFromHiddenSelect = async () => {
  await act(async () => {
    const native = hiddenSelect();
    native.value = 'not-an-option';
    native.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

// Every `change` dispatched on the hidden select, and the value it read back then. A
// capture listener sees one whether or not it bubbles.
let nativeChanges: string[] = [];
const recordNativeChange = (event: Event) => {
  if (event.target instanceof HTMLSelectElement) nativeChanges.push(event.target.value);
};
const recordNativeChanges = () => {
  nativeChanges = [];
  document.addEventListener('change', recordNativeChange, true);
};
afterEach(() => document.removeEventListener('change', recordNativeChange, true));

describe('FormSelectRoot', () => {
  it('Radix Select no longer reports an empty value for a value whose option is not registered yet (radix-ui 1.8.0+)', async () => {
    const onValueChange = vi.fn();
    render(<Harness Root={Select.Root} onValueChange={onValueChange} />);
    recordNativeChanges();
    await moveToUnregisteredValue();
    // The case still happens: Radix writes 'b' into its hidden select before the
    // option exists, and the select reads it back as ''.
    expect(nativeChanges).toContain('');
    // Radix no longer passes that '' on. If this fails with a call of '', the bug is back
    // (radix-ui up to 1.7.0), and FormSelectRoot is what keeps the forms working.
    expect(onValueChange).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger()).toHaveTextContent('Option b'));
  });

  it('keeps the value through that case, and the trigger shows it once its option exists', async () => {
    // End to end, not the wrapper: since radix-ui 1.8.0 Radix reports nothing here (test 1),
    // so this passes with or without the guard. The next two tests show the guard working.
    const onValueChange = vi.fn();
    render(<Harness Root={FormSelectRoot} onValueChange={onValueChange} />);
    await moveToUnregisteredValue();
    expect(onValueChange).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger()).toHaveTextContent('Option b'));
  });

  it('without the wrapper, Radix still reports the empty value a bubbling change reads back', async () => {
    // The control for the next test: this path still reaches onValueChange with ''.
    const onValueChange = vi.fn();
    render(<Harness Root={Select.Root} onValueChange={onValueChange} />);
    await bubbleEmptyFromHiddenSelect();
    expect(onValueChange).toHaveBeenCalledWith('');
    expect(trigger()).not.toHaveTextContent('Option a');
  });

  it('drops that empty value, and the field keeps its value', async () => {
    const onValueChange = vi.fn();
    render(<Harness Root={FormSelectRoot} onValueChange={onValueChange} />);
    await bubbleEmptyFromHiddenSelect();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveTextContent('Option a');
  });

  it('passes a real choice through', async () => {
    const onValueChange = vi.fn();
    render(<Harness Root={FormSelectRoot} onValueChange={onValueChange} />);
    await act(async () => screen.getByRole('button', { name: 'add b' }).click());
    // The hidden native select (remounted when its options change) is how a form's
    // autofill reaches Radix; a real choice through it must still arrive.
    const native = hiddenSelect();
    await act(async () => {
      native.value = 'b';
      native.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onValueChange).toHaveBeenCalledWith('b');
    expect(trigger()).toHaveTextContent('Option b');
  });
});
