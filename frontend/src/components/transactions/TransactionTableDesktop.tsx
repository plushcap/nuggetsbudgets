import React from 'react';
import { Checkbox, Table } from '@radix-ui/themes';
import type { Transaction } from '../../services/api';
import type { TransactionRowViewProps } from './transactionRows';
import TransactionTableRow from './TransactionTableRow';

interface TransactionTableDesktopProps
  extends Omit<TransactionRowViewProps, 'transaction' | 'selected'> {
  transactions: Transaction[];
  selectedTransactions: ReadonlySet<string>;
  onSelectAll?: (() => void) | undefined;
  /** A row's right-click menu. */
  menuFor: (transaction: Transaction) => React.ReactNode;
}

/** The transaction table on a desktop: one row a transaction, its columns as the page asks. */
const TransactionTableDesktop: React.FC<TransactionTableDesktopProps> = ({
  transactions,
  selectedTransactions,
  onSelectAll,
  menuFor,
  ...rowProps
}) => (
  <Table.Root variant="surface">
    <Table.Header>
      <Table.Row>
        {rowProps.showCheckboxes && (
          <Table.ColumnHeaderCell width="40px">
            <Checkbox
              aria-label="Select all transactions"
              checked={selectedTransactions.size === transactions.length && transactions.length > 0}
              onCheckedChange={onSelectAll}
            />
          </Table.ColumnHeaderCell>
        )}
        <Table.ColumnHeaderCell width="40px">Reviewed</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell width="40px">User</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell>Date</Table.ColumnHeaderCell>
        {rowProps.showAccount && <Table.ColumnHeaderCell>Account</Table.ColumnHeaderCell>}
        <Table.ColumnHeaderCell>Payee</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell>Budget Period</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell>Budget Item</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell width="80px">Tags</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell>Amount</Table.ColumnHeaderCell>
        {rowProps.showBalance && <Table.ColumnHeaderCell>Balance</Table.ColumnHeaderCell>}
        <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell width="40px"></Table.ColumnHeaderCell>
      </Table.Row>
    </Table.Header>

    <Table.Body>
      {transactions.map((transaction) => (
        <TransactionTableRow
          key={transaction.id}
          {...rowProps}
          transaction={transaction}
          selected={selectedTransactions.has(transaction.uuid)}
          menu={menuFor(transaction)}
        />
      ))}
    </Table.Body>
  </Table.Root>
);

export default TransactionTableDesktop;
