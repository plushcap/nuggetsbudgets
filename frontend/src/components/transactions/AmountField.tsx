import React from 'react';
import { Badge, Box, Text } from '@radix-ui/themes';
import { formatMoney } from '@nuggets/shared';
import CurrencyInput from '../CurrencyInput';
import FieldError, { fieldErrorProps } from '../forms/FieldError';
import { textColorProps } from '../../utils/textColor';
import { FieldCaption, FieldStatus, ReadOnlyValue, type FieldSaveStatus } from './TransactionFieldParts';

/** The amount box's id: Save Changes focuses it when its text isn't an amount. */
export const AMOUNT_FIELD_ID = 'transaction-amount';

interface AmountFieldProps {
  editing: boolean;
  status: FieldSaveStatus;
  /** A split parent's amount is its splits' sum: it changes only by unsplitting. */
  isSplitParent: boolean;
  /** The amount the form holds (0 while the box is empty). */
  value: number;
  onChange: (parsed: number | null, unreadable: boolean) => void;
  /** Why Save Changes was refused beside the box, if it was. */
  problem: string | null;
  /** The transaction's saved amount, shown while it isn't edited. */
  savedAmount: number;
}

/** The transaction's amount, pre-signed: an expense negative. */
export const AmountField: React.FC<AmountFieldProps> = ({ editing, status, isSplitParent, value, onChange, problem, savedAmount }) => (
  <Box>
    <FieldCaption htmlFor={editing && !isSplitParent ? AMOUNT_FIELD_ID : undefined}>
      Amount
      <FieldStatus {...status} />
      {isSplitParent && (
        <Badge color="gray" size="1" ml="2">
          Sum of splits
        </Badge>
      )}
    </FieldCaption>
    {editing && !isSplitParent ? (
      <>
        <CurrencyInput
          id={AMOUNT_FIELD_ID}
          size="3"
          value={value === 0 ? null : value}
          onChange={onChange}
          allowNegative
          hideOwnHint
          {...fieldErrorProps(AMOUNT_FIELD_ID, problem)}
        />
        <FieldError fieldId={AMOUNT_FIELD_ID} message={problem} />
      </>
    ) : (
      <ReadOnlyValue>
        <Text size="4" weight="bold" {...textColorProps(savedAmount >= 0 ? 'green' : 'red')}>
          {formatMoney(savedAmount)}
        </Text>
        {isSplitParent && editing && (
          <Text as="div" size="1" color="gray" mt="1">
            To change amount, unsplit first
          </Text>
        )}
      </ReadOnlyValue>
    )}
  </Box>
);
