import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Box, Card, Flex, Text, Button, TextField, Callout, AlertDialog, Checkbox, Table, ScrollArea } from '@radix-ui/themes';
import { Trash2, TriangleAlert, AlertCircle, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { logger } from '../utils/logger';
import { apiErrorMessage, errorCode, errorMessage } from '../utils/errors';
import { calendarDatePart, formatCalendarDate, todayLocal } from '../utils/dateUtils';
import {
  previewDeleteTransactions,
  deleteTransactions,
  type DeleteTransactionsCriteria,
  type DeleteTransactionsPreview,
} from '../services/api/data-management';
import { invalidateTransactionData } from '../hooks/queries/invalidation';
import { useAuth } from '../contexts/AuthContext';
import PageContainer from '../components/PageContainer';
import { formatMoney } from '@nuggets/shared';

/** What a preview counted: the criteria it sent, and what the server found for them. */
interface Preview {
  criteria: DeleteTransactionsCriteria;
  result: DeleteTransactionsPreview;
}

export default function DataDeletionSettingsPage() {
  const queryClient = useQueryClient();
  // A backup holds every ledger on the server, so only a deployment admin may have one
  // made first, as on the Backup page; the server refuses anyone else's.
  const { isDeploymentAdmin } = useAuth();
  // Form state
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [excludeBudgetPeriod, setExcludeBudgetPeriod] = useState(true);
  const [backupChosen, setCreateBackup] = useState(true);
  const createBackup = isDeploymentAdmin && backupChosen;

  // Preview state. Delete deletes what was previewed, and changing what to delete takes
  // the preview away, so nothing is deleted that wasn't previewed.
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewData = preview?.result ?? null;
  const [previewing, setPreviewing] = useState(false);
  // The server refused a deletion: the range's transactions are no longer the ones the
  // preview found (a bank sync, another member), so it deleted nothing. Its text.
  const [outdated, setOutdated] = useState<string | null>(null);

  // Deletion state
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [confirmationChecked, setConfirmationChecked] = useState(false);

  /** Change what to delete: the preview no longer counts it. */
  const changeCriteria = (change: () => void) => {
    change();
    setPreview(null);
    setOutdated(null);
  };

  /**
   * Validate date range
   */
  const validateDates = (): string | null => {
    if (!dateFrom || !dateTo) {
      return 'Both start and end dates are required';
    }

    // Calendar days, compared as 'YYYY-MM-DD' strings (not UTC instants).
    const fromDate = calendarDatePart(dateFrom);
    const toDate = calendarDatePart(dateTo);
    const today = todayLocal();

    if (!fromDate || !toDate) {
      return 'Invalid date format';
    }

    if (fromDate > toDate) {
      return 'Start date must be before or equal to end date';
    }

    if (fromDate > today || toDate > today) {
      return 'Cannot delete transactions in the future';
    }

    return null;
  };

  /**
   * Handle preview button click
   */
  const handlePreview = async () => {
    const validationError = validateDates();
    if (validationError) {
      toast.error(validationError);
      return;
    }

    try {
      setPreviewing(true);
      setPreview(null);
      setOutdated(null);

      const criteria = { dateFrom, dateTo, excludeBudgetPeriod };
      const result = await previewDeleteTransactions(criteria);

      setPreview({ criteria, result });

      if (result.count === 0) {
        toast('No transactions found in the specified date range', {
          icon: '📭'
        });
      } else {
        toast.success(`Found ${result.count} transaction${result.count !== 1 ? 's' : ''} to delete`);
      }

      logger.info({ count: result.count, dateFrom, dateTo }, 'Preview completed');

    } catch (error) {
      logger.error({ err: error }, 'Failed to preview deletion');
      toast.error('Failed to preview deletion');
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  };

  /**
   * Open confirmation dialog
   */
  const handleDelete = () => {
    if (!previewData || previewData.count === 0) {
      toast.error('Please preview the deletion first');
      return;
    }

    setConfirmationChecked(false);
    setDeleteDialogOpen(true);
  };

  /**
   * Execute actual deletion
   */
  const handleConfirmDelete = async () => {
    if (!confirmationChecked) {
      toast.error('Please confirm you understand this action is permanent');
      return;
    }

    if (!preview?.result.selectionKey) {
      toast.error('Preview data not available');
      return;
    }

    try {
      setDeleting(true);

      // Exactly what was previewed, not what the form says now: its criteria, and the key
      // of the set it found, which the server checks is still the range's.
      const result = await deleteTransactions({ ...preview.criteria, createBackup, selectionKey: preview.result.selectionKey });

      setDeleteDialogOpen(false);
      // Balances, budgets and every total built on the deleted transactions changed.
      invalidateTransactionData(queryClient);

      let successMessage = `Successfully deleted ${result.count} transaction${result.count !== 1 ? 's' : ''}`;
      if (result.backupCreated && result.backupFileName) {
        successMessage += `. Backup saved: ${result.backupFileName}`;
      }

      toast.success(successMessage, { duration: 5000 });

      logger.info({
        deletedCount: result.count,
        affectedAccounts: result.affectedAccounts,
        backupCreated: result.backupCreated,
        backupFileName: result.backupFileName
      }, 'Transactions deleted successfully');

      // Reset form
      setDateFrom('');
      setDateTo('');
      setPreview(null);
      setConfirmationChecked(false);

    } catch (error) {
      logger.error({ err: error }, 'Failed to delete transactions');

      if (errorCode(error) === 'BACKUP_REQUIRES_DEPLOYMENT_ADMIN') {
        // Nothing was deleted: a backup is for deployment admins (no longer one, say).
        toast.error(apiErrorMessage(error, 'Only a deployment admin can create a backup. Nothing was deleted.'), { duration: 6000 });
      } else if (errorCode(error) === 'PREVIEW_OUTDATED') {
        // Nothing was deleted. Its counts are out of date: take them away until a new preview.
        const text = apiErrorMessage(error, 'The transactions in this range have changed since the preview, so nothing was deleted.');
        setDeleteDialogOpen(false);
        setConfirmationChecked(false);
        setPreview(null);
        setOutdated(text);
        toast.error(text, { duration: 6000 });
      } else if (errorCode(error) === 'DELETION_CONFLICT') {
        // Nothing was deleted: another change to these transactions was saved at the same
        // time. The preview and the dialog stay, so Confirm Delete tries again.
        toast.error(apiErrorMessage(error, 'Another change to these transactions was being saved at the same time, so nothing was deleted. Try again.'), { duration: 6000 });
      // Check if error message mentions backup failure
      } else if (errorMessage(error, '').toLowerCase().includes('backup')) {
        toast.error('Backup creation failed. Deletion was blocked for safety.', { duration: 6000 });
      } else {
        toast.error('Failed to delete transactions');
      }
    } finally {
      setDeleting(false);
    }
  };

  /**
   * Reset form and preview
   */
  const resetForm = () => {
    setDateFrom('');
    setDateTo('');
    setPreview(null);
    setOutdated(null);
    setConfirmationChecked(false);
    setExcludeBudgetPeriod(true);
    setCreateBackup(true);
  };


  /**
   * Format a transaction date (a calendar day)
   */
  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return 'N/A';
    return formatCalendarDate(dateStr, 'en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  return (
    <PageContainer width="form">
      <SettingsPageHeader
        title="Data Management"
        subtitle="Safely delete transaction data with automatic backups"
        icon={<Trash2 size={20} className="text-[var(--red-11)]" />}
        iconBackground="bg-[var(--red-3)]"
        backPath="/settings"
      />

      <Flex direction="column" gap="6">
        {/* Warning Callout */}
        <Callout.Root color="red" size="2">
          <Callout.Icon>
            <TriangleAlert size={16} />
          </Callout.Icon>
          <Callout.Text>
            <Text weight="bold">Warning:</Text> Data deletion is permanent and includes both imported and manual transactions.{' '}
            {isDeploymentAdmin ? 'Always create a backup first.' : 'Ask a deployment admin for a backup first.'}
          </Callout.Text>
        </Callout.Root>

        {/* Delete Transactions Form */}
        <Card>
          <Flex direction="column" gap="4">
            <Box>
              <Text size="5" weight="bold">Delete Transactions</Text>
              <Text size="2" color="gray" mt="1">
                Delete ALL transactions (imported and manual) within a date range
              </Text>
            </Box>

            <Flex direction="column" gap="3" mt="2">
              {/* Date From */}
              <Box>
                <Text as="label" htmlFor="delete-date-from" size="2" weight="medium" mb="1">
                  Start Date <span aria-hidden="true" className="text-[var(--red-11)]">*</span>
                </Text>
                <TextField.Root
                  id="delete-date-from"
                  aria-required="true"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => changeCriteria(() => setDateFrom(e.target.value))}
                  placeholder="Select start date"
                  disabled={previewing || deleting}
                />
              </Box>

              {/* Date To */}
              <Box>
                <Text as="label" htmlFor="delete-date-to" size="2" weight="medium" mb="1">
                  End Date <span aria-hidden="true" className="text-[var(--red-11)]">*</span>
                </Text>
                <TextField.Root
                  id="delete-date-to"
                  aria-required="true"
                  type="date"
                  value={dateTo}
                  onChange={(e) => changeCriteria(() => setDateTo(e.target.value))}
                  placeholder="Select end date"
                  disabled={previewing || deleting}
                />
              </Box>

              {/* Exclude Budget Period Checkbox */}
              <Flex asChild align="start" gap="2">
                <label style={{ cursor: 'pointer' }}>
                  <Checkbox
                    checked={excludeBudgetPeriod}
                    onCheckedChange={(checked) => changeCriteria(() => setExcludeBudgetPeriod(checked as boolean))}
                    disabled={previewing || deleting}
                    aria-labelledby="exclude-budget-period-label"
                    aria-describedby="exclude-budget-period-hint"
                  />
                  <Box as="span" flexGrow="1" flexBasis="0%">
                    <Text id="exclude-budget-period-label" size="2" weight="medium" style={{ display: 'block' }}>
                      Exclude transactions assigned to budget periods
                    </Text>
                    <Text id="exclude-budget-period-hint" size="1" color="gray" mt="1" style={{ display: 'block' }}>
                      Skip deletion of transactions that have been assigned to a budget period
                    </Text>
                  </Box>
                </label>
              </Flex>

              {/* Create Backup Checkbox: deployment admins only */}
              {isDeploymentAdmin ? (
                <Flex asChild align="start" gap="2">
                  <label style={{ cursor: 'pointer' }}>
                    <Checkbox
                      checked={createBackup}
                      onCheckedChange={(checked) => setCreateBackup(checked as boolean)}
                      disabled={previewing || deleting}
                      aria-labelledby="create-backup-label"
                      aria-describedby="create-backup-hint"
                    />
                    <Box as="span" flexGrow="1" flexBasis="0%">
                      <Text id="create-backup-label" size="2" weight="medium" style={{ display: 'block' }}>
                        Create automatic backup before deletion
                      </Text>
                      <Text id="create-backup-hint" size="1" color="gray" mt="1" style={{ display: 'block' }}>
                        <strong>Recommended.</strong> A backup will be created before any data is deleted. Deletion will be blocked if backup fails.
                      </Text>
                    </Box>
                  </label>
                </Flex>
              ) : (
                <Text id="create-backup-unavailable" size="1" color="gray">
                  No backup is made first: a backup holds every ledger on this server, so only a deployment admin can create one.
                </Text>
              )}
            </Flex>

            {/* Action Buttons */}
            <Flex gap="3" mt="4">
              <Button
                variant="soft"
                color="gray"
                onClick={handlePreview}
                disabled={previewing || deleting}
              >
                {previewing ? 'Previewing...' : 'Preview Deletion'}
              </Button>

              <Button
                color="red"
                onClick={handleDelete}
                disabled={!previewData || previewData.count === 0 || previewing || deleting}
              >
                <Trash2 size={16} />
                Delete Transactions
              </Button>

              <Button
                variant="outline"
                color="gray"
                onClick={resetForm}
                disabled={previewing || deleting}
              >
                Reset
              </Button>
            </Flex>
          </Flex>
        </Card>

        {/* The transactions changed after the preview: nothing was deleted. */}
        {outdated && (
          <Callout.Root highContrast color="amber" size="2">
            <Callout.Icon>
              <AlertCircle size={16} />
            </Callout.Icon>
            <Callout.Text>{outdated}</Callout.Text>
            <Box>
              <Button variant="soft" color="amber" onClick={handlePreview} disabled={previewing}>
                {previewing ? 'Previewing...' : 'Preview again'}
              </Button>
            </Box>
          </Callout.Root>
        )}

        {/* Preview Results */}
        {previewData && previewData.count > 0 && (
          <Card className="border-[var(--amber-7)]" style={{ borderWidth: '2px' }}>
            <Flex direction="column" gap="3">
              <Flex align="center" gap="2">
                <AlertCircle size={20} className="text-[var(--amber-12)]" />
                <Text size="5" weight="bold" color="amber" highContrast>
                  Preview Results
                </Text>
              </Flex>

              <Callout.Root highContrast color="amber" size="2">
                <Callout.Icon>
                  <TriangleAlert size={16} />
                </Callout.Icon>
                <Callout.Text>
                  The following transactions will be <strong>permanently deleted</strong> when you confirm.
                </Callout.Text>
              </Callout.Root>

              <ScrollArea scrollbars="horizontal">
                <Table.Root variant="surface">
                <Table.Body>
                  <Table.Row>
                    <Table.RowHeaderCell>Transactions to Delete</Table.RowHeaderCell>
                    <Table.Cell>
                      <Text weight="bold" size="3">{previewData.count}</Text>
                    </Table.Cell>
                  </Table.Row>
                  <Table.Row>
                    <Table.RowHeaderCell>Affected Accounts</Table.RowHeaderCell>
                    <Table.Cell>
                      <Text weight="bold" size="3">{previewData.affectedAccounts}</Text>
                    </Table.Cell>
                  </Table.Row>
                  <Table.Row>
                    <Table.RowHeaderCell>Total Income</Table.RowHeaderCell>
                    <Table.Cell>
                      <Text weight="bold" size="3" color="green" highContrast>
                        {formatMoney(previewData.totalIncome)}
                      </Text>
                    </Table.Cell>
                  </Table.Row>
                  <Table.Row>
                    <Table.RowHeaderCell>Total Expenses</Table.RowHeaderCell>
                    <Table.Cell>
                      <Text weight="bold" size="3" color="red">
                        {formatMoney(previewData.totalExpenses)}
                      </Text>
                    </Table.Cell>
                  </Table.Row>
                  <Table.Row>
                    <Table.RowHeaderCell>Date Range</Table.RowHeaderCell>
                    <Table.Cell>
                      <Text size="2">
                        {formatDate(previewData.earliestDate)} to {formatDate(previewData.latestDate)}
                      </Text>
                    </Table.Cell>
                  </Table.Row>
                </Table.Body>
                </Table.Root>
              </ScrollArea>

              <Callout.Root color="blue" size="2">
                <Callout.Icon>
                  <CheckCircle2 size={16} />
                </Callout.Icon>
                <Callout.Text>
                  {createBackup
                    ? 'A backup will be created automatically before deletion.'
                    : isDeploymentAdmin
                      ? 'No backup will be created. This is not recommended.'
                      : 'No backup will be created: only a deployment admin can create one.'}
                </Callout.Text>
              </Callout.Root>
            </Flex>
          </Card>
        )}

        {/* No Transactions Found */}
        {previewData && previewData.count === 0 && (
          <Card>
            <Flex align="center" gap="3" p="4">
              <AlertCircle size={20} className="text-[var(--gray-11)]" />
              <Box>
                <Text size="3" weight="bold">No Transactions Found</Text>
                <Text size="2" color="gray">
                  No transactions exist in the specified date range with the current filters.
                </Text>
              </Box>
            </Flex>
          </Card>
        )}
      </Flex>

      {/* Confirmation Dialog */}
      <AlertDialog.Root open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialog.Content maxWidth="500px">
          <AlertDialog.Title>Confirm Transaction Deletion</AlertDialog.Title>
          <AlertDialog.Description size="2" mb="3">
            You are about to <strong>permanently delete</strong> the following:
          </AlertDialog.Description>
          <Flex direction="column" gap="3" mb="4">
                <ul style={{ paddingLeft: '20px', margin: 0 }}>
                  <li>
                    <strong>{previewData?.count}</strong> transaction{previewData?.count !== 1 ? 's' : ''}
                  </li>
                  {preview && (
                    <li>
                      Dated <strong>{formatDate(preview.criteria.dateFrom)}</strong> to{' '}
                      <strong>{formatDate(preview.criteria.dateTo)}</strong>
                      {preview.criteria.excludeBudgetPeriod
                        ? ', except those assigned to a budget period'
                        : ', including those assigned to a budget period'}
                    </li>
                  )}
                  <li>
                    Affecting <strong>{previewData?.affectedAccounts}</strong> account{previewData?.affectedAccounts !== 1 ? 's' : ''}
                  </li>
                  <li>
                    Total income: <strong>{formatMoney(previewData?.totalIncome || 0)}</strong>
                  </li>
                  <li>
                    Total expenses: <strong>{formatMoney(previewData?.totalExpenses || 0)}</strong>
                  </li>
                  {createBackup && (
                    <li className="text-[var(--green-12)]">
                      ✓ Backup will be created before deletion
                    </li>
                  )}
                  <li className="text-[var(--accent-11)]">
                    ✓ Account balances will be automatically recalculated
                  </li>
                </ul>

                <Callout.Root color="red" size="1">
                  <Callout.Icon>
                    <TriangleAlert size={12} />
                  </Callout.Icon>
                  <Callout.Text>
                    This action cannot be undone. Deleted transactions cannot be recovered except from a backup.
                  </Callout.Text>
                </Callout.Root>

                <Flex asChild align="center" gap="2">
                  <label style={{ cursor: 'pointer' }}>
                    <Checkbox
                      checked={confirmationChecked}
                      onCheckedChange={(checked) => setConfirmationChecked(checked as boolean)}
                      disabled={deleting}
                    />
                    <Text size="2" weight="medium">
                      I understand this action is permanent
                    </Text>
                  </label>
                </Flex>
          </Flex>

          <Flex gap="3" justify="end" mt="4">
            <AlertDialog.Cancel>
              <Button variant="soft" color="gray" disabled={deleting}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <Button
              color="red"
              onClick={handleConfirmDelete}
              disabled={!confirmationChecked || deleting}
            >
              {deleting ? 'Deleting...' : 'Confirm Delete'}
            </Button>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </PageContainer>
  );
}
