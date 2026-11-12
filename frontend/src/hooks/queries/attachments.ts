import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getAttachmentsByTransaction, uploadAttachments, deleteAttachment,
} from '../../services/api';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

const attachmentKeys = {
  all: ['attachments'] as const,
  byTransaction: (uuid: string) => ['attachments', 'transaction', uuid] as const,
};

/** Attachments for a transaction. `undefined` uuid disables the query. */
export function useTransactionAttachmentsQuery(transactionUuid: string | undefined, options?: QueryOverrides) {
  return useQuery({
    queryKey: attachmentKeys.byTransaction(transactionUuid ?? ''),
    queryFn: () => getAttachmentsByTransaction(transactionUuid as string),
    enabled: !!transactionUuid,
    ...options,
  });
}

/** Upload attachments (multipart). Invalidates the transaction's attachments. */
export function useUploadAttachmentsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ formData }: { transactionUuid: string; formData: FormData }) => uploadAttachments(formData),
    onSuccess: (_d, { transactionUuid }) => {
      void qc.invalidateQueries({ queryKey: attachmentKeys.byTransaction(transactionUuid) });
    },
  });
}

/** Delete an attachment. Invalidates the transaction's attachments. */
export function useDeleteAttachmentMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ attachmentUuid }: { transactionUuid: string; attachmentUuid: string }) => deleteAttachment(attachmentUuid),
    onSuccess: (_d, { transactionUuid }) => {
      void qc.invalidateQueries({ queryKey: attachmentKeys.byTransaction(transactionUuid) });
    },
  });
}
