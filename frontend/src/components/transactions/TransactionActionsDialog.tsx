import React, { useId } from 'react';
import { Box, Button, Dialog, Flex, IconButton, Separator, Text, VisuallyHidden } from '@radix-ui/themes';
import { Check, ChevronRight, Edit, Tag as TagIcon, X as CloseIcon } from 'lucide-react';
import type { BudgetItem, BudgetPeriod, Tag, Transaction, User } from '../../services/api';
import type { TransactionQuickActions } from '../../hooks/useTransactionQuickActions';
import type { TransactionActionsSheet } from '../../hooks/useTransactionActionsSheet';
import { formatCurrency } from '../../utils/currency';
import { DateUtils } from '../../utils/dateUtils';
import { textColorProps } from '../../utils/textColor';
import RadixBudgetItemSelector from '../RadixBudgetItemSelector';
import TagSelector from '../TagSelector';
import { amountColor, latestBudgetPeriods, payeeOf } from './transactionRows';
import { PersonInitials } from './TransactionCells';
import { transactionReviewStatus } from '@nuggets/shared';
import { personInitials, personName } from '../../utils/personName';

interface TransactionActionsDialogProps {
  sheet: TransactionActionsSheet;
  actions: TransactionQuickActions;
  budgetPeriods: BudgetPeriod[];
  budgetItems: BudgetItem[];
  users: User[];
  /** The tags that may be applied (the active ones). */
  tags: Tag[];
  /** Opens the transaction (the page's onTransactionClick). */
  onEdit: (transaction: Transaction) => void;
}

const BACK_ICON = <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />;

/** A submenu's way back to the main list. */
const BackButton: React.FC<{ onClick: () => void; gap: '1' | '2'; spaced?: boolean }> = ({ onClick, gap, spaced = false }) => (
  <Button
    variant="ghost"
    size="2"
    onClick={onClick}
    // Inline, not mb="2": a ghost Button's margin props are offset by its ghost padding (mb="2" is 4px).
    style={{ justifyContent: 'flex-start', ...(spaced ? { marginBottom: '8px' } : {}) }}
  >
    <Flex align="center" gap={gap}>
      {BACK_ICON}
      <Text size="2" weight="bold">Back</Text>
    </Flex>
  </Button>
);

/** A submenu button that opens one of the sheet's lists or pickers. */
const SubmenuButton: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <Button variant="soft" size="3" onClick={onClick} style={{ justifyContent: 'space-between' }}>
    {children}
    <ChevronRight size={16} />
  </Button>
);

/** A choice in a submenu's list, the last one (which clears the field) included; the others take mb="2". */
const CHOICE_STYLE: React.CSSProperties = { justifyContent: 'flex-start', width: '100%' };

/**
 * The transaction table's quick-actions sheet: the same actions as a desktop row's right-click
 * menu (review, budget period, budget item, assignee, tags) and Edit, for a phone and the
 * keyboard. While a picker is open the on-screen keyboard covers much of the screen, so the
 * header collapses to a single Back row and the sheet pins to the top.
 */
const TransactionActionsDialog: React.FC<TransactionActionsDialogProps> = ({
  sheet,
  actions,
  budgetPeriods,
  budgetItems,
  users,
  tags,
  onEdit,
}) => {
  const pickerLabelId = useId();
  const { transaction, menu, setMenu, runAndClose } = sheet;
  const isPicker = menu === 'budgetItem' || menu === 'applyTag';
  const pickerLabel = menu === 'budgetItem' ? 'Budget Item' : 'Tags';
  const pickerHeader = (
    <Flex align="center" justify="between" mb="2">
      <BackButton onClick={() => setMenu('main')} gap="1" />
      <Text id={pickerLabelId} size="2" weight="bold" color="gray">{pickerLabel}</Text>
    </Flex>
  );

  return (
    <Dialog.Root open={sheet.open} onOpenChange={(open) => !open && sheet.close()}>
      <Dialog.Content
        onCloseAutoFocus={sheet.returnFocus}
        maxWidth="450px"
        maxHeight="90vh"
        // While a picker is open the keyboard covers the lower half of the screen, so pin
        // the dialog to the top (margin-bottom:auto wins over Radix's flex centering) and give
        // it room so the dropdown opens inside the scrollable content instead of being clipped.
        {...(isPicker ? { minHeight: '70vh' } : {})}
        style={isPicker ? { marginTop: 'var(--space-3)', marginBottom: 'auto' } : undefined}
      >
        {isPicker ? (
          // Collapsed header: an accessible title, hidden so the keyboard doesn't push the picker off-screen.
          <VisuallyHidden>
            <Dialog.Title>Transaction Actions</Dialog.Title>
          </VisuallyHidden>
        ) : (
          <>
            <Dialog.Title>
              <Flex justify="between" align="center">
                <Text size="4" weight="bold">Transaction Actions</Text>
                <IconButton variant="ghost" color="gray" onClick={sheet.close} aria-label="Close">
                  <CloseIcon size={16} />
                </IconButton>
              </Flex>
            </Dialog.Title>
            <Dialog.Description size="2" mb="4">
              Choose an action for this transaction
            </Dialog.Description>
          </>
        )}

        {transaction && (
          <>
            {/* The transaction, hidden while picking to free vertical space */}
            {!isPicker && (
              <>
                <Flex direction="column" gap="2" mb="4" pt="3">
                  <Text size="3" weight="bold">{payeeOf(transaction)}</Text>
                  <Flex gap="4">
                    <Text size="2" color="gray">
                      {DateUtils.formatDateUS(transaction.transaction_date)}
                    </Text>
                    <Text size="2" weight="bold" {...textColorProps(amountColor(transaction.amount))}>
                      {formatCurrency(transaction.amount)}
                    </Text>
                  </Flex>
                </Flex>
                <Separator size="4" mb="3" />
              </>
            )}

            {menu === 'main' && (
              <Flex direction="column" gap="2">
                <Button
                  variant="soft"
                  size="3"
                  onClick={() => runAndClose(() => actions.toggleReviewed(transaction))}
                  style={{ justifyContent: 'flex-start' }}
                >
                  <Flex align="center" gap="2" width="100%">
                    <Check size={16} />
                    <Text>
                      {transaction.review_status === transactionReviewStatus.enum.reviewed ? 'Mark as Needs Review' : 'Mark as Reviewed'}
                    </Text>
                  </Flex>
                </Button>

                {budgetPeriods.length > 0 && (
                  <SubmenuButton onClick={() => setMenu('budgetPeriod')}>
                    <Text>Budget Period</Text>
                  </SubmenuButton>
                )}
                {budgetItems.length > 0 && (
                  <SubmenuButton onClick={() => setMenu('budgetItem')}>
                    <Text>Budget Item</Text>
                  </SubmenuButton>
                )}
                {users.length > 0 && (
                  <SubmenuButton onClick={() => setMenu('assignUser')}>
                    <Text>Assign To</Text>
                  </SubmenuButton>
                )}
                {tags.length > 0 && (
                  <SubmenuButton onClick={() => setMenu('applyTag')}>
                    <Flex align="center" gap="2">
                      <TagIcon size={16} />
                      <Text>Tags</Text>
                    </Flex>
                  </SubmenuButton>
                )}

                <Button
                  variant="soft"
                  size="3"
                  onClick={() => {
                    onEdit(transaction);
                    sheet.close();
                  }}
                  style={{ justifyContent: 'flex-start' }}
                >
                  <Flex align="center" gap="2">
                    <Edit size={16} />
                    <Text>Edit Transaction</Text>
                  </Flex>
                </Button>
              </Flex>
            )}

            {menu === 'budgetPeriod' && (
              <Flex direction="column" gap="2">
                <BackButton onClick={() => setMenu('main')} gap="2" spaced />
                <Box maxHeight="300px" overflowY="auto">
                  {latestBudgetPeriods(budgetPeriods).map((period) => (
                    <Button
                      key={period.id}
                      variant="soft"
                      size="3"
                      onClick={() => runAndClose(() => actions.changeBudgetPeriod(transaction, period.id))}
                      mb="2"
                      style={CHOICE_STYLE}
                    >
                      {period.name}
                    </Button>
                  ))}
                  <Separator size="4" my="2" />
                  <Button
                    variant="outline"
                    size="3"
                    color="gray"
                    onClick={() => runAndClose(() => actions.changeBudgetPeriod(transaction, null))}
                    style={CHOICE_STYLE}
                  >
                    Clear Budget Period
                  </Button>
                </Box>
              </Flex>
            )}

            {menu === 'budgetItem' && (
              <Flex direction="column" gap="2">
                {pickerHeader}
                {/* The searchable picker the transaction page uses */}
                <RadixBudgetItemSelector
                  aria-labelledby={pickerLabelId}
                  value={transaction.budget_item_id ?? null}
                  onChange={(value) => runAndClose(() => actions.changeBudgetItem(transaction, value))}
                  budgetItems={budgetItems}
                  placeholder="Select a budget item..."
                  defaultOpen
                  keyboardAware
                />
              </Flex>
            )}

            {menu === 'assignUser' && (
              <Flex direction="column" gap="2">
                <BackButton onClick={() => setMenu('main')} gap="2" spaced />
                <Box maxHeight="300px" overflowY="auto">
                  {users.map((user) => (
                    <Button
                      key={user.id}
                      variant="soft"
                      size="3"
                      onClick={() => runAndClose(() => actions.assignUser(transaction, user.id))}
                      mb="2"
                      style={CHOICE_STYLE}
                    >
                      <Flex align="center" gap="2">
                        <PersonInitials user={user}>{personInitials(user)}</PersonInitials>
                        <Text>{personName(user)}</Text>
                      </Flex>
                    </Button>
                  ))}
                  <Separator size="4" my="2" />
                  <Button
                    variant="outline"
                    size="3"
                    color="gray"
                    onClick={() => runAndClose(() => actions.assignUser(transaction, null))}
                    style={CHOICE_STYLE}
                  >
                    Unassign
                  </Button>
                </Box>
              </Flex>
            )}

            {menu === 'applyTag' && (
              <Flex direction="column" gap="2">
                {pickerHeader}
                {/* The searchable multi-select tag picker the transaction page uses: the current tags, added or removed */}
                <TagSelector
                  aria-labelledby={pickerLabelId}
                  selectedTags={sheet.tags}
                  tags={tags}
                  onChange={sheet.changeTags}
                  placeholder="Search tags..."
                  defaultOpen
                  keyboardAware
                />
              </Flex>
            )}
          </>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default TransactionActionsDialog;
