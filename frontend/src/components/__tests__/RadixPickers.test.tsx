import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import RadixDatePicker from '../RadixDatePicker';
import { RadixIconPicker } from '../RadixIconPicker';
import { RadixColorPicker } from '../RadixColorPicker';
import FieldError, { fieldErrorDescribedBy } from '../forms/FieldError';
import { focusFirstError } from '../../utils/focusFirstError';

// The date picker took no id, so a form focused a refused date through a Box around it;
// the icon and colour pickers took no aria-describedby, so their messages weren't read with them.
describe('the custom pickers, tied to their field', () => {
  it('gives the date picker’s button the id it is given, which a refused submit focuses', () => {
    render(
      <Theme>
        <span id="due-label">Due date</span>
        <RadixDatePicker id="bill-due" aria-labelledby="due-label" value="2026-10-15" onChange={vi.fn()} />
      </Theme>,
    );
    const button = screen.getByRole('button', { name: /^Due date/ });
    expect(button).toHaveAttribute('id', 'bill-due');
    // Named by its label, then by the date it shows (its own id).
    expect(button).toHaveAttribute('aria-labelledby', 'due-label bill-due');
    expect(button).toHaveAccessibleName('Due date October 15th, 2026');

    focusFirstError({ due: { type: 'required', message: 'Choose a date.' } }, [['due', '#bill-due']]);
    expect(button).toHaveFocus();
  });

  it('makes its own id without one', () => {
    render(
      <Theme>
        <span id="from-label">From</span>
        <RadixDatePicker aria-labelledby="from-label" onChange={vi.fn()} />
      </Theme>,
    );
    const button = screen.getByRole('button', { name: /^From/ });
    expect(button.id).not.toBe('');
    expect(button).toHaveAttribute('aria-labelledby', `from-label ${button.id}`);
  });

  it.each([
    ['icon', (describedBy: string | undefined) => <RadixIconPicker value="User" onChange={vi.fn()} label="Profile Icon" aria-describedby={describedBy} />, /^Profile Icon/],
    ['colour', (describedBy: string | undefined) => <RadixColorPicker value="#3B82F6" onChange={vi.fn()} label="Profile Color" aria-describedby={describedBy} />, /^Profile Color/],
  ] as const)('reads the %s picker’s message after its name, and nothing without one', (_kind, picker, name) => {
    const { rerender } = render(
      <Theme>
        {picker(fieldErrorDescribedBy('profile-field', 'Give the colour as #RRGGBB'))}
        <FieldError fieldId="profile-field" message="Give the colour as #RRGGBB" />
      </Theme>,
    );
    expect(screen.getByRole('button', { name })).toHaveAccessibleDescription('Give the colour as #RRGGBB');

    rerender(<Theme>{picker(fieldErrorDescribedBy('profile-field', undefined))}</Theme>);
    expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-describedby');
  });
});
