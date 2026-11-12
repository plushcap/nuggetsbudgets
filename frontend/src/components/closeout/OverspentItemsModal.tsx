import React from 'react';
import { Dialog, Flex, Text, Grid, Box } from '@radix-ui/themes';
import { TrendingDown } from 'lucide-react';
import { BudgetPeriodItem } from '../../services/api';
import { getIconByName } from '../../utils/iconCatalog';
import { formatCurrency } from '../../utils/currency';

interface OverspentItemsModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  items: BudgetPeriodItem[];
}

const num = (value: unknown): number => parseFloat(String(value)) || 0;

const OverspentItemsModal: React.FC<OverspentItemsModalProps> = ({
  open,
  onClose,
  title,
  items,
}) => {
  // Most-overspent first (most negative remaining at the top).
  const sorted = [...items].sort(
    (a, b) => num(a.calculated_remaining) - num(b.calculated_remaining)
  );

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Content maxWidth="520px" maxHeight="85vh">
        <Dialog.Title>
          <Flex align="center" gap="2">
            <TrendingDown size={20} className="text-[var(--red-11)]" />
            {title}
          </Flex>
        </Dialog.Title>

        <Dialog.Description size="2" mb="4" className="text-[var(--gray-11)]">
          {sorted.length} item{sorted.length !== 1 ? 's' : ''} over budget this period.
        </Dialog.Description>

        {sorted.length === 0 ? (
          <Text size="2" className="text-[var(--gray-11)]">No overspent items.</Text>
        ) : (
          <Flex direction="column" gap="2">
            {sorted.map((item) => {
              const iconOption = getIconByName(item.icon);
              const IconComponent = iconOption?.component;
              return (
                <Flex
                  key={item.uuid}
                  direction={{ initial: 'column', xs: 'row' }}
                  align={{ initial: 'start', xs: 'center' }}
                  justify="between"
                  gap="2"
                  p="3" className="bg-[var(--gray-2)] rounded-[var(--radius-4)]"
                >
                  <Flex align="center" gap="3" minWidth="0px" width="100%">
                    {IconComponent && (
                      <IconComponent size={20} className="shrink-0 text-[var(--gray-11)]" />
                    )}
                    <Text
                      as="div"
                      size="2"
                      weight="medium"
                      truncate
                      className="min-w-0 text-[var(--gray-12)]"
                    >
                      {item.budget_item_name}
                    </Text>
                  </Flex>

                  <Grid columns="3" gap="4" flexShrink="0">
                    <Box className="text-right">
                      <Text as="div" size="1" className="text-[var(--gray-11)]">Budget</Text>
                      <Text as="div" size="2" weight="medium" className="text-[var(--gray-12)]">
                        {formatCurrency(num(item.calculated_budget))}
                      </Text>
                    </Box>
                    <Box className="text-right">
                      <Text as="div" size="1" className="text-[var(--gray-11)]">Actual</Text>
                      <Text as="div" size="2" weight="medium" className="text-[var(--gray-12)]">
                        {formatCurrency(num(item.calculated_actual))}
                      </Text>
                    </Box>
                    <Box className="text-right">
                      <Text as="div" size="1" className="text-[var(--gray-11)]">Remaining</Text>
                      <Text as="div" size="2" weight="bold" color="red">
                        {formatCurrency(num(item.calculated_remaining))}
                      </Text>
                    </Box>
                  </Grid>
                </Flex>
              );
            })}
          </Flex>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default OverspentItemsModal;
