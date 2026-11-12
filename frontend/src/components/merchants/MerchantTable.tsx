import React from 'react';
import { Link } from 'react-router-dom';
import { Flex, IconButton, Table, Text } from '@radix-ui/themes';
import { Edit3, Merge, Settings, Trash2 } from 'lucide-react';
import type { Merchant } from '../../services/api';
import { rowClick } from '../StretchedLink';
import MerchantThumbnail from './MerchantThumbnail';

interface MerchantTableProps {
  merchants: Merchant[];
  /** A merchant's page: its name cell's link, and where a click on its row goes. */
  viewPath: (merchant: Merchant) => string;
  onOpen: (merchant: Merchant) => void;
  onEdit: (merchant: Merchant) => void;
  onManageRules: (merchant: Merchant) => void;
  onDelete: (merchant: Merchant) => void;
  onMerge: (merchant: Merchant) => void;
}

/**
 * The desktop merchant list. A row's name is a link (the keyboard's way in); a click
 * elsewhere on the row follows it too, unless it lands on one of the row's buttons.
 */
const MerchantTable: React.FC<MerchantTableProps> = ({
  merchants,
  viewPath,
  onOpen,
  onEdit,
  onManageRules,
  onDelete,
  onMerge,
}) => (
  <Table.Root variant="surface">
    <Table.Header>
      <Table.Row>
        <Table.ColumnHeaderCell>Image</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell>Merchant</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell>Transactions</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell>Rules</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell align="right">Actions</Table.ColumnHeaderCell>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {merchants.map((merchant) => (
        <Table.Row key={merchant.id} className="cursor-pointer row-hover" onClick={rowClick(() => onOpen(merchant))}>
          <Table.Cell>
            <MerchantThumbnail merchant={merchant} look="row" />
          </Table.Cell>
          <Table.Cell>
            <Text weight="medium" color="gray" highContrast asChild>
              <Link to={viewPath(merchant)} className="hover:underline">
                {merchant.name}
              </Link>
            </Text>
          </Table.Cell>
          <Table.Cell>
            <Text color="gray" highContrast>
              {merchant.transaction_count || 0}
            </Text>
          </Table.Cell>
          <Table.Cell>
            <Text color="gray" highContrast>
              {merchant.rule_count || 0}
            </Text>
          </Table.Cell>
          <Table.Cell align="right">
            <Flex gap="1" justify="end">
              <IconButton
                size="2"
                variant="ghost"
                color="red"
                onClick={(e) => { e.stopPropagation(); onDelete(merchant); }}
                aria-label={`Delete merchant ${merchant.name}`}
                title="Delete"
              >
                <Trash2 size={16} />
              </IconButton>
              <IconButton
                size="2"
                variant="ghost"
                color="orange"
                onClick={(e) => { e.stopPropagation(); onMerge(merchant); }}
                aria-label={`Merge merchant ${merchant.name}`}
                title="Merge"
              >
                <Merge size={16} />
              </IconButton>
              <IconButton
                size="2"
                variant="ghost"
                color="gray"
                onClick={(e) => { e.stopPropagation(); onManageRules(merchant); }}
                aria-label={`Manage rules ${merchant.name}`}
                title="Rules"
              >
                <Settings size={16} />
              </IconButton>
              <IconButton
                size="2"
                variant="ghost"
                color="blue"
                onClick={(e) => { e.stopPropagation(); onEdit(merchant); }}
                aria-label={`Edit merchant ${merchant.name}`}
                title="Edit"
              >
                <Edit3 size={16} />
              </IconButton>
            </Flex>
          </Table.Cell>
        </Table.Row>
      ))}
    </Table.Body>
  </Table.Root>
);

export default MerchantTable;
