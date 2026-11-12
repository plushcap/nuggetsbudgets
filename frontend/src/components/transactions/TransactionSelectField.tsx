import React from 'react';
import { Box, Select } from '@radix-ui/themes';
import { FieldCaption, FieldStatus, ReadOnlyValue, type FieldSaveStatus } from './TransactionFieldParts';

export interface SelectFieldOption {
  value: string;
  label: string;
}

interface TransactionSelectFieldProps {
  /** The select's id, which its caption names while it is edited. */
  id: string;
  label: string;
  editing: boolean;
  status: FieldSaveStatus;
  value: string;
  options: readonly SelectFieldOption[];
  /**
   * Show a value that isn't among the options, not a blank: by its label when `labels` names
   * it (Income, left out on a liability account), else as "<value> (legacy value)": a row may
   * keep a type or status from before today's lists, and saves it back.
   */
  keepUnlistedValue?: boolean;
  /** The list's labels, for a value outside the options (keepUnlistedValue). */
  labels?: Readonly<Record<string, string>> | undefined;
  placeholder?: string;
  onChange: (value: string) => void;
  /** What the field shows while it isn't edited. */
  display: React.ReactNode;
}

/** One of the transaction's fields that is picked from a list (type, status, period, …). */
export const TransactionSelectField: React.FC<TransactionSelectFieldProps> = ({
  id,
  label,
  editing,
  status,
  value,
  options,
  keepUnlistedValue = false,
  labels = {},
  placeholder,
  onChange,
  display,
}) => {
  const unlisted = keepUnlistedValue && value !== '' && !options.some((option) => option.value === value);
  // The list's own label (not one an object inherits, like `constructor`).
  const unlistedLabel = Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : `${value} (legacy value)`;
  return (
    <Box>
      <FieldCaption htmlFor={editing ? id : undefined}>
        {label}
        <FieldStatus {...status} />
      </FieldCaption>
      {editing ? (
        <Select.Root value={value} onValueChange={onChange} size="3">
          <Select.Trigger id={id} variant="surface" className="w-full" {...(placeholder === undefined ? {} : { placeholder })} />
          <Select.Content>
            {options.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
            {unlisted && <Select.Item value={value}>{unlistedLabel}</Select.Item>}
          </Select.Content>
        </Select.Root>
      ) : (
        <ReadOnlyValue>{display}</ReadOnlyValue>
      )}
    </Box>
  );
};
