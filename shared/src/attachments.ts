import { z } from 'zod';
import { instant, nullableDayText, nullableInstant, responseCount } from './responses.js';

/**
 * An attachment as the API answers it: the fields every attachment answer has,
 * and those only an upload's carries (the row's id, its stored file name and the record it is
 * on), optional here. file_size is a bigint, which pg sends as text, read as a number.
 */
export const attachmentResponseSchema = z.object({
  uuid: z.uuid(),
  name: z.string(),
  original_filename: z.string(),
  safe_filename: z.string(),
  file_extension: z.string(),
  file_size: responseCount.nullable(),
  mime_type: z.string().nullable(),
  date_uploaded: nullableInstant,
  bill_date: nullableDayText,
  notes: z.string().nullable(),
  attachment_type: z.string().nullable(),
  created_at: instant,
  // An upload's answer: the rest of the row.
  id: z.number().int().optional(),
  file_name: z.string().optional(),
  transaction_id: z.number().int().nullable().optional(),
  budget_item_id: z.number().int().nullable().optional(),
  merchant_id: z.number().int().nullable().optional(),
  holding_event_id: z.number().int().nullable().optional(),
});
export type AttachmentResponse = z.infer<typeof attachmentResponseSchema>;

/** GET /api/transactions/:uuid/attachments: the transaction's attachments, newest first. */
export const attachmentListResponseSchema = z.object({ attachments: z.array(attachmentResponseSchema) });
export type AttachmentListResponse = z.infer<typeof attachmentListResponseSchema>;

/** POST /api/attachments/upload: the attachments written, each the whole row. */
export const attachmentUploadResponseSchema = z.object({
  attachments: z.array(
    attachmentResponseSchema.required({
      id: true,
      file_name: true,
      transaction_id: true,
      budget_item_id: true,
      merchant_id: true,
      holding_event_id: true,
    })
  ),
});
export type AttachmentUploadResponse = z.infer<typeof attachmentUploadResponseSchema>;

/** DELETE /api/attachments/:uuid. */
export const attachmentDeletedResponseSchema = z.object({ message: z.string(), uuid: z.uuid() });
