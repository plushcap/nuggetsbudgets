/**
 * API Attachments Module - Attachment Operations
 *
 * Handles all attachment-related API operations:
 * - Upload attachments for transactions
 * - Retrieve attachments for transactions
 * - Delete attachments
 */

import {
  attachmentDeletedResponseSchema,
  attachmentListResponseSchema,
  attachmentUploadResponseSchema,
  type AttachmentListResponse,
  type AttachmentUploadResponse,
} from '@nuggets/shared';
import { API_BASE_URL, getAuthHeaders, handleResponse, apiPostFormData } from './base';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

/** A transaction's attachments: attachmentListResponseSchema. */
export type AttachmentsResponse = AttachmentListResponse;

/**
 * Upload attachments (files) for a transaction or other entity
 */
export const uploadAttachments = async (formData: FormData): Promise<AttachmentUploadResponse> => {
  // Delegate to the shared FormData helper so the X-CSRF-Token header is attached.
  return parseAnswer(attachmentUploadResponseSchema, await apiPostFormData<unknown>('/attachments/upload', formData), 'attachments upload');
};

/**
 * Get all attachments for a specific transaction
 */
export const getAttachmentsByTransaction = async (transactionUuid: string): Promise<AttachmentsResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/transactions/${transactionUuid}/attachments`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(attachmentListResponseSchema, await handleResponse<unknown>(response), 'attachments');
  } catch (error) {
    logger.error({ err: error, transactionUuid, endpoint: `/attachments/transaction/${transactionUuid}` }, 'Failed to fetch attachments');
    throw error;
  }
};

/**
 * Delete an attachment by UUID
 */
export const deleteAttachment = async (uuid: string): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/attachments/${uuid}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    parseAnswer(attachmentDeletedResponseSchema, await handleResponse<unknown>(response), 'deleted attachment');
  } catch (error) {
    logger.error({ err: error, attachmentUuid: uuid, endpoint: `/attachments/${uuid}` }, 'Failed to delete attachment');
    throw error;
  }
};
