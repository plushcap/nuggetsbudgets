import React from 'react';
import { Controller } from 'react-hook-form';
import { Badge, Box, Card, Flex, Table, Text, TextField } from '@radix-ui/themes';
import { formatMoney, type TaxLot } from '@nuggets/shared';
import FieldError, { fieldErrorProps } from '../forms/FieldError';
import { decimalUnits, unitsText } from '../../utils/decimalText';
import type { SellEventFormData } from '../../types/forms';
import type { CustomFieldProps } from './investmentEventForm';

/** Share counts are kept to 6 decimal places. */
export const SHARE_PLACES = 6;
/** The lots box's id: focused, with its message, when the lots don't add up. */
export const SELL_LOTS_ID = 'sell-lots';
export const lotFieldId = (lotUuid: string) => `sell-lot-${lotUuid}`;

/** What a sale reads besides its own values: the open lots of its account's security (a specific-lots sale's). */
export interface SellLookups {
  openLots: readonly TaxLot[];
}

/**
 * Each open lot's shares as typed, and their sum against the shares sold, added exactly in
 * millionths (a float sum of 0.1 + 0.2 isn't 0.3).
 */
export function lotTally(values: SellEventFormData, openLots: readonly TaxLot[]) {
  const picks = openLots.map((lot) => ({ lot, text: (values.lot_shares[lot.uuid] ?? '').trim() }));
  const pickedUnits = picks.reduce((sum, pick) => sum + (decimalUnits(pick.text, SHARE_PLACES) ?? 0n), 0n);
  const sharesUnits = decimalUnits(values.shares, SHARE_PLACES);
  return { picks, pickedUnits, sharesUnits, lotsAddUp: pickedUnits > 0n && pickedUnits === sharesUnits };
}

const acquired = (lot: TaxLot) => String(lot.acquisition_date).slice(0, 10);

/** A specific-lots sale's lot list: each open lot's basis, per share and in total, and the shares to sell from it. */
export const SellLotsField: React.FC<CustomFieldProps<SellEventFormData, SellLookups>> = ({ control, values, context, shown }) => {
  const { openLots } = context;
  const { pickedUnits, sharesUnits, lotsAddUp } = lotTally(values, openLots);
  return (
    <Card variant="surface">
      <Box id={SELL_LOTS_ID} tabIndex={-1} role="group" aria-labelledby="sell-lots-label" {...fieldErrorProps(SELL_LOTS_ID, shown(SELL_LOTS_ID))}>
        <Flex direction="column" gap="2" p="2">
          <Flex align="center" gap="2">
            <Text id="sell-lots-label" size="2" weight="medium">Select lots</Text>
            <Badge color={lotsAddUp ? 'green' : 'amber'} highContrast variant="soft">
              {unitsText(pickedUnits, SHARE_PLACES)} / {sharesUnits != null ? unitsText(sharesUnits, SHARE_PLACES) : 0} shares
            </Badge>
          </Flex>
          <FieldError fieldId={SELL_LOTS_ID} message={shown(SELL_LOTS_ID)} />
          {openLots.length === 0 ? <Text size="1" color="gray">Pick an account and security to list open lots.</Text> : (
            <Table.Root variant="surface" size="1">
              <Table.Header><Table.Row>
                <Table.ColumnHeaderCell>Acquired</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell align="right">Available</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell align="right">Cost/share</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell align="right">Total basis</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell align="right">Sell qty</Table.ColumnHeaderCell>
              </Table.Row></Table.Header>
              <Table.Body>
                {openLots.map((lot) => {
                  const id = lotFieldId(lot.uuid);
                  return (
                    <Table.Row key={lot.uuid}>
                      <Table.Cell>{acquired(lot)}</Table.Cell>
                      <Table.Cell align="right">{lot.shares_remaining}</Table.Cell>
                      <Table.Cell align="right">{formatMoney(lot.cost_basis_per_share)}</Table.Cell>
                      <Table.Cell align="right">{formatMoney(lot.total_cost_basis)}</Table.Cell>
                      <Table.Cell align="right">
                        <Controller
                          control={control}
                          name={`lot_shares.${lot.uuid}`}
                          render={({ field }) => (
                            <TextField.Root
                              id={id}
                              aria-label={`Sell qty, lot acquired ${acquired(lot)}`}
                              type="number"
                              step="0.000001"
                              min="0"
                              max={String(lot.shares_remaining)}
                              value={field.value ?? ''}
                              onChange={(e) => field.onChange(e.target.value)}
                              onBlur={field.onBlur}
                              style={{ width: 110 }}
                              {...fieldErrorProps(id, shown(id))}
                            />
                          )}
                        />
                        <FieldError fieldId={id} message={shown(id)} />
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          )}
        </Flex>
      </Box>
    </Card>
  );
};

export default SellLotsField;
