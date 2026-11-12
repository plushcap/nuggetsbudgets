import React, { useRef } from 'react';
import { Button, type ButtonProps } from '@radix-ui/themes';

interface FilePickerButtonProps {
  /** The file types the chooser offers (the input's `accept`). */
  accept: string;
  /** Called with the files picked: one, unless `multiple`. */
  onFiles: (files: File[]) => void;
  /** Lets several files be picked at once. */
  multiple?: boolean;
  /** The button's id (a `<label htmlFor>` elsewhere doesn't name it: its text does). */
  id?: string;
  /** The ids of the field's hint and error (fieldErrorDescribedBy). */
  'aria-describedby'?: string | undefined;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  color?: ButtonProps['color'];
  /** The button's text (and icon): its name. */
  children: React.ReactNode;
}

/**
 * A button that opens the browser's file chooser. The app's one file input: it stays out
 * of sight and out of the tab order (a label around a hidden input is mouse-only, and a raw
 * input can't take the theme), and the button is the control people reach, named by its text
 * and described by the field's hint and error. The input is emptied after each pick, so the same
 * file picked again (after a refusal, or a removal) is read again.
 */
const FilePickerButton: React.FC<FilePickerButtonProps> = ({
  accept,
  onFiles,
  multiple = false,
  id,
  'aria-describedby': describedBy,
  disabled,
  loading,
  size,
  variant = 'soft',
  color,
  children,
}) => {
  const input = useRef<HTMLInputElement>(null);
  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) onFiles(files);
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={picked}
        hidden
        tabIndex={-1}
        aria-hidden="true"
      />
      <Button
        type="button"
        id={id}
        variant={variant}
        {...(size ? { size } : {})}
        {...(color ? { color } : {})}
        disabled={disabled ?? false}
        loading={loading ?? false}
        aria-describedby={describedBy}
        onClick={() => input.current?.click()}
      >
        {children}
      </Button>
    </>
  );
};

export default FilePickerButton;
