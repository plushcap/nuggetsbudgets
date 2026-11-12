import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import FilePickerButton from '../FilePickerButton';

/** The app's one file input: a button named by its text, the input out of sight. */
describe('FilePickerButton', () => {
  const input = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;

  it('is a named button, with its input out of the tab order and away from screen readers', () => {
    render(<Theme><FilePickerButton accept="image/*" onFiles={vi.fn()} aria-describedby="hint">Upload Image</FilePickerButton><p id="hint">Max 5MB.</p></Theme>);
    expect(screen.getByRole('button', { name: 'Upload Image' })).toHaveAccessibleDescription('Max 5MB.');
    expect(input()).toHaveAttribute('tabindex', '-1');
    expect(input()).toHaveAttribute('aria-hidden', 'true');
    expect(input().accept).toBe('image/*');
  });

  it('hands over the files picked, several when asked, and empties its input after each pick', async () => {
    const onFiles = vi.fn();
    render(<Theme><FilePickerButton accept=".pdf" multiple onFiles={onFiles}>Upload</FilePickerButton></Theme>);
    const a = new File(['a'], 'a.pdf', { type: 'application/pdf' });
    const b = new File(['b'], 'b.pdf', { type: 'application/pdf' });
    await userEvent.upload(input(), [a, b]);
    expect(onFiles).toHaveBeenLastCalledWith([a, b]);
    // Emptied, so picking the same file again is a change the browser reports.
    expect(input().value).toBe('');
  });

  it('calls nothing for a chooser closed without a file', () => {
    const onFiles = vi.fn();
    render(<Theme><FilePickerButton accept="image/*" onFiles={onFiles}>Upload</FilePickerButton></Theme>);
    fireEvent.change(input(), { target: { files: [] } });
    expect(onFiles).not.toHaveBeenCalled();
  });
});
