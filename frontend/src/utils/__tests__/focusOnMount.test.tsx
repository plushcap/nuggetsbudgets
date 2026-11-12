import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TextField, Theme } from '@radix-ui/themes';
import { focusOnMount } from '../focusOnMount';

/** An amount shown as a button that turns into a field when pressed. */
const InlineEdit = ({ hint }: { hint: string }) => {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('10');
  return (
    <>
      {editing ? (
        <input aria-label="Amount" ref={focusOnMount} value={value} onChange={(e) => setValue(e.target.value)} />
      ) : (
        <button type="button" onClick={() => setEditing(true)}>
          {value}
        </button>
      )}
      <button type="button">{hint}</button>
    </>
  );
};

describe('focusOnMount', () => {
  it('moves focus into the field that replaces the pressed control', async () => {
    render(<InlineEdit hint="Elsewhere" />);
    await userEvent.click(screen.getByRole('button', { name: '10' }));
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveFocus();
  });

  it('focuses only on mount, not on later renders', async () => {
    const { rerender } = render(<InlineEdit hint="Elsewhere" />);
    await userEvent.click(screen.getByRole('button', { name: '10' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Amount' }), '5');
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('105');

    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    rerender(<InlineEdit hint="Still elsewhere" />);
    expect(screen.getByRole('button', { name: 'Still elsewhere' })).toHaveFocus();
  });

  it("focuses once through a Radix TextField, whose ref changes on every render", () => {
    const Field = ({ value }: { value: string }) => (
      <Theme>
        <TextField.Root aria-label="Budget" ref={focusOnMount} value={value} onChange={() => {}} />
        <button type="button">Elsewhere</button>
      </Theme>
    );
    const { rerender } = render(<Field value="1" />);
    expect(screen.getByRole('textbox', { name: 'Budget' })).toHaveFocus();

    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    rerender(<Field value="2" />);
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
  });
});
