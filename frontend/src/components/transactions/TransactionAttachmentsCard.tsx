import React, { useState } from 'react';
import { Box, Card, Flex, Grid, Heading, IconButton, Text } from '@radix-ui/themes';
import { Eye, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import type { TransactionWithSplits } from '@nuggets/shared';
import { useDeleteAttachmentMutation, useUploadAttachmentsMutation } from '../../hooks/queries';
import type { UseConfirmationReturn } from '../../hooks/useConfirmation';
import { API_BASE_URL, type Attachment } from '../../services/api';
import { formatInstantDate } from '../../utils/dateUtils';
import { apiErrorMessage } from '../../utils/errors';
import { logger } from '../../utils/logger';
import FilePickerButton from '../forms/FilePickerButton';

/** The files a transaction takes, by extension, and how large. */
const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.xls', '.xlsx'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface TransactionAttachmentsCardProps {
  transaction: TransactionWithSplits;
  /** Its attachments, which the page asks for alongside the transaction. */
  attachments: Attachment[];
  confirmAsync: UseConfirmationReturn['confirmAsync'];
}

/** A transaction's receipts and documents: listed, uploaded, opened and deleted. */
export const TransactionAttachmentsCard: React.FC<TransactionAttachmentsCardProps> = ({ transaction, attachments, confirmAsync }) => {
  const uploadAttachmentsMutation = useUploadAttachmentsMutation();
  const deleteAttachmentMutation = useDeleteAttachmentMutation();
  const [uploading, setUploading] = useState(false);

  const upload = async (files: readonly File[]) => {
    if (!files.length) return;
    // Only the files that pass these checks are sent, and only they are counted.
    const accepted = Array.from(files).filter((file) => {
      const extension = '.' + file.name.split('.').pop()?.toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(extension)) {
        toast.error(`File type ${extension} not allowed`);
        return false;
      }
      if (file.size > MAX_FILE_BYTES) {
        toast.error(`${file.name} is larger than 5 MB`);
        return false;
      }
      return true;
    });
    if (accepted.length === 0) return;

    setUploading(true);
    try {
      const formData = new FormData();
      // The transaction first: the server checks it before it writes any file, and refuses a
      // file sent before it.
      formData.append('transaction_id', transaction.id.toString());
      accepted.forEach((file) => formData.append('attachments', file));
      await uploadAttachmentsMutation.mutateAsync({ transactionUuid: transaction.uuid, formData });
      toast.success(accepted.length === 1 ? '1 file uploaded' : `${accepted.length} files uploaded`);
    } catch (error) {
      logger.error({ err: error, uuid: transaction.uuid }, 'Failed to upload attachments');
      toast.error(apiErrorMessage(error, 'Failed to upload attachments'));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (attachmentUuid: string) => {
    const confirmed = await confirmAsync({
      title: 'Delete Attachment',
      message: 'Are you sure you want to delete this attachment? This action cannot be undone.',
      variant: 'danger',
      confirmText: 'Delete',
      cancelText: 'Cancel',
    });
    if (!confirmed) return;

    try {
      await deleteAttachmentMutation.mutateAsync({ transactionUuid: transaction.uuid, attachmentUuid });
      toast.success('Attachment deleted successfully');
    } catch (error) {
      logger.error({ err: error, attachmentId: attachmentUuid }, 'Failed to delete attachment');
      toast.error('Failed to delete attachment');
    }
  };

  return (
    <Card>
      <Flex direction={{ initial: 'column', sm: 'row' }} align={{ sm: 'center' }} justify={{ sm: 'between' }} gap="3" mb="4">
        <Heading as="h2" size="4">
          <Flex align="center" gap="2">
            <Paperclip size={20} />
            Attachments ({attachments.length})
          </Flex>
        </Heading>
        <FilePickerButton
          accept={ALLOWED_EXTENSIONS.join(',')}
          multiple
          onFiles={(files) => void upload(files)}
          disabled={uploading}
          loading={uploading}
          variant="solid"
          size="3"
        >
          <Upload size={16} />
          Upload
        </FilePickerButton>
      </Flex>

      {attachments.length === 0 ? (
        <Flex direction="column" align="center" gap="1" py="8">
          <FileText size={48} className="mb-2 text-[var(--gray-7)]" />
          <Text color="gray">No attachments yet</Text>
          <Text size="2" color="gray">Upload receipts, invoices, or other documents</Text>
        </Flex>
      ) : (
        <Grid columns={{ initial: '1', md: '2' }} gap="4">
          {attachments.map((attachment) => (
            <Box key={attachment.uuid} p="4" className="rounded-[var(--radius-3)] border border-[var(--gray-6)]">
              <Flex align="start" justify="between">
                <Box flexGrow="1" minWidth="0">
                  <Text as="div" weight="medium" truncate color="gray" highContrast>
                    {attachment.name || attachment.original_filename}
                  </Text>
                  <Text as="div" size="2" color="gray">
                    {attachment.file_extension?.toUpperCase()} •{' '}
                    {formatInstantDate(attachment.date_uploaded, 'en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })}
                  </Text>
                  {attachment.file_size && (
                    <Text as="div" size="1" color="gray">
                      {(attachment.file_size / 1024).toFixed(1)} KB
                    </Text>
                  )}
                </Box>
                <Flex align="center" gap="2" ml="4">
                  <IconButton
                    variant="soft"
                    color="gray"
                    size="1"
                    onClick={() => window.open(`${API_BASE_URL}/attachments/file/${encodeURIComponent(attachment.uuid)}`, '_blank', 'noopener')}
                    aria-label="View attachment"
                  >
                    <Eye size={16} />
                  </IconButton>
                  <IconButton variant="soft" color="red" size="1" onClick={() => void remove(attachment.uuid)} aria-label="Delete attachment">
                    <Trash2 size={16} />
                  </IconButton>
                </Flex>
              </Flex>
            </Box>
          ))}
        </Grid>
      )}
    </Card>
  );
};
